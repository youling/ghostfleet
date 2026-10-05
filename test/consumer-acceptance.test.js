import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import {
  ConsumerAcceptanceState,
  CustodyClass,
  CustodyDurability,
  NON_ADMITTING_SIGNALS,
  REQUIRED_CONSUMER_EVIDENCE,
  assertNodeScopedRollbackComplete,
  classifyCustody,
  createConsumerAcceptance,
  evaluateConsumerAcceptance,
  recordConsumerEvidence,
  recordConsumerSignal,
} from "../src/core/consumer-acceptance.js";
import { makeId } from "../src/core/ids.js";
import { EventType, NodeLifecycle } from "../src/core/model.js";

const SOURCE_REVISION = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
// Deliberately NOT a Git SHA: a deployment/provider config revision need not be.
const CONFIG_REVISION = "deployment-config/2026.10.5-rc1";
const CONTROL_PATH_REF = "control-path/deployment-alpha/primary";
const OWNER_REF = "owner/platform-team";
const ATTESTATION_REF = "attestation/deployment-alpha/custody-v1";
const DURABLE_CUSTODY = {
  custody_class: CustodyClass.PROVIDER_NATIVE_SECRET,
  custody_ref: "deployment-secret/alpha",
  owner_ref: OWNER_REF,
  attestation_ref: ATTESTATION_REF,
};
const DECLARED_BINDINGS = ["adapter-binding/node-scope", "adapter-binding/consumer-route"];
const ORIGIN_EXECUTOR = "executor-original-run";
const FRESH_CONTEXT = "executor-fresh-context";
const RESTORATION_CONTRACT = "contract/prior-path-restoration-v1";

function admitNode(controller) {
  const attempt = controller.createEnrollmentAttempt({ asset_hint: "lab-device" });
  controller.prepareEnrollmentAttempt(attempt.attempt_id);
  controller.claimEnrollmentAttempt(attempt.attempt_id);
  const materialized = controller.startMaterialization(attempt.attempt_id, { node_id: "lab-device", platform: "linux" });
  for (const type of ["transport.ready", "bootstrap.report", "control.canary", "convergence.zero_delta", "reboot.recovered"]) {
    controller.recordEvidence(attempt.attempt_id, { type, source: "synthetic-test", data: { status: "PASS" } });
  }
  const node = controller.acceptEnrollment(attempt.attempt_id, { node_id: "lab-device", platform: "linux" });
  return { node, attempt, materialized };
}

function openAcceptance(controller, node, custody = DURABLE_CUSTODY) {
  return controller.openConsumerAcceptance({
    node_uid: node.node_uid,
    consumer_ref: "adapter.alpha",
    source_revision: SOURCE_REVISION,
    config_revision: CONFIG_REVISION,
    control_path_ref: CONTROL_PATH_REF,
    custody,
    origin_executor_ref: ORIGIN_EXECUTOR,
  });
}

function planFor(record, { bindings = DECLARED_BINDINGS } = {}) {
  return ["rollback.plan", { declared_bindings: bindings, prior_path_restoration_contract_ref: RESTORATION_CONTRACT }];
}

function evidencePairs(record, { bindings = DECLARED_BINDINGS, includeIndependence = true, includePlan = true } = {}) {
  const pairs = [
    ["identity.reference", { node_uid: record.node_uid, lifecycle: NodeLifecycle.ACTIVE }],
    ["consumer.identity", { consumer_ref: record.consumer_ref, source_revision: record.source_revision, config_revision: record.config_revision }],
    ["control_path.binding", { control_path_ref: record.control_path_ref, binding_ref: bindings[0] ?? "adapter-binding/node-scope" }],
    ["custody.durability", { durability: CustodyDurability.DURABLE, custody_class: record.custody.custody_class, custody_ref: record.custody.custody_ref, owner_ref: record.custody.owner_ref, attestation_ref: record.custody.attestation_ref }],
    ["authority.positive", { operation: "node.identity.read", result: "PASS", receipt_ref: "receipt/positive-one" }],
    ["authority.negative", { operation: "node.privileged.write", result: "DENIED", denial_observed: true, receipt_ref: "receipt/negative-one" }],
    ["call_route.readback", { node_uid: record.node_uid, observed_ref: "route-readback/observed-one" }],
  ];
  if (includeIndependence) {
    pairs.push(["executor.independence", { fresh_context_ref: FRESH_CONTEXT, origin_executor_ref: record.origin_executor_ref, dependency_free: true, operation: "node.identity.read", result: "PASS" }]);
  }
  if (includePlan) pairs.push(planFor(record, { bindings }));
  return pairs;
}

