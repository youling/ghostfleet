/**
 * G1: Human-Approved Admin Command — Request, Ledger, and Trusted Issuer Port.
 *
 * Implements the generic request lifecycle, state machine, durable ledger,
 * and separation between Agent requestors and Human approval / signing authority.
 */
import { Buffer } from "buffer";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, unlink, open, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type ControlActor,
  controlActorRef,
  actorAllows,
  PRIVILEGED_APPROVE_SCOPE,
  PRIVILEGED_SCOPE,
} from "./controlPolicy.js";

export const ADMIN_COMMAND_DOMAIN = new TextEncoder().encode("ghostfleet-approved-admin-command/v1\0");

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const uid = z.string().regex(/^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const ref = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$/);
const text = z.string().min(1).max(4096).refine(value => !value.includes("\0"));

export const adminCommandPayloadSchema = z.object({
  argv: z.array(text).min(1).max(64),
  cwd: text,
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), text).default({}),
  executable_sha256: hex,
  output: z.literal("discard").default("discard"),
}).strict();

export type AdminCommandPayload = z.infer<typeof adminCommandPayloadSchema>;

export const adminCommandRequestInputSchema = z.object({
  node_uid: uid,
  work_ref: text,
  purpose: text,
  command: adminCommandPayloadSchema,
  approval_ref: text.optional(),
  rollback_ref: text,
  max_runtime_seconds: z.number().int().min(1).max(900).default(30),
  ttl_seconds: z.number().int().min(10).max(3600).default(300),
}).strict();

export type AdminCommandRequestInput = z.infer<typeof adminCommandRequestInputSchema>;

export type AdminApprovalState =
  | "PENDING"
  | "APPROVED"
  | "DISPATCHED"
  | "CANCEL_REQUESTED"
  | "CONSUMED"
  | "DENIED"
  | "EXPIRED"
  | "CANCELLED";

export interface AdminApprovalRecord {
  version: number;
  request_id: string;
  node_uid: string;
  actor_ref: string;
  requester_user_id: string;
  work_ref: string;
  purpose: string;
  command: AdminCommandPayload;
  rollback_ref: string;
  approval_ref: string;
  max_runtime_seconds: number;
  ttl_seconds: number;
  created_at: number;
  expires_at: number;
  state: AdminApprovalState;
  dispatch_state?: "NOT_DISPATCHED" | "DISPATCHED" | "UNKNOWN" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STOPPED";
  reconcile_required?: boolean;
  decision?: {
    decided_by: string;
    decided_at: number;
    decision: "APPROVED" | "DENIED";
    reason?: string;
  };
  lease?: {
    lease_id: string;
    operation_id: string;
    issuer_id: string;
    raw_lease_b64: string;
    signature_b64: string;
    lease_digest: string;
  };
  consumption?: {
    consumed_at: number;
    consumed_by_actor_ref: string;
  };
  cancellation?: {
    cancelled_at: number;
    cancelled_by_actor_ref: string;
    reason?: string;
    confirmed_at?: number;
    completed_before_cancel?: boolean;
  };
  execution_receipt?: unknown;
  late_dispatch_outcome?: {
    recorded_at: number;
    outcome: string;
    receipt?: unknown;
    error?: string;
  };
}

export interface TrustedIssuerPort {
  issuerId: string;
  sign(leaseBytes: Uint8Array): Promise<{ issuer_id: string; signature_b64: string }>;
}

export class DefaultUnconfiguredIssuer implements TrustedIssuerPort {
  readonly issuerId = "unconfigured";
  async sign(): Promise<{ issuer_id: string; signature_b64: string }> {
    throw new Error("ISSUER_NOT_CONFIGURED");
  }
}

export interface NodeGenerationPolicy {
  generation: string;
  profile_generation: string;
  subject_ref: string;
  issuer_ids: string[];
  allowed_approvers?: string[];
  allowed_work_prefixes?: string[];
}

