import { DEFAULT_ACCEPTANCE_EVIDENCE } from "./model.js";
import { assertPublicSafe } from "./security.js";

export function createEvidence({ type, source = "unknown", data = {}, at = new Date().toISOString() }) {
  if (!type || typeof type !== "string") throw new TypeError("evidence type is required");
  assertPublicSafe(data);
  return Object.freeze({ type, source, data: structuredClone(data), at });
}

export function missingAcceptanceEvidence(evidence, required = DEFAULT_ACCEPTANCE_EVIDENCE) {
  const present = new Set((evidence ?? []).map((item) => item.type));
  return required.filter((type) => !present.has(type));
}