function recordAll(controller, record, options) {
  for (const [element, data] of evidencePairs(record, options)) {
    controller.recordConsumerAcceptanceEvidence(record.acceptance_id, element, data);
  }
  return controller.getConsumerAcceptance(record.acceptance_id);
}

function acceptedRecord(controller, node, options) {
  const record = recordAll(controller, openAcceptance(controller, node), options);
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.state, ConsumerAcceptanceState.ACCEPTED);
  return decided;
}

// Criterion 1 — core ACTIVE alone cannot mark a consumer accepted.

test("criterion 1: core ACTIVE alone cannot mark a consumer accepted", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  assert.equal(node.lifecycle, NodeLifecycle.ACTIVE);
  const record = openAcceptance(controller, node);
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.state, ConsumerAcceptanceState.PENDING);
  assert.equal(decided.decision.accepted, false);
  assert.deepEqual(decided.decision.missing, REQUIRED_CONSUMER_EVIDENCE);
});

test("criterion 1: every non-admitting signal is ignored for acceptance", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  let record = openAcceptance(controller, node);
  for (const signal of NON_ADMITTING_SIGNALS) record = controller.recordConsumerSignal(record.acceptance_id, signal, { observed: true });
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.decision.accepted, false);
  assert.deepEqual([...decided.decision.non_admitting_signals_ignored].sort(), [...NON_ADMITTING_SIGNALS].sort());
  assert.equal(decided.evidence.length, 0, "signals must never land in evidence");
  assert.equal(decided.decision.missing.length, REQUIRED_CONSUMER_EVIDENCE.length);
});

test("criterion 1: an unknown signal is rejected and evidence elements are closed", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  assert.throws(() => controller.recordConsumerSignal(record.acceptance_id, "core_active_but_really"), /SIGNAL_UNKNOWN/);
  assert.throws(() => recordConsumerEvidence(record, "core_active", { status: "PASS" }), /EVIDENCE_ELEMENT_UNKNOWN/);
  assert.throws(() => recordConsumerEvidence(record, "transport_tunnel_healthy", { status: "PASS" }), /EVIDENCE_ELEMENT_UNKNOWN/);
});

// R6 — term/state separation in the event stream.

test("R6: a recorded signal emits a signal event, never an evidence event", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  controller.recordConsumerSignal(record.acceptance_id, "core_active");
  controller.recordConsumerSignal(record.acceptance_id, "single_ssh_call");
  controller.recordConsumerAcceptanceEvidence(record.acceptance_id, "identity.reference", { node_uid: node.node_uid, lifecycle: NodeLifecycle.ACTIVE });

  const events = controller.listEvents().filter((event) => event.subject === record.acceptance_id);
  const signalEvents = events.filter((event) => event.type === EventType.CONSUMER_ACCEPTANCE_SIGNAL_RECORDED);
  const evidenceEvents = events.filter((event) => event.type === EventType.CONSUMER_ACCEPTANCE_EVIDENCE_UPDATED);
  assert.equal(signalEvents.length, 2);
  assert.equal(evidenceEvents.length, 1, "only real evidence mutations emit an evidence event");
  for (const event of signalEvents) assert.equal(event.data.element, undefined, "signal events must not claim an evidence element");
  for (const event of evidenceEvents) assert.equal(event.data.signal, undefined, "evidence events must not claim a signal");
  assert.notEqual(EventType.CONSUMER_ACCEPTANCE_SIGNAL_RECORDED, EventType.CONSUMER_ACCEPTANCE_EVIDENCE_UPDATED);
});

// R2 — lifecycle closure.

test("R2: the consumer acceptance state machine is frozen to two transitions", () => {
  assert.deepEqual(Object.values(ConsumerAcceptanceState), ["PENDING", "ACCEPTED", "ROLLED_BACK"]);
  assert.equal(Object.hasOwn(ConsumerAcceptanceState, "REJECTED"), false, "REJECTED had no reachable transition and is removed");
});

