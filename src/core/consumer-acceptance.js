import { makeId } from "./ids.js";
import { assertPublicSafe, publicClone } from "./security.js";

// Provider-neutral consumer acceptance contract.
//
// This is deliberately NOT a second node lifecycle. It references an existing
// NodeIdentity, never mints one, and never mutates NodeLifecycle. Core
// `ACTIVE` is a precondition, never an acceptance signal.
//
// State machine (frozen, no other transitions exist):
//
//   PENDING  --evaluate(all elements present, custody durable)-->  ACCEPTED
//   ACCEPTED --completeConsumerRollback(exact set match)------->  ROLLED_BACK  (terminal)
//
// PENDING stays PENDING while any element is missing or custody is not durable.
// Every other transition is rejected. ROLLED_BACK is terminal: re-admission
// requires a NEW acceptance record, never revival of a rolled-back one.

export const ConsumerAcceptanceState = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  ROLLED_BACK: "ROLLED_BACK",
});

export const CustodyClass = Object.freeze({
  PROVIDER_NATIVE_SECRET: "PROVIDER_NATIVE_SECRET",
  HOST_OWNED_PROTECTED_ARTIFACT: "HOST_OWNED_PROTECTED_ARTIFACT",
  EXECUTOR_WORKSPACE: "EXECUTOR_WORKSPACE",
  SESSION_LOCAL: "SESSION_LOCAL",
  AGENT_ARTIFACT: "AGENT_ARTIFACT",
  UNRESOLVED: "UNRESOLVED",
});

export const CustodyDurability = Object.freeze({
  DURABLE: "DURABLE",
  EXECUTOR_BOUND: "EXECUTOR_BOUND",
  UNRESOLVED: "UNRESOLVED",
});

// A durable custody class is a claim, not a proof. Durability additionally
// requires a named owner and a deployment attestation reference, so a caller
// cannot reach DURABLE by selecting an enum value alone.
const DURABLE_CUSTODY_CLASSES = new Set([
  CustodyClass.PROVIDER_NATIVE_SECRET,
  CustodyClass.HOST_OWNED_PROTECTED_ARTIFACT,
]);

const EXECUTOR_BOUND_CUSTODY_CLASSES = new Set([
  CustodyClass.EXECUTOR_WORKSPACE,
  CustodyClass.SESSION_LOCAL,
  CustodyClass.AGENT_ARTIFACT,
]);

/**
 * Observations that are real, useful, and still never sufficient on their own.
 * They are recorded for observability under `signals`, never under `evidence`,
 * so none of them can structurally satisfy an acceptance element.
 */
export const NON_ADMITTING_SIGNALS = Object.freeze([
  "core_active",
  "core_admission_evidence",
  "transport_tunnel_healthy",
  "single_ssh_call",
  "single_typed_call",
  "human_maintenance_surface",
]);

export const REQUIRED_CONSUMER_EVIDENCE = Object.freeze([
  "identity.reference",
  "consumer.identity",
  "control_path.binding",
  "custody.durability",
  "authority.positive",
  "authority.negative",
  "call_route.readback",
  "executor.independence",
  // Acceptance requires a rollback PLAN (declared binding set + prior-path
  // restoration contract). The actual rollback RESULT is verified only at
  // completeConsumerRollback. Requiring a completed rollback before ACCEPTED
  // would invert the cutover meaning.
  "rollback.plan",
]);

const NODE_UID_RE = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONSUMER_REF_RE = /^[a-z][a-z0-9._-]{2,79}$/;
// Provider-neutral: a revision is a bounded opaque immutable reference. It is
// NOT required to be a Git SHA, because deployment/provider config revisions
// are not Git objects. `source_revision` MAY be a Git SHA (that satisfies this
// shape); `config_revision` need not be.
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,159}$/;
// Opaque reference only: no whitespace, no PEM/JWT shapes, bounded length.
const OPAQUE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,159}$/;
const SECRET_SHAPED = [
  /-----BEGIN/,
  /\beyJ[A-Za-z0-9_-]{8,}\./,
  /\b(?:nodekey|machinekey):/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
];
const MAX_BINDINGS = 64;

