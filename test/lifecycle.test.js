import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { CORE_OWNED_EVIDENCE, DEFAULT_ACCEPTANCE_EVIDENCE, EnrollmentState, NodeLifecycle } from "../src/core/model.js";
import { InMemoryStore } from "../src/control-plane/store.js";

const ADAPTER_EVIDENCE = DEFAULT_ACCEPTANCE_EVIDENCE.filter((type) => !CORE_OWNED_EVIDENCE.includes(type));

test("enrollment lifecycle requires HumanGate and evidence before admission", () => {
  const controller = new GhostFleetController();
  const created = controller.createEnrollmentAttempt({ asset_hint: "lab-laptop" });
  assert.equal(created.state, EnrollmentState.CREATED);

  controller.prepareEnrollmentAttempt(created.attempt_id);
  const gate = controller.requireEnrollmentHumanGate(created.attempt_id);
  assert.equal(controller.getEnrollmentAttempt(created.attempt_id).state, EnrollmentState.WAITING_HUMAN);

  controller.resolveHumanGate(gate.gate_id, "APPROVE");
  assert.equal(controller.getEnrollmentAttempt(created.attempt_id).state, EnrollmentState.CLAIMED);

  controller.startMaterialization(created.attempt_id, { node_id: "lab-laptop", platform: "linux" });
  for (const type of ADAPTER_EVIDENCE) {
    controller.recordEvidence(created.attempt_id, { type, source: "synthetic-test", data: { status: "PASS" } });
  }

  const node = controller.acceptEnrollment(created.attempt_id, { node_id: "lab-laptop", platform: "linux" });
  assert.equal(node.lifecycle, NodeLifecycle.ACTIVE);
  const accepted = controller.getEnrollmentAttempt(created.attempt_id);
  assert.equal(accepted.state, EnrollmentState.ACCEPTED);
  assert.equal(accepted.node_uid, node.node_uid);
});

test("enrollment cannot skip lifecycle phases", () => {
  const controller = new GhostFleetController();
  const created = controller.createEnrollmentAttempt();
  assert.throws(() => controller.startMaterialization(created.attempt_id), /INVALID_TRANSITION|invalid enrollment transition/);
});

test("acceptance reports missing evidence instead of silently admitting", () => {
  const controller = new GhostFleetController();
  const attempt = controller.createEnrollmentAttempt();
  controller.prepareEnrollmentAttempt(attempt.attempt_id);
  controller.claimEnrollmentAttempt(attempt.attempt_id);
  controller.startMaterialization(attempt.attempt_id);
  assert.throws(
    () => controller.acceptEnrollment(attempt.attempt_id),
    (error) => error.message === "ACCEPTANCE_EVIDENCE_MISSING" && error.missing.length === ADAPTER_EVIDENCE.length,
  );
});

test("materialization exposes one provisional identity before real control/reboot proofs", () => {
  const c = new GhostFleetController();
  const a = c.createEnrollmentAttempt();
  c.prepareEnrollmentAttempt(a.attempt_id);
  c.claimEnrollmentAttempt(a.attempt_id);
  const m = c.startMaterialization(a.attempt_id, { node_id: "synthetic-device", platform: "linux" });
  assert.ok(m.node_uid);
  assert.equal(c.listNodes().length, 1);
  const node = c.getNode(m.node_uid);
  assert.equal(node.lifecycle, NodeLifecycle.PROVISIONAL);
  assert.equal(node.admitted_at, null);
  assert.deepEqual(node.capabilities, []);
  for (const type of CORE_OWNED_EVIDENCE) {
    const evidence = m.evidence.find((e) => e.type === type);
    assert.equal(evidence.source, "ghostfleet-core");
    assert.equal(evidence.data.node_uid, node.node_uid);
    assert.equal(evidence.data.lifecycle, NodeLifecycle.PROVISIONAL);
  }
  assert.throws(() => c.acceptEnrollment(a.attempt_id), /ACCEPTANCE_EVIDENCE_MISSING/);
  assert.equal(c.getNode(m.node_uid).lifecycle, NodeLifecycle.PROVISIONAL);
  for (const type of ADAPTER_EVIDENCE) c.recordEvidence(a.attempt_id, { type, source: "synthetic-test", data: { status: "PASS" } });
  const active = c.acceptEnrollment(a.attempt_id);
  assert.equal(active.node_uid, m.node_uid);
  assert.equal(active.lifecycle, NodeLifecycle.ACTIVE);
  assert.equal(c.listNodes().length, 1);
  assert.equal(c.listEvents().filter((e) => e.type === "NodeAdmitted").length, 1);
});

test("lost-response retry and restored reconcile retain identity without material delta", () => {
  let c = new GhostFleetController();
  const a = c.createEnrollmentAttempt();
  c.prepareEnrollmentAttempt(a.attempt_id);
  c.claimEnrollmentAttempt(a.attempt_id);
  const m = c.startMaterialization(a.attempt_id);
  const snapshot = c.store.snapshot();
  c = new GhostFleetController({ store: new InMemoryStore(snapshot) });
  assert.deepEqual(c.startMaterialization(a.attempt_id), m);
  assert.deepEqual(c.store.snapshot(), snapshot);
  c.markReconcileRequired(a.attempt_id);
  c = new GhostFleetController({ store: new InMemoryStore(c.store.snapshot()) });
  c.resumeFromReconcile(a.attempt_id, EnrollmentState.MATERIALIZING);
  assert.equal(c.getEnrollmentAttempt(a.attempt_id).node_uid, m.node_uid);
  assert.equal(c.listNodes().length, 1);
});