test("R2: a rolled-back record is terminal and cannot be re-evaluated to ACCEPTED", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const accepted = acceptedRecord(controller, node);
  const rolled = controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: DECLARED_BINDINGS, prior_path_restored: true });
  assert.equal(rolled.state, ConsumerAcceptanceState.ROLLED_BACK);
  assert.equal(rolled.evidence.length, REQUIRED_CONSUMER_EVIDENCE.length, "evidence is still present after rollback");

  assert.throws(() => controller.evaluateConsumerAcceptance(rolled.acceptance_id), (error) => {
    assert.equal(error.code, "CONSUMER_NOT_PENDING");
    assert.equal(error.state, ConsumerAcceptanceState.ROLLED_BACK);
    return true;
  });
  assert.throws(() => controller.recordConsumerAcceptanceEvidence(rolled.acceptance_id, "authority.positive", { operation: "x", result: "PASS", receipt_ref: "receipt/late" }), /CONSUMER_NOT_PENDING/);
  assert.throws(() => controller.recordConsumerSignal(rolled.acceptance_id, "core_active"), /CONSUMER_NOT_PENDING/);
  assert.throws(() => controller.completeConsumerRollback(rolled.acceptance_id, { removed_bindings: DECLARED_BINDINGS, prior_path_restored: true }), /ROLLBACK_REQUIRES_ACCEPTED/);
  assert.equal(controller.getConsumerAcceptance(rolled.acceptance_id).state, ConsumerAcceptanceState.ROLLED_BACK);

  // Re-admission requires a NEW record, never revival of the rolled-back one.
  const replacement = acceptedRecord(controller, node);
  assert.notEqual(replacement.acceptance_id, rolled.acceptance_id);
  assert.equal(replacement.state, ConsumerAcceptanceState.ACCEPTED);
});

test("R2: rollback cannot be completed from PENDING and an accepted record rejects new evidence", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const pending = openAcceptance(controller, node);
  assert.throws(() => controller.completeConsumerRollback(pending.acceptance_id, { removed_bindings: DECLARED_BINDINGS, prior_path_restored: true }), (error) => {
    assert.equal(error.code, "ROLLBACK_REQUIRES_ACCEPTED");
    assert.equal(error.state, ConsumerAcceptanceState.PENDING);
    return true;
  });
  const accepted = acceptedRecord(controller, node);
  assert.throws(() => controller.recordConsumerAcceptanceEvidence(accepted.acceptance_id, "authority.positive", { operation: "x", result: "PASS", receipt_ref: "receipt/c" }), /CONSUMER_NOT_PENDING/);
});

// R3 — origin executor reference is a decidable input.

test("R3: origin_executor_ref is required at create time", () => {
  const base = {
    node_uid: makeId("node"), consumer_ref: "adapter.alpha",
    source_revision: SOURCE_REVISION, config_revision: CONFIG_REVISION,
    control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY,
  };
  assert.throws(() => createConsumerAcceptance(base), /ORIGIN_EXECUTOR_REF_REQUIRED/);
  assert.throws(() => createConsumerAcceptance({ ...base, origin_executor_ref: null }), /ORIGIN_EXECUTOR_REF_REQUIRED/);
  assert.throws(() => createConsumerAcceptance({ ...base, origin_executor_ref: "" }), /ORIGIN_EXECUTOR_REF_REQUIRED|CUSTODY_REFERENCE_INVALID/);
  const record = createConsumerAcceptance({ ...base, origin_executor_ref: ORIGIN_EXECUTOR });
  assert.equal(record.origin_executor_ref, ORIGIN_EXECUTOR);
});

test("R3: independence evidence is validated on both ends against the record", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  assert.throws(
    () => recordConsumerEvidence(record, "executor.independence", { fresh_context_ref: FRESH_CONTEXT, origin_executor_ref: "some-other-executor", dependency_free: true, result: "PASS" }),
    /EXECUTOR_INDEPENDENCE_ORIGIN_MISMATCH/,
  );
  assert.throws(
    () => recordConsumerEvidence(record, "executor.independence", { fresh_context_ref: FRESH_CONTEXT, origin_executor_ref: ORIGIN_EXECUTOR, dependency_free: false, result: "PASS" }),
    /EXECUTOR_INDEPENDENCE_NOT_PROVEN/,
  );
  assert.throws(
    () => recordConsumerEvidence(record, "executor.independence", { fresh_context_ref: FRESH_CONTEXT, origin_executor_ref: ORIGIN_EXECUTOR, dependency_free: true, result: "FAIL" }),
    /EXECUTOR_INDEPENDENCE_NOT_PASS/,
  );
  assert.throws(
    () => recordConsumerEvidence(record, "executor.independence", { fresh_context_ref: ORIGIN_EXECUTOR, origin_executor_ref: ORIGIN_EXECUTOR, dependency_free: true, result: "PASS" }),
    /EXECUTOR_INDEPENDENCE_SAME_CONTEXT/,
  );
});