export class ConsumerAcceptanceError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = "ConsumerAcceptanceError";
    this.code = code;
    Object.assign(this, detail);
  }
}

function fail(code, detail) { throw new ConsumerAcceptanceError(code, detail); }

function assertOpaqueReference(value, field) {
  if (typeof value !== "string" || !OPAQUE_REF_RE.test(value)) fail("CUSTODY_REFERENCE_INVALID", { field });
  if (SECRET_SHAPED.some((pattern) => pattern.test(value))) fail("CUSTODY_REFERENCE_SECRET_SHAPED", { field });
  return value;
}

function assertRevision(value, field) {
  if (typeof value !== "string" || !REVISION_RE.test(value)) fail("REVISION_INVALID", { field });
  return value;
}

/** Validate a declared/removed binding list: public-safe, opaque, bounded, deduplicated. */
function normalizeBindingSet(value, field) {
  if (!Array.isArray(value)) fail("ROLLBACK_BINDINGS_INVALID", { field });
  if (value.length > MAX_BINDINGS) fail("ROLLBACK_BINDINGS_TOO_MANY", { field });
  const seen = new Set();
  for (const item of value) {
    assertOpaqueReference(item, field);
    if (seen.has(item)) fail("ROLLBACK_BINDINGS_DUPLICATE", { field, binding: item });
    seen.add(item);
  }
  // An explicitly empty set is legal and distinct from "never declared".
  return Object.freeze([...value]);
}

/**
 * Classify credential custody durability. Fails closed: a durable class
 * without a named owner is not durable, and an unresolved or executor-bound
 * custody never reports DURABLE, so acceptance cannot pass.
 */
export function classifyCustody(custody) {
  if (!custody || typeof custody !== "object" || Array.isArray(custody)) fail("CUSTODY_INVALID");
  assertPublicSafe(custody);
  const allowed = ["custody_class", "custody_ref", "owner_ref", "attestation_ref"];
  if (Object.keys(custody).some((key) => !allowed.includes(key))) fail("CUSTODY_FIELDS_INVALID");
  const custodyClass = custody.custody_class;
  if (!Object.values(CustodyClass).includes(custodyClass)) fail("CUSTODY_CLASS_INVALID");
  assertOpaqueReference(custody.custody_ref, "custody_ref");
  if (custody.owner_ref !== undefined && custody.owner_ref !== null) assertOpaqueReference(custody.owner_ref, "owner_ref");
  if (custody.attestation_ref !== undefined && custody.attestation_ref !== null) assertOpaqueReference(custody.attestation_ref, "attestation_ref");

  let durability = CustodyDurability.UNRESOLVED;
  if (DURABLE_CUSTODY_CLASSES.has(custodyClass)) {
    // A durable class alone is a caller assertion. Without an owner and a
    // deployment attestation it stays UNRESOLVED rather than DURABLE.
    const owner = custody.owner_ref ?? null;
    const attestation = custody.attestation_ref ?? null;
    if (owner && attestation) durability = CustodyDurability.DURABLE;
    else fail("CUSTODY_DURABILITY_UNPROVEN", { custody_class: custodyClass, owner_present: !!owner, attestation_present: !!attestation });
  } else if (EXECUTOR_BOUND_CUSTODY_CLASSES.has(custodyClass)) {
    durability = CustodyDurability.EXECUTOR_BOUND;
  }
  return Object.freeze({
    custody_class: custodyClass,
    custody_ref: custody.custody_ref,
    owner_ref: custody.owner_ref ?? null,
    attestation_ref: custody.attestation_ref ?? null,
    durability,
  });
}

