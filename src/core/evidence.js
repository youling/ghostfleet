import { DEFAULT_ACCEPTANCE_EVIDENCE } from "./model.js";
import { assertPublicSafe } from "./security.js";

export function createEvidence({ type, source = "unknown", data = {}, at = new Date().toISOString() }) {
  if (!type || typeof type !== "string") throw new TypeError("evidence type is required");
  assertPublicSafe(data);
  return Object.freeze({ type, source, data: structuredClone(data), at });
}

export function missingAcceptanceEvidence(evidence, required = DEFAULT_ACCEPTANCE_EVIDENCE) {
  // The newest result supersedes prior observations, including an earlier PASS.
  const results = new Map((evidence ?? []).map((item) => [item.type, item]));
  const present = new Set([...results].filter(([, item]) => item.data?.status === "PASS").map(([type]) => type));
  return required.filter((type) => !present.has(type));
}
