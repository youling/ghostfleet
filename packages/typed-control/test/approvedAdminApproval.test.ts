import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile, readFile, stat, mkdir, unlink, symlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

import {
  AdminApprovalManager,
  FileAdminApprovalLedgerStore,
  InMemoryAdminApprovalLedgerStore,
  REQUEST_ID_RE,
  isProcessAlive,
  type TrustedIssuerPort,
  type NodeGenerationPolicy,
  type AdminApprovalRecord,
} from "../src/approvedAdminApproval.js";
import {
  requestAdminCommand,
  getAdminCommandStatus,
  executeAdminCommand,
  cancelAdminCommand,
} from "../src/approvedAdminConsumer.js";
import { type ControlActor, controlActorRef, PRIVILEGED_APPROVE_SCOPE } from "../src/controlPolicy.js";
import { type ApprovedAdminEnvironment, type PrivilegedDependencies } from "../src/approvedAdminCommand.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uid = ["node", "00000000", "0000", "4000", "8000", "000000000001"].join("-");
const agentActor: ControlActor = { userId: "agent-caller", scopes: ["fleet.privileged"], authKind: "oauth" };
const humanActor: ControlActor = {
  userId: "operator-alice",
  scopes: ["fleet.privileged", PRIVILEGED_APPROVE_SCOPE],
  roles: ["human-approver"],
  authKind: "oauth",
};

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