export function createConsumerAcceptance(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("CONSUMER_INPUT_INVALID");
  const allowed = ["node_uid", "consumer_ref", "source_revision", "config_revision", "control_path_ref", "custody", "origin_executor_ref", "at"];
  // Closed input: reject unknown keys rather than silently dropping them.
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail("CONSUMER_INPUT_FIELDS_INVALID", { unexpected: Object.keys(input).filter((key) => !allowed.includes(key)) });
  const {
    node_uid,
    consumer_ref,
    source_revision,
    config_revision,
    control_path_ref,
    custody,
    at = new Date().toISOString(),
  } = input;
  // origin_executor_ref is a decidable input, not optional. Without it the
  // "fresh context must differ from the original executor" check is a no-op.
  const origin_executor_ref = input.origin_executor_ref;
  if (typeof node_uid !== "string" || !NODE_UID_RE.test(node_uid)) fail("NODE_UID_INVALID");
  if (typeof consumer_ref !== "string" || !CONSUMER_REF_RE.test(consumer_ref)) fail("CONSUMER_REF_INVALID");
  assertRevision(source_revision, "source_revision");
  assertRevision(config_revision, "config_revision");
  assertOpaqueReference(control_path_ref, "control_path_ref");
  if (typeof origin_executor_ref !== "string") fail("ORIGIN_EXECUTOR_REF_REQUIRED");
  assertOpaqueReference(origin_executor_ref, "origin_executor_ref");
  return Object.freeze({
    acceptance_id: makeId("consumer"),
    node_uid,
    consumer_ref,
    source_revision,
    config_revision,
    control_path_ref,
    custody: classifyCustody(custody),
    origin_executor_ref,
    state: ConsumerAcceptanceState.PENDING,
    evidence: [],
    signals: [],
    declared_bindings: null,
    decision: null,
    created_at: at,
    updated_at: at,
  });
}

/** Record a real-but-insufficient observation. Never satisfies an element. */
export function recordConsumerSignal(record, signal, detail = {}) {
  if (!NON_ADMITTING_SIGNALS.includes(signal)) fail("SIGNAL_UNKNOWN", { signal });
  if (record.state !== ConsumerAcceptanceState.PENDING) fail("CONSUMER_NOT_PENDING", { state: record.state });
  assertPublicSafe(detail);
  const at = new Date().toISOString();
  return Object.freeze({
    ...record,
    signals: [...record.signals, { signal, detail: publicClone(detail), at }],
    updated_at: at,
  });
}

