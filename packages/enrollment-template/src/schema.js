/**
 * Enrollment Template v0 — lifecycle-neutral contract constants and pure
 * predicate helpers. No resolver/validator/normalizer/digest implementation
 * lives here (that is the runtime lane's job); this module only freezes the
 * shape, allowed vocabularies, and fail-closed classification rules.
 */

export const TEMPLATE_VERSION_V0 = "enrollment-template/v0";

export const TEMPLATE_PROTOCOL = "ghostfleet-enrollment-template/v0";

/** Semver structure of the template's own version field. */
export const SEMVER_STRUCT = Object.freeze({
  type: "object",
  required: ["major", "minor", "patch"],
  shape: {major: "nonNegativeInteger", minor: "nonNegativeInteger", patch: "nonNegativeInteger", prerelease: "string|optional", build: "string|optional"},
});

/** Allowed platform values for the platform constraint. */
export const PLATFORM_VALUES = Object.freeze(["linux", "windows", "android", "macos"]);

/** Allowed role values for the roles constraint. */
export const ROLE_VALUES = Object.freeze(["server", "workstation", "edge", "phone", "iot"]);

/** HumanGate posture vocabulary. */
export const HUMANGATE_VALUES = Object.freeze(["required", "optional", "none"]);

/** Recovery/break-glass requirement vocabulary. */
export const RECOVERY_VALUES = Object.freeze(["required", "optional", "none"]);

/** Consumer-acceptance posture vocabulary. */
export const ACCEPTANCE_VALUES = Object.freeze(["strict", "standard", "minimal"]);

/** Lifecycle-neutral field spec. `immutable: true` fields must survive overlays untouched. */
export const FIELD_SPEC = Object.freeze([
  {name: "template_id", type: "string", required: true, immutable: true, note: "stable, unique, non-empty, no secret/topology material"},
  {name: "version", type: "semver-struct", required: true, immutable: true, note: "{major,minor,patch[,prerelease][,build]}"},
  {name: "generation", type: "positiveInteger", required: true, immutable: true, note: "monotonic per template_id; bump on any semantic change"},
  {name: "platform", type: "enum(PLATFORM_VALUES)", required: true, immutable: false, note: "target platform constraint"},
  {name: "roles", type: "array(enum(ROLE_VALUES))", required: true, immutable: false, note: "allowed management roles"},
  {name: "capabilities", type: "array(string)", required: true, immutable: false, note: "management capability list, e.g. remote_shell, file_transfer"},
  {name: "transport", type: "string", required: true, immutable: false, note: "transport reference, e.g. provider-neutral name or adapter id"},
  {name: "provider_options", type: "object", required: true, immutable: false, note: "provider option references; values must be refs, never secrets"},
  {name: "overridable_options", type: "array(string)", required: true, immutable: false, note: "allowlist of keys a user/overlay may override"},
  {name: "privilege_broker_required", type: "boolean", required: true, immutable: false, note: "whether privileged ops must route through Privilege Broker"},
  {name: "helper", type: "object|null", required: true, immutable: false, note: "helper requirement descriptor or null when not required"},
  {name: "humangate", type: "enum(HUMANGATE_VALUES)", required: true, immutable: false, note: "HumanGate posture"},
  {name: "recovery", type: "enum(RECOVERY_VALUES)|object", required: true, immutable: false, note: "break-glass/recovery requirement"},
  {name: "acceptance", type: "enum(ACCEPTANCE_VALUES)", required: true, immutable: false, note: "consumer-acceptance posture"},
  {name: "bootstrap", type: "object", required: true, immutable: false, note: "bootstrap requirements (refs only, no inline secrets)"},
  {name: "extends", type: "string|null", required: true, immutable: false, note: "single parent template reference (template_id@generation or digest); no multi-parent"},
]);

/** Fields an overlay must never modify. */
export const OVERLAY_IMMUTABLE_FIELDS = Object.freeze(
  FIELD_SPEC.filter((f) => f.immutable).map((f) => f.name),
);

/** Overlay may only touch keys listed in the parent's overridable_options. */
export const OVERLAY_ALLOWED_SCOPE_NOTE =
  "overlay keys must be a subset of parent.overridable_options; any other key is rejected";

/** Template-level reserved keys that overlays can never introduce. */
export const OVERLAY_FORBIDDEN_TOP_LEVEL_KEYS = Object.freeze([
  ...OVERLAY_IMMUTABLE_FIELDS,
  "extends",
  "digest",
  "attempt_binding",
]);

// ---- secret-safe rendering/reference ----

/** Prefix identifying an allowed secret reference (never a value). */
export const SECRET_REF_PREFIX = "secret://";

/** Alternative allowed reference shapes. */
export const SECRET_REF_PREFIXES = Object.freeze([SECRET_REF_PREFIX, "ref:", "env:"]);

/** Patterns that mark a value as a plaintext secret shape and must be rejected. */
export const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bpassword\s*[:=]\s*\S+/i,
  /\bpasswd\s*[:=]\s*\S+/i,
  /\btoken\s*[:=]\s*\S+/i,
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*(?!\/\/)\S+/i,
  /\bprivate[_-]?key\s*[:=]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._-]+/i,
  /\bxox[baprs]-[A-Za-z0-9-]+/,
]);

