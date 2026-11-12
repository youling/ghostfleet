import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GhostFleetController } from "../../src/control-plane/controller.js";
import { createHttpHandler } from "../../src/control-plane/http.js";
import { DEFAULT_EVENTS_LIMIT, InMemoryStore } from "../../src/control-plane/store.js";
import { CORE_OWNED_EVIDENCE, DEFAULT_ACCEPTANCE_EVIDENCE, NodeLifecycle } from "../../src/core/model.js";
import { makeId } from "../../src/core/ids.js";
import {
  AGENT_SCHEMA, MAX_TASKS_PER_POLL, NODE_BODY_LIMITS, NODE_RATE_LIMIT, TASK_LEASE_SECONDS,
  TASK_OPERATIONS, TASK_SCHEMA, TASK_STATUS, defaultAgentState, mintNodeCredential, projectAgent, sha256Hex,
} from "../../src/control-plane/node-agent.js";
import worker, { GhostFleetState } from "../../src/adapters/cloudflare/worker.js";

// Every clock in these tests is injected: the probe has no sleeps, no wall-clock
// dependency and no network. Synthetic times are deliberately in the future.
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");
const AGENT_VERSION = "0.1.0-synthetic";
const ADAPTER_EVIDENCE = DEFAULT_ACCEPTANCE_EVIDENCE.filter((type) => !CORE_OWNED_EVIDENCE.includes(type));
const PREFLIGHT = "sha256:" + "a".repeat(64);
const enrollmentDelivery = {
  assets_origin: "https://assets.example.invalid",
  enroll_origin: "https://enroll.example.invalid",
  bootstrap_sha256: "b".repeat(64),
};
const template_selection = { template_id: "managed-linux-tailscale", overrides: { "providers.tailscale.ssh": true } };

function createClock(startMs = START_MS) {
  const state = { ms: startMs };
  class Clock extends Date {
    constructor(value = state.ms) { super(value); }
    static now() { return state.ms; }
  }
  return {
    Clock,
    now() { return state.ms; },
    advance(seconds) { state.ms += Math.round(seconds * 1000); },
  };
}

function syntheticMaterializer() {
  return async ({ attempt, ticket, preflight_digest }) => ({
    outcome: "READY",
    delivery: {
      resume_session: "resume_" + "r".repeat(48),
      auth_key: "synthetic-one-time-provider-material",
      identity_kind: "provisional",
      enrollment_id: "enroll-12345678-1234-1234-1234-123456789abc",
      node_id: "fleet-bootstrap-123456abcdef",
      node_uid: null,
    },
    attempt_id: attempt.attempt_id,
    ticket_id: ticket.ticket_id,
    preflight_digest,
  });
}

function makeController(options = {}) {
  const clock = options.clock ?? createClock();
  const store = options.store ?? new InMemoryStore();
  const controller = new GhostFleetController({
    store,
    clock: clock.Clock,
    enrollmentClaimMaterializer: syntheticMaterializer(),
    enrollmentDelivery,
    ticketCodeFactory: () => "12345678",
  });
  return { controller, store, clock, handler: createHttpHandler(controller) };
}

// Runs the real enrollment ticket flow end to end and returns the single
// credential the control plane mints at completion.
async function completeEnrollmentFlow(parts) {
  const { controller } = parts;
  const attempt = controller.createEnrollmentAttempt({ template_selection });
  const issued = await controller.issueEnrollmentTicket(attempt.attempt_id);
  const claim = await controller.claimEnrollmentTicket({
    ticket_id: issued.ticket.ticket_id, short_code: "12345678", preflight_digest: PREFLIGHT,
  });
  const report = {
    identity_kind: "provisional", enrollment_id: claim.enrollment_id, node_id: claim.node_id,
    os_id: "debian", os_version_id: "13", bootstrap_version: "synthetic-v1",
  };
  const completed = controller.completeEnrollmentTicket({ resume_session: claim.resume_session, report });
  return { attempt, claim, report, completed, token: completed.node_credential, node_uid: completed.attempt.node_uid };
}

