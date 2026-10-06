import { normalizedRequestDigest } from "./digest.js";
import { deepFreeze } from "../util.js";

export function createApprovalRequest({ approval_request_id, request, expires_at }) {
  if (!approval_request_id) throw new Error("APPROVAL_REQUEST_ID_REQUIRED");
  return deepFreeze({
    approval_request_id,
    request_id: request?.request_id ?? null,
    normalized_request_digest: normalizedRequestDigest(request),
    state: "PENDING",
    expires_at,
  });
}

export function resolveApproval(approvalRequest, { approval_record_id, approver_ref, decision, decided_at, digest }) {
  if (approvalRequest?.state !== "PENDING") throw new Error("APPROVAL_NOT_PENDING");
  if (!["APPROVE","DENY"].includes(decision)) throw new Error("INVALID_APPROVAL_DECISION");
  if (digest && digest !== approvalRequest.normalized_request_digest) throw new Error("APPROVAL_DIGEST_MISMATCH");
  return deepFreeze({
    approval_record_id,
    approval_request_id: approvalRequest.approval_request_id,
    normalized_request_digest: approvalRequest.normalized_request_digest,
    approver_ref,
    decision,
    decided_at,
  });
}
