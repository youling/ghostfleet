import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { DEFAULT_ACCEPTANCE_EVIDENCE, EnrollmentState, NodeLifecycle } from "../src/core/model.js";

test("enrollment lifecycle requires HumanGate and evidence before admission", () => {
  const controller = new GhostFleetController();
  const created = controller.createEnrollmentAttempt({ asset_hint: "lab-laptop" });
  assert.equal(created.state, EnrollmentState.CREATED);

  controller.prepareEnrollmentAttempt(created.attempt_id);
  const gate = controller.requireEnrollmentHumanGate(created.attempt_id);
  assert.equal(controller.getEnrollmentAttempt(created.attempt_id).state, EnrollmentState.WAITING_HUMAN);

  controller.resolveHumanGate(gate.gate_id, "APPROVE");
  assert.equal(controller.getEnrollmentAttempt(created.attempt_id).state, EnrollmentState.CLAIMED);

  controller.startMaterialization(created.attempt_id);
  for (const type of DEFAULT_ACCEPTANCE_EVIDENCE) {
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
    (error) => error.message === "ACCEPTANCE_EVIDENCE_MISSING" && error.missing.length === DEFAULT_ACCEPTANCE_EVIDENCE.length,
  );
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
