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
import { NodeLifecycle } from "../src/core/model.js";

const SOURCE_REVISION = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const CONFIG_REVISION = "0f9e8d7c6b5a4938271605f4e3d2c1b0a9988776";
const CONTROL_PATH_REF = "control-path/deployment-alpha/primary";
const DURABLE_CUSTODY = { custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: "deployment-secret/alpha", owner_ref: "owner/platform-team" };
const INTRODUCED_BINDINGS = ["adapter-binding/node-scope", "adapter-binding/consumer-route"];

function admitNode(controller) {
  const attempt = controller.createEnrollmentAttempt({ asset_hint: "lab-device" });
  controller.prepareEnrollmentAttempt(attempt.attempt_id);
  controller.claimEnrollmentAttempt(attempt.attempt_id);
  const materialized = controller.startMaterialization(attempt.attempt_id, { node_id: "lab-device", platform: "linux" });
  const types = ["transport.ready", "bootstrap.report", "control.canary", "convergence.zero_delta", "reboot.recovered"];
  for (const type of types) controller.recordEvidence(attempt.attempt_id, { type, source: "synthetic-test", data: { status: "PASS" } });
  const node = controller.acceptEnrollment(attempt.attempt_id, { node_id: "lab-device", platform: "linux" });
  return { node, attempt, types };
}

function openAcceptance(controller, node, custody = DURABLE_CUSTODY, origin = "executor-original-run") {
  return controller.openConsumerAcceptance({
    node_uid: node.node_uid,
    consumer_ref: "adapter.alpha",
    source_revision: SOURCE_REVISION,
    config_revision: CONFIG_REVISION,
    control_path_ref: CONTROL_PATH_REF,
    custody,
    origin_executor_ref: origin,
  });
}

// Records through the controller so the durable store is updated, matching how
// an adapter integration would actually drive the contract.
function evidencePairs(record, { bindings = INTRODUCED_BINDINGS, removed = INTRODUCED_BINDINGS, includeIndependence = true } = {}) {
  const pairs = [
    ["identity.reference", { node_uid: record.node_uid, lifecycle: NodeLifecycle.ACTIVE }],
    ["consumer.identity", { consumer_ref: record.consumer_ref, source_revision: record.source_revision, config_revision: record.config_revision }],
    ["control_path.binding", { control_path_ref: record.control_path_ref, binding_ref: bindings[0] ?? "adapter-binding/node-scope" }],
    ["custody.durability", { durability: CustodyDurability.DURABLE, custody_class: record.custody.custody_class, custody_ref: record.custody.custody_ref }],
    ["authority.positive", { operation: "node.identity.read", result: "PASS", receipt_ref: "receipt/positive-one" }],
    ["authority.negative", { operation: "node.privileged.write", result: "DENIED", denial_observed: true, receipt_ref: "receipt/negative-one" }],
    ["call_route.readback", { node_uid: record.node_uid, observed_ref: "route-readback/observed-one" }],
  ];
  if (includeIndependence) pairs.push(["executor.independence", { fresh_context_ref: "executor-fresh-context", origin_executor_ref: record.origin_executor_ref, dependency_free: true, operation: "node.identity.read", result: "PASS" }]);
  pairs.push(["rollback.node_scoped", { declared_bindings: bindings, removed_bindings: removed, prior_path_restored: true, result: "PASS" }]);
  return pairs;
}

function evidenceFor(controller, record, options) {
  for (const [element, data] of evidencePairs(record, options)) {
    controller.recordConsumerAcceptanceEvidence(record.acceptance_id, element, data);
  }
  return controller.getConsumerAcceptance(record.acceptance_id);
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

test("criterion 1: an unknown signal cannot be recorded and evidence elements are closed", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  assert.throws(() => controller.recordConsumerSignal(record.acceptance_id, "core_active_but_really"), /SIGNAL_UNKNOWN/);
  assert.throws(() => recordConsumerEvidence(record, "core_active", { status: "PASS" }), /EVIDENCE_ELEMENT_UNKNOWN/);
  assert.throws(() => recordConsumerEvidence(record, "transport_tunnel_healthy", { status: "PASS" }), /EVIDENCE_ELEMENT_UNKNOWN/);
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
    () => recordConsumerEvidence(record, "custody.durability", { durability: CustodyDurability.DURABLE, custody_class: record.custody.custody_class, custody_ref: record.custody.custody_ref }),
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
});