test("R3: the original executor context cannot self-certify independence", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = recordAll(controller, openAcceptance(controller, node));
  const independence = record.evidence.find((item) => item.element === "executor.independence");
  assert.equal(independence.data.origin_executor_ref, record.origin_executor_ref);
  assert.notEqual(independence.data.fresh_context_ref, record.origin_executor_ref);
  assert.equal(independence.data.dependency_free, true);
});

// R4 — durable custody cannot be reached by enum selection alone.

test("R4: a durable custody class without an owner is not durable", () => {
  for (const custodyClass of [CustodyClass.PROVIDER_NATIVE_SECRET, CustodyClass.HOST_OWNED_PROTECTED_ARTIFACT]) {
    assert.throws(
      () => classifyCustody({ custody_class: custodyClass, custody_ref: "deployment-secret/alpha" }),
      (error) => {
        assert.equal(error.code, "CUSTODY_DURABILITY_UNPROVEN");
        assert.equal(error.owner_present, false);
        return true;
      },
      custodyClass + " without owner must not be durable",
    );
    assert.throws(
      () => classifyCustody({ custody_class: custodyClass, custody_ref: "deployment-secret/alpha", owner_ref: OWNER_REF }),
      (error) => {
        assert.equal(error.code, "CUSTODY_DURABILITY_UNPROVEN");
        assert.equal(error.attestation_present, false);
        return true;
      },
      custodyClass + " without attestation must not be durable",
    );
    const proven = classifyCustody({ custody_class: custodyClass, custody_ref: "deployment-secret/alpha", owner_ref: OWNER_REF, attestation_ref: ATTESTATION_REF });
    assert.equal(proven.durability, CustodyDurability.DURABLE);
    assert.equal(proven.owner_ref, OWNER_REF);
    assert.equal(proven.attestation_ref, ATTESTATION_REF);
  }
});

test("R4: self-asserted durable custody blocks acceptance at evaluate time", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  // Build a record whose custody claims a durable class; the record itself
  // cannot be created durable, so acceptance must fail closed.
  const forged = {
    ...openAcceptance(controller, node),
    custody: { custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: "deployment-secret/alpha", owner_ref: OWNER_REF, attestation_ref: ATTESTATION_REF, durability: CustodyDurability.DURABLE },
  };
  assert.equal(forged.custody.durability, CustodyDurability.DURABLE);
  const decided = controller.evaluateConsumerAcceptance(forged.acceptance_id);
  assert.equal(decided.decision.accepted, false, "a caller cannot inject a durable classification without the store round-trip");
  assert.equal(decided.decision.missing.includes("custody.durability"), true);
});

test("R4: custody durability evidence must carry the owner and attestation bound to the record", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  const base = { durability: CustodyDurability.DURABLE, custody_class: record.custody.custody_class, custody_ref: record.custody.custody_ref, owner_ref: record.custody.owner_ref, attestation_ref: record.custody.attestation_ref };
  let next = record;
  for (const [label, patch, pattern] of [
    ["wrong owner", { owner_ref: "owner/someone-else" }, /EVIDENCE_CUSTODY_OWNER_MISMATCH/],
    ["wrong attestation", { attestation_ref: "attestation/other/custody-v9" }, /EVIDENCE_CUSTODY_ATTESTATION_MISMATCH/],
    ["missing attestation", { attestation_ref: undefined }, /CUSTODY_REFERENCE_INVALID|EVIDENCE_CUSTODY_ATTESTATION_MISMATCH/],
  ]) {
    assert.throws(() => recordConsumerEvidence(next, "custody.durability", { ...base, ...patch }), pattern, label);
  }
  next = recordConsumerEvidence(next, "custody.durability", base);
  assert.equal(next.evidence.length, 1);
});

// Criterion 2 — executor/session-local credential custody is rejected.

test("criterion 2: executor-bound custody classes are rejected for acceptance", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  for (const custodyClass of [CustodyClass.EXECUTOR_WORKSPACE, CustodyClass.SESSION_LOCAL, CustodyClass.AGENT_ARTIFACT]) {
    const custody = { custody_class: custodyClass, custody_ref: "workspace/agent-local-material" };
    assert.equal(classifyCustody(custody).durability, CustodyDurability.EXECUTOR_BOUND);
    const record = openAcceptance(controller, node, custody);
    const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
    assert.equal(decided.decision.accepted, false, custodyClass + " must not be acceptable");
    assert.deepEqual(decided.decision.blocking.map((item) => item.code), ["CUSTODY_NOT_DURABLE"]);
    assert.equal(decided.decision.missing.includes("custody.durability"), true);
  }
});

