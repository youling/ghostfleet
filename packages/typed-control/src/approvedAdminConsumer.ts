/**
 * G2: Human-Approved Admin Command — Consumer API & ChatGPT DCR / MCP Tool Adapter.
 *
 * Exposes bounded control-side workflows: request, status, execute, cancel.
 * Explicitly separates Agent request/execution from Human approval.
 */
import { z } from "zod";
import { type ControlActor, controlActorRef } from "./controlPolicy.js";
import {
  AdminApprovalManager,
  adminCommandRequestInputSchema,
  type AdminCommandRequestInput,
  type AdminApprovalRecord,
} from "./approvedAdminApproval.js";
import {
  runApprovedAdminCommand,
  type ApprovedAdminEnvironment,
} from "./approvedAdminCommand.js";
import { type PrivilegedDependencies } from "./privilegedOperations.js";

export const adminConsumerToolNames = [
  "fleet_admin_request_command",
  "fleet_admin_command_status",
  "fleet_admin_command_execute",
  "fleet_admin_command_cancel",
] as const;

export type AdminConsumerToolName = typeof adminConsumerToolNames[number];

/**
 * Standard tool specifications declaring the DCR / MCP interface for approved admin commands.
 * Notice: 'approve' is strictly excluded from these definitions.
 */
export const fleetAdminToolDeclarations = [
  {
    name: "fleet_admin_request_command",
    description: "Submit a request to execute a root-level administrator command on an enrolled Fleet node. The request requires approval from an authorized human operator before it can be executed.",
    parameters: {
      type: "object",
      properties: {
        node_uid: { type: "string", description: "Target Fleet node canonical UID" },
        work_ref: { type: "string", description: "Tracking reference for the work or issue (e.g. youling/ai-hub#300)" },
        purpose: { type: "string", description: "Clear explanation of why administrative execution is necessary" },
        command: {
          type: "object",
          properties: {
            argv: { type: "array", items: { type: "string" }, description: "Full argument list including binary path" },
            cwd: { type: "string", description: "Working directory on the target host" },
            env: { type: "object", additionalProperties: { type: "string" }, description: "Restricted environment variables" },
            executable_sha256: { type: "string", description: "Exact SHA-256 digest of the binary on target host" },
          },
          required: ["argv", "cwd", "executable_sha256"],
        },
        rollback_ref: { type: "string", description: "Documented rollback or compensation step" },
        max_runtime_seconds: { type: "integer", default: 30, description: "Maximum execution timeout in seconds (1-900)" },
        ttl_seconds: { type: "integer", default: 300, description: "Lease validity window in seconds (10-3600)" },
      },
      required: ["node_uid", "work_ref", "purpose", "command", "rollback_ref"],
    },
  },
  {
    name: "fleet_admin_command_status",
    description: "Check the approval state of an administrator command request, or query execution status on the target host if already executed.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request ID returned by fleet_admin_request_command" },
      },
      required: ["request_id"],
    },
  },
  {
    name: "fleet_admin_command_execute",
    description: "Execute an administrator command on the target host after human approval has been granted. Can only be executed once.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The approved request ID to execute" },
      },
      required: ["request_id"],
    },
  },
  {
    name: "fleet_admin_command_cancel",
    description: "Cancel a pending or active administrator command lease.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request ID to cancel" },
        reason: { type: "string", description: "Optional explanation for cancellation" },
      },
      required: ["request_id"],
    },
  },
] as const;

export interface AdminConsumerContext {
  manager: AdminApprovalManager;
  env: ApprovedAdminEnvironment;
  actor: ControlActor;
  dependencies?: PrivilegedDependencies;
}

export async function requestAdminCommand(
  manager: AdminApprovalManager,
  actor: ControlActor,
  input: AdminCommandRequestInput,
) {
  const record = await manager.submitRequest(actor, input);
  return {
    ok: true,
    request_id: record.request_id,
    node_uid: record.node_uid,
    state: record.state,
    expires_at: record.expires_at,
    purpose: record.purpose,
    message: "Administrator command request submitted. Awaiting human operator approval.",
  };
}

