/**
 * G1: Human-Approved Admin Command — Request, Ledger, and Trusted Issuer Port.
 *
 * Implements the generic request lifecycle, state machine, and separation
 * between Agent requestors and Human approval / signing authority.
 */
import { Buffer } from "buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type ControlActor, controlActorRef } from "./controlPolicy.js";

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

export type AdminApprovalState = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CONSUMED" | "CANCELLED";

export interface AdminApprovalRecord {
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
  save(record: AdminApprovalRecord): Promise<void>;
  get(requestId: string): Promise<AdminApprovalRecord | null>;
  list(filter?: { node_uid?: string; state?: AdminApprovalState; work_ref?: string }): Promise<AdminApprovalRecord[]>;
}

export class InMemoryAdminApprovalLedgerStore implements AdminApprovalLedgerStore {
  private records = new Map<string, AdminApprovalRecord>();

  async save(record: AdminApprovalRecord): Promise<void> {
    this.records.set(record.request_id, JSON.parse(JSON.stringify(record)));
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
    const requestId = `req-${now}-${createHash("sha256").update(`${actorRef}:${input.node_uid}:${now}`).digest("hex").slice(0, 16)}`;

    const record: AdminApprovalRecord = {
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

    await this.store.save(record);
    return record;
  }

  async approveRequest(
    humanActor: ControlActor,
    requestId: string,
    policy: NodeGenerationPolicy,
    options?: { reason?: string; issuerOverride?: TrustedIssuerPort },
  ): Promise<AdminApprovalRecord> {
    const record = await this.store.get(requestId);
    if (!record) throw new Error("ADMIN_REQUEST_NOT_FOUND");
    if (record.state !== "PENDING") {
      throw new Error(`ADMIN_INVALID_STATE_FOR_APPROVAL:${record.state}`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (now >= record.expires_at) {
      record.state = "EXPIRED";
      await this.store.save(record);
      throw new Error("ADMIN_REQUEST_EXPIRED");
    }

    const issuer = options?.issuerOverride ?? this.issuer;
    if (!policy.issuer_ids.includes(issuer.issuerId)) {
      throw new Error("ADMIN_ISSUER_NOT_AUTHORIZED_FOR_NODE");
    }

    const leaseId = `lease-${now}-${record.request_id.slice(-8)}`;
    const operationId = `op-${now}-${record.request_id.slice(-8)}`;

    const lease = {
      schema: "ghostfleet-approved-admin-lease/v1" as const,
      lease_id: leaseId,
      request_id: record.request_id,
      operation_id: operationId,
      operation: "admin.command" as const,
      issuer_id: issuer.issuerId,
      node_uid: record.node_uid,
      subject_ref: record.actor_ref,
      audience_ref: "ghostfleet-approved-admin-command/v1" as const,
      generation: policy.generation,
      profile_generation: policy.profile_generation,
      work_ref: record.work_ref,
      purpose: record.purpose,
      approval_ref: record.approval_ref,
      rollback_ref: record.rollback_ref,
      issued_at: now,
      not_before: now,
      expires_at: record.expires_at,
      max_uses: 1 as const,
      max_runtime_seconds: record.max_runtime_seconds,
      command: {
        argv: record.command.argv,
        cwd: record.command.cwd,
        env: record.command.env,
        executable_sha256: record.command.executable_sha256,
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

    await this.store.save(record);
    return record;
  }

  async denyRequest(humanActor: ControlActor, requestId: string, reason?: string): Promise<AdminApprovalRecord> {
    const record = await this.store.get(requestId);
    if (!record) throw new Error("ADMIN_REQUEST_NOT_FOUND");
    if (record.state !== "PENDING") {
      throw new Error(`ADMIN_INVALID_STATE_FOR_DENIAL:${record.state}`);
    }

    const now = Math.floor(Date.now() / 1000);
    record.state = "DENIED";
    record.decision = {
      decided_by: humanActor.userId,
      decided_at: now,
      decision: "DENIED",
      reason,
    };

    await this.store.save(record);
    return record;
  }

  async cancelRequest(actor: ControlActor, requestId: string, reason?: string): Promise<AdminApprovalRecord> {
    const record = await this.store.get(requestId);
    if (!record) throw new Error("ADMIN_REQUEST_NOT_FOUND");
    if (record.state === "CONSUMED") {
      throw new Error("ADMIN_CANNOT_CANCEL_CONSUMED_LEASE");
    }
    if (record.state === "CANCELLED") {
      return record;
    }

    record.state = "CANCELLED";
    await this.store.save(record);
    return record;
  }

  async markConsumed(actorRef: string, requestId: string): Promise<AdminApprovalRecord> {
    const record = await this.store.get(requestId);
    if (!record) throw new Error("ADMIN_REQUEST_NOT_FOUND");
    if (record.state !== "APPROVED") {
      if (record.state === "CONSUMED") {
        throw new Error("ADMIN_LEASE_ALREADY_CONSUMED");
      }
      throw new Error(`ADMIN_NOT_APPROVED:${record.state}`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (now >= record.expires_at) {
      record.state = "EXPIRED";
      await this.store.save(record);
      throw new Error("ADMIN_LEASE_EXPIRED");
    }

    record.state = "CONSUMED";
    record.consumption = {
      consumed_at: now,
      consumed_by_actor_ref: actorRef,
    };

    await this.store.save(record);
    return record;
  }

  async getRequest(requestId: string): Promise<AdminApprovalRecord | null> {
    const record = await this.store.get(requestId);
    if (!record) return null;
    if ((record.state === "PENDING" || record.state === "APPROVED") && Math.floor(Date.now() / 1000) >= record.expires_at) {
      record.state = "EXPIRED";
      await this.store.save(record);
    }
    return record;
  }

  async listRequests(filter?: { node_uid?: string; state?: AdminApprovalState; work_ref?: string }): Promise<AdminApprovalRecord[]> {
    return this.store.list(filter);
  }
}