const ELEMENT_VALIDATORS = {
  "identity.reference": (record, data) => {
    if (data.node_uid !== record.node_uid) fail("EVIDENCE_IDENTITY_MISMATCH");
  },
  "consumer.identity": (record, data) => {
    if (data.consumer_ref !== record.consumer_ref) fail("EVIDENCE_CONSUMER_MISMATCH");
    assertRevision(data.source_revision, "source_revision");
    assertRevision(data.config_revision, "config_revision");
    if (data.source_revision !== record.source_revision || data.config_revision !== record.config_revision) fail("EVIDENCE_REVISION_MISMATCH");
  },
  "control_path.binding": (record, data) => {
    assertOpaqueReference(data.control_path_ref, "control_path_ref");
    if (data.control_path_ref !== record.control_path_ref) fail("EVIDENCE_CONTROL_PATH_MISMATCH");
    assertOpaqueReference(data.binding_ref, "binding_ref");
  },
  "custody.durability": (record, data) => {
    // The record's own classification is authoritative. A claimed durability in
    // the payload can never upgrade an executor-bound or unresolved custody.
    if (record.custody.durability !== CustodyDurability.DURABLE) {
      fail("CUSTODY_NOT_DURABLE", { durability: record.custody.durability, custody_class: record.custody.custody_class });
    }
    if (data.durability !== CustodyDurability.DURABLE) fail("EVIDENCE_CUSTODY_DURABILITY_MISMATCH", { claimed: data.durability ?? null });
    if (data.custody_class !== record.custody.custody_class || data.custody_ref !== record.custody.custody_ref) fail("EVIDENCE_CUSTODY_MISMATCH");
    if (data.owner_ref !== record.custody.owner_ref) fail("EVIDENCE_CUSTODY_OWNER_MISMATCH");
    // The deployment/deployment-owner attestation that made durability
    // decidable must be carried into the evidence, not just the record.
    if (data.attestation_ref !== record.custody.attestation_ref) fail("EVIDENCE_CUSTODY_ATTESTATION_MISMATCH");
    if (data.attestation_ref === null || data.attestation_ref === undefined) fail("CUSTODY_ATTESTATION_REQUIRED");
  },
  "authority.positive": (record, data) => {
    if (data.result !== "PASS") fail("EVIDENCE_POSITIVE_NOT_PASS");
    assertOpaqueReference(data.receipt_ref, "receipt_ref");
  },
  "authority.negative": (record, data) => {
    if (data.result !== "DENIED" || data.denial_observed !== true) fail("EVIDENCE_NEGATIVE_NOT_DENIED");
    assertOpaqueReference(data.receipt_ref, "receipt_ref");
  },
  "call_route.readback": (record, data) => {
    if (data.node_uid !== record.node_uid) fail("EVIDENCE_ROUTE_IDENTITY_MISMATCH");
    assertOpaqueReference(data.observed_ref, "observed_ref");
  },
  "executor.independence": (record, data) => {
    assertOpaqueReference(data.fresh_context_ref, "fresh_context_ref");
    if (data.dependency_free !== true) fail("EXECUTOR_INDEPENDENCE_NOT_PROVEN");
    // Both ends are bound to the record, not just the fresh one.
    if (data.origin_executor_ref !== record.origin_executor_ref) fail("EXECUTOR_INDEPENDENCE_ORIGIN_MISMATCH");
    if (data.fresh_context_ref === record.origin_executor_ref) fail("EXECUTOR_INDEPENDENCE_SAME_CONTEXT");
    if (data.result !== "PASS") fail("EXECUTOR_INDEPENDENCE_NOT_PASS");
  },
  "rollback.plan": (record, data) => {
    // Acceptance-time: declare the binding set this consumer introduced and
    // the contract for restoring the prior path. An explicitly empty set is
    // legal; "never declared" is a missing element, not an empty one.
    normalizeBindingSet(data.declared_bindings, "declared_bindings");
    assertOpaqueReference(data.prior_path_restoration_contract_ref, "prior_path_restoration_contract_ref");
  },
};

export function recordConsumerEvidence(record, element, data, { at = new Date().toISOString() } = {}) {
  if (!REQUIRED_CONSUMER_EVIDENCE.includes(element)) fail("EVIDENCE_ELEMENT_UNKNOWN", { element });
  if (record.state !== ConsumerAcceptanceState.PENDING) fail("CONSUMER_NOT_PENDING", { state: record.state });
  assertPublicSafe(data);
  ELEMENT_VALIDATORS[element](record, data);
  const next = {
    ...record,
    evidence: [...record.evidence, { element, data: publicClone(data), at }],
    updated_at: at,
  };
  if (element === "rollback.plan") next.declared_bindings = normalizeBindingSet(data.declared_bindings, "declared_bindings");
  return Object.freeze(next);
}

/**
 * Rollback completion is an exact-set match against the plan's declared set.
 * A missing binding and an extra undeclared binding are both rejected: a
 * node-scoped rollback may not claim to remove objects it never declared.
 */