test("criterion 3: secret-shaped custody references are rejected", () => {
  const pemHeader = ["-----BEGIN ", "(?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?", "PRIVATE KEY-----"].join("");
  assert.throws(() => classifyCustody({ custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: pemHeader }), /CUSTODY_REFERENCE_INVALID|CUSTODY_REFERENCE_SECRET_SHAPED/);
  assert.throws(() => classifyCustody({ custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP" }), /CUSTODY_REFERENCE_SECRET_SHAPED/);
  assert.throws(() => classifyCustody({ custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: "has spaces and is not opaque" }), /CUSTODY_REFERENCE_INVALID/);
});

test("criterion 3: raw secret-bearing custody fields are rejected by the public-safety gate", () => {
  const unsafe = (custody) => () => classifyCustody(custody);
  for (const field of ["private_key", "bearer", "api_token", "password"]) {
    assert.throws(unsafe({ custody_class: CustodyClass.PROVIDER_NATIVE_SECRET, custody_ref: "opaque-ref", [field]: "anything" }), (error) => {
      assert.equal(error.code, "UNSAFE_PUBLIC_PAYLOAD");
      return true;
    }, field + " must be rejected by the public-safety gate");
  }
});

test("criterion 3: full acceptance passes with a durable opaque custody reference", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = evidenceFor(controller, openAcceptance(controller, node));
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
  const record = openAcceptance(controller, node);
  for (const [element, data] of evidencePairs(record, { includeIndependence: false })) {
    controller.recordConsumerAcceptanceEvidence(record.acceptance_id, element, data);
  }
  const decided = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(decided.decision.accepted, false);
  assert.deepEqual(decided.decision.missing, ["executor.independence"]);
});

test("criterion 4: independence evidence must come from a genuinely fresh context", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  assert.throws(
    () => recordConsumerEvidence(record, "executor.independence", { fresh_context_ref: "executor-fresh-context", dependency_free: false, result: "PASS" }),
    /EXECUTOR_INDEPENDENCE_NOT_PROVEN/,
  );
  assert.throws(
    () => recordConsumerEvidence(record, "executor.independence", { fresh_context_ref: "executor-fresh-context", dependency_free: true, result: "FAIL" }),
    /EXECUTOR_INDEPENDENCE_NOT_PASS/,
  );
  assert.throws(
    () => recordConsumerEvidence(record, "executor.independence", { fresh_context_ref: record.origin_executor_ref, dependency_free: true, result: "PASS" }),
    /EXECUTOR_INDEPENDENCE_SAME_CONTEXT/,
  );
});

test("criterion 4: the original executor context cannot self-certify independence", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = evidenceFor(controller, openAcceptance(controller, node));
  assert.equal(record.evidence.some((item) => item.element === "executor.independence"), true);
  const independence = record.evidence.find((item) => item.element === "executor.independence");
  assert.notEqual(independence.data.fresh_context_ref, record.origin_executor_ref);
  assert.equal(independence.data.dependency_free, true);
});

// Criterion 5 — node-scoped rollback cannot pass while adapter-declared bindings remain.

test("criterion 5: rollback evidence is rejected while a declared binding remains live", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = openAcceptance(controller, node);
  assert.throws(
    () => recordConsumerEvidence(record, "rollback.node_scoped", { declared_bindings: INTRODUCED_BINDINGS, removed_bindings: [INTRODUCED_BINDINGS[0]], prior_path_restored: true, result: "PASS" }),
    /ROLLBACK_BINDINGS_REMAIN/,
  );
});

test("criterion 5: completed consumer rollback is blocked while a binding remains", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = evidenceFor(controller, openAcceptance(controller, node));
  const accepted = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(accepted.state, ConsumerAcceptanceState.ACCEPTED);
  assert.deepEqual(accepted.introduced_bindings, INTRODUCED_BINDINGS);
  assert.throws(() => controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: [INTRODUCED_BINDINGS[0]], prior_path_restored: true }), /ROLLBACK_BINDINGS_REMAIN/);
  const rolled = controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: INTRODUCED_BINDINGS, prior_path_restored: true });
  assert.equal(rolled.state, ConsumerAcceptanceState.ROLLED_BACK);
  assert.deepEqual(rolled.decision.removed_bindings, INTRODUCED_BINDINGS);
});

test("criterion 5: a code or version rollback alone cannot satisfy node-scoped rollback", () => {
  assert.throws(() => assertNodeScopedRollbackComplete({ declared_bindings: INTRODUCED_BINDINGS, removed_bindings: [], prior_path_restored: true, result: "PASS" }), /ROLLBACK_BINDINGS_REMAIN/);
  assert.throws(() => assertNodeScopedRollbackComplete({ declared_bindings: INTRODUCED_BINDINGS, removed_bindings: INTRODUCED_BINDINGS, prior_path_restored: false, result: "PASS" }), /ROLLBACK_PRIOR_PATH_NOT_RESTORED/);
  assert.throws(() => assertNodeScopedRollbackComplete({ declared_bindings: INTRODUCED_BINDINGS, removed_bindings: INTRODUCED_BINDINGS, prior_path_restored: true, result: "PENDING" }), /ROLLBACK_NOT_COMPLETE/);
});