function createTestEnv(policy: NodeGenerationPolicy): ApprovedAdminEnvironment {
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

describe("Architect R4 Remediation: approvedAdminApproval unit & integration tests", () => {
  // --------------------------------------------------------------------------
  // Fix 1: Lease ID & Operation ID 128-bit Entropy Collision Prevention
  // --------------------------------------------------------------------------
  describe("Fix 1: Lease ID & Operation ID 128-bit Entropy Collision Prevention", () => {
    it("prevents lease_id and operation_id collision with 128-bit entropy when approving identical commands in same second", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const commandPayload = {
        argv: ["/usr/bin/systemctl", "restart", "ghostfleet-service"],
        cwd: "/etc/ghostfleet",
        executable_sha256: "a".repeat(64),
        env: {},
        output: "discard" as const,
      };

      // Submit two requests with identical command payload and identical work ref
      const req1 = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/restart-service#101",
        purpose: "Restart service identical command A",
        command: commandPayload,
        rollback_ref: "ops/rollback#101",
      });

      const req2 = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/restart-service#101",
        purpose: "Restart service identical command B",
        command: commandPayload,
        rollback_ref: "ops/rollback#101",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };

      // Approve both requests (executed within milliseconds, same second)
      const approved1 = await manager.approveRequest(humanActor, req1.request_id, policy);
      const approved2 = await manager.approveRequest(humanActor, req2.request_id, policy);

      expect(approved1.lease).toBeDefined();
      expect(approved2.lease).toBeDefined();

      // Verify lease IDs and operation IDs are distinct
      expect(approved1.lease!.lease_id).not.toBe(approved2.lease!.lease_id);
      expect(approved1.lease!.operation_id).not.toBe(approved2.lease!.operation_id);

      // Verify format includes timestamp, 32 hex chars (16 bytes = 128-bit entropy), and 8 hex chars command digest
      const leaseIdPattern = /^lease-[0-9]+-[0-9a-f]{32}-[0-9a-f]{8}$/;
      const opIdPattern = /^op-[0-9]+-[0-9a-f]{32}-[0-9a-f]{8}$/;

      expect(approved1.lease!.lease_id).toMatch(leaseIdPattern);
      expect(approved2.lease!.lease_id).toMatch(leaseIdPattern);
      expect(approved1.lease!.operation_id).toMatch(opIdPattern);
      expect(approved2.lease!.operation_id).toMatch(opIdPattern);

      // Verify command digest suffix is identical (since command is identical) but 128-bit random entropy differs
      const leaseParts1 = approved1.lease!.lease_id.split("-");
      const leaseParts2 = approved2.lease!.lease_id.split("-");
      expect(leaseParts1[3]).toBe(leaseParts2[3]); // identical command digest slice(0, 8)
      expect(leaseParts1[2]).not.toBe(leaseParts2[2]); // unique cryptographic entropy
      expect(leaseParts1[2].length).toBe(32); // 128-bit entropy = 32 hex chars
    });
  });

  // --------------------------------------------------------------------------
  // Fix 2: Status Query After CONSUMED State & Receipt Consistency
  // --------------------------------------------------------------------------
  describe("Fix 2: Status Query After CONSUMED State & Consistency Check", () => {
    it("recordDispatchOutcome is idempotent on already-CONSUMED record when receiving same receipt", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/reboot#201",
        purpose: "Status idempotence test",
        command: { argv: ["/usr/bin/uptime"], cwd: "/", executable_sha256: "b".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#201",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };

      await manager.approveRequest(humanActor, req.request_id, policy);
      const callerRef = await controlActorRef(agentActor);
      await manager.markDispatched(callerRef, req.request_id);

      // Record first dispatch outcome -> transitions to CONSUMED
      const firstOutcome = await manager.recordDispatchOutcome(callerRef, req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { exit_code: 0, stdout: "up 5 days" },
      });
      expect(firstOutcome.state).toBe("CONSUMED");
      expect(firstOutcome.reconcile_required).toBe(false);

      // Call recordDispatchOutcome AGAIN with matching outcome
      const secondOutcome = await manager.recordDispatchOutcome(callerRef, req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { exit_code: 0, stdout: "up 5 days" },
      });
      expect(secondOutcome.state).toBe("CONSUMED");
      expect(secondOutcome.reconcile_required).toBe(false);
      expect(secondOutcome.execution_receipt).toEqual({ exit_code: 0, stdout: "up 5 days" });
    });

    it("MUST-4: detects contradictory receipts in CONSUMED state, preserves initial evidence and sets reconcile_required", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/conflict#204",
        purpose: "Contradictory receipt test",
        command: { argv: ["/usr/bin/uptime"], cwd: "/", executable_sha256: "b".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#204",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };

      await manager.approveRequest(humanActor, req.request_id, policy);
      const callerRef = await controlActorRef(agentActor);
      await manager.markDispatched(callerRef, req.request_id);

      // Initial execution report: SUCCEEDED
      const initial = await manager.recordDispatchOutcome(callerRef, req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { exit_code: 0, stdout: "initial success" },
      });
      expect(initial.state).toBe("CONSUMED");
      expect(initial.dispatch_state).toBe("SUCCEEDED");
      expect(initial.reconcile_required).toBe(false);

      // Now a contradictory receipt arrives: FAILED
      const conflicted = await manager.recordDispatchOutcome(callerRef, req.request_id, {
        outcome: "FAILED",
        receipt: { exit_code: 1, stderr: "conflict error" },
        error: "PROCESS_FAILED",
      });

      // Assert initial evidence is NOT silently overwritten
      expect(conflicted.state).toBe("CONSUMED");
      expect(conflicted.dispatch_state).toBe("SUCCEEDED");
      expect(conflicted.execution_receipt).toEqual({ exit_code: 0, stdout: "initial success" });

      // Assert reconcile_required is set and conflict evidence is audited
      expect(conflicted.reconcile_required).toBe(true);
      expect(conflicted.conflicting_dispatch_outcome).toBeDefined();
      expect(conflicted.conflicting_dispatch_outcome?.outcome).toBe("FAILED");
      expect(conflicted.conflicting_dispatch_outcome?.receipt).toEqual({ exit_code: 1, stderr: "conflict error" });
    });

    it("reconcileFromStatus cleanly updates CONSUMED record on SUCCEEDED receipt without throwing", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/reconcile#202",
        purpose: "Status reconciliation test",
        command: { argv: ["/usr/bin/uptime"], cwd: "/", executable_sha256: "b".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#202",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };

      await manager.approveRequest(humanActor, req.request_id, policy);
      const callerRef = await controlActorRef(agentActor);
      await manager.markDispatched(callerRef, req.request_id);
      await manager.recordDispatchOutcome(callerRef, req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { state: "SUCCEEDED", exit_code: 0 },
      });

      // Status query triggers reconcileFromStatus on already-CONSUMED record
      const reconciled = await manager.reconcileFromStatus(req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { state: "SUCCEEDED" },
      });

      expect(reconciled).not.toBeNull();
      expect(reconciled?.state).toBe("CONSUMED");
      expect(reconciled?.reconcile_required).toBe(false);
    });

    it("getAdminCommandStatus queries and returns cleanly when record is in CONSUMED state", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };
      const env = createTestEnv(policy);

      const reqRes = await requestAdminCommand(manager, agentActor, {
        node_uid: uid,
        work_ref: "ops/status-consumed#203",
        purpose: "Consumer status query test",
        command: { argv: ["/usr/bin/uptime"], cwd: "/", executable_sha256: "b".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#203",
      });

      await manager.approveRequest(humanActor, reqRes.request_id, policy);
      const approved = await manager.getRequest(reqRes.request_id);
      const subject = await controlActorRef(agentActor);

      const receipt = {
        schema: "ghostfleet-approved-admin-receipt/v1",
        lease_id: approved!.lease!.lease_id,
        request_id: approved!.request_id,
        operation_id: approved!.lease!.operation_id,
        node_uid: uid,
        actor_ref: subject,
        lease_digest: approved!.lease!.lease_digest,
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

      const deps: PrivilegedDependencies = {
        connect: async () => ({ close: async () => {}, closed: Promise.resolve() } as never),
        execute: async () => ({ exit_code: 0, stdout: JSON.stringify({ ok: true, receipt }), stderr: "", truncated: false }),
      };

      // Execute command -> transitions to CONSUMED
      const execRes = await executeAdminCommand(manager, env, agentActor, reqRes.request_id, deps);
      expect(execRes.ok).toBe(true);
      expect(execRes.state).toBe("CONSUMED");

      // Now query status on the CONSUMED record
      const statusRes = await getAdminCommandStatus(manager, env, agentActor, reqRes.request_id, deps);
      expect(statusRes.ok).toBe(true);
      expect(statusRes.state).toBe("CONSUMED");
      expect(statusRes.reconcile_required).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Fix 3: Reverse Execute / Cancel Race & Clarity in Status Query
  // --------------------------------------------------------------------------
  describe("Fix 3: Reverse Execute / Cancel Race", () => {
    it("MUST-3: safely records delayed execution on CANCELLED record, sets reconcile_required, and exposes effect", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/cancel-race#301",
        purpose: "Reverse cancel/execute race test",
        command: { argv: ["/usr/bin/sleep", "10"], cwd: "/", executable_sha256: "c".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#301",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };

      await manager.approveRequest(humanActor, req.request_id, policy);
      const callerRef = await controlActorRef(agentActor);
      await manager.markDispatched(callerRef, req.request_id);

      // Step 1: Cancellation is requested
      await manager.requestCancellation(agentActor, req.request_id, "Operator initiated abort");

      // Step 2: Remote cancellation is confirmed -> state becomes CANCELLED
      const confirmed = await manager.confirmCancellation(req.request_id, callerRef, { state: "REVOKED" });
      expect(confirmed.state).toBe("CANCELLED");

      // Step 3: Delayed execution receipt arrives afterward (reverse race!)
      const lateOutcome = await manager.recordDispatchOutcome(callerRef, req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { exit_code: 0, stdout: "Command actually finished right before cancel took effect" },
      });

      // Verify state is NOT overwritten to CONSUMED
      expect(lateOutcome.state).toBe("CANCELLED");

      // MUST-3: reconcile_required MUST be true because command took effect despite cancellation
      expect(lateOutcome.reconcile_required).toBe(true);

      // Verify that late execution was safely audited
      expect(lateOutcome.late_dispatch_outcome).toBeDefined();
      expect(lateOutcome.late_dispatch_outcome?.outcome).toBe("SUCCEEDED");
      expect(lateOutcome.late_dispatch_outcome?.receipt).toEqual({
        exit_code: 0,
        stdout: "Command actually finished right before cancel took effect",
      });
      expect(typeof lateOutcome.late_dispatch_outcome?.recorded_at).toBe("number");

      // Consumer getAdminCommandStatus exposes actual effect to avoid misleading user
      const env = createTestEnv(policy);
      const statusRes = await getAdminCommandStatus(manager, env, agentActor, req.request_id);
      expect(statusRes.state).toBe("CANCELLED");
      expect(statusRes.reconcile_required).toBe(true);
      expect(statusRes.actual_execution_outcome).toBe("SUCCEEDED");
      expect(statusRes.effect_summary).toContain("COMMAND_EFFECT_EXECUTED_DESPITE_CANCELLATION");
    });

    it("reconcileFromStatus audits late SUCCEEDED receipt on CANCELLED record and sets reconcile_required", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/cancel-race#302",
        purpose: "Reverse cancel reconcile test",
        command: { argv: ["/usr/bin/sleep", "10"], cwd: "/", executable_sha256: "c".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#302",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };

      await manager.approveRequest(humanActor, req.request_id, policy);
      const callerRef = await controlActorRef(agentActor);
      await manager.confirmCancellation(req.request_id, callerRef);

      // Reconcile with late status receipt
      const result = await manager.reconcileFromStatus(req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { state: "SUCCEEDED" },
      });

      expect(result?.state).toBe("CANCELLED");
      expect(result?.reconcile_required).toBe(true);
      expect(result?.late_dispatch_outcome).toBeDefined();
      expect(result?.late_dispatch_outcome?.outcome).toBe("SUCCEEDED");
    });

    it("confirmCancellation is idempotent when invoked repeatedly on already-CANCELLED record", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/cancel-idempotent#303",
        purpose: "Confirm cancel idempotence",
        command: { argv: ["/usr/bin/true"], cwd: "/", executable_sha256: "c".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#303",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
      };

      await manager.approveRequest(humanActor, req.request_id, policy);
      const callerRef = await controlActorRef(agentActor);

      const cancel1 = await manager.confirmCancellation(req.request_id, callerRef, { rev: 1 });
      expect(cancel1.state).toBe("CANCELLED");

      const cancel2 = await manager.confirmCancellation(req.request_id, callerRef, { rev: 2 });
      expect(cancel2.state).toBe("CANCELLED");
    });
  });

  // --------------------------------------------------------------------------
  // Fix 4: File Ledger Security, Durability & True Multi-Process Concurrency
  // --------------------------------------------------------------------------
  describe("Fix 4: File Ledger Security, Durability & True Multi-Process Concurrency", () => {
    it("MUST-1: strictly validates request_id with regex and rejects path traversal attempts", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-path-traversal-test-"));
      try {
        const store = new FileAdminApprovalLedgerStore(tmp);

        const maliciousIds = [
          "../evil",
          "../../etc/passwd",
          "req-123/evil",
          "req-123\\evil",
          "req-123\0evil",
          "req-12345",
          "not-a-valid-request-id",
          "req-abc-def-ghi",
          "req-1700000000-short-hex",
        ];

        for (const badId of maliciousIds) {
          await expect(store.get(badId)).rejects.toThrow("INVALID_REQUEST_ID");
          await expect(store.compareAndSwap(badId, "PENDING", (r) => r)).rejects.toThrow("INVALID_REQUEST_ID");
        }

        // Legitimate ID matching regex succeeds without throwing INVALID_REQUEST_ID
        const validId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";
        expect(REQUEST_ID_RE.test(validId)).toBe(true);
        const res = await store.get(validId);
        expect(res).toBeNull();
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("MUST-1: rejects symlinked directory paths for ledger store", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-symlink-dir-test-"));
      try {
        const realTarget = path.join(tmp, "real-store");
        await mkdir(realTarget, { recursive: true });
        const symlinkDir = path.join(tmp, "symlink-store");

        try {
          await symlink(realTarget, symlinkDir, "junction");
        } catch {
          // If platform lacks symlink/junction privileges, skip gracefully
          return;
        }

        const store = new FileAdminApprovalLedgerStore(symlinkDir);
        await expect(store.get("req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef")).rejects.toThrow(
          "ADMIN_STORE_INSECURE_PATH",
        );
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("MUST-1: rejects store directory with 0777 permissions or world-writable ancestor without sticky bit", async () => {
      if (process.platform === "win32") {
        return;
      }
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-perm-test-"));
      try {
        // Storage directory itself with 0777 (group- and world-writable)
        const insecureDir = path.join(tmp, "insecure-store");
        await mkdir(insecureDir, { recursive: true, mode: 0o777 });
        await chmod(insecureDir, 0o777);

        const store = new FileAdminApprovalLedgerStore(insecureDir);
        await expect(store.get("req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef")).rejects.toThrow(
          "ADMIN_STORE_INSECURE_PERMISSIONS",
        );

        // Ancestor directory with 0777 (world-writable without sticky bit)
        const insecureAncestor = path.join(tmp, "insecure-parent");
        await mkdir(insecureAncestor, { recursive: true, mode: 0o777 });
        await chmod(insecureAncestor, 0o777);
        const childStore = path.join(insecureAncestor, "child-store");

        const store2 = new FileAdminApprovalLedgerStore(childStore);
        await expect(store2.get("req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef")).rejects.toThrow(
          "ADMIN_STORE_INSECURE_PERMISSIONS",
        );

        // Ancestor directory with 01777 (world-writable WITH sticky bit, e.g. /tmp) is allowed
        const stickyAncestor = path.join(tmp, "sticky-parent");
        await mkdir(stickyAncestor, { recursive: true, mode: 0o1777 });
        await chmod(stickyAncestor, 0o1777);
        const stickyChildStore = path.join(stickyAncestor, "child-store");

        const store3 = new FileAdminApprovalLedgerStore(stickyChildStore);
        const validId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";
        const res = await store3.get(validId);
        expect(res).toBeNull();
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("MUST-2: safe lock release verifies nonce and does not unlink competitor lock if overwritten", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-lock-nonce-test-"));
      try {
        const store = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";

        // Process 1 acquires lock
        const release1 = await (store as any).acquireFileLock(reqId, 5000);
        const lockPath = path.join(tmp, `${reqId}.lock`);

        // Simulate that while Process 1 was executing, another process took over the lock with a different nonce
        const competitorNonce = "competitor-nonce-1234567890abcdef";
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, time: Date.now(), nonce: competitorNonce }), "utf8");

        // Process 1 attempts to release its lock
        await release1();

        // The lock file MUST STILL EXIST because nonce did not match!
        const contentAfter = await readFile(lockPath, "utf8");
        const metaAfter = JSON.parse(contentAfter);
        expect(metaAfter.nonce).toBe(competitorNonce);

        // Clean up competitor lock manually
        await unlink(lockPath).catch(() => {});
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("safe lock timeout: preserves active locks held by living processes and rejects without unlinking", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-active-lock-test-"));
      try {
        const store = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";

        // Create an active lock owned by our own living PID
        const lockPath = path.join(tmp, `${reqId}.lock`);
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "active-nonce" }), "utf8");

        // isProcessAlive returns true for process.pid
        expect(isProcessAlive(process.pid)).toBe(true);

        // Attempting to acquire lock with short timeout (100ms) should timeout and NOT unlink the active lock
        await expect((store as any).acquireFileLock(reqId, 100)).rejects.toThrow(/ADMIN_STORE_LOCK_TIMEOUT/);

        // The lock file MUST still exist because the process holding it is ALIVE
        const lockStillExists = await stat(lockPath).then(() => true).catch(() => false);
        expect(lockStillExists).toBe(true);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("safe lock timeout: acquireFileLock times out without unlinking stale lock (no auto-reaping in request path)", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-stale-lock-test-"));
      try {
        const store = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";

        // Write a lock file with a non-existent dead PID (e.g. 999999)
        const deadPid = 999999;
        expect(isProcessAlive(deadPid)).toBe(false);

        const lockPath = path.join(tmp, `${reqId}.lock`);
        const lockContent = JSON.stringify({ pid: deadPid, time: Date.now() - 30000, nonce: "stale-nonce" });
        await writeFile(lockPath, lockContent, "utf8");

        // Attempting to acquire lock with short timeout (50ms) times out and MUST NOT unlink the stale lock!
        await expect((store as any).acquireFileLock(reqId, 50)).rejects.toThrow(/ADMIN_STORE_LOCK_TIMEOUT/);

        // Verify the lock file was NOT unlinked
        const contentAfter = await readFile(lockPath, "utf8");
        expect(contentAfter).toBe(lockContent);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("two-competitor timeout and new living lock interleaving: timed-out competitors never unlink a newly acquired living lock", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-interleaved-lock-test-"));
      try {
        const store1 = new FileAdminApprovalLedgerStore(tmp);
        const store2 = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";
        const lockPath = path.join(tmp, `${reqId}.lock`);

        // Competitor 1 and Competitor 2 both try to acquire lock concurrently while initial lock exists
        await writeFile(lockPath, JSON.stringify({ pid: 999999, time: Date.now(), nonce: "initial-dead" }), "utf8");

        // Both store1 and store2 attempt to acquire with 50ms timeout
        const p1 = (store1 as any).acquireFileLock(reqId, 50);
        const p2 = (store2 as any).acquireFileLock(reqId, 50);

        // Both must timeout with ADMIN_STORE_LOCK_TIMEOUT and NOT unlink the lock
        // Await concurrently with Promise.all to avoid unhandled rejection if p2 rejects while awaiting p1
        await Promise.all([
          expect(p1).rejects.toThrow(/ADMIN_STORE_LOCK_TIMEOUT/),
          expect(p2).rejects.toThrow(/ADMIN_STORE_LOCK_TIMEOUT/),
        ]);

        // Now operator explicitly recovers the stale lock
        const recovered = await store1.recoverStaleLock(reqId);
        expect(recovered).toBe(true);

        // A new process A acquires a fresh active lock with its own nonce
        const releaseA = await (store1 as any).acquireFileLock(reqId, 5000);
        const lockContentA = await readFile(lockPath, "utf8");
        const metaA = JSON.parse(lockContentA);
        expect(metaA.pid).toBe(process.pid);

        // Even if competitor 2 runs another attempt or has delayed timeout handling,
        // it cannot unlink Process A's new living lock
        await expect((store2 as any).acquireFileLock(reqId, 50)).rejects.toThrow(/ADMIN_STORE_LOCK_TIMEOUT/);

        // Verify Process A's lock is completely intact
        const lockContentAfter = await readFile(lockPath, "utf8");
        const metaAfter = JSON.parse(lockContentAfter);
        expect(metaAfter.nonce).toBe(metaA.nonce);
        expect(metaAfter.pid).toBe(process.pid);

        // Process A releases cleanly
        await releaseA();
        const lockExists = await stat(lockPath).then(() => true).catch(() => false);
        expect(lockExists).toBe(false);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("recoverStaleLock: safely clears locks from dead processes and protects locks from active processes", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-recover-lock-test-"));
      try {
        const store = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";
        const lockPath = path.join(tmp, `${reqId}.lock`);

        // Case 1: No lock file exists -> returns false
        const resEmpty = await store.recoverStaleLock(reqId);
        expect(resEmpty).toBe(false);

        // Case 2: Lock held by an ACTIVE living process -> throws LOCKED_BY_ACTIVE_PROCESS
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "living-nonce" }), "utf8");
        await expect(store.recoverStaleLock(reqId)).rejects.toThrow(/LOCKED_BY_ACTIVE_PROCESS/);

        // Lock file must still exist
        expect(await stat(lockPath).then(() => true).catch(() => false)).toBe(true);

        // Case 3: Lock held by a DEAD process -> successfully unlinks and returns true
        const deadPid = 999999;
        expect(isProcessAlive(deadPid)).toBe(false);
        await writeFile(lockPath, JSON.stringify({ pid: deadPid, time: Date.now() - 60000, nonce: "dead-nonce" }), "utf8");

        const resRecovered = await store.recoverStaleLock(reqId);
        expect(resRecovered).toBe(true);
        expect(await stat(lockPath).then(() => true).catch(() => false)).toBe(false);

        // After recovery, normal creation succeeds
        await store.create({
          version: 1,
          request_id: reqId,
          node_uid: uid,
          actor_ref: "act",
          requester_user_id: "usr",
          work_ref: "wrk",
          purpose: "pur",
          command: { argv: ["echo"], cwd: "/", env: {}, executable_sha256: "0".repeat(64), output: "discard" },
          rollback_ref: "rb",
          approval_ref: "app",
          max_runtime_seconds: 30,
          ttl_seconds: 300,
          created_at: 1700000000,
          expires_at: 1700000300,
          state: "PENDING",
        });
        const rec = await store.get(reqId);
        expect(rec?.state).toBe("PENDING");
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("real multi-process concurrency: serializes concurrent CAS across separate OS child processes", async () => {
      const distPath = path.resolve(__dirname, "../dist/approvedAdminApproval.js");
      if (!existsSync(distPath)) {
        execSync("npm run build", { cwd: path.resolve(__dirname, ".."), stdio: "ignore" });
      }

      const tmp = await mkdtemp(path.join(tmpdir(), "gf-multi-process-cas-test-"));
      try {
        const distUrl = pathToFileURL(distPath).href;
        const store = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";

        await store.create({
          version: 1,
          request_id: reqId,
          node_uid: uid,
          actor_ref: "act",
          requester_user_id: "usr",
          work_ref: "wrk",
          purpose: "pur",
          command: { argv: ["echo"], cwd: "/", env: {}, executable_sha256: "0".repeat(64), output: "discard" },
          rollback_ref: "rb",
          approval_ref: "app",
          max_runtime_seconds: 30,
          ttl_seconds: 300,
          created_at: 1700000000,
          expires_at: 1700000300,
          state: "PENDING",
        });

        // Script executed by distinct Node.js child OS processes
        const childCode = `
          import { pathToFileURL } from "node:url";
          const distUrl = "${distUrl}";
          const tmp = process.argv[1];
          const reqId = process.argv[2];
          const targetState = process.argv[3];
          const { FileAdminApprovalLedgerStore } = await import(distUrl);
          const store = new FileAdminApprovalLedgerStore(tmp);
          try {
            await store.compareAndSwap(reqId, "PENDING", (r) => {
              r.state = targetState;
              return r;
            });
            process.stdout.write("SUCCESS:" + targetState);
          } catch (err) {
            process.stdout.write("FAIL:" + (err.message || String(err)));
          }
        `;

        // 4 concurrent child processes competing to transition from PENDING
        const candidates = ["APPROVED", "DENIED", "CANCELLED", "EXPIRED"];
        const promises = candidates.map((targetState) =>
          execFileAsync(process.execPath, ["--input-type=module", "-e", childCode, tmp, reqId, targetState]),
        );

        const results = await Promise.all(promises);
        const outputs = results.map((r) => r.stdout.trim());

        const successes = outputs.filter((o) => o.startsWith("SUCCESS:"));
        const failures = outputs.filter((o) => o.startsWith("FAIL:ADMIN_CAS_STATE_MISMATCH"));

        // Exactly ONE process must have won the CAS race
        expect(successes.length).toBe(1);
        // The other 3 processes must have received CAS state mismatch
        expect(failures.length).toBe(3);

        // Verify the persisted record on disk reflects the winning process's state and version incremented to 2
        const winningState = successes[0].replace("SUCCESS:", "");
        const finalRecord = await store.get(reqId);
        expect(finalRecord?.state).toBe(winningState);
        expect(finalRecord?.version).toBe(2);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Fix 5: Node Approval Scope & Human Architecture Ruling
  // --------------------------------------------------------------------------
  describe("Fix 5: Node Approval Scope & Human Ruling", () => {
    it("enforces allowed_approvers when configured, but does not block universal admin channel when omitted or empty", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/node-scope#501",
        purpose: "Universal admin approver test",
        command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "d".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#501",
      });

      // 1. Specific allowed approver: unauthorized approver fails
      const policyRestricted: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_approvers: ["operator-charlie"],
      };
      await expect(manager.approveRequest(humanActor, req.request_id, policyRestricted)).rejects.toThrow(
        "APPROVER_NOT_AUTHORIZED_FOR_NODE",
      );

      // 2. Empty allowed_approvers: Human ruling - does NOT fail closed, allows universal admin channel
      const policyEmptyApprovers: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_approvers: [],
      };
      const approved = await manager.approveRequest(humanActor, req.request_id, policyEmptyApprovers);
      expect(approved.state).toBe("APPROVED");
    });

    it("enforces allowed_work_prefixes when configured, but does not block universal admin channel when omitted or empty", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/node-scope#502",
        purpose: "Universal admin work ref test",
        command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "d".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#502",
      });

      // 1. Non-matching prefix: fails
      const policyMismatchedWork: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_work_prefixes: ["youling/ai-hub#"],
      };
      await expect(manager.approveRequest(humanActor, req.request_id, policyMismatchedWork)).rejects.toThrow(
        "WORK_REF_NOT_AUTHORIZED_FOR_NODE",
      );

      // 2. Empty allowed_work_prefixes: Human ruling - work_ref acts as audit context, not a hard blocking whitelist
      const policyEmptyWork: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_work_prefixes: [],
      };
      const approved = await manager.approveRequest(humanActor, req.request_id, policyEmptyWork);
      expect(approved.state).toBe("APPROVED");
    });

    it("enforces approver cannot be requester", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      // User submits their own request
      const req = await manager.submitRequest(humanActor, {
        node_uid: uid,
        work_ref: "ops/self-approval#503",
        purpose: "Self-approval rejection test",
        command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "d".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#503",
      });

      const policy: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(humanActor),
        issuer_ids: ["human-issuer-v1"],
      };

      // Same user attempts to approve their own request
      await expect(manager.approveRequest(humanActor, req.request_id, policy)).rejects.toThrow(
        "APPROVER_CANNOT_BE_REQUESTER",
      );
    });

    it("rejects unauthorized issuer for node generation policy", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer(); // issuerId: human-issuer-v1
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/issuer-check#504",
        purpose: "Issuer authorization test",
        command: { argv: ["/usr/bin/id"], cwd: "/", executable_sha256: "d".repeat(64), env: {}, output: "discard" },
        rollback_ref: "ops/rb#504",
      });

      const policyWrongIssuer: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["other-issuer-id"],
      };

      await expect(manager.approveRequest(humanActor, req.request_id, policyWrongIssuer)).rejects.toThrow(
        "ADMIN_ISSUER_NOT_AUTHORIZED_FOR_NODE",
      );
    });
  });
});
