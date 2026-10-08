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
const requestWithBody = (token, path, body) => new Request(request("POST", token, path), {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
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

test("access metadata reports the authenticated scope without touching storage", async () => {
  const env = {
    GHOSTFLEET_OPERATOR_TOKEN: operator, GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_STATE: { idFromName() { throw new Error("metadata must not access storage"); } },
  };
  for (const [token, scope] of [[operator, "operator"], [reader, "read_only"]]) {
    const response = await worker.fetch(request("GET", token, "/v0/access"), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true, access: scope });
  }
  assert.equal((await worker.fetch(request("GET", "wrong", "/v0/access"), env)).status, 401);
  assert.equal((await worker.fetch(request("GET", undefined, "/v0/access"), env)).status, 401);
  assert.equal((await worker.fetch(request("GET", reader, "/v0/access"), {})).status, 503);
  assert.equal((await worker.fetch(request("POST", reader, "/v0/access"), env)).status, 403);
});

test("provider setup readiness is read-only and secret-safe", async () => {
  let storageCalls = 0;
  const privateService = {
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/readiness");
      return Response.json({
        authority: { provider: "tailscale", generation: "ghostfleet-tailscale-auth-v1" },
        secrets: {
          TAILSCALE_ENROLL_OAUTH_CLIENT_ID: "PRESENT",
          TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET: "PRESENT",
        },
        forbidden_value: undefined,
      });
    },
  };
  const env = {
    GHOSTFLEET_OPERATOR_TOKEN: operator,
    GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_ENROLLMENT_CLAIM_READY: "1",
    GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: privateService,
    GHOSTFLEET_STATE: { idFromName() { storageCalls++; throw new Error("provider setup must not access state"); } },
  };
  const response = await worker.fetch(request("GET", reader, "/v0/providers/setup"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.providers.tailscale.status, "READY");
  assert.equal(body.providers.tailscale.authority_generation, "ghostfleet-tailscale-auth-v1");
  assert.equal(body.providers.tailscale.secret_state.client_secret, "PRESENT");
  assert.equal(JSON.stringify(body).includes("synthetic-secret"), false);
  assert.equal(storageCalls, 0);

  const missing = await worker.fetch(request("GET", reader, "/v0/providers/setup"), {
    GHOSTFLEET_OPERATOR_TOKEN: operator,
    GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_STATE: env.GHOSTFLEET_STATE,
  });
  assert.equal((await missing.json()).providers.tailscale.status, "MISSING");
  assert.equal(storageCalls, 0);
});

test("provider credential setup is operator-only and transient through the private binding", async () => {
  const providerCredentialValue = "synthetic-" + "x".repeat(40);
  let storageCalls = 0;
  let privateCalls = 0;
  const privateService = {
    async fetch(request) {
      privateCalls += 1;
      assert.equal(new URL(request.url).pathname, "/v1/provider/tailscale/setup");
      const body = await request.json();
      assert.equal(body.protocol, "fleet-provider-authority-setup/v1");
      assert.equal(body.provider, "tailscale");
      assert.equal(body.client_id, "synthetic-client-id");
      assert.equal(body.client_secret, providerCredentialValue);
      return Response.json({
        ok: true,
        provider: "tailscale",
        status: "READY",
        authority_generation: "ghostfleet-tailscale-auth-v1",
        scope: "auth_keys",
        tag: "tag:fleet-ssh-target",
      });
    },
  };
  const env = {
    GHOSTFLEET_OPERATOR_TOKEN: operator,
    GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_ENROLLMENT_CLAIM_READY: "1",
    GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: privateService,
    GHOSTFLEET_STATE: { idFromName() { storageCalls++; throw new Error("provider setup must not touch lifecycle state"); } },
  };

  const denied = await worker.fetch(requestWithBody(reader, "/v0/providers/tailscale/setup", {
    client_id: "synthetic-client-id",
    client_secret: providerCredentialValue,
  }), env);
  assert.equal(denied.status, 403);
  assert.equal(privateCalls, 0);

  const response = await worker.fetch(requestWithBody(operator, "/v0/providers/tailscale/setup", {
    client_id: "synthetic-client-id",
    client_secret: providerCredentialValue,
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    provider: "tailscale",
    status: "READY",
    authority_generation: "ghostfleet-tailscale-auth-v1",
    scope: "auth_keys",
    tag: "tag:fleet-ssh-target",
  });
  assert.equal(JSON.stringify(body).includes("synthetic-client-secret"), false);
  assert.equal(storageCalls, 0);
  assert.equal(privateCalls, 1);
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
  for (const type of DEFAULT_ACCEPTANCE_EVIDENCE.filter((type) => !["identity.materialized", "catalog.admitted"].includes(type))) c.recordEvidence(attempt.attempt_id, { type, data: { status: "PASS" } });
  c.recordEvidence(attempt.attempt_id, { type: "reboot.recovered", data: { status: "FAIL" } });
  assert.throws(() => c.acceptEnrollment(attempt.attempt_id), (error) => error.missing?.includes("reboot.recovered"));
  assert.equal(c.listNodes().length, 1);
  assert.equal(c.listNodes()[0].lifecycle, "PROVISIONAL");
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