// A provisioned-but-not-yet-admitted node: PROVISIONAL is an agent-plane
// lifecycle, so protocol tests do not need acceptance evidence.
function materializeNode(controller, node_id = "synthetic-device") {
  const attempt = controller.createEnrollmentAttempt();
  controller.prepareEnrollmentAttempt(attempt.attempt_id);
  controller.claimEnrollmentAttempt(attempt.attempt_id);
  const materialized = controller.startMaterialization(attempt.attempt_id, { node_id, platform: "linux" });
  return { attempt_id: attempt.attempt_id, node_uid: materialized.node_uid };
}

function admitNode(controller, node_id = "synthetic-device") {
  const { attempt_id, node_uid } = materializeNode(controller, node_id);
  for (const type of ADAPTER_EVIDENCE) controller.recordEvidence(attempt_id, { type, source: "synthetic-test", data: { status: "PASS" } });
  const node = controller.acceptEnrollment(attempt_id);
  assert.equal(node.node_uid, node_uid);
  assert.equal(node.lifecycle, NodeLifecycle.ACTIVE);
  return node_uid;
}

function giveCredential(controller, node_uid) {
  const minted = mintNodeCredential();
  const node = controller.store.getNode(node_uid);
  controller.store.putNodeAgent(node_uid, { ...node.agent, credential_digest: minted.digestHex });
  return minted;
}

let sequence = 0;
function agentEnvelope(clock, node_uid, extra = {}, options = {}) {
  sequence += 1;
  return {
    schema: AGENT_SCHEMA,
    node_uid,
    nonce: options.nonce ?? randomBytes(18).toString("base64url"),
    sent_at: options.sent_at ?? new Date(clock.now()).toISOString(),
    boot_id: options.boot_id ?? "boot-synthetic-1",
    seq: options.seq ?? sequence,
    ...extra,
  };
}

async function nodePost(handler, path, options) {
  const headers = {
    "content-type": options.contentType ?? "application/json",
    "x-ghostfleet-agent-version": options.agentVersion ?? AGENT_VERSION,
  };
  if (options.token) headers.authorization = "Bearer " + options.token;
  if (options.headerUid) headers["x-ghostfleet-node-uid"] = options.headerUid;
  Object.assign(headers, options.headers ?? {});
  const payload = options.raw === undefined ? JSON.stringify(options.body ?? {}) : options.raw;
  const response = await handler(new Request("https://ghostfleet.invalid" + path, { method: "POST", headers, body: payload }));
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { response, status: response.status, json: parsed, text };
}

function heartbeat(handler, clock, node_uid, token, extra = {}, options = {}) {
  return nodePost(handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token, headerUid: node_uid, body: agentEnvelope(clock, node_uid, extra, options), ...options,
  });
}

function poll(handler, clock, node_uid, token, options = {}) {
  return nodePost(handler, "/v0/nodes/" + node_uid + "/tasks/poll", {
    token, headerUid: node_uid, body: agentEnvelope(clock, node_uid, {}, options), ...options,
  });
}

function sendResult(handler, clock, node_uid, token, task_id, result, options = {}) {
  return nodePost(handler, "/v0/nodes/" + node_uid + "/tasks/" + task_id + "/result", {
    token, headerUid: node_uid, body: agentEnvelope(clock, node_uid, { task_id, result }, options), ...options,
  });
}

// The node token never equals a stored digest, so a snapshot diff plus a text
// scan is the strongest available leak assertion.
function assertNoCredentialMaterial(text, token, digestHex) {
  assert.equal(text.includes(token), false, "the raw node token must never be exposed");
  assert.equal(text.includes(digestHex), false, "the node credential digest must never be public");
}

async function expectRejection(parts, invoke, status, code) {
  const before = parts.store.snapshot();
  const result = await invoke();
  assert.equal(result.status, status, "unexpected status for " + code + ": " + result.text);
  assert.equal(result.json.error, code);
  assert.deepEqual(parts.store.snapshot(), before, "a rejected node request must not mutate state");
  return result;
}

