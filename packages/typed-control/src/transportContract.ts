/**
 * Provider-neutral transport contract scaffold (Issue #36 Phase 4).
 *
 * Semantics frozen by Architect review on #36:
 * - dispatch_state MUST NOT default to NOT_DISPATCHED; missing state fails
 *   closed and MAY_HAVE_EXECUTED/UNKNOWN must survive restart via durable store.
 * - purpose has no global default; only explicit legacy machine-control entry
 *   may derive it.
 * - required_tags (durable policy) never merged with runtime_tags.
 * - raw tokens/keys/enrollment auth keys never enter the public contract.
 *
 * No provider adapter performs real network mutation in this scaffold.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Purpose = "machine-control" | "human-maintenance" | "recovery";
export type Plane = "cloudflare-vpc" | "tailnet" | "native-lan";
export type DispatchState = "NOT_DISPATCHED" | "MAY_HAVE_EXECUTED" | "UNKNOWN";
export type FailureDomain = "worker_vpc" | "tailnet" | "lan" | "provider" | "unknown";
export type EndpointKind = "tailscale_ssh" | "native_sshd" | "cloudflared_forwarded_sshd";
export type TargetProofMethod = "pinned_host_key" | "provider_binding_tag" | "tailscale_jit_host_key";
export type LocatorKind = "binding_name" | "provider_ref" | "magicdns" | "explicit_ip";

export class ContractValidationError extends Error {}
export class PurposeUnspecifiedError extends ContractValidationError {}
export class DispatchStateUnrecoverableError extends ContractValidationError {}

export interface PlaneBinding {
  plane: Plane;
  provider: string;
  provider_ref: string;
  required_tags: string[]; // durable policy
  runtime_tags: string[]; // provider observation, never merged
}

export interface Endpoint {
  kind: EndpointKind;
  port?: number;
}

export interface Caller {
  auth_kind: "oauth" | "tailscale_acl" | "openssh_pubkey";
  actor_ref: string;
}

export interface Authority {
  scope: string;
  policy_revision: string;
}

export interface TargetProof {
  method: TargetProofMethod;
  detail_digest?: string;
}

export interface Candidate {
  plane: Plane;
  endpoint: Endpoint;
  target_proof: TargetProof;
  locator_kind: LocatorKind;
  failure_domain: FailureDomain;
}

export interface TransportRequest {
  node_uid: string;
  caller: Caller;
  authority: Authority;
  purpose: Purpose | null;
  dispatch_state: DispatchState | null;
  plane_bindings: PlaneBinding[];
}

export function requirePurpose(request: TransportRequest): Purpose {
  if (request.purpose === null || request.purpose === undefined) {
    throw new PurposeUnspecifiedError("purpose is required; no global default");
  }
  return request.purpose;
}

export function requireDispatchState(request: TransportRequest): DispatchState {
  if (request.dispatch_state === null || request.dispatch_state === undefined) {
    throw new DispatchStateUnrecoverableError(
      "dispatch_state is unknown; refusing to treat it as NOT_DISPATCHED",
    );
  }
  return request.dispatch_state;
}

export function derivePurposeForLegacyMachineControlEntry(): Purpose {
  return "machine-control";
}

export interface GateResult {
  candidates: Candidate[];
  reason: string;
  purpose?: Purpose;
  dispatch_state?: DispatchState;
}

export function evaluateGate(request: TransportRequest): GateResult {
  const purpose = requirePurpose(request);
  const state = requireDispatchState(request);
  if (state !== "NOT_DISPATCHED") {
    return { candidates: [], reason: "reconcile_required", dispatch_state: state, purpose };
  }
  const allowed: Record<Purpose, Plane[]> = {
    "machine-control": ["cloudflare-vpc", "tailnet"],
    "human-maintenance": ["tailnet"],
    recovery: ["native-lan"],
  };
  const candidates = request.plane_bindings
    .filter((b) => allowed[purpose].includes(b.plane))
    .map((b) => ({
      plane: b.plane,
      endpoint: { kind: "tailscale_ssh" as EndpointKind },
      target_proof: { method: "provider_binding_tag" as TargetProofMethod },
      locator_kind: "provider_ref" as LocatorKind,
      failure_domain: "tailnet" as FailureDomain,
    }));
  return { candidates, reason: "ok", purpose };
}

export function tagPolicySatisfied(requiredTags: string[], runtimeTags: string[]): boolean {
  const runtime = new Set(runtimeTags);
  return requiredTags.every((t) => runtime.has(t));
}

const FORBIDDEN_FIELD_HINTS = ["token", "secret", "private_key", "auth_key", "credential"];

export function assertNoSecretFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_FIELD_HINTS.some((hint) => lowered.includes(hint))) {
      throw new ContractValidationError(`secret-like field is forbidden in contract: ${key}`);
    }
  }
}

export interface DispatchStateStore {
  get(key: string): DispatchState | null;
  put(key: string, state: DispatchState): void;
}

export class JsonFileDispatchStateStore implements DispatchStateStore {
  constructor(private readonly filePath: string) {}

  private read(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) result[k] = String(v);
      return result;
    } catch {
      return {};
    }
  }

  get(key: string): DispatchState | null {
    const value = this.read()[key];
    if (value === "NOT_DISPATCHED" || value === "MAY_HAVE_EXECUTED" || value === "UNKNOWN") {
      return value;
    }
    return null;
  }

  put(key: string, state: DispatchState): void {
    const data = this.read();
    data[key] = state;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
