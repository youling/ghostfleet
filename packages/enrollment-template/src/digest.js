/**
 * digest.js — canonical JSON + sha256 hex digest. Pure functions.
 * Canonical JSON: keys lexicographically sorted (recursive), no whitespace,
 * arrays order-preserved, ASCII-safe UTF-8 JSON (all non-ASCII escaped),
 * no NaN/Infinity.
 */

import { createHash } from "node:crypto";
import { normalizeTemplate, codedError } from "./normalize.js";

function escapeString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else if (code < 0x7f) out += ch;
    else if (code < 0x800) {
      // handled below via codePoint loop instead
      out += ch;
    } else {
      out += ch;
    }
  }
  // Second pass: replace non-ASCII chars with \uXXXX (surrogate pairs split).
  // eslint-disable-next-line no-control-regex
  return out.replace(/[^\x00-\x7F]/g, (c) => {
    const code = c.charCodeAt(0);
    return "\\u" + code.toString(16).padStart(4, "0");
  });
}

function canonicalize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw codedError("NON_FINITE_NUMBER", "NaN/Infinity not allowed in canonical JSON");
      }
      return JSON.stringify(value);
    case "string":
      return '"' + escapeString(value) + '"';
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map(canonicalize).join(",") + "]";
      }
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const k of keys) {
        const v = value[k];
        if (v === undefined || typeof v === "function" || typeof v === "symbol") {
          throw codedError("CANONICAL_NOT_SERIALIZABLE", `key ${k} is not JSON-serializable`);
        }
        parts.push('"' + escapeString(k) + '":' + canonicalize(v));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw codedError("CANONICAL_NOT_SERIALIZABLE", `type ${typeof value} is not JSON-serializable`);
  }
}

/** canonical JSON string of any JSON-shaped value. Pure, deterministic. */
export function canonicalJson(value) {
  return canonicalize(value);
}

/** sha256 hex of the canonical JSON of the normalized template. Pure. */
export function templateDigest(input) {
  const normalized = normalizeTemplate(input);
  const json = canonicalJson(normalized);
  return "sha256:" + createHash("sha256").update(json, "utf8").digest("hex");
}