function suspendNode(store, node_uid) {
  const record = store.getNode(node_uid);
  store.putNode({ ...record, lifecycle: NodeLifecycle.SUSPENDED });
}

test("enrollment completion mints exactly one node credential", async () => {
  const parts = makeController();
  const flow = await completeEnrollmentFlow(parts);
  const token = flow.token;
  assert.equal(typeof token, "string");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const record = parts.store.getNode(flow.node_uid);
  assert.equal(record.lifecycle, NodeLifecycle.PROVISIONAL);
  assert.equal(record.agent.credential_digest, sha256Hex(token));
  assert.equal(record.agent.credential_minted_at, new Date(parts.clock.now()).toISOString());
  assert.equal(JSON.stringify(parts.store.snapshot()).includes(token), false);

  const replay = parts.controller.completeEnrollmentTicket({ resume_session: flow.claim.resume_session, report: flow.report });
  assert.equal(replay.ticket.state, "COMPLETED");
  assert.equal(replay.node_credential, null, "a retried completion must not remint a credential");
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_digest, record.agent.credential_digest);
  assert.throws(
    () => parts.controller.completeEnrollmentTicket({ resume_session: flow.claim.resume_session, report: { ...flow.report, node_id: "different-node" } }),
    /BOOTSTRAP_COMPLETION_CONFLICT/,
  );
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_digest, record.agent.credential_digest);
});

test("node credential material never reaches public responses, events or projections", async () => {
  const parts = makeController();
  const flow = await completeEnrollmentFlow(parts);
  const token = flow.token;
  const digest = parts.store.getNode(flow.node_uid).agent.credential_digest;

  const nodes = await parts.handler(new Request("https://ghostfleet.invalid/v0/nodes"));
  const nodesText = await nodes.text();
  assert.equal(nodes.status, 200);
  assertNoCredentialMaterial(nodesText, token, digest);
  assert.equal(nodesText.includes("credential_digest"), false);
  assert.equal(nodesText.includes("nonces"), false);

  const events = await parts.handler(new Request("https://ghostfleet.invalid/v0/events"));
  const eventsText = await events.text();
  assert.equal(events.status, 200);
  assertNoCredentialMaterial(eventsText, token, digest);

  assertNoCredentialMaterial(JSON.stringify(parts.controller.listNodes()), token, digest);
  assertNoCredentialMaterial(JSON.stringify(parts.controller.getNode(flow.node_uid)), token, digest);
  assert.equal(JSON.stringify(parts.controller.listNodes()).includes("credential_digest"), false);

  // The digest stays durable because verification needs it; only the token is
  // excluded from durable state entirely.
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_digest, digest);
  assert.equal(JSON.stringify(parts.store.snapshot()).includes(token), false);
});

test("node endpoints reject unauthenticated, foreign and mis-scoped credentials", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller);
  const credential = giveCredential(parts.controller, node_uid);
  const other_uid = admitNode(parts.controller, "synthetic-device-peer");
  const other = giveCredential(parts.controller, other_uid);

  await expectRejection(parts, () => poll(parts.handler, parts.clock, node_uid, null), 401, "NODE_AUTH_INVALID");
  await expectRejection(parts, () => poll(parts.handler, parts.clock, node_uid, randomBytes(32).toString("base64url")), 401, "NODE_AUTH_INVALID");
  await expectRejection(parts, () => poll(parts.handler, parts.clock, node_uid, other.token), 403, "NODE_SCOPE_MISMATCH");
  await expectRejection(parts, () => nodePost(parts.handler, "/v0/nodes/" + node_uid + "/tasks/poll", {
    token: credential.token, headerUid: other_uid, body: agentEnvelope(parts.clock, node_uid),
  }), 403, "NODE_SCOPE_MISMATCH");
  await expectRejection(parts, () => nodePost(parts.handler, "/v0/nodes/" + node_uid + "/tasks/poll", {
    token: credential.token, headerUid: node_uid, body: agentEnvelope(parts.clock, other_uid),
  }), 403, "NODE_SCOPE_MISMATCH");

  const abnormal = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/tasks/poll", {
    token: credential.token, headerUid: node_uid, contentType: "text/plain", body: agentEnvelope(parts.clock, node_uid),
  });
  assert.equal(abnormal.status, 415);
  assert.equal(abnormal.json.error, "UNSUPPORTED_CONTENT_TYPE");

  const missingVersion = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/tasks/poll", {
    token: credential.token, headerUid: node_uid, agentVersion: "", body: agentEnvelope(parts.clock, node_uid),
  });
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.json.error, "NODE_REQUEST_INVALID");

  suspendNode(parts.store, node_uid);
  await expectRejection(parts, () => poll(parts.handler, parts.clock, node_uid, credential.token), 403, "NODE_NOT_ADMITTED");
});