test("public evidence cannot manufacture or overwrite core identity/catalog proofs", () => {
  const c = new GhostFleetController();
  const a = c.createEnrollmentAttempt();
  for (const type of CORE_OWNED_EVIDENCE) {
    assert.throws(() => c.recordEvidence(a.attempt_id, { type, source: "synthetic-test", data: { status: "PASS" } }), /CORE_EVIDENCE_RESERVED/);
  }
  assert.throws(() => c.recordEvidence(a.attempt_id, { type: "transport.ready", source: "ghostfleet-core" }), /CORE_EVIDENCE_RESERVED/);
  assert.equal(c.getEnrollmentAttempt(a.attempt_id).evidence.length, 0);
});

test("reconcile cannot skip identity materialization", () => {
  const c = new GhostFleetController();
  const a = c.createEnrollmentAttempt();
  c.prepareEnrollmentAttempt(a.attempt_id);
  c.claimEnrollmentAttempt(a.attempt_id);
  c.markReconcileRequired(a.attempt_id);
  const before = c.store.snapshot();
  assert.throws(() => c.resumeFromReconcile(a.attempt_id, EnrollmentState.MATERIALIZING), /PROVISIONAL_IDENTITY_MISSING/);
  assert.deepEqual(c.store.snapshot(), before);
});

test("caller-selected identity and mismatched core evidence fail closed", () => {
  const c = new GhostFleetController();
  const a = c.createEnrollmentAttempt();
  c.prepareEnrollmentAttempt(a.attempt_id);
  c.claimEnrollmentAttempt(a.attempt_id);
  assert.throws(() => c.startMaterialization(a.attempt_id, { node_uid: "node-synthetic-retired" }), /MATERIALIZATION_INPUT_INVALID/);
  assert.equal(c.listNodes().length, 0);
  const m = c.startMaterialization(a.attempt_id);
  for (const type of ADAPTER_EVIDENCE) c.recordEvidence(a.attempt_id, { type, data: { status: "PASS" } });
  const corrupted = c.getEnrollmentAttempt(a.attempt_id);
  corrupted.evidence.find((e) => e.type === "catalog.admitted").data.node_uid = "node-synthetic-other";
  c.store.putAttempt(corrupted);
  const before = c.store.snapshot();
  assert.throws(() => c.acceptEnrollment(a.attempt_id), /CORE_EVIDENCE_INVALID/);
  assert.equal(c.getNode(m.node_uid).lifecycle, NodeLifecycle.PROVISIONAL);
  assert.deepEqual(c.store.snapshot(), before);
});

test("identity drift and expired acceptance never promote or remint a node", () => {
  let now = 0;
  class Clock extends Date {
    constructor(value = now) { super(value); }
    static now() { return now; }
  }
  const c = new GhostFleetController({ clock: Clock });
  const a = c.createEnrollmentAttempt({ ttl_seconds: 30 });
  c.prepareEnrollmentAttempt(a.attempt_id);
  c.claimEnrollmentAttempt(a.attempt_id);
  const m = c.startMaterialization(a.attempt_id, { node_id: "synthetic-device", platform: "linux" });
  for (const type of ADAPTER_EVIDENCE) c.recordEvidence(a.attempt_id, { type, data: { status: "PASS" } });
  const snapshot = c.store.snapshot();
  assert.throws(() => c.startMaterialization(a.attempt_id, { node_id: "another-device" }), /NODE_IDENTITY_MISMATCH/);
  assert.throws(() => c.acceptEnrollment(a.attempt_id, { platform: "android" }), /NODE_IDENTITY_MISMATCH/);
  assert.deepEqual(c.store.snapshot(), snapshot);
  now = 31_000;
  assert.throws(() => c.acceptEnrollment(a.attempt_id), /ATTEMPT_EXPIRED/);
  assert.equal(c.getNode(m.node_uid).lifecycle, NodeLifecycle.PROVISIONAL);
  assert.deepEqual(c.store.snapshot(), snapshot);
});

test("ambiguous outcome becomes explicit reconcile state", () => {
  const controller = new GhostFleetController();
  const attempt = controller.createEnrollmentAttempt();
  controller.prepareEnrollmentAttempt(attempt.attempt_id);
  controller.claimEnrollmentAttempt(attempt.attempt_id);
  controller.markReconcileRequired(attempt.attempt_id, "provider outcome unknown");
  assert.equal(controller.getEnrollmentAttempt(attempt.attempt_id).state, EnrollmentState.RECONCILE_REQUIRED);
  controller.resumeFromReconcile(attempt.attempt_id, EnrollmentState.CLAIMED);
  assert.equal(controller.getEnrollmentAttempt(attempt.attempt_id).state, EnrollmentState.CLAIMED);
});

test("public evidence rejects raw secret-bearing fields", () => {
  const controller = new GhostFleetController();
  const attempt = controller.createEnrollmentAttempt();
  assert.throws(
    () => controller.recordEvidence(attempt.attempt_id, { type: "transport.ready", data: { api_token: "do-not-store-this" } }),
    /raw secret-bearing field/,
  );
});