test("criterion 5: rollback cannot be completed for a record that never declared bindings", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const record = evidenceFor(controller, openAcceptance(controller, node), { bindings: [], removed: [] });
  const accepted = controller.evaluateConsumerAcceptance(record.acceptance_id);
  assert.equal(accepted.state, ConsumerAcceptanceState.ACCEPTED);
  assert.throws(() => controller.completeConsumerRollback(accepted.acceptance_id, { removed_bindings: [], prior_path_restored: true }), /ROLLBACK_NO_BINDINGS_DECLARED/);
});

// Criterion 6 — existing core semantics and the read-only default MCP surface are unchanged.

test("criterion 6: consumer acceptance never mutates NodeIdentity lifecycle or mints a second identity", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const before = controller.listNodes();
  const record = evidenceFor(controller, openAcceptance(controller, node));
  const accepted = controller.evaluateConsumerAcceptance(record.acceptance_id);
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
    node_uid: provisionalNode.node_uid,
    consumer_ref: "adapter.alpha",
    source_revision: SOURCE_REVISION,
    config_revision: CONFIG_REVISION,
    control_path_ref: CONTROL_PATH_REF,
    custody: DURABLE_CUSTODY,
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
  const record = evidenceFor(controller, openAcceptance(controller, node));
  controller.evaluateConsumerAcceptance(record.acceptance_id);
  const dispatch = createMcpDispatcher(controller);
  assert.deepEqual((await dispatch("ghostfleet_list_nodes", {})).nodes.map((item) => item.node_uid), [node.node_uid]);
  await assert.rejects(() => dispatch("ghostfleet_list_consumer_acceptances", {}), /MCP_TOOL_NOT_FOUND/);
});

// Criterion 7 — both languages are covered by docs/CONSUMER_ACCEPTANCE.md (structure asserted in docs-check).

test("criterion 7: the bilingual consumer acceptance document is registered and complete", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../docs/CONSUMER_ACCEPTANCE.md", import.meta.url), "utf8");
  const zh = text.indexOf("## 中文");
  const en = text.indexOf("## English");
  assert.ok(zh >= 0 && en > zh, "both language sections are required");
  for (const topic of ["boundary", "elements", "custody", "independence", "rollback", "nonadmitting"]) {
    assert.ok(text.includes(`<!-- topic:${topic} -->`), `zh topic ${topic}`);
    assert.ok(text.indexOf(`<!-- topic:${topic} -->`) > zh, `zh topic ${topic} placement`);
    assert.ok(text.lastIndexOf(`<!-- topic:${topic} -->`) > en, `en topic ${topic} placement`);
  }
});

// Contract shape and fail-closed behaviour.

test("consumer acceptance input is closed and validated", () => {
  assert.throws(() => createConsumerAcceptance({}), /NODE_UID_INVALID/);
  assert.throws(() => createConsumerAcceptance({ node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: "nothex", config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY }), /REVISION_INVALID/);
  assert.throws(() => createConsumerAcceptance({ node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION, config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY, unexpected: true }), /CONSUMER_INPUT_FIELDS_INVALID/);
});

test("positive, negative and readback evidence must actually prove what they claim", () => {
  const record = createConsumerAcceptance({
    node_uid: makeId("node"), consumer_ref: "adapter.alpha", source_revision: SOURCE_REVISION,
    config_revision: CONFIG_REVISION, control_path_ref: CONTROL_PATH_REF, custody: DURABLE_CUSTODY,
  });
  assert.throws(() => recordConsumerEvidence(record, "authority.positive", { operation: "x", result: "DENIED", receipt_ref: "receipt/a" }), /EVIDENCE_POSITIVE_NOT_PASS/);
  assert.throws(() => recordConsumerEvidence(record, "authority.negative", { operation: "x", result: "PASS", receipt_ref: "receipt/b" }), /EVIDENCE_NEGATIVE_NOT_DENIED/);
  assert.throws(() => recordConsumerEvidence(record, "call_route.readback", { node_uid: makeId("node"), observed_ref: "route/other-node" }), /EVIDENCE_ROUTE_IDENTITY_MISMATCH/);
  assert.throws(() => recordConsumerEvidence(record, "identity.reference", { node_uid: makeId("node") }), /EVIDENCE_IDENTITY_MISMATCH/);
});

test("an accepted record rejects further evidence and non-accepted records cannot roll back", () => {
  const controller = new GhostFleetController();
  const { node } = admitNode(controller);
  const pending = openAcceptance(controller, node);
  assert.throws(() => controller.completeConsumerRollback(pending.acceptance_id, { removed_bindings: INTRODUCED_BINDINGS, prior_path_restored: true }), /ROLLBACK_REQUIRES_ACCEPTED/);
  const accepted = controller.evaluateConsumerAcceptance(evidenceFor(controller, pending).acceptance_id);
  assert.equal(accepted.state, ConsumerAcceptanceState.ACCEPTED);
  assert.throws(() => controller.recordConsumerAcceptanceEvidence(accepted.acceptance_id, "authority.positive", { operation: "x", result: "PASS", receipt_ref: "receipt/c" }), /CONSUMER_ALREADY_ACCEPTED/);
});