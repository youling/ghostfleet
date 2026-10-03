import { RiskClass } from "./model.js";

export const DEFAULT_CAPABILITIES = Object.freeze([
  { id: "system.info", risk: RiskClass.R0, description: "Read bounded system identity and health information." },
  { id: "file.read", risk: RiskClass.R0, description: "Read files within a policy-approved scope." },
  { id: "file.write", risk: RiskClass.R1, description: "Write files within a policy-approved scope." },
  { id: "docker.inspect", risk: RiskClass.R0, description: "Inspect container runtime state." },
  { id: "docker.restart", risk: RiskClass.R1, description: "Restart an explicitly selected container or service." },
  { id: "browser.control", risk: RiskClass.R1, description: "Drive a policy-approved browser automation surface." },
  { id: "android.ui", risk: RiskClass.R1, description: "Drive a policy-approved Android UI automation surface." },
  { id: "legacy.exec", risk: RiskClass.R2, description: "Compatibility escape hatch for arbitrary command execution.", deprecated_primary_surface: true },
]);

export function defaultApprovalPolicy(definition) {
  if (definition.risk === RiskClass.R0) return { decision: "AUTO_APPROVE", human_gate: false };
  return {
    decision: "REQUIRE_HUMAN",
    human_gate: true,
    reason: definition.risk === RiskClass.R2
      ? "sensitive capability requires explicit human approval"
      : "bounded mutation requires approval under the V0 default policy",
  };
}