test("body caps are enforced before authentication and before any state change", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "cap-device");
  const credential = giveCredential(parts.controller, node_uid);
  const oversized = (pad) => JSON.stringify({ ...agentEnvelope(parts.clock, node_uid), pad: "x".repeat(pad) });

  const declared = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token: credential.token, headerUid: node_uid, raw: "{}", headers: { "content-length": String(NODE_BODY_LIMITS.heartbeat + 1) },
  });
  assert.equal(declared.status, 413);
  assert.equal(declared.json.error, "REQUEST_BODY_TOO_LARGE");

  for (const [path, limit] of [
    ["/v0/nodes/" + node_uid + "/heartbeat", NODE_BODY_LIMITS.heartbeat],
    ["/v0/nodes/" + node_uid + "/tasks/poll", NODE_BODY_LIMITS.poll],
  ]) {
    const before = parts.store.snapshot();
    const result = await nodePost(parts.handler, path, {
      token: credential.token, headerUid: node_uid, raw: oversized(limit + 64),
    });
    assert.equal(result.status, 413);
    assert.equal(result.json.error, "REQUEST_BODY_TOO_LARGE");
    assert.deepEqual(parts.store.snapshot(), before);
  }

  const task = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity"] } });
  const result = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, {
    outcome: "OK", note: "y".repeat(NODE_BODY_LIMITS.result + 64),
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.error, "REQUEST_BODY_TOO_LARGE");
});

test("clock skew, schema drift, bad nonces and rate limits are rejected without writes", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "skew-device");
  const credential = giveCredential(parts.controller, node_uid);

  await expectRejection(parts, () => heartbeat(parts.handler, parts.clock, node_uid, credential.token, {}, {
    sent_at: new Date(parts.clock.now() - 301000).toISOString(),
  }), 401, "NODE_CLOCK_SKEW");
  await expectRejection(parts, () => heartbeat(parts.handler, parts.clock, node_uid, credential.token, {}, {
    sent_at: new Date(parts.clock.now() + 301000).toISOString(),
  }), 401, "NODE_CLOCK_SKEW");

  await expectRejection(parts, () => nodePost(parts.handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token: credential.token, headerUid: node_uid,
    body: { ...agentEnvelope(parts.clock, node_uid), schema: "ghostfleet-node-agent/v1" },
  }), 400, "NODE_SCHEMA_UNSUPPORTED");

  await expectRejection(parts, () => heartbeat(parts.handler, parts.clock, node_uid, credential.token, {}, { nonce: "short" }), 400, "NODE_REQUEST_INVALID");

  const record = parts.store.getNode(node_uid);
  parts.store.putNodeAgent(node_uid, { ...record.agent, rate: { window_start_ms: parts.clock.now(), count: NODE_RATE_LIMIT.requests } });
  await expectRejection(parts, () => poll(parts.handler, parts.clock, node_uid, credential.token), 429, "NODE_RATE_LIMITED");
});

