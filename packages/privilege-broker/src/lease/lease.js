import { normalizePrivilegeRequest, normalizedRequestDigest } from "../approval/digest.js";
import { deepFreeze } from "../util.js";

export function leasePayload(lease) {
  const { authenticity, ...payload } = lease;
  return payload;
}

export function issuePrivilegeLease({
  lease_id, request, policyDecision, approvalRecord = null, signer,
  issuer_ref = "broker", audience_ref, now = new Date(), ttl_seconds, max_uses,
}) {
  if (!signer) throw new Error("SIGNER_REQUIRED");
  if (!lease_id || !audience_ref) throw new Error("LEASE_BINDING_REQUIRED");
  const digest = normalizedRequestDigest(request);
  if (policyDecision?.normalized_request_digest !== digest) throw new Error("POLICY_DIGEST_MISMATCH");
  if (!["AUTO_APPROVE","HUMAN_REQUIRED"].includes(policyDecision?.outcome)) throw new Error("POLICY_NOT_APPROVED");
  if (policyDecision.outcome === "HUMAN_REQUIRED") {
    if (approvalRecord?.decision !== "APPROVE") throw new Error("HUMAN_APPROVAL_REQUIRED");
    if (approvalRecord.normalized_request_digest !== digest) throw new Error("APPROVAL_DIGEST_MISMATCH");
  }
  const normalized = normalizePrivilegeRequest(request);
  const start = new Date(now);
  const ttl = Math.min(Number(ttl_seconds ?? policyDecision.lease_bounds?.ttl_seconds ?? 900), Number(policyDecision.lease_bounds?.ttl_seconds ?? 900));
  const uses = Math.min(Number(max_uses ?? policyDecision.lease_bounds?.max_uses ?? 1), Number(policyDecision.lease_bounds?.max_uses ?? 1));
  const payload = deepFreeze({
    schema_version:1,
    lease_id,
    issuer_ref,
    subject_ref: normalized.requester_ref,
    audience_ref,
    node_uid: normalized.node_uid,
    request_id: normalized.request_id,
    normalized_request_digest:digest,
    policy_decision_ref:policyDecision.policy_decision_id ?? null,
    approval_ref:approvalRecord?.approval_record_id ?? null,
    policy_revision:policyDecision.policy_revision ?? normalized.policy_revision,
    allowed_operations:normalized.operations,
    not_before:start.toISOString(),
    expires_at:new Date(start.getTime()+ttl*1000).toISOString(),
    max_uses:Math.max(1, uses),
    effect_fence_namespace:"privilege/" + lease_id,
  });
  return deepFreeze({ ...payload, authenticity: signer.sign(payload) });
}