export interface AdminApprovalLedgerStore {
  create(record: AdminApprovalRecord): Promise<void>;
  get(requestId: string): Promise<AdminApprovalRecord | null>;
  list(filter?: { node_uid?: string; state?: AdminApprovalState; work_ref?: string }): Promise<AdminApprovalRecord[]>;
  compareAndSwap(
    requestId: string,
    expectedState: AdminApprovalState | AdminApprovalState[],
    mutate: (current: AdminApprovalRecord) => AdminApprovalRecord,
  ): Promise<AdminApprovalRecord>;
}

export class InMemoryAdminApprovalLedgerStore implements AdminApprovalLedgerStore {
  private records = new Map<string, AdminApprovalRecord>();
  private locks = new Map<string, Promise<void>>();

  private async acquireLock(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let unlock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      unlock = () => {
        this.locks.delete(key);
        resolve();
      };
    });
    this.locks.set(key, lockPromise);
    return unlock;
  }

  async create(record: AdminApprovalRecord): Promise<void> {
    const unlock = await this.acquireLock(record.request_id);
    try {
      if (this.records.has(record.request_id)) {
        throw new Error("ADMIN_REQUEST_ALREADY_EXISTS");
      }
      const initial = JSON.parse(JSON.stringify(record));
      if (!initial.version) initial.version = 1;
      this.records.set(record.request_id, initial);
    } finally {
      unlock();
    }
  }

  async get(requestId: string): Promise<AdminApprovalRecord | null> {
    const found = this.records.get(requestId);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async list(filter?: { node_uid?: string; state?: AdminApprovalState; work_ref?: string }): Promise<AdminApprovalRecord[]> {
    let all = Array.from(this.records.values()).map(r => JSON.parse(JSON.stringify(r)));
    if (filter?.node_uid) all = all.filter(r => r.node_uid === filter.node_uid);
    if (filter?.state) all = all.filter(r => r.state === filter.state);
    if (filter?.work_ref) all = all.filter(r => r.work_ref === filter.work_ref);
    return all;
  }

  async compareAndSwap(
    requestId: string,
    expectedState: AdminApprovalState | AdminApprovalState[],
    mutate: (current: AdminApprovalRecord) => AdminApprovalRecord,
  ): Promise<AdminApprovalRecord> {
    const unlock = await this.acquireLock(requestId);
    try {
      const current = this.records.get(requestId);
      if (!current) throw new Error("ADMIN_REQUEST_NOT_FOUND");
      const allowed = Array.isArray(expectedState) ? expectedState : [expectedState];
      if (!allowed.includes(current.state)) {
        throw new Error(`ADMIN_CAS_STATE_MISMATCH:${current.state}`);
      }
      const cloned = JSON.parse(JSON.stringify(current));
      const next = mutate(cloned);
      next.version = (current.version ?? 0) + 1;
      this.records.set(requestId, JSON.parse(JSON.stringify(next)));
      return JSON.parse(JSON.stringify(next));
    } finally {
      unlock();
    }
  }
}

export const REQUEST_ID_RE = /^req-[0-9]+-[0-9a-f]{32}-[0-9a-f]{8,16}$/;

export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== "number" || isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as { code?: string };
    return error?.code === "EPERM";
  }
}

/**
 * File-backed durable transactional ledger store supporting cross-process CAS and crash recovery.
 */
export class FileAdminApprovalLedgerStore implements AdminApprovalLedgerStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private validateRequestId(requestId: string): void {
    if (!requestId || typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
      throw new Error(`INVALID_REQUEST_ID:${requestId}`);
    }
    if (requestId.includes("..") || requestId.includes("/") || requestId.includes("\\") || requestId.includes("\0")) {
      throw new Error(`INVALID_REQUEST_ID:${requestId}`);
    }
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private filePath(requestId: string): string {
    this.validateRequestId(requestId);
    return path.join(this.dir, `${requestId}.json`);
  }

  private lockPath(requestId: string): string {
    this.validateRequestId(requestId);
    return path.join(this.dir, `${requestId}.lock`);
  }