test("nonce replay is rejected and produces no additional side effect", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "replay-device");
  const credential = giveCredential(parts.controller, node_uid);
  const body = agentEnvelope(parts.clock, node_uid);

  const first = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token: credential.token, headerUid: node_uid, body,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);

  const afterFirst = parts.store.snapshot();
  const second = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token: credential.token, headerUid: node_uid, body,
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "NODE_NONCE_REPLAY");
  assert.deepEqual(parts.store.snapshot(), afterFirst);
});

function taskError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

function taskCode(fn) {
  const error = taskError(fn);
  return error.code ?? error.message;
}

test("operator task vocabulary is read-only and rejects forbidden parameters", () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "task-device");
  const submit = (input) => parts.controller.createNodeTask(node_uid, input);

  assert.equal(taskCode(() => submit({ operation: "node.exec", params: {} })), "TASK_OPERATION_FORBIDDEN");
  assert.equal(taskCode(() => submit({ operation: "service.status.read", params: { units: ["ssh.service"], command: "systemctl restart ssh" } })), "TASK_PARAMS_FORBIDDEN");
  assert.equal(taskCode(() => submit({ operation: "node.observe", params: { want: ["identity"], nested: { shell: true } } })), "TASK_PARAMS_FORBIDDEN");
  assert.equal(taskCode(() => submit({ operation: "node.observe", params: { want: ["identity"], deep: { a: { b: { c: { d: 1 } } } } } })), "TASK_PARAMS_INVALID");
  assert.equal(taskCode(() => submit({ operation: "service.status.read", params: { units: Array.from({ length: 9 }, (_, index) => "unit" + index + ".service") } })), "TASK_PARAMS_INVALID");
  assert.equal(taskCode(() => submit({ operation: "node.observe", params: { want: ["kernel"] } })), "TASK_PARAMS_INVALID");
  assert.equal(taskCode(() => submit({ operation: "node.observe", params: { want: ["identity"] }, ttl_seconds: 601 })), "TASK_REQUEST_INVALID");
  assert.equal(taskCode(() => submit({ operation: "node.observe", params: { want: ["identity"] }, urgent: true })), "TASK_REQUEST_INVALID");
  assert.equal(taskCode(() => parts.controller.createNodeTask(makeId("node"), { operation: "node.observe", params: { want: ["identity"] } })), "NODE_NOT_FOUND");

  const accepted = submit({ operation: "service.status.read", params: { units: ["ssh.service", "ghostfleet-agent.service"] } });
  assert.equal(accepted.operation, "service.status.read");
  assert.equal(accepted.status, TASK_STATUS.PENDING);
  assert.equal(accepted.attempt, 0);
  assert.equal(accepted.result_digest, null);
  assert.equal(accepted.node_uid, node_uid);
  assert.ok(Date.parse(accepted.expires_at) - Date.parse(accepted.issued_at) <= 600000);

  const duplicate = submit({ task_id: "task-synthetic-fixed", operation: "capability.inspect", params: {} });
  assert.equal(taskCode(() => submit({ task_id: duplicate.task_id, operation: "capability.inspect", params: {} })), "TASK_ALREADY_EXISTS");

  for (let index = 0; index < 62; index += 1) submit({ operation: "capability.inspect", params: {} });
  assert.equal(taskCode(() => submit({ operation: "capability.inspect", params: {} })), "TASK_QUEUE_FULL");
});

