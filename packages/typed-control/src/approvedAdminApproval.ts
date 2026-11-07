/**
 * G1: Human-Approved Admin Command — Request, Ledger, and Trusted Issuer Port.
 *
 * Implements the generic request lifecycle, state machine, and separation
 * between Agent requestors and Human approval / signing authority.
 */
import { Buffer } from "buffer";
import { createHash, randomBytes } from "node:crypto";
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
  dispatch_state?: "NOT_DISPATCHED" | "DISPATCHED" | "UNKNOWN";
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
}

export interface AdminApprovalLedgerStore {
  create(record: AdminApprovalRecord): Promise<void>;
  save(record: AdminApprovalRecord): Promise<void>;
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

  async save(record: AdminApprovalRecord): Promise<void> {
    const unlock = await this.acquireLock(record.request_id);
    try {
      const cloned = JSON.parse(JSON.stringify(record));
      if (!cloned.version) cloned.version = 1;
      this.records.set(record.request_id, cloned);
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
  constructor(
    private store: AdminApprovalLedgerStore = new InMemoryAdminApprovalLedgerStore(),
    private issuer: TrustedIssuerPort = new DefaultUnconfiguredIssuer(),
  ) {}

  async submitRequest(actor: ControlActor, inputRaw: AdminCommandRequestInput): Promise<AdminApprovalRecord> {
    const input = adminCommandRequestInputSchema.parse(inputRaw);
    const actorRef = await controlActorRef(actor);
    const now = Math.floor(Date.now() / 1000);
    const entropy = randomBytes(8).toString("hex");
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

    if (existing.state !== "PENDING") {
      throw new Error(`ADMIN_INVALID_STATE_FOR_APPROVAL:${existing.state}`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (now >= existing.expires_at) {
      await this.expireRequest(requestId);
      throw new Error("ADMIN_REQUEST_EXPIRED");
    }

    const issuer = this.issuer;
    if (!policy.issuer_ids.includes(issuer.issuerId)) {
      throw new Error("ADMIN_ISSUER_NOT_AUTHORIZED_FOR_NODE");
    }

    const leaseId = `lease-${now}-${existing.request_id.slice(-8)}`;
    const operationId = `op-${now}-${existing.request_id.slice(-8)}`;

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

  async cancelRequest(actor: ControlActor, requestId: string, reason?: string): Promise<AdminApprovalRecord> {
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
    return this.store.compareAndSwap(requestId, ["PENDING", "APPROVED", "DISPATCHED", "CONSUMED"], (record) => {
      record.state = "CANCELLED";
      record.cancellation = {
        cancelled_at: now,
        cancelled_by_actor_ref: callerRef,
        reason,
      };
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
    return this.store.compareAndSwap(requestId, "DISPATCHED", (record) => {
      record.state = "APPROVED";
      record.dispatch_state = "NOT_DISPATCHED";
      return record;
    });
  }

  async recordDispatchUnknown(requestId: string): Promise<AdminApprovalRecord> {
    return this.store.compareAndSwap(requestId, "DISPATCHED", (record) => {
      record.dispatch_state = "UNKNOWN";
      record.reconcile_required = true;
      return record;
    });
  }

  async recordDispatchSuccess(actorRef: string, requestId: string): Promise<AdminApprovalRecord> {
    const now = Math.floor(Date.now() / 1000);
    return this.store.compareAndSwap(requestId, "DISPATCHED", (record) => {
      record.state = "CONSUMED";
      record.consumption = {
        consumed_at: now,
        consumed_by_actor_ref: actorRef,
      };
      return record;
    });
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
