import { RiskClass } from "./model.js";
import { assertPublicSafe } from "./security.js";

export function validateCapabilityDefinition(definition) {
  assertPublicSafe(definition);
  if (!definition || typeof definition !== "object") throw new Error("CAPABILITY_DEFINITION_INVALID");
  if (!/^[a-z][a-z0-9.-]{2,80}$/.test(definition.id ?? "")) throw new Error("CAPABILITY_ID_INVALID");
  if (!Object.values(RiskClass).includes(definition.risk)) throw new Error("CAPABILITY_RISK_INVALID");
  return Object.freeze({
    id: definition.id,
    risk: definition.risk,
    description: String(definition.description ?? ""),
    adapter_contract: definition.adapter_contract ? structuredClone(definition.adapter_contract) : null,
  });
}
