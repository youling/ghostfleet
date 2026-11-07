import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "buffer";
import {
  AdminApprovalManager,
  InMemoryAdminApprovalLedgerStore,
  type TrustedIssuerPort,
  type NodeGenerationPolicy,
  ADMIN_COMMAND_DOMAIN,
} from "../src/approvedAdminApproval.js";
import {
  requestAdminCommand,
  getAdminCommandStatus,
  executeAdminCommand,
  cancelAdminCommand,
  dispatchAdminToolCall,
  fleetAdminToolDeclarations,
  adminConsumerToolNames,
} from "../src/approvedAdminConsumer.js";
import { type ControlActor, controlActorRef } from "../src/controlPolicy.js";
import { type ApprovedAdminEnvironment } from "../src/approvedAdminCommand.js";

const uid = "node-00000000-0000-4000-8000-000000000001";
const agentActor: ControlActor = { userId: "agent-caller", scopes: ["fleet.privileged"], authKind: "oauth" };
const humanActor: ControlActor = { userId: "operator-alice", scopes: ["fleet.privileged", "fleet.admin"], authKind: "oauth" };

function generateTestIssuer(): { issuer: TrustedIssuerPort; privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const issuer: TrustedIssuerPort = {
    issuerId: "human-issuer-v1",
    async sign(leaseBytes: Uint8Array) {
      const sig = sign(null, Buffer.from(leaseBytes), privateKey);
      return {
        issuer_id: "human-issuer-v1",
        signature_b64: sig.toString("base64"),
      };
    },
  };
  return { issuer, privateKeyPem, publicKeyPem };
}