test("heartbeat dispatches at most two tasks and leases never overlap", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "dispatch-device");
  const credential = giveCredential(parts.controller, node_uid);
  const first = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity"] } });
  const second = parts.controller.createNodeTask(node_uid, { operation: "agent.self.test", params: { nonce: "heartbeat-probe" } });
  const third = parts.controller.createNodeTask(node_uid, { operation: "capability.inspect", params: {} });

  const beat = await heartbeat(parts.handler, parts.clock, node_uid, credential.token, {
    health: "OK", agent_version: AGENT_VERSION, capability_digest: "sha256:" + "c".repeat(64), queue_depth: 3,
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.schema, AGENT_SCHEMA);
  assert.equal(beat.json.node_uid, node_uid);
  assert.equal(beat.json.interval_s, 30);
  assert.equal(beat.json.tasks.length, 2);
  for (const envelope of beat.json.tasks) {
    assert.equal(envelope.schema, TASK_SCHEMA);
    assert.equal(envelope.node_uid, node_uid);
    assert.equal(envelope.attempt, 1);
    assert.ok(Date.parse(envelope.lease_expires_at) > parts.clock.now());
    assert.ok([first.task_id, second.task_id, third.task_id].includes(envelope.task_id));
  }
  const afterBeat = parts.controller.listNodeTasks(node_uid);
  assert.equal(afterBeat.filter((task) => task.status === TASK_STATUS.LEASED).length, 2);
  assert.equal(afterBeat.filter((task) => task.status === TASK_STATUS.PENDING).length, 1);

  // A heartbeat is also a dispatch point, so the third pending task goes out on
  // the next beat; nothing else can be leased while the first leases are live.
  const pendingBeat = await heartbeat(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(pendingBeat.status, 200);
  assert.equal(pendingBeat.json.tasks.length, 1);
  assert.equal(pendingBeat.json.tasks[0].task_id, afterBeat.find((task) => task.status === TASK_STATUS.PENDING).task_id);
  assert.equal(pendingBeat.json.tasks[0].attempt, 1);

  const whileLeased = await heartbeat(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(whileLeased.status, 200);
  assert.deepEqual(whileLeased.json.tasks, []);

  parts.clock.advance(TASK_LEASE_SECONDS + 1);
  const renewed = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(renewed.status, 200);
  assert.equal(renewed.json.lease_seconds, TASK_LEASE_SECONDS);
  assert.equal(renewed.json.tasks.length, 3);
  const attempts = renewed.json.tasks.map((task) => task.attempt).sort();
  assert.deepEqual(attempts, [2, 2, 2]);

  parts.clock.advance(600);
  const retired = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.deepEqual(retired.json.tasks, []);
  const retiredTasks = parts.controller.listNodeTasks(node_uid);
  assert.equal(retiredTasks.every((task) => task.status === TASK_STATUS.EXPIRED), true);
});

test("poll returns at most four tasks and ignores the operation order", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "poll-device");
  const credential = giveCredential(parts.controller, node_uid);
  for (let index = 0; index < MAX_TASKS_PER_POLL + 1; index += 1) {
    parts.controller.createNodeTask(node_uid, { operation: "capability.inspect", params: {} });
  }
  const polled = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(polled.status, 200);
  assert.equal(polled.json.tasks.length, MAX_TASKS_PER_POLL);
  assert.equal(polled.json.tasks.every((task) => task.schema === TASK_SCHEMA), true);
});

test("task results are idempotent by digest and are never overwritten", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "result-device");
  const credential = giveCredential(parts.controller, node_uid);
  const task = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity", "uptime"] } });

  const lease = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(lease.status, 200);
  assert.equal(lease.json.tasks.length, 1);
  assert.equal(lease.json.tasks[0].task_id, task.task_id);

  const result = { outcome: "OK", observed: { identity: "synthetic-node", uptime_s: 42 } };
  const first = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, result);
  assert.equal(first.status, 200);
  assert.equal(first.json.idempotent, false);
  assert.equal(first.json.task.status, TASK_STATUS.COMPLETED);
  assert.equal(first.json.task.result_outcome, "OK");
  assert.match(first.json.result_digest, /^[a-z0-9]{64}$/);
  const completedAt = first.json.task.completed_at;

  const replay = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, result);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.result_digest, first.json.result_digest);
  assert.equal(replay.json.task.completed_at, completedAt);

  await expectRejection(parts, () => sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, {
    outcome: "FAILED", observed: { identity: "tampered" },
  }), 409, "TASK_RESULT_CONFLICT");

  const other = makeId("task");
  await expectRejection(parts, () => sendResult(parts.handler, parts.clock, node_uid, credential.token, other, { outcome: "OK" }), 404, "TASK_NOT_FOUND");

  await expectRejection(parts, () => nodePost(parts.handler, "/v0/nodes/" + node_uid + "/tasks/" + task.task_id + "/result", {
    token: credential.token, headerUid: node_uid,
    body: agentEnvelope(parts.clock, node_uid, { task_id: other, result: { outcome: "OK" } }),
  }), 400, "NODE_REQUEST_INVALID");

  const completed = parts.controller.listNodeTasks(node_uid).find((item) => item.task_id === task.task_id);
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  assert.equal(completed.completed_at, completedAt);
  const afterResult = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.deepEqual(afterResult.json.tasks, []);
});

