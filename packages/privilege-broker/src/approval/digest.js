import { canonicalize, canonicalStringify, sha256, deepFreeze } from "../util.js";

function normalizedOperation(operation = {}) {
  const recovery = operation.recovery ? {
    mode: operation.recovery.mode ?? null,
    ref: operation.recovery.ref ?? operation.recovery.plan_ref ?? null,
  } : null;
  return canonicalize({
    operation_id: operation.operation_id ?? null,
    scope_ref: operation.scope_ref ?? null,
    parameters: operation.parameters ?? null,
    parameter_constraints_ref: operation.parameter_constraints_ref ?? null,
    recovery,
  });
}

export function normalizePrivilegeRequest(request = {}) {
  const operations = Array.isArray(request.operations) ? request.operations.map(normalizedOperation) : [];
  operations.sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));
  return deepFreeze(canonicalize({
    request_id: request.request_id ?? null,
    node_uid: request.node_uid ?? null,
    requester_ref: request.requester_ref ?? null,
    intent: request.intent ?? null,
    operations,
    requested_ttl_seconds: Number(request.requested_ttl_seconds ?? 0),
    requested_max_uses: Number(request.requested_max_uses ?? 1),
    policy_revision: request.policy_revision ?? null,
  }));
}
export function normalizedRequestDigest(request) {
  return sha256(normalizePrivilegeRequest(request));
}