function generateSshKey() {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

async function createTestEnv(policy: NodeGenerationPolicy): Promise<ApprovedAdminEnvironment> {
  const target = (username: string) => ({
    username,
    transport_mode: "local_ssh" as const,
    ssh_host_key_algorithm: "ecdsa-sha2-nistp256",
    ssh_host_key_sha256: "SHA256:AAAA",
  });

  return {
    CONTROL_APPROVED_ADMIN_POLICY_JSON: JSON.stringify({
      [uid]: {
        generation: policy.generation,
        profile_generation: policy.profile_generation,
        subject_ref: policy.subject_ref,
        issuer_ids: policy.issuer_ids,
      },
    }),
    CONTROL_PRIVILEGED_USERNAME: "ghostfleet-ops",
    CONTROL_PRIVILEGED_SSH_PRIVATE_KEY: generateSshKey(),
    CONTROL_SSH_PRIVATE_KEY: generateSshKey(),
    CONTROL_PRIVILEGED_TARGETS_JSON: JSON.stringify({ [uid]: target("ghostfleet-ops") }),
    CONTROL_TARGETS_JSON: JSON.stringify({ [uid]: target("ghostfleet") }),
  };
}

describe("G1/G2 Trusted Admin Approval and Consumer API", () => {
  it("enforces tool definition boundaries: 'approve' is strictly excluded from Agent tools", () => {
    const names = fleetAdminToolDeclarations.map(t => t.name);
    expect(names).toEqual([
      "fleet_admin_request_command",
      "fleet_admin_command_status",
      "fleet_admin_command_execute",
      "fleet_admin_command_cancel",
    ]);
    expect(names.some(n => n.includes("approve"))).toBe(false);
    expect(adminConsumerToolNames).toContain("fleet_admin_request_command");
    expect(adminConsumerToolNames).not.toContain("fleet_admin_approve" as never);
  });

  it("submits a valid request in PENDING state with atomic audit fields", async () => {
    const manager = new AdminApprovalManager();
    const res = await requestAdminCommand(manager, agentActor, {
      node_uid: uid,
      work_ref: "youling/ai-hub#300@test",
      purpose: "Read kernel diagnostics",
      command: {
        argv: ["/usr/bin/id"],
        cwd: "/root",
        env: {},
        executable_sha256: "5".repeat(64),
        output: "discard",
      },
      rollback_ref: "zero-mutation-test",
      max_runtime_seconds: 15,
      ttl_seconds: 120,
    });

    expect(res.ok).toBe(true);
    expect(res.request_id).toMatch(/^req-\d+-[0-9a-f]{16}$/);
    expect(res.state).toBe("PENDING");
    expect(res.node_uid).toBe(uid);

    const record = await manager.getRequest(res.request_id);
    expect(record).not.toBeNull();
    expect(record?.state).toBe("PENDING");
    expect(record?.requester_user_id).toBe("agent-caller");
  });

  it("fails closed when approving without configured issuer (ISSUER_NOT_CONFIGURED)", async () => {
    const manager = new AdminApprovalManager(); // defaults to DefaultUnconfiguredIssuer
    const res = await requestAdminCommand(manager, agentActor, {
      node_uid: uid,
      work_ref: "work-1",
      purpose: "test",
      command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "a".repeat(64), env: {}, output: "discard" },
      rollback_ref: "rb-1",
    });

    const subject = await controlActorRef(agentActor);
    const policy: NodeGenerationPolicy = {
      generation: "b".repeat(64),
      profile_generation: "sha256:" + "c".repeat(64),
      subject_ref: subject,
      issuer_ids: ["unconfigured"],
    };

    await expect(
      manager.approveRequest(humanActor, res.request_id, policy),
    ).rejects.toThrow("ISSUER_NOT_CONFIGURED");
  });

  it("approves request with trusted issuer, binding Ed25519 signature and one-use lease", async () => {
    const { issuer } = generateTestIssuer();
    const manager = new AdminApprovalManager(new InMemoryAdminApprovalLedgerStore(), issuer);

    const res = await requestAdminCommand(manager, agentActor, {
      node_uid: uid,
      work_ref: "youling/ai-hub#300@canary",
      purpose: "Verify canary admin execution",
      command: { argv: ["/usr/bin/id"], cwd: "/root", env: {}, executable_sha256: "e".repeat(64), output: "discard" },
      rollback_ref: "rb-canary",
      ttl_seconds: 300,
    });

    const subject = await controlActorRef(agentActor);
    const policy: NodeGenerationPolicy = {
      generation: "b".repeat(64),
      profile_generation: "sha256:" + "c".repeat(64),
      subject_ref: subject,
      issuer_ids: ["human-issuer-v1"],
    };

    const approved = await manager.approveRequest(humanActor, res.request_id, policy, { reason: "Authorized for issue 300 test" });
    expect(approved.state).toBe("APPROVED");
    expect(approved.decision?.decision).toBe("APPROVED");
    expect(approved.decision?.decided_by).toBe("operator-alice");
    expect(approved.lease).toBeDefined();
    expect(approved.lease?.issuer_id).toBe("human-issuer-v1");
    expect(approved.lease?.raw_lease_b64).toBeTruthy();
    expect(approved.lease?.signature_b64).toBeTruthy();
  });

  it("denies execution if request has not been approved (ADMIN_REQUEST_NOT_YET_APPROVED)", async () => {
    const manager = new AdminApprovalManager();
    const env = await createTestEnv({
      generation: "b".repeat(64),
      profile_generation: "sha256:" + "c".repeat(64),
      subject_ref: await controlActorRef(agentActor),
      issuer_ids: ["human-issuer-v1"],
    });

    const res = await requestAdminCommand(manager, agentActor, {
      node_uid: uid,
      work_ref: "work",
      purpose: "purpose",
      command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "f".repeat(64), env: {}, output: "discard" },
      rollback_ref: "rb",
    });

    const execRes = await executeAdminCommand(manager, env, agentActor, res.request_id);
    expect(execRes.ok).toBe(false);
    expect(execRes.error).toBe("ADMIN_REQUEST_NOT_YET_APPROVED");
  });

  it("denies execution and records denial when human rejects the request", async () => {
    const manager = new AdminApprovalManager();
    const env = await createTestEnv({
      generation: "b".repeat(64),
      profile_generation: "sha256:" + "c".repeat(64),
      subject_ref: await controlActorRef(agentActor),
      issuer_ids: ["human-issuer-v1"],
    });

    const res = await requestAdminCommand(manager, agentActor, {
      node_uid: uid,
      work_ref: "work",
      purpose: "purpose",
      command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "f".repeat(64), env: {}, output: "discard" },
      rollback_ref: "rb",
    });

    await manager.denyRequest(humanActor, res.request_id, "Command unsafe for production");
    const statusRes = await getAdminCommandStatus(manager, env, agentActor, res.request_id);
    expect(statusRes.ok).toBe(true);
    expect(statusRes.state).toBe("DENIED");
    expect(statusRes.decision?.decision).toBe("DENIED");
    expect(statusRes.decision?.reason).toBe("Command unsafe for production");

    const execRes = await executeAdminCommand(manager, env, agentActor, res.request_id);
    expect(execRes.ok).toBe(false);
    expect(execRes.error).toBe("ADMIN_CANNOT_EXECUTE:DENIED");
  });

  it("enforces one-use fence: executing approved lease twice is rejected with ADMIN_LEASE_ALREADY_CONSUMED", async () => {
    const { issuer } = generateTestIssuer();
    const manager = new AdminApprovalManager(new InMemoryAdminApprovalLedgerStore(), issuer);
    const subject = await controlActorRef(agentActor);
    const policy: NodeGenerationPolicy = {
      generation: "b".repeat(64),
      profile_generation: "sha256:" + "c".repeat(64),
      subject_ref: subject,
      issuer_ids: ["human-issuer-v1"],
    };
    const env = await createTestEnv(policy);

    const res = await requestAdminCommand(manager, agentActor, {
      node_uid: uid,
      work_ref: "work",
      purpose: "purpose",
      command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "a".repeat(64), env: {}, output: "discard" },
      rollback_ref: "rb",
    });

    await manager.approveRequest(humanActor, res.request_id, policy);

    // Mock dependencies for execute
    const connect = vi.fn(async () => ({ close: async () => {}, closed: Promise.resolve() } as never));
    const execute = vi.fn(async () => {
      const record = await manager.getRequest(res.request_id);
      const receipt = {
        schema: "ghostfleet-approved-admin-receipt/v1",
        lease_id: record!.lease!.lease_id,
        request_id: record!.request_id,
        operation_id: record!.lease!.operation_id,
        node_uid: uid,
        actor_ref: subject,
        lease_digest: record!.lease!.lease_digest,
        command_digest: "e".repeat(64),
        state: "SUCCEEDED",
        duplicate: false,
        retry_safe: false,
        reconcile_required: false,
        exit_code: 0,
        execution_privilege: "root",
        output: "discarded",
        persistent_effects_rolled_back: false,
        code: null,
      };
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, receipt }), stderr: "", truncated: false };
    });

    // First execution succeeds
    const firstExec = await executeAdminCommand(manager, env, agentActor, res.request_id, { connect, execute });
    expect(firstExec.ok).toBe(true);
    expect(firstExec.execution?.outcome).toBe("SUCCEEDED");

    // Second execution must be blocked by the one-use ledger fence
    const secondExec = await executeAdminCommand(manager, env, agentActor, res.request_id, { connect, execute });
    expect(secondExec.ok).toBe(false);
    expect(secondExec.error).toBe("ADMIN_LEASE_ALREADY_CONSUMED");
  });

  it("cancelling an approved command transitions to CANCELLED and dispatches remote cancel", async () => {
    const { issuer } = generateTestIssuer();
    const manager = new AdminApprovalManager(new InMemoryAdminApprovalLedgerStore(), issuer);
    const subject = await controlActorRef(agentActor);
    const policy: NodeGenerationPolicy = {
      generation: "b".repeat(64),
      profile_generation: "sha256:" + "c".repeat(64),
      subject_ref: subject,
      issuer_ids: ["human-issuer-v1"],
    };
    const env = await createTestEnv(policy);

    const res = await requestAdminCommand(manager, agentActor, {
      node_uid: uid,
      work_ref: "work",
      purpose: "purpose",
      command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "a".repeat(64), env: {}, output: "discard" },
      rollback_ref: "rb",
    });

    await manager.approveRequest(humanActor, res.request_id, policy);

    const connect = vi.fn(async () => ({ close: async () => {}, closed: Promise.resolve() } as never));
    const execute = vi.fn(async () => {
      const record = await manager.getRequest(res.request_id);
      const receipt = {
        schema: "ghostfleet-approved-admin-receipt/v1",
        lease_id: record!.lease!.lease_id,
        request_id: record!.request_id,
        operation_id: record!.lease!.operation_id,
        node_uid: uid,
        actor_ref: subject,
        lease_digest: record!.lease!.lease_digest,
        command_digest: "e".repeat(64),
        state: "REVOKED",
        duplicate: false,
        retry_safe: false,
        reconcile_required: false,
        exit_code: null,
        execution_privilege: null,
        output: "discarded",
        persistent_effects_rolled_back: false,
        code: null,
      };
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, receipt }), stderr: "", truncated: false };
    });

    const cancelRes = await cancelAdminCommand(manager, env, agentActor, res.request_id, "User requested cancel", { connect, execute });
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.state).toBe("CANCELLED");

    const record = await manager.getRequest(res.request_id);
    expect(record?.state).toBe("CANCELLED");
  });

  it("dispatches all tool calls cleanly through dispatchAdminToolCall", async () => {
    const { issuer } = generateTestIssuer();
    const manager = new AdminApprovalManager(new InMemoryAdminApprovalLedgerStore(), issuer);
    const subject = await controlActorRef(agentActor);
    const policy: NodeGenerationPolicy = {
      generation: "b".repeat(64),
      profile_generation: "sha256:" + "c".repeat(64),
      subject_ref: subject,
      issuer_ids: ["human-issuer-v1"],
    };
    const env = await createTestEnv(policy);
    const ctx = { manager, env, actor: agentActor };

    // 1. Tool call: request
    const reqRes = await dispatchAdminToolCall("fleet_admin_request_command", {
      node_uid: uid,
      work_ref: "work",
      purpose: "purpose",
      command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "b".repeat(64) },
      rollback_ref: "rb",
    }, ctx);
    expect(reqRes.ok).toBe(true);
    const reqId = reqRes.request_id as string;

    // 2. Tool call: status
    const statusRes = await dispatchAdminToolCall("fleet_admin_command_status", { request_id: reqId }, ctx);
    expect(statusRes.ok).toBe(true);
    expect(statusRes.state).toBe("PENDING");

    // 3. Tool call: cancel
    const cancelRes = await dispatchAdminToolCall("fleet_admin_command_cancel", { request_id: reqId, reason: "Testing tool dispatch" }, ctx);
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.state).toBe("CANCELLED");

    // 4. Unknown tool returns error
    const unknownRes = await dispatchAdminToolCall("fleet_admin_unknown_tool", {}, ctx);
    expect(unknownRes.ok).toBe(false);
    expect(unknownRes.error).toContain("UNKNOWN_ADMIN_TOOL");
  });
});