test("expired tasks are retired instead of dispatched", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "expiry-device");
  const credential = giveCredential(parts.controller, node_uid);
  parts.controller.createNodeTask(node_uid, { operation: "capability.inspect", params: {}, ttl_seconds: 5 });
  parts.clock.advance(6);
  const polled = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(polled.status, 200);
  assert.deepEqual(polled.json.tasks, []);
  const tasks = parts.controller.listNodeTasks(node_uid);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, TASK_STATUS.EXPIRED);
  assert.equal(tasks[0].attempt, 0);
});

test("store caps events and keeps the durable agent record separate from public projections", () => {
  const store = new InMemoryStore();
  for (let index = 0; index < DEFAULT_EVENTS_LIMIT + 50; index += 1) {
    store.appendEvent({ event_id: "event-" + index, type: "SyntheticEvent", subject: "synthetic", data: {}, at: new Date(START_MS).toISOString() });
  }
  const events = store.listEvents();
  assert.equal(events.length, DEFAULT_EVENTS_LIMIT);
  assert.equal(events[0].event_id, "event-50");
  assert.equal(events[DEFAULT_EVENTS_LIMIT - 1].event_id, "event-" + (DEFAULT_EVENTS_LIMIT + 49));

  const capped = new InMemoryStore(null, { events_limit: 3 });
  for (let index = 0; index < 5; index += 1) {
    capped.appendEvent({ event_id: "event-" + index, type: "SyntheticEvent", subject: "synthetic", data: {}, at: new Date(START_MS).toISOString() });
  }
  assert.deepEqual(capped.listEvents().map((event) => event.event_id), ["event-2", "event-3", "event-4"]);

  const node = {
    node_uid: makeId("node"), node_id: "synthetic-node", platform: "linux",
    lifecycle: NodeLifecycle.PROVISIONAL, capabilities: [], admitted_at: null,
    materialized_at: new Date(START_MS).toISOString(), updated_at: new Date(START_MS).toISOString(),
  };
  store.putNode(node);
  const record = store.getNode(node.node_uid);
  assert.equal(record.lifecycle, NodeLifecycle.PROVISIONAL);
  assert.deepEqual(Object.keys(record.agent).sort(), Object.keys(defaultAgentState()).sort());
  assert.equal(record.agent.credential_digest, null);
  assert.deepEqual(record.agent.nonces, []);
  assert.deepEqual(record.agent.tasks, {});

  const projected = projectAgent(record.agent);
  assert.equal(Object.hasOwn(projected, "credential_digest"), false);
  assert.equal(Object.hasOwn(projected, "nonces"), false);
  assert.equal(Object.hasOwn(projected, "rate"), false);
  assert.equal(Object.hasOwn(projected, "tasks"), false);

  const listed = store.listNodes().find((item) => item.node_uid === node.node_uid);
  assert.equal(JSON.stringify(listed).includes("credential_digest"), false);
  assert.equal(store.snapshot().nodes[node.node_uid].agent.credential_digest, null);
  assert.deepEqual(new InMemoryStore(store.snapshot()).snapshot(), store.snapshot());
});

