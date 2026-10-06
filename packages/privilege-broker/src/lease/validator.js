import { leasePayload } from "./lease.js";
import { canonicalStringify } from "../util.js";
import { allow, deny } from "../types.js";

function revoked(leaseId, revocations) {
  return Array.isArray(revocations) && revocations.some((item) => item === leaseId || item?.lease_id === leaseId);
}
export function validatePrivilegeLease({
  lease, signer, context = {}, now = new Date(), revocations = [], policy_revision, use_count = 0,
}) {
  if (!lease) return deny("LEASE_REQUIRED");
  if (!signer?.verify?.(leasePayload(lease), lease.authenticity)) return deny("LEASE_AUTHENTICITY_INVALID");
  if (revoked(lease.lease_id, revocations)) return deny("LEASE_REVOKED");
  const at = new Date(now).getTime();
  if (!(at >= Date.parse(lease.not_before))) return deny("LEASE_NOT_YET_VALID");
  if (!(at < Date.parse(lease.expires_at))) return deny("LEASE_EXPIRED");
  if (policy_revision && lease.policy_revision !== policy_revision) return deny("POLICY_REVISION_STALE");
  if (Number(use_count) >= Number(lease.max_uses)) return deny("LEASE_USE_LIMIT");
  if (context.node_uid && lease.node_uid !== context.node_uid) return deny("LEASE_NODE_MISMATCH");
  if (context.subject_ref && lease.subject_ref !== context.subject_ref) return deny("LEASE_SUBJECT_MISMATCH");
  if (context.audience_ref && lease.audience_ref !== context.audience_ref) return deny("LEASE_AUDIENCE_MISMATCH");

  if (context.operation_id) {
    const allowedOp = lease.allowed_operations.find((op) => op.operation_id === context.operation_id && op.scope_ref === (context.scope_ref ?? null));
    if (!allowedOp) return deny("LEASE_OPERATION_SCOPE_MISMATCH");
    if (context.parameters !== undefined && canonicalStringify(allowedOp.parameters) !== canonicalStringify(context.parameters)) {
      return deny("LEASE_PARAMETER_MISMATCH");
    }
  }
  return allow({ lease_id: lease.lease_id });
}
