/**
 * G2: Human-Approved Admin Command — Consumer API & ChatGPT DCR / MCP Tool Adapter.
 *
 * Exposes bounded control-side workflows: request, status, execute, cancel.
 * Explicitly separates Agent request/execution from Human approval.
 */
import { z } from "zod";
import {
  type ControlActor,
  controlActorRef,
  actorAllows,
  PRIVILEGED_APPROVE_SCOPE,
} from "./controlPolicy.js";
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
 * Legacy declaration format for backwards compatibility with function-calling manifests.
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
            output: { type: "string", enum: ["discard", "bounded"], default: "discard", description: "Diagnostic output capture mode: 'discard' (default) or 'bounded' (up to 32 KiB stdout/stderr)" },
            output_limit_bytes: { type: "integer", default: 32768, description: "Maximum combined stdout/stderr budget in bytes (1024-32768, default 32768)" },
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

/**
 * Standard MCP specifications compatible with @modelcontextprotocol/sdk.
 * Explicitly separates agent tools from human approval.
 */
export const FLEET_ADMIN_MCP_TOOLS = Object.freeze([
  {
    name: "fleet_admin_request_command",
    description: "Submit a request to execute a root-level administrator command on an enrolled Fleet node. The request requires approval from an authorized human operator before it can be executed.",
    inputSchema: {
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
            output: { type: "string", enum: ["discard", "bounded"], default: "discard", description: "Diagnostic output capture mode: 'discard' (default) or 'bounded' (up to 32 KiB stdout/stderr)" },
            output_limit_bytes: { type: "integer", default: 32768, description: "Maximum combined stdout/stderr budget in bytes (1024-32768, default 32768)" },
          },
          required: ["argv", "cwd", "executable_sha256"],
        },
        rollback_ref: { type: "string", description: "Documented rollback or compensation step" },
        max_runtime_seconds: { type: "integer", default: 30, description: "Maximum execution timeout in seconds (1-900)" },
        ttl_seconds: { type: "integer", default: 300, description: "Lease validity window in seconds (10-3600)" },
      },
      required: ["node_uid", "work_ref", "purpose", "command", "rollback_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_admin_command_status",
    description: "Check the approval state of an administrator command request, or query execution status on the target host if already dispatched or running.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request ID returned by fleet_admin_request_command" },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_admin_command_execute",
    description: "Execute an administrator command on the target host after human approval has been granted. Can only be dispatched once.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The approved request ID to execute" },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_admin_command_cancel",
    description: "Cancel a pending, approved, or in-flight administrator command request or lease.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request ID to cancel" },
        reason: { type: "string", description: "Optional explanation for cancellation" },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
  },
]);

export interface AdminConsumerContext {
  manager: AdminApprovalManager;
  env: ApprovedAdminEnvironment;
  actor: ControlActor;
  dependencies?: PrivilegedDependencies;
}

