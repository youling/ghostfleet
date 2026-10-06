/**
 * normalize.js — pure, deterministic normalization for template objects.
 * No I/O, no mutation of input, fail-closed on untrusted shapes.
 */

import { FIELD_SPEC } from "./schema.js";

const KNOWN_KEYS = new Set(FIELD_SPEC.map((f) => f.name));

export function codedError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep-clone with cycle detection. Pure: never mutates input.
 * Throws {code:"CYCLE"} on circular references.
 */
export function deepClone(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw codedError("CYCLE", "circular reference detected");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => deepClone(v, seen));
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = deepClone(value[k], seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * normalizeTemplate(input) -> normalized plain object.
 * - input must be a non-null, non-array object (else {code:"NOT_OBJECT"})
 * - unknown top-level keys are rejected ({code:"UNKNOWN_KEY"})
 * - forbidden overlay-only or internal keys rejected ({code:"UNKNOWN_KEY"})
 * - circular references rejected ({code:"CYCLE"})
 * - returns a fresh deep copy; input is never mutated.
 */
export function normalizeTemplate(input) {
  if (!isPlainObject(input)) {
    throw codedError("NOT_OBJECT", "template must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) {
      throw codedError("UNKNOWN_KEY", `unknown top-level key: ${key}`);
    }
    if (key === "digest" || key === "attempt_binding") {
      throw codedError("UNKNOWN_KEY", `internal key not allowed on template: ${key}`);
    }
  }
  return deepClone(input);
}
