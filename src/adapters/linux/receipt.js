import { assertPublicSafe } from "../../core/security.js";

export const LINUX_RECEIPT_PROTOCOL = "ghostfleet-linux-receipt/v1";
export const LINUX_BINDING_PROTOCOL = "ghostfleet-linux-binding/v1";
export const LINUX_CONVERGENCE_ENGINES = Object.freeze(["fleet-linux-converger/v1", "fleet-enroll-bootstrap/v2-r1"]);
export const LINUX_EVIDENCE_TYPES = Object.freeze([
  "transport.ready", "bootstrap.report", "control.canary",
  "convergence.zero_delta", "reboot.recovered",
]);

const HASH = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9._-]{2,127}$/;
// References are opaque handles, never URLs, paths or access-bearing values.
const REF = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUBJECT_KEYS = ["machine_id_digest", "provider_identity_digest", "boot_id_digest"];
const BINDING_KEYS = ["protocol", "attempt_id", "node_uid", "lifecycle", "enrollment_id", "adapter_id", "observer_id", "credential_ref", "source_revision", "subject", "reboot_checkpoint", "expires_at", "max_age_seconds"];
const RECEIPT_KEYS = ["protocol", "type", "operation_id", "attempt_id", "node_uid", "enrollment_id", "adapter_id", "observer_id", "credential_ref", "source_revision", "subject", "observed_at", "outcome", "receipt_ref", "facts"];
const VERIFICATION_KEYS = ["verified", "receipt_digest", "nonce", "observer_id", "credential_ref", "source_revision", "current_subject", "observed_at"];
const FACT_KEYS = {
  "transport.ready": ["external_observation", "authenticated", "host_pin_matches", "provider_running"],
  "bootstrap.report": ["completion_verified", "report_digest", "checkpoint_digest"],
  "control.canary": ["operation", "risk", "receipt_verified"],
  "convergence.zero_delta": ["engine", "outcome", "execution_verified", "repeat", "plan_digest", "before_state_digest", "after_state_digest", "material_delta", "lifecycle_promoted"],
  "reboot.recovered": ["scheduled_checkpoint_ref", "dispatch_ref", "before_boot_digest", "after_boot_digest", "recovered_transport", "recovered_control", "recovered_identity"],
};

export class LinuxReceiptError extends Error {
  constructor(code) { super(code); this.name = "LinuxReceiptError"; this.code = code; }
}
function requireThat(condition, code) { if (!condition) throw new LinuxReceiptError(code); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys, code) {
  requireThat(object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), code);
}
function subject(value) {
  exact(value, SUBJECT_KEYS, "LINUX_SUBJECT_INVALID");
  requireThat(SUBJECT_KEYS.every((key) => HASH.test(value[key])), "LINUX_SUBJECT_INVALID");
}
function timestamp(value) {
  requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), "LINUX_TIME_INVALID");
  const parsed = Date.parse(value);
  requireThat(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, "LINUX_TIME_INVALID");
  return parsed;
}
function fresh(value, now, maxAge) {
  const at = timestamp(value);
  requireThat(at <= now && now - at <= maxAge * 1000, "LINUX_RECEIPT_STALE");
}
function matches(left, right, keys) { return keys.every((key) => left[key] === right[key]); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

/** Digest the strict receipt envelope; the private observer uses the same digest. */
export async function linuxReceiptDigest(receipt) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical(receipt)));
  requireThat(encoded.byteLength <= 16384, "LINUX_RECEIPT_TOO_LARGE");
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return "sha256:" + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** This binding is installed by the private owner, never selected by a device/request. */
export function validateLinuxBinding(value, now = Date.now()) {
  assertPublicSafe(value);
  exact(value, BINDING_KEYS, "LINUX_BINDING_INVALID");
  requireThat(value.protocol === LINUX_BINDING_PROTOCOL && value.lifecycle === "PROVISIONAL", "LINUX_BINDING_INVALID");
  for (const key of ["attempt_id", "node_uid", "enrollment_id", "adapter_id", "observer_id"]) requireThat(typeof value[key] === "string" && ID.test(value[key]), "LINUX_BINDING_INVALID");
  requireThat(value.attempt_id.startsWith("attempt-") && value.node_uid.startsWith("node-"), "LINUX_BINDING_INVALID");
  requireThat(REF.test(value.credential_ref) && REVISION.test(value.source_revision), "LINUX_BINDING_INVALID");
  requireThat(Number.isInteger(value.max_age_seconds) && value.max_age_seconds >= 1 && value.max_age_seconds <= 300, "LINUX_BINDING_INVALID");
  subject(value.subject);
  if (value.reboot_checkpoint !== null) {
    exact(value.reboot_checkpoint, ["checkpoint_ref", "dispatch_ref", "before_boot_digest"], "LINUX_REBOOT_CHECKPOINT_INVALID");
    requireThat(REF.test(value.reboot_checkpoint.checkpoint_ref) && REF.test(value.reboot_checkpoint.dispatch_ref) && value.reboot_checkpoint.before_boot_digest === value.subject.boot_id_digest, "LINUX_REBOOT_CHECKPOINT_INVALID");
  }
  requireThat(timestamp(value.expires_at) > now, "LINUX_BINDING_EXPIRED");
  return structuredClone(value);
}

