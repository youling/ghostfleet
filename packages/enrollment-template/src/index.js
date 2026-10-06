/**
 * index.js — public runtime API for @ghostfleet/enrollment-template.
 */

export { normalizeTemplate, deepClone, codedError } from "./normalize.js";
export { canonicalJson, templateDigest } from "./digest.js";
export { resolveTemplate, applyOverlay } from "./resolver.js";
export { validateTemplate } from "./validate.js";

export * from "./schema.js";
