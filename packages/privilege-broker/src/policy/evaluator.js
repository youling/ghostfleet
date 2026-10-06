import { normalizedRequestDigest } from "../approval/digest.js";
import { maxRisk, POLICY_OUTCOMES } from "../types.js";
import { deepFreeze } from "../util.js";

function recoverySatisfied(operation, requirement) {
  if (requirement === "NONE") return true;
  const recovery = operation?.recovery;
  if (!recovery || recovery.mode !== requirement) return false;
  if (requirement === "IRREVERSIBLE") return Boolean(recovery.ref);
  return Boolean(recovery.ref ?? recovery.plan_ref);
}

export function evaluatePrivilegeRequest(request, { registry, deploymentPolicy = {} } = {}) {
  if (!registry) throw new Error("REGISTRY_REQUIRED");
  const operations = Array.isArray(request?.operations) ? request.operations : [];
  if (!operations.length) return deepFreeze({
    outcome:"REJECT", derived_risk:"HIGH", reason_codes:["OPERATIONS_REQUIRED"],
    normalized_request_digest: normalizedRequestDigest(request), policy_revision: request?.policy_revision ?? null,
  });

  let derivedRisk = "LOW";
  let auto = true;
  let ttl = Number(request?.requested_ttl_seconds ?? 0) || Infinity;
  let maxUses = Number(request?.requested_max_uses ?? 1) || 1;
  const reasons = [];

  for (const operation of operations) {
    const policy = registry.get(operation.operation_id);
    if (!policy) {
      reasons.push("UNKNOWN_OPERATION");
      return deepFreeze({
        outcome:"REJECT", derived_risk:maxRisk(derivedRisk,"HIGH"), reason_codes:reasons,
        normalized_request_digest:normalizedRequestDigest(request), policy_revision:request?.policy_revision ?? null,
      });
    }
    derivedRisk = maxRisk(derivedRisk, policy.risk_floor);
    ttl = Math.min(ttl, policy.max_ttl_seconds);
    maxUses = Math.min(maxUses, policy.max_uses);
    if (!recoverySatisfied(operation, policy.recovery_requirement)) {
      reasons.push("RECOVERY_REQUIRED");
      return deepFreeze({
        outcome:"REJECT", derived_risk:maxRisk(derivedRisk,"HIGH"), reason_codes:reasons,
        normalized_request_digest:normalizedRequestDigest(request), policy_revision:request?.policy_revision ?? null,
      });
    }
    if (!policy.auto_approvable || policy.recovery_requirement === "IRREVERSIBLE") auto = false;
  }

  if (deploymentPolicy.minimum_risk) derivedRisk = maxRisk(derivedRisk, deploymentPolicy.minimum_risk);
  if (deploymentPolicy.force_human === true) auto = false;
  if (Array.isArray(deploymentPolicy.force_human_operations) &&
      operations.some((op) => deploymentPolicy.force_human_operations.includes(op.operation_id))) auto = false;
  if (["HIGH","CRITICAL"].includes(derivedRisk)) auto = false;

  const outcome = auto ? "AUTO_APPROVE" : "HUMAN_REQUIRED";
  if (!POLICY_OUTCOMES.includes(outcome)) throw new Error("INVALID_POLICY_OUTCOME");
  return deepFreeze({
    policy_decision_id: request?.policy_decision_id ?? null,
    normalized_request_digest: normalizedRequestDigest(request),
    policy_revision: request?.policy_revision ?? null,
    derived_risk: derivedRisk,
    outcome,
    reason_codes: reasons,
    lease_bounds: {
      ttl_seconds: Number.isFinite(ttl) ? ttl : 900,
      max_uses: Math.max(1, maxUses),
    },
  });
}
