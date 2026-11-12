import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";
import { createMcpDispatcher } from "../src/integrations/mcp.js";
import { CORE_OWNED_EVIDENCE, DEFAULT_ACCEPTANCE_EVIDENCE } from "../src/core/model.js";

test("HTTP API creates and lists enrollment attempts", async () => {
  const controller = new GhostFleetController();
  const handle = createHttpHandler(controller, { authorizeOperator: () => true });
  const create = await handle(new Request("http://ghostfleet.test/v0/enrollment-attempts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ asset_hint: "test-node" }),
  }));
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.attempt.asset_hint, "test-node");

  const list = await handle(new Request("http://ghostfleet.test/v0/enrollment-attempts"));
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.attempts.length, 1);
});

test("HTTP health endpoint is independent from node availability", async () => {
  const handle = createHttpHandler(new GhostFleetController(), { authorizeOperator: () => true });
  const response = await handle(new Request("http://ghostfleet.test/healthz"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "ghostfleet", version: "0.1.0-dev" });
});

test("HTTP and read-only MCP expose the same provisional identity before and after acceptance", async () => {
  const c = new GhostFleetController();
  const handle = createHttpHandler(c, { authorizeOperator: () => true });
  const mcp = createMcpDispatcher(c);
  const a = c.createEnrollmentAttempt();
  c.prepareEnrollmentAttempt(a.attempt_id);
  c.claimEnrollmentAttempt(a.attempt_id);
  const materialized = await handle(new Request(`http://ghostfleet.test/v0/enrollment-attempts/${a.attempt_id}/materialize`, {
    method: "POST", body: JSON.stringify({ node_id: "synthetic-device", platform: "linux" }),
  }));
  const m = (await materialized.json()).attempt;
  assert.ok(m.node_uid);
  const http = await (await handle(new Request("http://ghostfleet.test/v0/nodes"))).json();
  assert.deepEqual(http.nodes, (await mcp("ghostfleet_list_nodes")).nodes);
  assert.equal(http.nodes[0].lifecycle, "PROVISIONAL");
  assert.equal(http.nodes[0].node_id, "synthetic-device");
  for (const type of DEFAULT_ACCEPTANCE_EVIDENCE.filter((type) => !CORE_OWNED_EVIDENCE.includes(type))) {
    c.recordEvidence(a.attempt_id, { type, source: "synthetic-test", data: { status: "PASS" } });
  }
  const active = c.acceptEnrollment(a.attempt_id);
  assert.equal(active.node_uid, m.node_uid);
  assert.deepEqual((await (await handle(new Request("http://ghostfleet.test/v0/nodes"))).json()).nodes, (await mcp("ghostfleet_list_nodes")).nodes);
});


test("operator HTTP cannot forge Linux admission evidence or bootstrap completion", async () => {
  const c = new GhostFleetController();
  const handle = createHttpHandler(c, { authorizeOperator: () => true });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "synthetic-target" });
  c.prepareEnrollmentAttempt(attempt.attempt_id);
  c.claimEnrollmentAttempt(attempt.attempt_id);
  const materialized = c.startMaterialization(attempt.attempt_id, { node_id: "synthetic-target", platform: "linux" });
  const prior = c.getEnrollmentAttempt(attempt.attempt_id);
  const required = DEFAULT_ACCEPTANCE_EVIDENCE.filter((type) => !CORE_OWNED_EVIDENCE.includes(type));
  for (const type of [...required, ...CORE_OWNED_EVIDENCE, "BOOTSTRAP_COMPLETION", "synthetic.arbitrary"]) {
    const response = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts/" +
      encodeURIComponent(attempt.attempt_id) + "/evidence", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, source: "ghostfleet-linux-adapter", data: { status: "PASS" } }),
    }));
    assert.equal(response.status, 403, type);
    assert.deepEqual(await response.json(), { ok: false, error: "EVIDENCE_TRUSTED_INGRESS_REQUIRED" });
  }
  assert.deepEqual(c.getEnrollmentAttempt(attempt.attempt_id), prior);
  const admission = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts/" +
    encodeURIComponent(attempt.attempt_id) + "/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  const outcome = await admission.json();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "ACCEPTANCE_EVIDENCE_MISSING");
  assert.deepEqual(new Set(outcome.missing), new Set(required));
  assert.equal(c.getNode(materialized.node_uid).lifecycle, "PROVISIONAL");
  assert.equal(c.listEvents().some((event) => event.type === "NodeAdmitted"), false);
});

test("a refused acceptance transition is a 409 while materialization shape errors stay 400", async () => {
  const c = new GhostFleetController();
  const handle = createHttpHandler(c, { authorizeOperator: () => true });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "synthetic-target" });
  c.prepareEnrollmentAttempt(attempt.attempt_id);
  c.claimEnrollmentAttempt(attempt.attempt_id);
  const path = (suffix) => "https://ghostfleet.invalid/v0/enrollment-attempts/" +
    encodeURIComponent(attempt.attempt_id) + "/" + suffix;
  const post = (suffix, body) => handle(new Request(path(suffix), {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));

  // Request shape: the body is repairable by the caller, so these stay 400.
  for (const [body, code] of [
    [JSON.stringify({ bogus: 1 }), "MATERIALIZATION_INPUT_INVALID"],
    [JSON.stringify({ node_id: "x".repeat(129) }), "NODE_ID_INVALID"],
    [JSON.stringify({ platform: "Linux!" }), "PLATFORM_INVALID"],
  ]) {
    const response = await post("materialize", body);
    assert.equal(response.status, 400, code);
    const payload = await response.json();
    assert.equal(payload.error, code);
    assert.equal(payload.code, code);
  }

  const materialized = await post("materialize", JSON.stringify({ node_id: "synthetic-target", platform: "linux" }));
  assert.equal(materialized.status, 200);

  // State: the request is well formed but the attempt lacks acceptance evidence.
  // This is the status the cloud smoke and an operator retry policy dispatch on.
  const admission = await post("accept", "{}");
  assert.equal(admission.status, 409);
  const outcome = await admission.json();
  assert.equal(outcome.error, "ACCEPTANCE_EVIDENCE_MISSING");
  assert.equal(outcome.code, "ACCEPTANCE_EVIDENCE_MISSING");
  assert.ok(Array.isArray(outcome.missing) && outcome.missing.length > 0);
  assert.equal(c.getNode(c.getEnrollmentAttempt(attempt.attempt_id).node_uid).lifecycle, "PROVISIONAL");
});

test("SDK-side evidence remains a separate integration responsibility, not HTTP authority", async () => {
  const c = new GhostFleetController();
  const attempt = c.createEnrollmentAttempt();
  // Legacy server SDK can still store non-admission diagnostic evidence.
  const result = c.recordEvidence(attempt.attempt_id, {
    type: "synthetic.diagnostic", source: "synthetic-test", data: { status: "UNKNOWN" },
  });
  assert.equal(result.type, "synthetic.diagnostic");
  assert.equal(c.getEnrollmentAttempt(attempt.attempt_id).evidence.length, 1);
});