  private async atomicWriteJson(file: string, data: unknown): Promise<void> {
    const tmpFile = `${file}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    const content = JSON.stringify(data, null, 2);
    const handle = await open(tmpFile, "w", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpFile, file);
    try {
      const dirHandle = await open(this.dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Directory fsync is platform-dependent (e.g. Windows EPERM/EISDIR)
    }
  }

  private async acquireFileLock(requestId: string, timeoutMs = 10000): Promise<() => Promise<void>> {
    this.validateRequestId(requestId);
    await this.ensureDir();
    const lockFile = this.lockPath(requestId);
    const start = Date.now();
    while (true) {
      try {
        const handle = await open(lockFile, "wx", 0o600);
        try {
          const lockMeta = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
          await handle.writeFile(lockMeta, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === "EEXIST") {
          if (Date.now() - start > timeoutMs) {
            try {
              const content = await readFile(lockFile, "utf8");
              const meta = JSON.parse(content);
              if (meta?.pid && !isProcessAlive(meta.pid)) {
                await unlink(lockFile).catch(() => {});
                continue;
              }
            } catch {
              try {
                const fileStat = await stat(lockFile);
                if (Date.now() - fileStat.mtimeMs > timeoutMs * 2) {
                  await unlink(lockFile).catch(() => {});
                  continue;
                }
              } catch {}
            }
            throw new Error(`ADMIN_STORE_LOCK_TIMEOUT:${requestId}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        throw err;
      }
    }
    return async () => {
      await unlink(lockFile).catch(() => {});
    };
  }

  async create(record: AdminApprovalRecord): Promise<void> {
    this.validateRequestId(record.request_id);
    await this.ensureDir();
    const release = await this.acquireFileLock(record.request_id);
    try {
      const file = this.filePath(record.request_id);
      try {
        await readFile(file);
        throw new Error("ADMIN_REQUEST_ALREADY_EXISTS");
      } catch (err: unknown) {
        const error = err as Error;
        if (error?.message === "ADMIN_REQUEST_ALREADY_EXISTS") throw error;
      }
      const initial = JSON.parse(JSON.stringify(record));
      if (!initial.version) initial.version = 1;
      await this.atomicWriteJson(file, initial);
    } finally {
      await release();
    }
  }

  async get(requestId: string): Promise<AdminApprovalRecord | null> {
    this.validateRequestId(requestId);
    await this.ensureDir();
    const file = this.filePath(requestId);
    try {
      const content = await readFile(file, "utf8");
      return JSON.parse(content);
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error?.code === "ENOENT") return null;
      throw err;
    }
  }

  async list(filter?: { node_uid?: string; state?: AdminApprovalState; work_ref?: string }): Promise<AdminApprovalRecord[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir);
    const results: AdminApprovalRecord[] = [];
    for (const entry of entries) {
      if (entry.endsWith(".json") && !entry.includes(".tmp.")) {
        const reqId = entry.slice(0, -5);
        if (!REQUEST_ID_RE.test(reqId)) continue;
        try {
          const content = await readFile(path.join(this.dir, entry), "utf8");
          const rec: AdminApprovalRecord = JSON.parse(content);
          if (filter?.node_uid && rec.node_uid !== filter.node_uid) continue;
          if (filter?.state && rec.state !== filter.state) continue;
          if (filter?.work_ref && rec.work_ref !== filter.work_ref) continue;
          results.push(rec);
        } catch {
          // ignore transient read errors
        }
      }
    }
    return results;
  }

  async compareAndSwap(
    requestId: string,
    expectedState: AdminApprovalState | AdminApprovalState[],
    mutate: (current: AdminApprovalRecord) => AdminApprovalRecord,
  ): Promise<AdminApprovalRecord> {
    this.validateRequestId(requestId);
    await this.ensureDir();
    const release = await this.acquireFileLock(requestId);
    try {
      const file = this.filePath(requestId);
      let current: AdminApprovalRecord;
      try {
        const content = await readFile(file, "utf8");
        current = JSON.parse(content);
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === "ENOENT") throw new Error("ADMIN_REQUEST_NOT_FOUND");
        throw err;
      }
      const allowed = Array.isArray(expectedState) ? expectedState : [expectedState];
      if (!allowed.includes(current.state)) {
        throw new Error(`ADMIN_CAS_STATE_MISMATCH:${current.state}`);
      }
      const cloned = JSON.parse(JSON.stringify(current));
      const next = mutate(cloned);
      next.version = (current.version ?? 0) + 1;
      await this.atomicWriteJson(file, next);
      return JSON.parse(JSON.stringify(next));
    } finally {
      await release();
    }
  }
}