async function assertCallerAuthorized(record: AdminApprovalRecord, actor: ControlActor): Promise<string> {
  const callerRef = await controlActorRef(actor);
  const isRequester = record.actor_ref === callerRef;
  const isSupervisor = actorAllows(actor, PRIVILEGED_APPROVE_SCOPE);
  if (!isRequester && !isSupervisor) {
    throw new Error("ADMIN_REQUEST_ACCESS_DENIED");
  }
  return callerRef;
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

  try {
    await assertCallerAuthorized(record, actor);
  } catch {
    return { ok: false, error: "ADMIN_REQUEST_ACCESS_DENIED" };
  }

  // If already dispatched, consumed, or cancel is requested/reconciliation required, query live node status
  const requiresLiveStatus =
    (record.state === "DISPATCHED" ||
      record.state === "CONSUMED" ||
      record.state === "CANCEL_REQUESTED" ||
      record.reconcile_required) &&
    Boolean(record.lease);

  if (requiresLiveStatus && record.lease) {
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

    // Reconcile status into durable ledger if node returned receipt
    const reconciled = await manager.reconcileFromStatus(record.request_id, liveStatus as any);
    const current = reconciled ?? record;

    const isLateSuccess =
      current.state === "CANCELLED" &&
      (current.late_dispatch_outcome?.outcome === "SUCCEEDED" ||
        (current.execution_receipt as any)?.state === "SUCCEEDED");

    return {
      ok: true,
      request_id: current.request_id,
      state: current.state,
      decision: current.decision,
      reconcile_required: current.reconcile_required,
      live_execution: liveStatus,
      execution_receipt: current.execution_receipt,
      late_dispatch_outcome: current.late_dispatch_outcome,
      conflicting_dispatch_outcome: current.conflicting_dispatch_outcome,
      actual_execution_outcome: current.late_dispatch_outcome?.outcome ?? current.dispatch_state,
      output: (liveStatus as any)?.output,
      effect_summary: isLateSuccess
        ? "COMMAND_EFFECT_EXECUTED_DESPITE_CANCELLATION: Remote execution completed with SUCCEEDED before cancellation took effect"
        : undefined,
    };
  }

  const isLateSuccess =
    record.state === "CANCELLED" &&
    (record.late_dispatch_outcome?.outcome === "SUCCEEDED" ||
      (record.execution_receipt as any)?.state === "SUCCEEDED");

  return {
    ok: true,
    request_id: record.request_id,
    node_uid: record.node_uid,
    state: record.state,
    created_at: record.created_at,
    expires_at: record.expires_at,
    decision: record.decision,
    reconcile_required: record.reconcile_required,
    lease_available: Boolean(record.lease),
    execution_receipt: record.execution_receipt,
    late_dispatch_outcome: record.late_dispatch_outcome,
    conflicting_dispatch_outcome: record.conflicting_dispatch_outcome,
    actual_execution_outcome: record.late_dispatch_outcome?.outcome ?? record.dispatch_state,
    effect_summary: isLateSuccess
      ? "COMMAND_EFFECT_EXECUTED_DESPITE_CANCELLATION: Remote execution completed with SUCCEEDED before cancellation took effect"
      : undefined,
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

  try {
    await assertCallerAuthorized(record, actor);
  } catch {
    return { ok: false, error: "ADMIN_REQUEST_ACCESS_DENIED" };
  }

  if (record.state !== "APPROVED") {
    if (record.state === "CONSUMED") {
      return { ok: false, error: "ADMIN_LEASE_ALREADY_CONSUMED" };
    }
    if (record.state === "DISPATCHED") {
      return { ok: false, error: "ADMIN_COMMAND_ALREADY_DISPATCHED" };
    }
    if (record.state === "CANCEL_REQUESTED" || record.state === "CANCELLED") {
      return { ok: false, error: `ADMIN_CANNOT_EXECUTE:${record.state}` };
    }
    if (record.state === "PENDING") {
      return { ok: false, error: "ADMIN_REQUEST_NOT_YET_APPROVED" };
    }
    return { ok: false, error: `ADMIN_CANNOT_EXECUTE:${record.state}` };
  }
  if (!record.lease) {
    return { ok: false, error: "ADMIN_LEASE_DATA_MISSING" };
  }

  const callerRef = await controlActorRef(actor);
  if (record.actor_ref !== callerRef) {
    return { ok: false, error: "ADMIN_ACTOR_MISMATCH" };
  }

  // Atomic ledger transition to DISPATCHED before dispatching network execution
  try {
    await manager.markDispatched(callerRef, requestId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

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

  if (execution.outcome === "NOT_DISPATCHED") {
    // Dispatch failed prior to transmitting command; revert state so caller may retry
    await manager.recordDispatchFailure(requestId);
    return {
      ok: false,
      request_id: record.request_id,
      lease_id: record.lease.lease_id,
      outcome: "NOT_DISPATCHED",
      error: execution.error,
      retry_safe: true,
    };
  }

  if (execution.outcome === "UNKNOWN") {
    // May have executed; mark reconcile_required
    await manager.recordDispatchUnknown(requestId, execution.error);
    return {
      ok: false,
      request_id: record.request_id,
      lease_id: record.lease.lease_id,
      outcome: "UNKNOWN",
      error: execution.error,
      reconcile_required: true,
      retry_safe: false,
    };
  }

  // Node acknowledged completion or running status (RUNNING, SUCCEEDED, FAILED, STOPPED)
  // CAS handles any concurrent cancellation cleanly without losing receipt (P0-3)
  const updated = await manager.recordDispatchOutcome(callerRef, requestId, execution);
  return {
    ok: true,
    request_id: record.request_id,
    lease_id: record.lease.lease_id,
    outcome: execution.outcome,
    state: updated.state,
    execution,
    output: (execution as any).output,
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

  let callerRef: string;
  try {
    callerRef = await assertCallerAuthorized(record, actor);
  } catch {
    return { ok: false, error: "ADMIN_REQUEST_ACCESS_DENIED" };
  }

  if (record.state === "CANCELLED") {
    return { ok: true, request_id: record.request_id, state: "CANCELLED" };
  }

  // If PENDING or APPROVED without active dispatch to host, cancel locally
  if (record.state === "PENDING" || (record.state === "APPROVED" && !record.lease)) {
    const updated = await manager.requestCancellation(actor, requestId, reason);
    return {
      ok: true,
      request_id: updated.request_id,
      state: updated.state,
    };
  }

  if (record.state === "APPROVED" && record.lease) {
    // Lease was issued, cancel locally before dispatch
    const updated = await manager.requestCancellation(actor, requestId, reason);
    return {
      ok: true,
      request_id: updated.request_id,
      state: updated.state,
    };
  }

  // For DISPATCHED, CONSUMED, or already CANCEL_REQUESTED, we MUST dispatch action: 'cancel' to node
  // and only confirm CANCELLED if node receipt confirms stop (P0-2)
  await manager.requestCancellation(actor, requestId, reason);

  let remoteCancelReceipt: any = null;
  if (record.lease) {
    remoteCancelReceipt = await runApprovedAdminCommand(
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
  }

  if (!remoteCancelReceipt || remoteCancelReceipt.outcome === "NOT_DISPATCHED") {
    await manager.recordCancelDispatchUncertain(requestId, "NOT_DISPATCHED", remoteCancelReceipt?.error);
    return {
      ok: false,
      request_id: record.request_id,
      state: "CANCEL_REQUESTED",
      outcome: "NOT_DISPATCHED",
      error: remoteCancelReceipt?.error ?? "CANCEL_CONNECT_FAILED",
      reconcile_required: true,
    };
  }

  if (remoteCancelReceipt.outcome === "UNKNOWN") {
    await manager.recordCancelDispatchUncertain(requestId, "UNKNOWN", remoteCancelReceipt.error);
    return {
      ok: false,
      request_id: record.request_id,
      state: "CANCEL_REQUESTED",
      outcome: "UNKNOWN",
      error: remoteCancelReceipt.error ?? "ADMIN_CANCEL_DISPATCH_UNCERTAIN",
      reconcile_required: true,
    };
  }

  // Node returned confirmed receipt
  const receiptState = remoteCancelReceipt.receipt?.state;
  if (receiptState === "REVOKED" || receiptState === "STOPPED") {
    const confirmed = await manager.confirmCancellation(requestId, callerRef, remoteCancelReceipt.receipt);
    return {
      ok: true,
      request_id: confirmed.request_id,
      state: confirmed.state,
      remote_cancel: remoteCancelReceipt,
    };
  }

  if (receiptState === "SUCCEEDED" || receiptState === "FAILED") {
    const completed = await manager.recordCompletedBeforeCancel(requestId, callerRef, remoteCancelReceipt.receipt);
    return {
      ok: false,
      request_id: completed.request_id,
      state: completed.state,
      error: "ADMIN_COMMAND_ALREADY_COMPLETED",
      remote_cancel: remoteCancelReceipt,
    };
  }

  return {
    ok: false,
    request_id: record.request_id,
    state: "CANCEL_REQUESTED",
    outcome: remoteCancelReceipt.outcome,
    reconcile_required: true,
    remote_cancel: remoteCancelReceipt,
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

export function createAdminMcpDispatcher(context: AdminConsumerContext) {
  return async function dispatch(name: string, args: Record<string, unknown> = {}) {
    return dispatchAdminToolCall(name, args, context);
  };
}
