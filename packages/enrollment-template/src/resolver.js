/**
 * resolver.js — extends-chain resolution, overlay application, cycle detection.
 * All fail-closed: every rejection throws an Error with a `.code`.
 */

import {
  OVERLAY_FORBIDDEN_TOP_LEVEL_KEYS,
  OVERLAY_IMMUTABLE_FIELDS,
  isOverlayKeyAllowed,
  isValidExtendsRef,
  isUnknownOption,
  touchesImmutableField,
} from "./schema.js";
import { codedError, deepClone } from "./normalize.js";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function mergeObjects(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over)) {
    if (isPlainObject(base[k]) && isPlainObject(over[k])) {
      out[k] = mergeObjects(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function refOf(t) {
  if (!isPlainObject(t) || typeof t.template_id !== "string") return null;
  return `${t.template_id}@${t.generation}`;
}

/**
 * applyOverlay(parentTemplate, overlay) — validate and merge one overlay.
 * Throws coded errors:
 *  NOT_OBJECT, OVERLAY_IMMUTABLE_FIELD, OVERLAY_FORBIDDEN_KEY,
 *  OVERLAY_KEY_NOT_ALLOWED
 */
export function applyOverlay(parentTemplate, overlay) {
  if (!isPlainObject(overlay)) throw codedError("NOT_OBJECT", "overlay must be a plain object");
  if (!isPlainObject(parentTemplate)) throw codedError("NOT_OBJECT", "parent must be a plain object");
  const keys = Object.keys(overlay);
  if (touchesImmutableField(keys)) {
    const bad = keys.find((k) => OVERLAY_FORBIDDEN_TOP_LEVEL_KEYS.includes(k));
    throw codedError("OVERLAY_IMMUTABLE_FIELD", `overlay touches forbidden/immutable key: ${bad}`);
  }
  for (const k of keys) {
    if (!isOverlayKeyAllowed(parentTemplate.overridable_options, k)) {
      throw codedError("OVERLAY_KEY_NOT_ALLOWED", `overlay key not in overridable_options: ${k}`);
    }
  }
  return mergeObjects(deepClone(parentTemplate), deepClone(overlay));
}

/**
 * resolveTemplate(template, options) -> resolved template (fresh object).
 * options:
 *   resolveParent(ref) -> parent template object (required if extends non-null)
 *   overlays?: array of overlay objects applied in order after extends resolution
 *   knownProviderOptions?: array of known provider option keys
 *
 * Throws coded errors for: NOT_OBJECT, INVALID_EXTENDS, MULTI_PARENT_EXTENDS,
 * CYCLE, UNKNOWN_OPTION, and coded errors from applyOverlay.
 */
export function resolveTemplate(template, options = {}) {
  if (!isPlainObject(template)) throw codedError("NOT_OBJECT", "template must be a plain object");
  // Backwards-compatible overlay form: resolveTemplate(template, overlay) or
  // resolveTemplate(template, [overlay, ...]) when `options` is not an
  // options bag (i.e. lacks resolveParent/overlays/knownProviderOptions keys).
  if (isPlainObject(options) && !("resolveParent" in options) && !("overlays" in options) && !("knownProviderOptions" in options)) {
    return applyOverlay(template, options);
  }
  if (Array.isArray(options)) {
    let merged = deepClone(template);
    for (const ov of options) merged = applyOverlay(merged, ov);
    return merged;
  }
  const { resolveParent, overlays = [], knownProviderOptions } = options;
  if (resolveParent !== undefined && typeof resolveParent !== "function") {
    throw codedError("BAD_OPTIONS", "resolveParent must be a function");
  }
  if (!Array.isArray(overlays)) throw codedError("BAD_OPTIONS", "overlays must be an array");

  // extends chain resolution with cycle detection
  const chain = [];
  const seen = new Set();
  let current = template;
  while (current && current.extends != null) {
    if (typeof current.extends !== "string") {
      throw codedError("INVALID_EXTENDS", "extends must be a string or null");
    }
    if (current.extends.includes(",") || current.extends.includes(";") || current.extends.includes(" ")) {
      throw codedError("MULTI_PARENT_EXTENDS", "multi-parent extends is not allowed");
    }
    if (!isValidExtendsRef(current.extends)) {
      throw codedError("INVALID_EXTENDS", `invalid extends ref: ${current.extends}`);
    }
    const key = refOf(current) ?? current.extends;
    const lineage = current.template_id != null ? String(current.template_id) : current.extends;
    if (seen.has(lineage)) throw codedError("CYCLE", `extends cycle at ${lineage}`);
    seen.add(lineage);
    chain.push(current);
    if (typeof resolveParent !== "function") {
      throw codedError("NO_PARENT_RESOLVER", "resolveParent required to resolve extends");
    }
    const parent = resolveParent(current.extends);
    if (!isPlainObject(parent)) throw codedError("PARENT_NOT_FOUND", `parent not found: ${current.extends}`);
    current = parent;
  }

  // merge from root of chain down to the template itself
  let merged = deepClone(current);
  for (let i = chain.length - 1; i >= 0; i--) {
    const child = chain[i];
    // immutable identity fields of the child win for its own lineage; all
    // other fields override the parent.
    merged = mergeObjects(merged, deepClone(child));
  }

  // overlays, in order
  for (const ov of overlays) {
    merged = applyOverlay(merged, ov);
  }

  // unknown provider option keys fail closed when a known list is supplied
  if (knownProviderOptions !== undefined && isPlainObject(merged.provider_options)) {
    for (const k of Object.keys(merged.provider_options)) {
      if (isUnknownOption(knownProviderOptions, k)) {
        throw codedError("UNKNOWN_OPTION", `unknown provider option key: ${k}`);
      }
    }
  }

  return merged;
}