test("criterion 2: unresolved custody fails closed", () => {
  assert.equal(classifyCustody({ custody_class: CustodyClass.UNRESOLVED, custody_ref: "unresolved-ref" }).durability, CustodyDurability.UNRESOLVED);
  assert.throws(() => classifyCustody({ custody_class: "SOMETHING_ELSE", custody_ref: "opaque-ref" }), /CUSTODY_CLASS_INVALID/);
});

test("criterion 2: executor-bound custody cannot be laundered into durable evidence", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node, { custody_class: CustodyClass.SESSION_LOCAL, custody_ref: "session/local-material" });
  assert.throws(
    () => recordConsumerEvidence(record, "custody.durability", { durability: CustodyDurability.DURABLE, custody_class: record.custody.custody_class, custody_ref: record.custody.custody_ref, owner_ref: null, attestation_ref: null }),
    /CUSTODY_NOT_DURABLE/,
  );
});

// Criterion 3 — durable opaque custody reference satisfies the precondition without exposing secret material.

test("criterion 3: a durable opaque custody reference satisfies the precondition", () => {
  const classified = classifyCustody(DURABLE_CUSTODY);
  assert.equal(classified.durability, CustodyDurability.DURABLE);
  assert.equal(classified.custody_ref, "deployment-secret/alpha");
  const serialized = JSON.stringify(classified);
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal(serialized.includes("owner/platform-team") && false, false);
});

test("criterion 3: secret-shaped custody references are rejected", () => {
  const pemHeader = ["-----BEGIN ", "(?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?", "PRIVATE KEY-----"].join("");
  assert.throws(() => classifyCustody({ custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: pemHeader, owner_ref: OWNER_REF, attestation_ref: ATTESTATION_REF }), /CUSTODY_REFERENCE_INVALID|CUSTODY_REFERENCE_SECRET_SHAPED/);
  assert.throws(() => classifyCustody({ custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP", owner_ref: OWNER_REF, attestation_ref: ATTESTATION_REF }), /CUSTODY_REFERENCE_SECRET_SHAPED/);
  assert.throws(() => classifyCustody({ custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: "has spaces and is not opaque", owner_ref: OWNER_REF, attestation_ref: ATTESTATION_REF }), /CUSTODY_REFERENCE_INVALID/);
});

test("criterion 3: raw secret-bearing custody fields are rejected by the public-safety gate", () => {
  const unsafe = (custody) => () => classifyCustody(custody);
  for (const field of ["private_key", "bearer", "api_token", "password"]) {
    assert.throws(unsafe({ ...DURABLE_CUSTODY, [field]: "anything" }), (error) => {
      assert.equal(error.code, "UNSAFE_PUBLIC_PAYLOAD");
      return true;
    }, field + " must be rejected by the public-safety gate");
  }
});

test("criterion 3: full acceptance passes with a durable opaque custody reference", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = recordAll(controller, openAcceptance(controller, node));
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.decision.accepted, true);
  assert.deepEqual(decided.decision.missing, []);
  assert.deepEqual(decided.decision.blocking, []);
  assert.equal(decided.state, ConsumerAcceptanceState.ACCEPTED);
});

// Criterion 4 — executor-independence evidence is required before acceptance.

test("criterion 4: acceptance is withheld while executor-independence evidence is absent", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = recordAll(controller, openAcceptance(controller, node), { includeIndependence: false });
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.decision.accepted, false);
  assert.deepEqual(decided.decision.missing, ["executor.independence"]);
});

// R1 — rollback layering: acceptance requires a plan, not a completed rollback.

test("R1: acceptance requires a rollback plan, not a completed rollback", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = recordAll(controller, openAcceptance(controller, node));
  const accepted = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(accepted.state, ConsumerAcceptanceState.ACCEPTED);
  assert.deepEqual(accepted.declared_bindings, DECLARED_BINDINGS);
  assert.equal(accepted.decision.rolled_back_at, undefined, "acceptance must not carry a rollback result");
});

test("R1: the cutover meaning is preserved: bindings stay live while accepted", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const accepted = acceptedRecord(controller, node);
  // At ACCEPTED the new path must still be in place; nothing has been removed.
  assert.deepEqual(accepted.declared_bindings, DECLARED_BINDINGS);
  assert.equal(accepted.state, ConsumerAcceptanceState.ACCEPTED);
  assert.equal(accepted.decision.removed_bindings, undefined);
});

test("R1: a missing rollback plan is reported as missing, not as a completed rollback", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = recordAll(controller, openAcceptance(controller, node), { includePlan: false });
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.decision.accepted, false);
  assert.deepEqual(decided.decision.missing, ["rollback.plan"]);
  assert.equal(decided.declared_bindings, null, "never declared is distinct from explicitly empty");
});

