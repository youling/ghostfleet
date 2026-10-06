import { RISKS, RECOVERY_MODES } from "../types.js";
import { deepFreeze } from "../util.js";

export function createOperationRegistry(entries = []) {
  const map = new Map();
  for (const raw of entries) {
    const operation_id = String(raw?.operation_id ?? "");
    if (!operation_id) throw new Error("OPERATION_ID_REQUIRED");
    if (map.has(operation_id)) throw new Error("DUPLICATE_OPERATION");
    const risk_floor = raw.risk_floor ?? "HIGH";
    const recovery_requirement = raw.recovery_requirement ?? "NONE";
    if (!RISKS.includes(risk_floor)) throw new Error("INVALID_RISK");
    if (!RECOVERY_MODES.includes(recovery_requirement)) throw new Error("INVALID_RECOVERY");
    map.set(operation_id, deepFreeze({
      operation_id,
      risk_floor,
      auto_approvable: Boolean(raw.auto_approvable),
      recovery_requirement,
      max_ttl_seconds: Number(raw.max_ttl_seconds ?? 900),
      max_uses: Number(raw.max_uses ?? 1),
    }));
  }
  return Object.freeze({
    has: (id) => map.has(id),
    get: (id) => map.get(id) ?? null,
    list: () => [...map.values()],
  });
}
