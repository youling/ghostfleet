import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}
export function sha256(value) {
  return "sha256:" + createHash("sha256").update(typeof value === "string" ? value : canonicalStringify(value)).digest("hex");
}
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
