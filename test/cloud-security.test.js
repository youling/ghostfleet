import test from "node:test";
import assert from "node:assert/strict";
import worker, { GhostFleetState } from "../src/adapters/cloudflare/worker.js";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { DEFAULT_ACCEPTANCE_EVIDENCE } from "../src/core/model.js";

const operator = "synthetic-operator-".repeat(3);
const reader = "synthetic-reader-".repeat(3);
const request = (method = "GET", token, path = "/v0/nodes") => new Request(`https://ghostfleet.test${path}`, {
  method, headers: token ? { authorization: `Bearer ${token}` } : {},
});

test("cloud API fails closed before it reaches storage", async () => {
  let calls = 0;
  const env = {
    GHOSTFLEET_OPERATOR_TOKEN: operator, GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_STATE: { idFromName: () => "test", get: () => ({ fetch: () => { calls++; return Response.json({ ok: true }); } }) },
  };
  assert.equal((await worker.fetch(request(), {})).status, 503);
  assert.equal((await worker.fetch(request(), env)).status, 401);
  assert.equal((await worker.fetch(request("GET", "wrong"), env)).status, 401);
  assert.equal((await worker.fetch(request("POST", reader), env)).status, 403);
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(request("GET", reader), env)).status, 200);
  assert.equal((await worker.fetch(request("POST", operator), env)).status, 200);
  assert.equal(calls, 2);
});

test("Durable Object reloads committed state between requests", async () => {
  const values = new Map();
  const storage = { transaction: (fn) => fn({ get: async (key) => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)) }) };
  const first = new GhostFleetState({ storage });
  const created = await first.fetch(new Request("https://ghostfleet.test/v0/enrollment-attempts", { method: "POST", body: "{}" }));
  assert.equal(created.status, 201);
  const attempt = (await created.json()).attempt;
  const restored = new GhostFleetState({ storage });
  const list = await restored.fetch(new Request("https://ghostfleet.test/v0/enrollment-attempts"));
  assert.equal((await list.json()).attempts[0].attempt_id, attempt.attempt_id);
  const invalid = await restored.fetch(new Request("https://ghostfleet.test/v0/enrollment-attempts", { method: "POST", body: "{broken" }));
  assert.equal((await invalid.json()).error, "INVALID_JSON");
  assert.equal(values.get("ghostfleet-state").attempts[attempt.attempt_id].state, "CREATED");
});

test("an unresolved HumanGate cannot be bypassed through claim", () => {
  const c = new GhostFleetController();
  const attempt = c.createEnrollmentAttempt();
  c.prepareEnrollmentAttempt(attempt.attempt_id);
  const gate = c.requireEnrollmentHumanGate(attempt.attempt_id);
  assert.throws(() => c.claimEnrollmentAttempt(attempt.attempt_id), /HUMAN_GATE_APPROVAL_REQUIRED/);
  assert.equal(c.getEnrollmentAttempt(attempt.attempt_id).state, "WAITING_HUMAN");
  c.resolveHumanGate(gate.gate_id, "APPROVE");
  assert.throws(() => c.resolveHumanGate(gate.gate_id, "APPROVE"), /ALREADY_RESOLVED/);
});

test("expired attempts and gates cannot be approved or advanced", () => {
  let now = Date.parse("2026-10-01T00:00:00Z");
  class Clock extends Date {
    constructor(value = now) { super(value); }
    static now() { return now; }
  }
  const c = new GhostFleetController({ clock: Clock });
  const attempt = c.createEnrollmentAttempt({ ttl_seconds: 60 });
  c.prepareEnrollmentAttempt(attempt.attempt_id);
  const gate = c.requireEnrollmentHumanGate(attempt.attempt_id, { ttl_seconds: 30 });
  now += 31_000;
  assert.throws(() => c.resolveHumanGate(gate.gate_id, "APPROVE"), /HUMAN_GATE_EXPIRED/);
  assert.equal(c.listHumanGates()[0].state, "EXPIRED");
  now += 30_000;
  assert.throws(() => c.claimEnrollmentAttempt(attempt.attempt_id), /APPROVAL_REQUIRED/);
  assert.throws(() => c.recordEvidence(attempt.attempt_id, { type: "transport.ready" }), /ATTEMPT_EXPIRED/);
});

test("failed or unknown latest evidence cannot admit a node", () => {
  const c = new GhostFleetController();
  const attempt = c.createEnrollmentAttempt();
  c.prepareEnrollmentAttempt(attempt.attempt_id);
  c.claimEnrollmentAttempt(attempt.attempt_id);
  c.startMaterialization(attempt.attempt_id);
  for (const type of DEFAULT_ACCEPTANCE_EVIDENCE) c.recordEvidence(attempt.attempt_id, { type, data: { status: "PASS" } });
  c.recordEvidence(attempt.attempt_id, { type: "reboot.recovered", data: { status: "FAIL" } });
  assert.throws(() => c.acceptEnrollment(attempt.attempt_id), (error) => error.missing?.includes("reboot.recovered"));
  assert.equal(c.listNodes().length, 0);
  c.recordEvidence(attempt.attempt_id, { type: "reboot.recovered", data: { status: "PASS" } });
  c.acceptEnrollment(attempt.attempt_id);
  assert.throws(() => c.recordEvidence(attempt.attempt_id, { type: "reboot.recovered" }), /EVIDENCE_STATE_INVALID/);
  assert.throws(() => c.acceptEnrollment(attempt.attempt_id), /ACCEPT_STATE_INVALID/);
});

test("invalid capability IDs, risks and secret fields never enter state", () => {
  const c = new GhostFleetController();
  for (const definition of [{ id: "__proto__", risk: "R0" }, { id: "valid.capability", risk: "ADMIN" }, { id: "valid.capability", risk: "R0", api_token: "synthetic" }]) {
    assert.throws(() => c.registerCapabilityDefinition(definition));
  }
  assert.equal(c.listCapabilityDefinitions().length, 0);
});

test("prototype names cannot masquerade as existing lifecycle objects", () => {
  const c = new GhostFleetController();
  for (const id of ["constructor", "__proto__", "toString"]) {
    assert.throws(() => c.getEnrollmentAttempt(id), /ATTEMPT_NOT_FOUND/);
    assert.throws(() => c.getNode(id), /NODE_NOT_FOUND/);
  }
});