export async function getAdminCommandStatus(
  manager: AdminApprovalManager,
  env: ApprovedAdminEnvironment,
  actor: ControlActor,
  requestId: string,
  dependencies?: PrivilegedDependencies,
) {
  const record = await manager.getRequest(requestId);
  if (!record) {
    return { ok: false, error: "ADMIN_REQUEST_NOT_FOUND" };
  }

  // If already consumed and has a lease, query live node status
  if (record.state === "CONSUMED" && record.lease) {
    const liveStatus = await runApprovedAdminCommand(
      env,
      actor,
      {
        node_uid: record.node_uid,
        action: "status",
        lease_b64: record.lease.raw_lease_b64,
        signature_b64: record.lease.signature_b64,
      },
      dependencies,
    );
    return {
      ok: true,
      request_id: record.request_id,
      state: record.state,
      decision: record.decision,
      live_execution: liveStatus,
    };
  }

  return {
    ok: true,
    request_id: record.request_id,
    node_uid: record.node_uid,
    state: record.state,
    created_at: record.created_at,
    expires_at: record.expires_at,
    decision: record.decision,
    lease_available: Boolean(record.lease),
  };
}

export async function executeAdminCommand(
  manager: AdminApprovalManager,
  env: ApprovedAdminEnvironment,
  actor: ControlActor,
  requestId: string,
  dependencies?: PrivilegedDependencies,
) {
  const record = await manager.getRequest(requestId);
  if (!record) {
    return { ok: false, error: "ADMIN_REQUEST_NOT_FOUND" };
  }
  if (record.state !== "APPROVED") {
    if (record.state === "CONSUMED") {
      return { ok: false, error: "ADMIN_LEASE_ALREADY_CONSUMED" };
    }
    if (record.state === "PENDING") {
      return { ok: false, error: "ADMIN_REQUEST_NOT_YET_APPROVED" };
    }
    return { ok: false, error: `ADMIN_CANNOT_EXECUTE:${record.state}` };
  }
  if (!record.lease) {
    return { ok: false, error: "ADMIN_LEASE_DATA_MISSING" };
  }

  const subject = await controlActorRef(actor);
  if (record.actor_ref !== subject) {
    return { ok: false, error: "ADMIN_ACTOR_MISMATCH" };
  }

  // Atomic ledger transition to CONSUMED (one-use fence)
  await manager.markConsumed(subject, requestId);

  // Dispatch live V4 privileged execution
  const execution = await runApprovedAdminCommand(
    env,
    actor,
    {
      node_uid: record.node_uid,
      action: "execute",
      lease_b64: record.lease.raw_lease_b64,
      signature_b64: record.lease.signature_b64,
    },
    dependencies,
  );

  return {
    ok: true,
    request_id: record.request_id,
    lease_id: record.lease.lease_id,
    execution,
  };
}

export async function cancelAdminCommand(
  manager: AdminApprovalManager,
  env: ApprovedAdminEnvironment,
  actor: ControlActor,
  requestId: string,
  reason?: string,
  dependencies?: PrivilegedDependencies,
) {
  const record = await manager.getRequest(requestId);
  if (!record) {
    return { ok: false, error: "ADMIN_REQUEST_NOT_FOUND" };
  }

  if (record.state === "APPROVED" && record.lease) {
    // Attempt node cancellation if approved lease exists
    try {
      await runApprovedAdminCommand(
        env,
        actor,
        {
          node_uid: record.node_uid,
          action: "cancel",
          lease_b64: record.lease.raw_lease_b64,
          signature_b64: record.lease.signature_b64,
        },
        dependencies,
      );
    } catch {
      // Best-effort remote cancel; ledger state still updates
    }
  }

  const updated = await manager.cancelRequest(actor, requestId, reason);
  return {
    ok: true,
    request_id: updated.request_id,
    state: updated.state,
  };
}

export async function dispatchAdminToolCall(
  name: string,
  rawArgs: unknown,
  context: AdminConsumerContext,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const { manager, env, actor, dependencies } = context;

  switch (name) {
    case "fleet_admin_request_command": {
      const parsed = adminCommandRequestInputSchema.parse(rawArgs);
      return requestAdminCommand(manager, actor, parsed);
    }
    case "fleet_admin_command_status": {
      const parsed = z.object({ request_id: z.string() }).parse(rawArgs);
      return getAdminCommandStatus(manager, env, actor, parsed.request_id, dependencies);
    }
    case "fleet_admin_command_execute": {
      const parsed = z.object({ request_id: z.string() }).parse(rawArgs);
      return executeAdminCommand(manager, env, actor, parsed.request_id, dependencies);
    }
    case "fleet_admin_command_cancel": {
      const parsed = z.object({ request_id: z.string(), reason: z.string().optional() }).parse(rawArgs);
      return cancelAdminCommand(manager, env, actor, parsed.request_id, parsed.reason, dependencies);
    }
    default:
      return { ok: false, error: `UNKNOWN_ADMIN_TOOL:${name}` };
  }
}