export function assertNodeScopedRollbackComplete(rollback) {
  const declared = rollback?.declared_bindings;
  if (!Array.isArray(declared)) fail("ROLLBACK_DECLARATION_INVALID");
  const removed = normalizeBindingSet(rollback?.removed_bindings ?? [], "removed_bindings");
  const declaredSet = new Set(declared);
  const missing = declared.filter((ref) => !removed.includes(ref));
  if (missing.length) fail("ROLLBACK_BINDINGS_REMAIN", { missing });
  const extra = removed.filter((ref) => !declaredSet.has(ref));
  if (extra.length) fail("ROLLBACK_BINDINGS_UNDECLARED", { extra });
  if (rollback?.prior_path_restored !== true) fail("ROLLBACK_PRIOR_PATH_NOT_RESTORED");
  if (rollback?.result !== "PASS") fail("ROLLBACK_NOT_COMPLETE");
  return true;
}

export function missingConsumerEvidence(record) {
  const present = new Set(record.evidence.filter((item) => REQUIRED_CONSUMER_EVIDENCE.includes(item.element)).map((item) => item.element));
  return REQUIRED_CONSUMER_EVIDENCE.filter((element) => !present.has(element));
}

/**
 * Decide consumer acceptance.
 *
 * Precondition: an already-ACTIVE NodeIdentity with a matching node_uid. Core
 * ACTIVE never contributes evidence; the durable custody gate is evaluated
 * independently; missing elements hold the record at PENDING.
 *
 * Only PENDING -> ACCEPTED exists. A ROLLED_BACK record is terminal and is
 * never revived here.
 */
export function evaluateConsumerAcceptance(record, { node } = {}) {
  if (!node) fail("NODE_REFERENCE_REQUIRED");
  if (node.node_uid !== record.node_uid) fail("NODE_REFERENCE_MISMATCH");
  if (node.lifecycle !== "ACTIVE") fail("NODE_NOT_ACTIVE");
  if (record.state !== ConsumerAcceptanceState.PENDING) fail("CONSUMER_NOT_PENDING", { state: record.state });

  const blocking = [];
  if (record.custody.durability !== CustodyDurability.DURABLE) {
    blocking.push({ code: "CUSTODY_NOT_DURABLE", durability: record.custody.durability, custody_class: record.custody.custody_class });
  }
  const missing = missingConsumerEvidence(record);
  const accepted = blocking.length === 0 && missing.length === 0;
  const at = new Date().toISOString();
  const decision = {
    accepted,
    missing,
    blocking,
    // Explicitly reported so an auditor can see that these were present and insufficient.
    non_admitting_signals_ignored: [...new Set(record.signals.map((item) => item.signal))],
    decided_at: at,
  };
  return Object.freeze({
    ...record,
    state: accepted ? ConsumerAcceptanceState.ACCEPTED : ConsumerAcceptanceState.PENDING,
    decision,
    updated_at: at,
  });
}

/**
 * Complete a node-scoped rollback. Terminal transition from ACCEPTED.
 * `removed_bindings` must exactly match the plan's declared set. An explicitly
 * empty declared set is a legal, completable rollback.
 */
export function completeConsumerRollback(record, input = {}) {
  if (record.state !== ConsumerAcceptanceState.ACCEPTED) fail("ROLLBACK_REQUIRES_ACCEPTED", { state: record.state });
  const allowed = ["removed_bindings", "prior_path_restored", "result", "at"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail("ROLLBACK_INPUT_FIELDS_INVALID", { unexpected: Object.keys(input).filter((key) => !allowed.includes(key)) });
  const at = input.at ?? new Date().toISOString();
  if (record.declared_bindings === null) fail("ROLLBACK_PLAN_MISSING");
  assertPublicSafe(input);
  assertNodeScopedRollbackComplete({
    declared_bindings: record.declared_bindings,
    removed_bindings: input.removed_bindings,
    prior_path_restored: input.prior_path_restored,
    result: input.result ?? "PASS",
  });
  return Object.freeze({
    ...record,
    state: ConsumerAcceptanceState.ROLLED_BACK,
    decision: { ...record.decision, rolled_back_at: at, removed_bindings: normalizeBindingSet(input.removed_bindings, "removed_bindings") },
    updated_at: at,
  });
}