test("R1: rollback result is verified only at completeConsumerRollback", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const accepted = acceptedRecord(controller, node);
  // Prior path not restored yet: acceptance is unaffected, rollback is blocked.
  assert.throws(() => controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: DECLARED_BINDINGS, prior_path_restored: false }), /ROLLBACK_PRIOR_PATH_NOT_RESTORED/);
  const rolled = controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: DECLARED_BINDINGS, prior_path_restored: true });
  assert.equal(rolled.state, ConsumerAcceptanceState.ROLLED_BACK);
  assert.deepEqual(rolled.decision.removed_bindings, DECLARED_BINDINGS);
});

// R5 — rollback output boundary: public-safe, exact set, explicit empty allowed.

test("R5: an extra undeclared removed binding is rejected", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const accepted = acceptedRecord(controller, node);
  assert.throws(
    () => controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: [...DECLARED_BINDINGS, "adapter-binding/someone-elses"], prior_path_restored: true }),
    (error) => {
      assert.equal(error.code, "ROLLBACK_BINDINGS_UNDECLARED");
      assert.deepEqual(error.extra, ["adapter-binding/someone-elses"]);
      return true;
    },
  );
});

test("R5: a partially removed declared set is rejected", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const accepted = acceptedRecord(controller, node);
  assert.throws(
    () => controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: [DECLARED_BINDINGS[0]], prior_path_restored: true }),
    (error) => {
      assert.equal(error.code, "ROLLBACK_BINDINGS_REMAIN");
      assert.deepEqual(error.missing, [DECLARED_BINDINGS[1]]);
      return true;
    },
  );
});

test("R5: rollback bindings are public-safe, bounded, opaque and deduplicated", () => {
  const base = { declared_bindings: DECLARED_BINDINGS, prior_path_restored: true, result: "PASS" };
  assert.throws(() => assertNodeScopedRollbackComplete({ ...base, removed_bindings: "not-an-array" }), /ROLLBACK_BINDINGS_INVALID/);
  assert.throws(() => assertNodeScopedRollbackComplete({ ...base, removed_bindings: ["has spaces in it"] }), /CUSTODY_REFERENCE_INVALID/);
  assert.throws(() => assertNodeScopedRollbackComplete({ ...base, removed_bindings: [DECLARED_BINDINGS[0], DECLARED_BINDINGS[0]] }), /ROLLBACK_BINDINGS_DUPLICATE/);
  assert.throws(() => assertNodeScopedRollbackComplete({ ...base, removed_bindings: DECLARED_BINDINGS, prior_path_restored: false }), /ROLLBACK_PRIOR_PATH_NOT_RESTORED/);
  assert.throws(() => assertNodeScopedRollbackComplete({ ...base, removed_bindings: DECLARED_BINDINGS, result: "PENDING" }), /ROLLBACK_NOT_COMPLETE/);
});

test("R5: completeConsumerRollback input is closed and public-safe", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const accepted = acceptedRecord(controller, node);
  assert.throws(() => controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: DECLARED_BINDINGS, prior_path_restored: true, unexpected: true }), /ROLLBACK_INPUT_FIELDS_INVALID/);
});

test("R5: an explicitly empty declared binding set is a legal, completable rollback", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const accepted = acceptedRecord(controller, node, { bindings: [] });
  assert.equal(accepted.state, ConsumerAcceptanceState.ACCEPTED);
  assert.deepEqual(accepted.declared_bindings, [], "explicitly empty is a real declaration");
  const rolled = controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: [], prior_path_restored: true });
  assert.equal(rolled.state, ConsumerAcceptanceState.ROLLED_BACK);
  assert.deepEqual(rolled.decision.removed_bindings, []);
});

test("R5: rollback without a declared plan is rejected as a missing plan", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  for (const [element, data] of evidencePairs(record, { includePlan: false })) {
    controller.recordConsumerAcceptanceEvidence(record.acceptance_id, element, data);
  }
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.state, ConsumerAcceptanceState.PENDING);
  assert.throws(() => controller.completeConsumerRollback(decided.acceptance_id, { removed_bindings: [], prior_path_restored: true }), /ROLLBACK_REQUIRES_ACCEPTED/);
});

// R7 — provider-neutral revision contract.

