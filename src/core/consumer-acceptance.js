import { makeId } from "./ids.js";
import { assertPublicSafe, publicClone } from "./security.js";

// Provider-neutral consumer acceptance contract.
//
// This is deliberately NOT a second node lifecycle. It references an existing
// NodeIdentity, never mints one, and never mutates NodeLifecycle. Core
// `ACTIVE` is a precondition, never an acceptance signal.

export const ConsumerAcceptanceState = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
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
  "rollback.node_scoped",
]);

const NODE_UID_RE = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION_RE = /^[0-9a-f]{7,40}$/;
const CONSUMER_REF_RE = /^[a-z][a-z0-9._-]{2,79}$/;
// Opaque reference only: no whitespace, no PEM/JWT shapes, bounded length.
// The contract stores reference metadata and never secret material.
const OPAQUE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,159}$/;
const SECRET_SHAPED = [
  /-----BEGIN/,
  /\beyJ[A-Za-z0-9_-]{8,}\./,
  /\b(?:nodekey|machinekey):/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
];

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

/**
 * Classify credential custody durability. Fails closed: an unresolved or
 * executor-bound custody never reports DURABLE, so acceptance cannot pass.
 */
export function classifyCustody(custody) {
  if (!custody || typeof custody !== "object" || Array.isArray(custody)) fail("CUSTODY_INVALID");
  assertPublicSafe(custody);
  const allowed = ["custody_class", "custody_ref", "owner_ref"];
  if (Object.keys(custody).some((key) => !allowed.includes(key))) fail("CUSTODY_FIELDS_INVALID");
  const custodyClass = custody.custody_class;
  if (!Object.values(CustodyClass).includes(custodyClass)) fail("CUSTODY_CLASS_INVALID");
  assertOpaqueReference(custody.custody_ref, "custody_ref");
  if (custody.owner_ref !== undefined && custody.owner_ref !== null) assertOpaqueReference(custody.owner_ref, "owner_ref");
  let durability = CustodyDurability.UNRESOLVED;
  if (DURABLE_CUSTODY_CLASSES.has(custodyClass)) durability = CustodyDurability.DURABLE;
  else if (EXECUTOR_BOUND_CUSTODY_CLASSES.has(custodyClass)) durability = CustodyDurability.EXECUTOR_BOUND;
  return Object.freeze({
    custody_class: custodyClass,
    custody_ref: custody.custody_ref,
    owner_ref: custody.owner_ref ?? null,
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
    origin_executor_ref = null,
    at = new Date().toISOString(),
  } = input;
  if (typeof node_uid !== "string" || !NODE_UID_RE.test(node_uid)) fail("NODE_UID_INVALID");
  if (typeof consumer_ref !== "string" || !CONSUMER_REF_RE.test(consumer_ref)) fail("CONSUMER_REF_INVALID");
  assertRevision(source_revision, "source_revision");
  assertRevision(config_revision, "config_revision");
  assertOpaqueReference(control_path_ref, "control_path_ref");
  if (origin_executor_ref !== null && origin_executor_ref !== undefined) assertOpaqueReference(origin_executor_ref, "origin_executor_ref");
  return Object.freeze({
    acceptance_id: makeId("consumer"),
    node_uid,
    consumer_ref,
    source_revision,
    config_revision,
    control_path_ref,
    custody: classifyCustody(custody),
    origin_executor_ref: origin_executor_ref ?? null,
    state: ConsumerAcceptanceState.PENDING,
    evidence: [],
    signals: [],
    introduced_bindings: [],
    decision: null,
    created_at: at,
    updated_at: at,
  });
}

/** Record a real-but-insufficient observation. Never satisfies an element. */
export function recordConsumerSignal(record, signal, detail = {}) {
  if (!NON_ADMITTING_SIGNALS.includes(signal)) fail("SIGNAL_UNKNOWN", { signal });
  assertPublicSafe(detail);
  const next = { ...record, signals: [...record.signals, { signal, detail: publicClone(detail), at: new Date().toISOString() }], updated_at: new Date().toISOString() };
  return Object.freeze(next);
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
    // The record's own classified durability is authoritative. A claimed
    // durability in the evidence payload can never upgrade an executor-bound
    // or unresolved custody class into a durable one.
    if (record.custody.durability !== CustodyDurability.DURABLE) {
      fail("CUSTODY_NOT_DURABLE", { durability: record.custody.durability, custody_class: record.custody.custody_class });
    }
    if (data.durability !== CustodyDurability.DURABLE) fail("EVIDENCE_CUSTODY_DURABILITY_MISMATCH", { claimed: data.durability ?? null });
    if (data.custody_class !== record.custody.custody_class || data.custody_ref !== record.custody.custody_ref) fail("EVIDENCE_CUSTODY_MISMATCH");
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
    if (record.origin_executor_ref !== null && data.fresh_context_ref === record.origin_executor_ref) fail("EXECUTOR_INDEPENDENCE_SAME_CONTEXT");
    if (data.result !== "PASS") fail("EXECUTOR_INDEPENDENCE_NOT_PASS");
  },
  "rollback.node_scoped": (record, data) => {
    assertNodeScopedRollbackComplete(data);
  },
};

export function recordConsumerEvidence(record, element, data, { at = new Date().toISOString() } = {}) {
  if (!REQUIRED_CONSUMER_EVIDENCE.includes(element)) fail("EVIDENCE_ELEMENT_UNKNOWN", { element });
  if (record.state === ConsumerAcceptanceState.ACCEPTED) fail("CONSUMER_ALREADY_ACCEPTED");
  assertPublicSafe(data);
  ELEMENT_VALIDATORS[element](record, data);
  const next = {
    ...record,
    evidence: [...record.evidence, { element, data: publicClone(data), at }],
    updated_at: at,
  };
  if (element === "rollback.node_scoped" && Array.isArray(data.declared_bindings)) {
    next.introduced_bindings = publicClone(data.declared_bindings);
  }
  return Object.freeze(next);
}

/** Node-scoped rollback is complete only when no adapter-declared binding remains live. */
export function assertNodeScopedRollbackComplete(rollback) {
  const declared = rollback?.declared_bindings;
  const removed = new Set(rollback?.removed_bindings ?? []);
  if (!Array.isArray(declared)) fail("ROLLBACK_DECLARATION_INVALID");
  const remaining = declared.filter((ref) => !removed.has(ref));
  if (remaining.length) fail("ROLLBACK_BINDINGS_REMAIN", { remaining });
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
 */
export function evaluateConsumerAcceptance(record, { node } = {}) {
  if (!node) fail("NODE_REFERENCE_REQUIRED");
  if (node.node_uid !== record.node_uid) fail("NODE_REFERENCE_MISMATCH");
  if (node.lifecycle !== "ACTIVE") fail("NODE_NOT_ACTIVE");

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

/** Complete a node-scoped rollback. Fails while any declared binding remains live. */
export function completeConsumerRollback(record, { removed_bindings, prior_path_restored, result = "PASS", at = new Date().toISOString() } = {}) {
  if (record.state !== ConsumerAcceptanceState.ACCEPTED) fail("ROLLBACK_REQUIRES_ACCEPTED");
  const declared = record.introduced_bindings;
  if (!declared.length) fail("ROLLBACK_NO_BINDINGS_DECLARED");
  assertNodeScopedRollbackComplete({ declared_bindings: declared, removed_bindings, prior_path_restored, result });
  return Object.freeze({
    ...record,
    state: ConsumerAcceptanceState.ROLLED_BACK,
    decision: { ...record.decision, rolled_back_at: at, removed_bindings: [...removed_bindings] },
    updated_at: at,
  });
}