export function defaultApprovalLedgerStore(): AdminApprovalLedgerStore {
  const dir = process.env.CONTROL_APPROVAL_STORE_DIR;
  if (dir) {
    return new FileAdminApprovalLedgerStore(dir);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DURABLE_APPROVAL_STORE_REQUIRED: In production, configure CONTROL_APPROVAL_STORE_DIR or provide a durable AdminApprovalLedgerStore.",
    );
  }
  return new InMemoryAdminApprovalLedgerStore();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  return createHash("sha256").update(buf).digest("hex");
}

export class AdminApprovalManager {
  private store: AdminApprovalLedgerStore;
  private issuer: TrustedIssuerPort;

  constructor(
    store: AdminApprovalLedgerStore = defaultApprovalLedgerStore(),
    issuer: TrustedIssuerPort = new DefaultUnconfiguredIssuer(),
  ) {
    this.store = store;
    this.issuer = issuer;
  }

  async submitRequest(actor: ControlActor, inputRaw: AdminCommandRequestInput): Promise<AdminApprovalRecord> {
    const input = adminCommandRequestInputSchema.parse(inputRaw);
    const actorRef = await controlActorRef(actor);
    const now = Math.floor(Date.now() / 1000);
    // 16 bytes = 128-bit random entropy for zero collisions
    const entropy = randomBytes(16).toString("hex");
    const cmdDigest = createHash("sha256").update(canonicalJson(input.command)).digest("hex").slice(0, 16);
    const requestId = `req-${now}-${entropy}-${cmdDigest}`;

    const record: AdminApprovalRecord = {
      version: 1,
      request_id: requestId,
      node_uid: input.node_uid,
      actor_ref: actorRef,
      requester_user_id: actor.userId,
      work_ref: input.work_ref,
      purpose: input.purpose,
      command: input.command,
      rollback_ref: input.rollback_ref,
      approval_ref: input.approval_ref ?? `app-${requestId}`,
      max_runtime_seconds: input.max_runtime_seconds,
      ttl_seconds: input.ttl_seconds,
      created_at: now,
      expires_at: now + input.ttl_seconds,
      state: "PENDING",
    };

    await this.store.create(record);
    return record;
  }

