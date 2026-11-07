import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
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

describe("Architect R3 Remediation: approvedAdminApproval unit & integration tests", () => {
  // --------------------------------------------------------------------------
  // Fix 1: Lease ID & Operation ID Collision Prevention
  // --------------------------------------------------------------------------
  describe("Fix 1: Lease ID & Operation ID Collision Prevention", () => {
    it("prevents lease_id and operation_id collision when approving identical commands within the same second", async () => {
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

      // Verify format includes timestamp, 16 hex chars (8 bytes) entropy, and 8 hex chars command digest
      const leaseIdPattern = /^lease-[0-9]+-[0-9a-f]{16}-[0-9a-f]{8}$/;
      const opIdPattern = /^op-[0-9]+-[0-9a-f]{16}-[0-9a-f]{8}$/;

      expect(approved1.lease!.lease_id).toMatch(leaseIdPattern);
      expect(approved2.lease!.lease_id).toMatch(leaseIdPattern);
      expect(approved1.lease!.operation_id).toMatch(opIdPattern);
      expect(approved2.lease!.operation_id).toMatch(opIdPattern);

      // Verify command digest suffix is identical (since command is identical) but random entropy differs
      const leaseParts1 = approved1.lease!.lease_id.split("-");
      const leaseParts2 = approved2.lease!.lease_id.split("-");
      expect(leaseParts1[3]).toBe(leaseParts2[3]); // identical command digest slice(0, 8)
      expect(leaseParts1[2]).not.toBe(leaseParts2[2]); // unique cryptographic entropy
    });
  });

  // --------------------------------------------------------------------------
  // Fix 2: Status Query After CONSUMED State (Idempotence & No CAS Mismatch)
  // --------------------------------------------------------------------------
  describe("Fix 2: Status Query After CONSUMED State", () => {
    it("recordDispatchOutcome is idempotent on already-CONSUMED record without ADMIN_CAS_STATE_MISMATCH", async () => {
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

      // Call recordDispatchOutcome AGAIN (simulating duplicate receipt arrival or status reconciliation)
      const secondOutcome = await manager.recordDispatchOutcome(callerRef, req.request_id, {
        outcome: "SUCCEEDED",
        receipt: { exit_code: 0, stdout: "up 5 days" },
      });
      expect(secondOutcome.state).toBe("CONSUMED");
      expect(secondOutcome.reconcile_required).toBe(false);
      expect(secondOutcome.execution_receipt).toEqual({ exit_code: 0, stdout: "up 5 days" });
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
  // Fix 3: Reverse Execute / Cancel Race
  // --------------------------------------------------------------------------
  describe("Fix 3: Reverse Execute / Cancel Race", () => {
    it("safely records delayed execution on confirmed CANCELLED record without state corruption or crash", async () => {
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

      // Verify that recordDispatchOutcome did not crash with ADMIN_CAS_STATE_MISMATCH
      // and state is NOT overwritten to CONSUMED
      expect(lateOutcome.state).toBe("CANCELLED");

      // Verify that late execution was safely audited
      expect(lateOutcome.late_dispatch_outcome).toBeDefined();
      expect(lateOutcome.late_dispatch_outcome?.outcome).toBe("SUCCEEDED");
      expect(lateOutcome.late_dispatch_outcome?.receipt).toEqual({
        exit_code: 0,
        stdout: "Command actually finished right before cancel took effect",
      });
      expect(typeof lateOutcome.late_dispatch_outcome?.recorded_at).toBe("number");
    });

    it("reconcileFromStatus audits late SUCCEEDED receipt on CANCELLED record", async () => {
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
    it("strictly validates request_id with regex and rejects path traversal attempts", async () => {
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

    it("safe lock timeout: preserves active locks held by living processes and rejects without unlinking", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-active-lock-test-"));
      try {
        const store = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";

        // Create an active lock owned by our own living PID
        const lockPath = path.join(tmp, `${reqId}.lock`);
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");

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

    it("safe lock timeout: automatically cleans up stale locks from dead processes and succeeds", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "gf-stale-lock-test-"));
      try {
        const store = new FileAdminApprovalLedgerStore(tmp);
        const reqId = "req-1700000000-0123456789abcdef0123456789abcdef-0123456789abcdef";

        // Write a lock file with a non-existent dead PID (e.g. 999999)
        const deadPid = 999999;
        expect(isProcessAlive(deadPid)).toBe(false);

        const lockPath = path.join(tmp, `${reqId}.lock`);
        await writeFile(lockPath, JSON.stringify({ pid: deadPid, createdAt: Date.now() - 30000 }), "utf8");

        // Attempting to acquire lock with short timeout (100ms) detects dead PID, clears stale lock, and succeeds
        const release = await (store as any).acquireFileLock(reqId, 100);
        await release();

        // Now creating the record proceeds cleanly
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
        expect(rec).not.toBeNull();
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
  // Fix 5: Node Approval Scope Fail-Closed Semantics
  // --------------------------------------------------------------------------
  describe("Fix 5: Node Approval Scope Fail-Closed Semantics", () => {
    it("fails closed when policy.allowed_approvers is empty or does not include approver", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/node-scope#501",
        purpose: "Fail-closed approver test",
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

      // 2. Empty allowed_approvers: MUST FAIL CLOSED (nobody authorized)
      const policyEmptyApprovers: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_approvers: [],
      };
      await expect(manager.approveRequest(humanActor, req.request_id, policyEmptyApprovers)).rejects.toThrow(
        "APPROVER_NOT_AUTHORIZED_FOR_NODE",
      );

      // 3. Array with only empty/whitespace strings: MUST FAIL CLOSED
      const policyWhitespaceApprovers: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_approvers: ["", "   "],
      };
      await expect(manager.approveRequest(humanActor, req.request_id, policyWhitespaceApprovers)).rejects.toThrow(
        "APPROVER_NOT_AUTHORIZED_FOR_NODE",
      );
    });

    it("fails closed when policy.allowed_work_prefixes is empty or does not match", async () => {
      const store = new InMemoryAdminApprovalLedgerStore();
      const { issuer } = generateTestIssuer();
      const manager = new AdminApprovalManager(store, issuer);

      const req = await manager.submitRequest(agentActor, {
        node_uid: uid,
        work_ref: "ops/node-scope#502",
        purpose: "Fail-closed work prefix test",
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

      // 2. Empty allowed_work_prefixes: MUST FAIL CLOSED
      const policyEmptyWork: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_work_prefixes: [],
      };
      await expect(manager.approveRequest(humanActor, req.request_id, policyEmptyWork)).rejects.toThrow(
        "WORK_REF_NOT_AUTHORIZED_FOR_NODE",
      );

      // 3. Array containing only empty string: MUST NOT permit arbitrary work_ref
      const policyBlankPrefix: NodeGenerationPolicy = {
        generation: "b".repeat(64),
        profile_generation: "sha256:" + "c".repeat(64),
        subject_ref: await controlActorRef(agentActor),
        issuer_ids: ["human-issuer-v1"],
        allowed_work_prefixes: [""],
      };
      await expect(manager.approveRequest(humanActor, req.request_id, policyBlankPrefix)).rejects.toThrow(
        "WORK_REF_NOT_AUTHORIZED_FOR_NODE",
      );
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