/** True when the value is an allowed reference form (secret://, ref:, env:). */
export function isSecretReference(value) {
  return typeof value === "string" && SECRET_REF_PREFIXES.some((p) => value.startsWith(p));
}

/** True when the value matches a plaintext-secret shape that schema must reject. */
export function looksLikePlaintextSecret(value) {
  return typeof value === "string" && SECRET_PATTERNS.some((re) => re.test(value));
}

/** True when a secret-typed field value is acceptable (a ref), false when inline or plaintext-shaped. */
export function isSecretSafeValue(value) {
  if (typeof value !== "string") return false;
  if (looksLikePlaintextSecret(value)) return false;
  return isSecretReference(value);
}

// ---- UNKNOWN / fail-closed predicates ----

/** Fail closed: any provider/option key not in the known allowlist is UNKNOWN and rejected. */
export function isUnknownOption(knownKeys, key) {
  if (!Array.isArray(knownKeys)) return true;
  return !knownKeys.includes(key);
}

/** Overlay key allowed only if declared in the parent's overridable_options allowlist. */
export function isOverlayKeyAllowed(parentOverridableOptions, key) {
  if (!Array.isArray(parentOverridableOptions)) return false;
  return parentOverridableOptions.includes(key);
}

/** Overlay must not modify immutable identity/version fields. */
export function touchesImmutableField(overlayKeys) {
  if (!Array.isArray(overlayKeys)) return true;
  return overlayKeys.some((k) => OVERLAY_IMMUTABLE_FIELDS.includes(k) || OVERLAY_FORBIDDEN_TOP_LEVEL_KEYS.includes(k));
}

/** Semver structure check (shape only; no range resolution). */
export function isValidSemverStruct(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const int = (n) => Number.isInteger(n) && n >= 0;
  if (!int(v.major) || !int(v.minor) || !int(v.patch)) return false;
  if (v.prerelease !== undefined && typeof v.prerelease !== "string") return false;
  if (v.build !== undefined && typeof v.build !== "string") return false;
  return true;
}

/** Generation must be a positive integer (>= 1). */
export function isValidGeneration(n) {
  return Number.isInteger(n) && n >= 1;
}

/** platform must be one of the allowed values. */
export function isKnownPlatform(p) {
  return PLATFORM_VALUES.includes(p);
}

/** roles must be a non-empty list drawn from ROLE_VALUES. */
export function isValidRoles(roles) {
  return Array.isArray(roles) && roles.length > 0 && roles.every((r) => ROLE_VALUES.includes(r));
}

/** humangate/recovery/acceptance vocab checks (exact, no fuzzy match). */
export function isKnownEnumValue(vocab, value) {
  return Array.isArray(vocab) && vocab.includes(value);
}

// ---- deterministic normalization + digest contract (interface only) ----

export const CANONICAL_JSON_RULES = Object.freeze({
  encoding: "utf-8",
  key_order: "lexicographic, recursive over objects",
  whitespace: "none (no spaces/newlines)",
  numbers: "JSON grammar, no leading zeros, no NaN/Infinity",
  arrays: "order preserved, elements canonicalized",
  trailing_commas: "forbidden",
});

export const DIGEST_CONTRACT = Object.freeze({
  algorithm: "sha256",
  input: "canonical JSON string of the normalized template object",
  output: "lowercase hex, 64 chars; common prefix form 'sha256:<hex>'",
  determinism: "normalizer is a pure function; same input -> same canonical JSON -> same digest",
});

// ---- immutable binding between template generation and EnrollmentAttempt ----

export const ATTEMPT_BINDING_RULE = Object.freeze({
  record_fields: ["template_id", "generation", "digest"],
  rule: "every approval/attempt record MUST capture template_id + generation + digest of the template version it was created against; any template change that alters generation or digest invalidates silent inheritance — old approvals/attempts must not be reused without a new explicit binding",
  stale_detection: "compare recorded binding against current normalized digest; mismatch -> fail closed, require new approval/attempt",
});

/** True when an overlay object is structurally inadmissible regardless of normalizer. */
export function isInadmissibleOverlay(overlay, parent) {
  if (overlay === null || typeof overlay !== "object" || Array.isArray(overlay)) return true;
  const keys = Object.keys(overlay);
  if (touchesImmutableField(keys)) return true;
  if (parent && Array.isArray(parent.overridable_options)) {
    for (const k of keys) if (!isOverlayKeyAllowed(parent.overridable_options, k)) return true;
  }
  return false;
}

/** extends must be a single parent reference of shape "<template_id>@<generation>" or "<template_id>#sha256:<hex>". */
export function isValidExtendsRef(ref) {
  if (ref === null) return true;
  if (typeof ref !== "string" || ref.length === 0 || ref.includes(",") || ref.includes(";")) return false;
  return /^[A-Za-z0-9._/-]+@[1-9][0-9]*$/.test(ref) || /^[A-Za-z0-9._/-]+#sha256:[0-9a-f]{64}$/.test(ref);
}
