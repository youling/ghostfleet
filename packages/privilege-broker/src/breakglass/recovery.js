import { deepFreeze } from "../util.js";

export function createRecoveryAttempt({ recovery_attempt_id, target_ref, reason_ref }) {
  return deepFreeze({ recovery_attempt_id, target_ref, reason_ref, state:"CREATED" });
}
export function authorizeRecovery(attempt, { authority_type, authority_ref }) {
  if (attempt.state !== "CREATED") throw new Error("RECOVERY_NOT_CREATED");
  if (authority_type !== "HUMAN") return deepFreeze({ ...attempt, state:"DENIED", reason_code:"HUMAN_RECOVERY_GATE_REQUIRED" });
  return deepFreeze({ ...attempt, state:"HUMAN_AUTHORIZED", authority_ref });
}
export function startRecovery(attempt) {
  if (attempt.state !== "HUMAN_AUTHORIZED") throw new Error("RECOVERY_NOT_AUTHORIZED");
  return deepFreeze({ ...attempt, state:"ACTIVE_RECOVERY" });
}
export function finishRecovery(attempt, outcome) {
  if (!["RECOVERED","FAILED","RECONCILE_REQUIRED"].includes(outcome)) throw new Error("INVALID_RECOVERY_OUTCOME");
  if (attempt.state !== "ACTIVE_RECOVERY" && attempt.state !== "RECONCILE_REQUIRED") throw new Error("RECOVERY_NOT_ACTIVE");
  return deepFreeze({ ...attempt, state:outcome });
}
export function ordinaryAgentBreakGlassRequest() {
  return deepFreeze({ ok:false, outcome:"DENY", code:"BREAK_GLASS_NOT_ORDINARY_AGENT_AUTHORITY" });
}