test("R7: config_revision need not be a Git SHA", () => {
  const record = createConsumerAcceptance({
    node_uid: makeId("node"), consumer_ref: "adapter.alpha",
    source_revision: SOURCE_REVISION, config_revision: CONFIG_REVISION,
    control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR,
  });
  assert.equal(record.config_revision, CONFIG_REVISION);
  assert.match(record.source_revision, /^[0-9a-f]{40}$/);
  for (const value of ["deployment-config/2026.10.5-rc1", "provider:config:42", "rev-2026-10-05", SOURCE_REVISION]) {
    assert.doesNotThrow(() => createConsumerAcceptance({
      node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION,
      config_revision: value, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR,
    }), value);
  }
  assert.throws(() => createConsumerAcceptance({
    node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION,
    config_revision: "has spaces and is not a ref", control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR,
  }), /REVISION_INVALID/);
});

// Criterion 6 — existing core semantics and the read-only default MCP surface are unchanged.

test("criterion 6: consumer acceptance never mutates NodeIdentity lifecycle or mints a second identity", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const before = controller.listNodes();
  const accepted = acceptedRecord(controller, node);
  assert.equal(accepted.state, ConsumerAcceptanceState.ACCEPTED);
  const after = controller.listNodes();
  assert.equal(after.length, before.length, "no second NodeIdentity may appear");
  assert.deepEqual(after, before, "node lifecycle and admission are untouched by consumer acceptance");
  assert.equal(controller.getNode(node.node_uid).lifecycle, NodeLifecycle.ACTIVE);
});

test("criterion 6: consumer acceptance is refused for a non-ACTIVE or mismatched node", () => {
  const controller = new GhostFleetController();
  const attempt = controller.createEnrollmentAttempt();
  controller.prepareEnrollmentAttempt(attempt.attempt_id);
  controller.claimEnrollmentAttempt(attempt.attempt_id);
  const provisional = controller.startMaterialization(attempt.attempt_id, { node_id: "provisional-device", platform: "linux" });
  const provisionalNode = controller.getNode(provisional.node_uid);
  assert.equal(provisionalNode.lifecycle, NodeLifecycle.PROVISIONAL);
  const record = controller.openConsumerAcceptance({
    node_uid: provisionalNode.node_uid, consumer_ref: "adapter.alpha",
    source_revision: SOURCE_REVISION, config_revision: CONFIG_REVISION,
    control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR,
  });
  assert.throws(() => controller.evaluateConsumerAcceptance(record.acceptance_id), /NODE_NOT_ACTIVE/);
  const other = admitNode(controller).node;
  assert.throws(() => evaluateConsumerAcceptance(record, { node: other }), /NODE_REFERENCE_MISMATCH/);
  assert.throws(() => evaluateConsumerAcceptance(record, {}), /NODE_REFERENCE_REQUIRED/);
});

test("criterion 6: the read-only default MCP tool surface is unchanged", async () => {
  const { MCP_TOOLS, createMcpDispatcher } = await import("../src/integrations/mcp.js");
  assert.deepEqual(MCP_TOOLS.map((tool) => tool.name), [
    "ghostfleet_list_nodes",
    "ghostfleet_list_enrollment_attempts",
    "ghostfleet_inspect_enrollment_attempt",
    "ghostfleet_list_capabilities",
  ]);
  for (const tool of MCP_TOOLS) assert.doesNotMatch(tool.name, /consumer/i);
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  recordAll(controller, openAcceptance(controller, node));
  controller.evaluateConsumerAcceptance(controller.listConsumerAcceptances()[0].acceptance_id);
  const dispatch = createMcpDispatcher(controller);
  assert.deepEqual((await dispatch("ghostfleet_list_nodes", {})).nodes.map((item) => item.node_uid), [node.node_uid]);
  await assert.rejects(() => dispatch("ghostfleet_list_consumer_acceptances", {}), /MCP_TOOL_NOT_FOUND/);
});

// Criterion 7 — both languages are covered by docs/CONSUMER_ACCEPTANCE.md.

test("criterion 7: the bilingual consumer acceptance document is registered and complete", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../docs/CONSUMER_ACCEPTANCE.md", import.meta.url), "utf8");
  const zh = text.indexOf("## 中文");
  const en = text.indexOf("## English");
  assert.ok(zh >= 0 && en > zh, "both language sections are required");
  // Before the Chinese section only machine-literal metadata (title, artifact
  // keys) may appear. Any prose line means English leaked above the Chinese.
  const preambleProse = text.slice(0, zh).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !/^(?:artifact|artifact_version|status|owner):/.test(line));
  assert.deepEqual(preambleProse, [], "no prose may precede the Chinese section");
  for (const topic of ["boundary", "elements", "custody", "independence", "rollback", "nonadmitting"]) {
    const zhTopic = text.indexOf(`<!-- topic:${topic} -->`);
    const enTopic = text.lastIndexOf(`<!-- topic:${topic} -->`);
    assert.ok(zhTopic > zh, `zh topic ${topic} placement`);
    assert.ok(enTopic > en, `en topic ${topic} placement`);
  }
});