  async approveRequest(
    humanActor: ControlActor,
    requestId: string,
    policy: NodeGenerationPolicy,
    options?: { reason?: string },
  ): Promise<AdminApprovalRecord> {
    if (!actorAllows(humanActor, PRIVILEGED_APPROVE_SCOPE)) {
      throw new Error("APPROVER_NOT_AUTHORIZED");
    }

    const existing = await this.store.get(requestId);
    if (!existing) throw new Error("ADMIN_REQUEST_NOT_FOUND");

    const approverRef = await controlActorRef(humanActor);
    if (existing.actor_ref === approverRef || existing.requester_user_id === humanActor.userId) {
      throw new Error("APPROVER_CANNOT_BE_REQUESTER");
    }

    // Node-level approver authorization check
    if (policy.allowed_approvers !== undefined) {
      const validApprovers = policy.allowed_approvers.filter(a => typeof a === "string" && a.trim().length > 0);
      const allowed = validApprovers.includes(humanActor.userId) || validApprovers.includes(approverRef);
      if (!allowed) {
        throw new Error("APPROVER_NOT_AUTHORIZED_FOR_NODE");
      }
    }

    // Work reference authorization check
    if (policy.allowed_work_prefixes !== undefined) {
      const validPrefixes = policy.allowed_work_prefixes.filter(p => typeof p === "string" && p.length > 0);
      const workAllowed = validPrefixes.length > 0 && validPrefixes.some(p => existing.work_ref.startsWith(p));
      if (!workAllowed) {
        throw new Error("WORK_REF_NOT_AUTHORIZED_FOR_NODE");
      }
    }

    if (existing.state !== "PENDING") {
      throw new Error(`ADMIN_INVALID_STATE_FOR_APPROVAL:${existing.state}`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (now >= existing.expires_at) {
      await this.expireRequest(requestId);
      throw new Error("ADMIN_REQUEST_EXPIRED");
    }

    const issuer = this.issuer;
    if (!policy.issuer_ids || !policy.issuer_ids.includes(issuer.issuerId)) {
      throw new Error("ADMIN_ISSUER_NOT_AUTHORIZED_FOR_NODE");
    }

    const entropy = randomBytes(8).toString("hex");
    const cmdDigest = sha256Hex(canonicalJson(existing.command)).slice(0, 8);
    const leaseId = `lease-${now}-${entropy}-${cmdDigest}`;
    const operationId = `op-${now}-${entropy}-${cmdDigest}`;

    const lease = {
      schema: "ghostfleet-approved-admin-lease/v1" as const,
      lease_id: leaseId,
      request_id: existing.request_id,
      operation_id: operationId,
      operation: "admin.command" as const,
      issuer_id: issuer.issuerId,
      node_uid: existing.node_uid,
      subject_ref: existing.actor_ref,
      audience_ref: "ghostfleet-approved-admin-command/v1" as const,
      generation: policy.generation,
      profile_generation: policy.profile_generation,
      work_ref: existing.work_ref,
      purpose: existing.purpose,
      approval_ref: existing.approval_ref,
      rollback_ref: existing.rollback_ref,
      issued_at: now,
      not_before: now,
      expires_at: existing.expires_at,
      max_uses: 1 as const,
      max_runtime_seconds: existing.max_runtime_seconds,
      command: {
        argv: existing.command.argv,
        cwd: existing.command.cwd,
        env: existing.command.env,
        executable_sha256: existing.command.executable_sha256,
        output: "discard" as const,
      },
    };

    const canonicalLeaseBytes = new TextEncoder().encode(canonicalJson(lease));
    const toSign = new Uint8Array(ADMIN_COMMAND_DOMAIN.length + canonicalLeaseBytes.length);
    toSign.set(ADMIN_COMMAND_DOMAIN, 0);
    toSign.set(canonicalLeaseBytes, ADMIN_COMMAND_DOMAIN.length);

    const signed = await issuer.sign(toSign);
    const leaseB64 = Buffer.from(canonicalLeaseBytes).toString("base64");
    const leaseDigest = sha256Hex(canonicalLeaseBytes);

    return this.store.compareAndSwap(requestId, "PENDING", (record) => {
      record.state = "APPROVED";
      record.decision = {
        decided_by: humanActor.userId,
        decided_at: now,
        decision: "APPROVED",
        reason: options?.reason,
      };
      record.lease = {
        lease_id: leaseId,
        operation_id: operationId,
        issuer_id: signed.issuer_id,
        raw_lease_b64: leaseB64,
        signature_b64: signed.signature_b64,
        lease_digest: leaseDigest,
      };
      return record;
    });
  }

  async denyRequest(humanActor: ControlActor, requestId: string, reason?: string): Promise<AdminApprovalRecord> {
    if (!actorAllows(humanActor, PRIVILEGED_APPROVE_SCOPE)) {
      throw new Error("APPROVER_NOT_AUTHORIZED");
    }

    const now = Math.floor(Date.now() / 1000);
    return this.store.compareAndSwap(requestId, "PENDING", (record) => {
      record.state = "DENIED";
      record.decision = {
        decided_by: humanActor.userId,
        decided_at: now,
        decision: "DENIED",
        reason,
      };
      return record;
    });
  }

  async requestCancellation(actor: ControlActor, requestId: string, reason?: string): Promise<AdminApprovalRecord> {
    const existing = await this.store.get(requestId);
    if (!existing) throw new Error("ADMIN_REQUEST_NOT_FOUND");

    const callerRef = await controlActorRef(actor);
    const isOwner = existing.actor_ref === callerRef;
    const isSupervisor = actorAllows(actor, PRIVILEGED_APPROVE_SCOPE);
    if (!isOwner && !isSupervisor) {
      throw new Error("ADMIN_REQUEST_ACCESS_DENIED");
    }

    if (existing.state === "CANCELLED") {
      return existing;
    }
    if (existing.state === "EXPIRED" || existing.state === "DENIED") {
      throw new Error(`ADMIN_INVALID_STATE_FOR_CANCELLATION:${existing.state}`);
    }

    const now = Math.floor(Date.now() / 1000);

    // If PENDING or APPROVED (not yet dispatched to remote host), directly transition to CANCELLED
    if (existing.state === "PENDING" || existing.state === "APPROVED") {
      return this.store.compareAndSwap(requestId, ["PENDING", "APPROVED"], (record) => {
        record.state = "CANCELLED";
        record.cancellation = {
          cancelled_at: now,
          cancelled_by_actor_ref: callerRef,
          reason,
          confirmed_at: now,
        };
        return record;
      });
    }

    // If DISPATCHED or CONSUMED, transition to CANCEL_REQUESTED awaiting node receipt
    return this.store.compareAndSwap(requestId, ["DISPATCHED", "CONSUMED", "CANCEL_REQUESTED"], (record) => {
      record.state = "CANCEL_REQUESTED";
      record.cancellation = {
        cancelled_at: now,
        cancelled_by_actor_ref: callerRef,
        reason,
      };
      return record;
    });
  }

  async confirmCancellation(requestId: string, actorRef: string, receipt?: unknown): Promise<AdminApprovalRecord> {
    const now = Math.floor(Date.now() / 1000);
    return this.store.compareAndSwap(
      requestId,
      ["CANCEL_REQUESTED", "DISPATCHED", "CONSUMED", "APPROVED", "CANCELLED"],
      (record) => {
        record.state = "CANCELLED";
        record.reconcile_required = false;
        if (!record.cancellation) {
          record.cancellation = {
            cancelled_at: now,
            cancelled_by_actor_ref: actorRef,
          };
        }
        if (!record.cancellation.confirmed_at) {
          record.cancellation.confirmed_at = now;
        }
        if (receipt && !record.execution_receipt) {
          record.execution_receipt = receipt;
        }
        return record;
      },
    );
  }

  async recordCancelDispatchUncertain(requestId: string, outcome: string, error?: string): Promise<AdminApprovalRecord> {
    return this.store.compareAndSwap(requestId, ["CANCEL_REQUESTED"], (record) => {
      record.reconcile_required = true;
      record.dispatch_state = outcome as any;
      return record;
    });
  }

  async recordCompletedBeforeCancel(requestId: string, actorRef: string, receipt?: unknown): Promise<AdminApprovalRecord> {
    const now = Math.floor(Date.now() / 1000);
    return this.store.compareAndSwap(requestId, ["CANCEL_REQUESTED"], (record) => {
      record.state = "CONSUMED";
      record.reconcile_required = false;
      record.execution_receipt = receipt;
      if (!record.consumption) {
        record.consumption = {
          consumed_at: now,
          consumed_by_actor_ref: actorRef,
        };
      }
      if (record.cancellation) {
        record.cancellation.completed_before_cancel = true;
      }
      return record;
    });
  }

  async markDispatched(actorRef: string, requestId: string): Promise<AdminApprovalRecord> {
    const existing = await this.store.get(requestId);
    if (!existing) throw new Error("ADMIN_REQUEST_NOT_FOUND");
    if (existing.actor_ref !== actorRef) throw new Error("ADMIN_ACTOR_MISMATCH");

    const now = Math.floor(Date.now() / 1000);
    if (now >= existing.expires_at) {
      await this.expireRequest(requestId);
      throw new Error("ADMIN_LEASE_EXPIRED");
    }

    return this.store.compareAndSwap(requestId, "APPROVED", (record) => {
      record.state = "DISPATCHED";
      record.dispatch_state = "DISPATCHED";
      return record;
    });
  }

  async recordDispatchFailure(requestId: string): Promise<AdminApprovalRecord> {
    return this.store.compareAndSwap(requestId, ["DISPATCHED", "CANCEL_REQUESTED"], (record) => {
      if (record.state === "CANCEL_REQUESTED") {
        record.state = "CANCELLED";
        record.reconcile_required = false;
      } else {
        record.state = "APPROVED";
        record.dispatch_state = "NOT_DISPATCHED";
      }
      return record;
    });
  }

  async recordDispatchUnknown(requestId: string, error?: string): Promise<AdminApprovalRecord> {
    return this.store.compareAndSwap(requestId, ["DISPATCHED", "CANCEL_REQUESTED"], (record) => {
      record.dispatch_state = "UNKNOWN";
      record.reconcile_required = true;
      return record;
    });
  }

  async recordDispatchOutcome(
    actorRef: string,
    requestId: string,
    execution: { outcome: string; receipt?: unknown; error?: string },
  ): Promise<AdminApprovalRecord> {
    const now = Math.floor(Date.now() / 1000);
    return this.store.compareAndSwap(
      requestId,
      ["APPROVED", "DISPATCHED", "CANCEL_REQUESTED", "CONSUMED", "CANCELLED"],
      (record) => {
        // Reverse Execute / Cancel Race: delayed execution arrival on confirmed CANCELLED record
        if (record.state === "CANCELLED") {
          record.late_dispatch_outcome = {
            recorded_at: now,
            outcome: execution.outcome,
            receipt: execution.receipt,
            error: execution.error,
          };
          return record;
        }

        // Idempotent reconciliation on already-CONSUMED record
        if (record.state === "CONSUMED") {
          if (execution.receipt && !record.execution_receipt) {
            record.execution_receipt = execution.receipt;
          }
          if (execution.outcome) {
            record.dispatch_state = execution.outcome as any;
          }
          record.reconcile_required = false;
          return record;
        }

        record.execution_receipt = execution.receipt;
        record.dispatch_state = execution.outcome as any;

        if (execution.outcome === "SUCCEEDED" || execution.outcome === "FAILED" || execution.outcome === "STOPPED") {
          record.state = "CONSUMED";
          record.reconcile_required = false;
          record.consumption = {
            consumed_at: now,
            consumed_by_actor_ref: actorRef,
          };
          if (record.cancellation) {
            record.cancellation.completed_before_cancel = true;
          }
        } else if (execution.outcome === "UNKNOWN") {
          record.reconcile_required = true;
        }
        return record;
      },
    );
  }

  async reconcileFromStatus(
    requestId: string,
    liveStatus: { outcome: string; receipt?: { state: string }; error?: string },
  ): Promise<AdminApprovalRecord | null> {
    const existing = await this.store.get(requestId);
    if (!existing || !existing.lease) return existing;

    if (liveStatus.receipt) {
      const st = liveStatus.receipt.state;
      if (st === "REVOKED" || st === "STOPPED") {
        if (existing.state === "CANCEL_REQUESTED" || existing.cancellation) {
          return this.confirmCancellation(requestId, existing.actor_ref, liveStatus.receipt);
        }
      }
      if (st === "SUCCEEDED" || st === "FAILED") {
        return this.recordDispatchOutcome(existing.actor_ref, requestId, liveStatus);
      }
    }
    return existing;
  }

  async expireRequest(requestId: string): Promise<AdminApprovalRecord | null> {
    try {
      return await this.store.compareAndSwap(requestId, ["PENDING", "APPROVED"], (record) => {
        record.state = "EXPIRED";
        return record;
      });
    } catch {
      return null;
    }
  }

  async getRequest(requestId: string): Promise<AdminApprovalRecord | null> {
    const record = await this.store.get(requestId);
    if (!record) return null;
    if ((record.state === "PENDING" || record.state === "APPROVED") && Math.floor(Date.now() / 1000) >= record.expires_at) {
      return this.expireRequest(requestId);
    }
    return record;
  }

  async listRequests(filter?: { node_uid?: string; state?: AdminApprovalState; work_ref?: string }): Promise<AdminApprovalRecord[]> {
    return this.store.list(filter);
  }
}
