import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";

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
