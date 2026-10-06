export const RISKS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const RECOVERY_MODES = Object.freeze(["NONE", "ROLLBACK", "COMPENSATING", "IRREVERSIBLE"]);
export const POLICY_OUTCOMES = Object.freeze(["AUTO_APPROVE", "HUMAN_REQUIRED", "REJECT"]);
export const LEASE_RESULTS = Object.freeze(["ALLOW", "DENY"]);

export function riskRank(value) {
  const index = RISKS.indexOf(value);
  return index < 0 ? -1 : index;
}
export function maxRisk(...values) {
  return values.reduce((best, value) => riskRank(value) > riskRank(best) ? value : best, "LOW");
}
export function deny(code, details = {}) {
  return Object.freeze({ ok: false, outcome: "DENY", code, ...details });
}
export function allow(details = {}) {
  return Object.freeze({ ok: true, outcome: "ALLOW", ...details });
}
