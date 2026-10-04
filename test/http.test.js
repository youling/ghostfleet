import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";
import { createMcpDispatcher } from "../src/integrations/mcp.js";
import { CORE_OWNED_EVIDENCE, DEFAULT_ACCEPTANCE_EVIDENCE } from "../src/core/model.js";

test("HTTP API creates and lists enrollment attempts", async () => {
  const controller = new GhostFleetController();
  const handle = createHttpHandler(controller);
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
  const handle = createHttpHandler(new GhostFleetController());
  const response = await handle(new Request("http://ghostfleet.test/healthz"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "ghostfleet", version: "0.1.0-dev" });
});

test("HTTP and read-only MCP expose the same provisional identity before and after acceptance", async () => {
  const c = new GhostFleetController();
  const handle = createHttpHandler(c);
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