function validateFacts(type, facts, successful, binding, receipt) {
  exact(facts, FACT_KEYS[type], "LINUX_FACTS_INVALID");
  const booleans = {
    "transport.ready": FACT_KEYS[type],
    "bootstrap.report": ["completion_verified"],
    "control.canary": ["receipt_verified"],
    "convergence.zero_delta": ["execution_verified", "repeat", "lifecycle_promoted"],
    "reboot.recovered": ["recovered_transport", "recovered_control", "recovered_identity"],
  }[type];
  requireThat(booleans.every((key) => typeof facts[key] === "boolean"), "LINUX_FACTS_INVALID");
  const digestKeys = FACT_KEYS[type].filter((key) => key.endsWith("_digest"));
  requireThat(digestKeys.every((key) => typeof facts[key] === "string" && HASH.test(facts[key])), "LINUX_FACTS_INVALID");
  if (type === "control.canary") requireThat(facts.operation === "node_inspect" && facts.risk === "R0", "LINUX_CONTROL_SCOPE_INVALID");
  if (type === "convergence.zero_delta") {
    requireThat(LINUX_CONVERGENCE_ENGINES.includes(facts.engine) && facts.outcome === "PRIMARY_CONVERGED" && Array.isArray(facts.material_delta) && facts.material_delta.every((item) => typeof item === "string" && ID.test(item)), "LINUX_CONVERGENCE_INVALID");
    if (successful) requireThat(facts.repeat && facts.execution_verified && !facts.lifecycle_promoted && facts.material_delta.length === 0 && facts.before_state_digest === facts.after_state_digest, "LINUX_MATERIAL_DELTA_PRESENT");
  } else if (type === "reboot.recovered") {
    requireThat(REF.test(facts.scheduled_checkpoint_ref) && REF.test(facts.dispatch_ref), "LINUX_REBOOT_CHECKPOINT_INVALID");
    requireThat(binding.reboot_checkpoint !== null && facts.scheduled_checkpoint_ref === binding.reboot_checkpoint.checkpoint_ref && facts.dispatch_ref === binding.reboot_checkpoint.dispatch_ref, "LINUX_REBOOT_CHECKPOINT_CONFLICT");
    requireThat(facts.before_boot_digest === binding.subject.boot_id_digest, "LINUX_REBOOT_CHECKPOINT_CONFLICT");
    if (successful) requireThat(facts.after_boot_digest === receipt.subject.boot_id_digest && facts.before_boot_digest !== facts.after_boot_digest, "LINUX_REBOOT_NOT_OBSERVED");
  }
  if (successful) requireThat(booleans.filter((key) => key !== "lifecycle_promoted").every((key) => facts[key] === true), "LINUX_POSTCONDITION_FAILED");
}

/**
 * No source label authenticates a receipt. verifyReceipt must resolve the receipt
 * through an independently authenticated observer in private custody. It must
 * return a fresh, nonce-bound attestation of this exact digest/current subject.
 */