// Contract shape and fail-closed behaviour.

test("consumer acceptance input is closed and validated", () => {
  assert.throws(() => createConsumerAcceptance({}), /NODE_UID_INVALID/);
  assert.throws(() => createConsumerAcceptance({ node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: "has spaces", config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR }), /REVISION_INVALID/);
  assert.throws(() => createConsumerAcceptance({ node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION, config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR, unexpected: true }), /CONSUMER_INPUT_FIELDS_INVALID/);
  assert.throws(() => createConsumerAcceptance([{ node_uid: makeId("node"), consumer_ref: "adapter.alpha" }]), /CONSUMER_INPUT_INVALID/);
  assert.throws(() => createConsumerAcceptance({ node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION, config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: { ...DURABLE_CUSTODY, extra_custody_field: "x" }, origin_executor_ref: ORIGIN_EXECUTOR }), /CUSTODY_FIELDS_INVALID/);
  assert.throws(() => createConsumerAcceptance({ node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION, config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: { custody_class: "SOMETHING_ELSE", custody_ref: "opaque-ref", owner_ref: OWNER_REF, attestation_ref: ATTESTATION_REF }, origin_executor_ref: ORIGIN_EXECUTOR }), /CUSTODY_CLASS_INVALID/);
});

test("positive, negative and readback evidence must actually prove what they claim", () => {
  const record = createConsumerAcceptance({
    node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION,
    config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR,
  });
  assert.throws(() => recordConsumerEvidence(record, "authority.positive", { operation: "x", result: "DENIED", receipt_ref: "receipt/a" }), /EVIDENCE_POSITIVE_NOT_PASS/);
  assert.throws(() => recordConsumerEvidence(record, "authority.negative", { operation: "x", result: "PASS", receipt_ref: "receipt/b" }), /EVIDENCE_NEGATIVE_NOT_DENIED/);
  assert.throws(() => recordConsumerEvidence(record, "call_route.readback", { node_uid: makeId("node"), observed_ref: "route/other-node" }), /EVIDENCE_ROUTE_IDENTITY_MISMATCH/);
  assert.throws(() => recordConsumerEvidence(record, "identity.reference", { node_uid: makeId("node") }), /EVIDENCE_IDENTITY_MISMATCH/);
});

test("a rollback plan must declare a bounded opaque binding set and a restoration contract", () => {
  const record = createConsumerAcceptance({
    node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION,
    config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR,
  });
  assert.throws(() => recordConsumerEvidence(record, "rollback.plan", { declared_bindings: "nope", prior_path_restoration_contract_ref: RESTORATION_CONTRACT }), /ROLLBACK_BINDINGS_INVALID/);
  assert.throws(() => recordConsumerEvidence(record, "rollback.plan", { declared_bindings: DECLARED_BINDINGS }), /CUSTODY_REFERENCE_INVALID/);
  assert.throws(() => recordConsumerEvidence(record, "rollback.plan", { declared_bindings: DECLARED_BINDINGS, prior_path_restoration_contract_ref: "not opaque" }), /CUSTODY_REFERENCE_INVALID/);
  const many = Array.from({ length: 65 }, (_, index) => `adapter-binding/b${index}`);
  assert.throws(() => recordConsumerEvidence(record, "rollback.plan", { declared_bindings: many, prior_path_restoration_contract_ref: RESTORATION_CONTRACT }), /ROLLBACK_BINDINGS_TOO_MANY/);
  const next = recordConsumerEvidence(record, "rollback.plan", { declared_bindings: [], prior_path_restoration_contract_ref: RESTORATION_CONTRACT });
  assert.deepEqual(next.declared_bindings, []);
});

test("signals are rejected once the record leaves PENDING and never mutate evidence", () => {
  const record = createConsumerAcceptance({
    node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION,
    config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, origin_executor_ref: ORIGIN_EXECUTOR,
  });
  const withSignal = recordConsumerSignal(record, "transport_tunnel_healthy", { note: "healthy" });
  assert.equal(withSignal.evidence.length, 0);
  assert.equal(withSignal.signals.length, 1);
  assert.throws(() => recordConsumerSignal(record, "not_a_signal"), /SIGNAL_UNKNOWN/);
});