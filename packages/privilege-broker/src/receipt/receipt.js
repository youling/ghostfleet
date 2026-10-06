import { deepFreeze } from "../util.js";

const RESULTS = new Set(["SUCCESS","DENIED","FAILED","RECONCILE_REQUIRED"]);
export function createPrivilegeReceipt(input = {}) {
  if (!RESULTS.has(input.result)) throw new Error("INVALID_RECEIPT_RESULT");
  return deepFreeze({
    receipt_id: input.receipt_id,
    lease_id: input.lease_id ?? null,
    request_id: input.request_id ?? null,
    operation_id: input.operation_id ?? null,
    effect_ref: input.effect_ref ?? null,
    result: input.result,
    before_state_ref: input.before_state_ref ?? null,
    after_state_ref: input.after_state_ref ?? null,
    recovery_ref: input.recovery_ref ?? null,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
  });
}