export async function validateLinuxReceipt(input, configuredBinding, { verifyReceipt, clock = Date, signal } = {}) {
  requireThat(!signal?.aborted, "LINUX_OBSERVATION_TIMEOUT");
  const now = clock.now();
  const binding = validateLinuxBinding(configuredBinding, now);
  assertPublicSafe(input);
  exact(input, RECEIPT_KEYS, "LINUX_RECEIPT_INVALID");
  requireThat(input.protocol === LINUX_RECEIPT_PROTOCOL && LINUX_EVIDENCE_TYPES.includes(input.type), "LINUX_RECEIPT_INVALID");
  requireThat(typeof input.operation_id === "string" && ID.test(input.operation_id) && typeof input.receipt_ref === "string" && REF.test(input.receipt_ref), "LINUX_RECEIPT_INVALID");
  requireThat(["SUCCEEDED", "FAILED", "UNKNOWN"].includes(input.outcome), "LINUX_OUTCOME_INVALID");
  requireThat(matches(input, binding, ["attempt_id", "node_uid", "enrollment_id", "adapter_id", "observer_id", "credential_ref", "source_revision"]), "LINUX_RECEIPT_BINDING_MISMATCH");
  subject(input.subject);
  requireThat(matches(input.subject, binding.subject, ["machine_id_digest", "provider_identity_digest"]), "LINUX_RECEIPT_SUBJECT_MISMATCH");
  if (input.type !== "reboot.recovered") requireThat(input.subject.boot_id_digest === binding.subject.boot_id_digest, "LINUX_RECEIPT_BOOT_CONFLICT");
  fresh(input.observed_at, now, binding.max_age_seconds);
  const receipt = structuredClone(input);
  validateFacts(receipt.type, receipt.facts, receipt.outcome === "SUCCEEDED", binding, receipt);
  requireThat(typeof verifyReceipt === "function", "LINUX_OBSERVER_REQUIRED");
  const receipt_digest = await linuxReceiptDigest(receipt);
  const nonce = crypto.randomUUID();
  const verified = await verifyReceipt({ receipt: structuredClone(receipt), receipt_digest, binding: structuredClone(binding), nonce, signal });
  requireThat(!signal?.aborted, "LINUX_OBSERVATION_TIMEOUT");
  const verifiedNow = clock.now();
  validateLinuxBinding(binding, verifiedNow);
  exact(verified, VERIFICATION_KEYS, "LINUX_OBSERVER_INVALID");
  requireThat(verified.verified === true && verified.nonce === nonce && verified.receipt_digest === receipt_digest && matches(verified, binding, ["observer_id", "credential_ref", "source_revision"]), "LINUX_OBSERVER_BINDING_MISMATCH");
  fresh(receipt.observed_at, verifiedNow, binding.max_age_seconds);
  fresh(verified.observed_at, verifiedNow, binding.max_age_seconds);
  if (receipt.outcome === "SUCCEEDED") {
    subject(verified.current_subject);
    requireThat(matches(verified.current_subject, receipt.subject, SUBJECT_KEYS), "LINUX_CURRENT_SUBJECT_CONFLICT");
  } else if (verified.current_subject !== null) {
    subject(verified.current_subject);
    requireThat(matches(verified.current_subject, binding.subject, ["machine_id_digest", "provider_identity_digest"]), "LINUX_CURRENT_SUBJECT_CONFLICT");
  }
  return {
    type: receipt.type, source: "ghostfleet-linux-adapter", at: receipt.observed_at,
    data: {
      status: { SUCCEEDED: "PASS", FAILED: "FAIL", UNKNOWN: "UNKNOWN" }[receipt.outcome],
      attempt_id: binding.attempt_id, node_uid: binding.node_uid, enrollment_id: binding.enrollment_id,
      adapter_id: binding.adapter_id, observer_id: binding.observer_id, credential_ref: binding.credential_ref,
      source_revision: binding.source_revision, operation_id: receipt.operation_id,
      receipt_ref: receipt.receipt_ref, receipt_digest, observed_at: receipt.observed_at,
      subject: receipt.subject, facts: receipt.facts,
    },
  };
}