function workerFixture() {
  const values = new Map();
  const storage = {
    transaction: (work) => work({
      get: async (key) => structuredClone(values.get(key)),
      put: async (key, value) => { values.set(key, structuredClone(value)); },
    }),
  };
  const state = new GhostFleetState({ storage });
  const operator = "operator-" + randomBytes(16).toString("hex");
  const reader = "read-only-" + randomBytes(16).toString("hex");
  const env = {
    GHOSTFLEET_OPERATOR_TOKEN: operator,
    GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_STATE: { idFromName: () => "test", get: () => state },
  };
  return {
    values, operator, reader,
    request(path, options = {}) {
      return worker.fetch(new Request("https://ghostfleet.invalid" + path, {
        method: options.method ?? "POST", headers: options.headers ?? {}, body: options.body,
      }), env);
    },
  };
}

test("worker exempts only the three node routes from operator bearer auth", async () => {
  const fixture = workerFixture();
  const node_uid = makeId("node");
  const body = JSON.stringify(agentEnvelope(createClock(), node_uid));
  const jsonHeaders = { "content-type": "application/json" };

  for (const suffix of ["/heartbeat", "/tasks/poll", "/tasks/" + makeId("task") + "/result"]) {
    const anonymous = await fixture.request("/v0/nodes/" + node_uid + suffix, { headers: jsonHeaders, body });
    assert.equal(anonymous.status, 401, "unauthenticated node route must fail closed: " + suffix);
    assert.equal((await anonymous.json()).error, "NODE_AUTH_INVALID");
  }

  const operatorOnNodeRoute = await fixture.request("/v0/nodes/" + node_uid + "/heartbeat", {
    headers: { ...jsonHeaders, authorization: "Bearer " + fixture.operator }, body,
  });
  assert.equal(operatorOnNodeRoute.status, 401);
  assert.equal((await operatorOnNodeRoute.json()).error, "NODE_AUTH_INVALID");

  for (const [method, path] of [["GET", "/v0/nodes"], ["GET", "/v0/events"], ["POST", "/v0/enrollment-attempts"], ["GET", "/mcp"]]) {
    const denied = await fixture.request(path, { method, headers: jsonHeaders });
    assert.equal([401, 403].includes(denied.status), true, path + " must still require an operator credential");
  }

  const readerNodes = await fixture.request("/v0/nodes", { method: "GET", headers: { authorization: "Bearer " + fixture.reader } });
  assert.equal(readerNodes.status, 200);
  assert.deepEqual((await readerNodes.json()).nodes, []);

  const created = await fixture.request("/v0/enrollment-attempts", {
    method: "POST", headers: { ...jsonHeaders, authorization: "Bearer " + fixture.operator }, body: JSON.stringify({ asset_hint: "worker" }),
  });
  assert.equal(created.status, 201);
});

test("worker keeps /v1 claim and completion behavior unchanged", async () => {
  const fixture = workerFixture();
  // The fixture deployment has no provider material, so the route reaches the
  // controller and fails closed with a configuration error rather than an
  // authentication error; the point is that /v1 is not operator-bearer gated.
  const claim = await fixture.request("/v1/enrollment-tickets/" + makeId("ticket") + "/claim", {
    headers: { "content-type": "application/json" }, body: "12345678",
  });
  assert.equal([401, 403].includes(claim.status), false);
  assert.equal(claim.status, 503);
  assert.equal((await claim.json()).error, "PROVIDER_CLAIM_MATERIAL_UNAVAILABLE");

  const complete = await fixture.request("/v1/enroll/complete", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume_session: "resume_" + "z".repeat(40), report: { node_id: "synthetic" } }),
  });
  assert.equal(complete.status, 404);
  assert.equal((await complete.json()).error, "TICKET_RESUME_NOT_FOUND");

  const retired = await fixture.request("/v1/bootstrap.sh", { method: "GET" });
  assert.equal(retired.status, 410);
});
