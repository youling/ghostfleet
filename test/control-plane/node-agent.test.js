import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GhostFleetController } from "../../src/control-plane/controller.js";
import { createHttpHandler } from "../../src/control-plane/http.js";
import { DEFAULT_EVENTS_LIMIT, InMemoryStore } from "../../src/control-plane/store.js";
import { CORE_OWNED_EVIDENCE, DEFAULT_ACCEPTANCE_EVIDENCE, NodeLifecycle } from "../../src/core/model.js";
import { makeId } from "../../src/core/ids.js";
import {
  AGENT_SCHEMA, CREDENTIAL_HANDOFF_CIPHER, CREDENTIAL_HANDOFF_INFO, CREDENTIAL_HANDOFF_IV_BYTES,
  CREDENTIAL_HANDOFF_KEY_BYTES, CREDENTIAL_HANDOFF_MAX_DELIVERIES, CREDENTIAL_HANDOFF_SALT,
  CREDENTIAL_HANDOFF_STATES, CREDENTIAL_HANDOFF_TAG_BYTES, CREDENTIAL_HANDOFF_TTL_SECONDS,
  MAX_TASKS_PER_POLL, NODE_BODY_LIMITS, NODE_RATE_LIMIT, RESULT_STATUSES, TASK_LEASE_SECONDS,
  TASK_OPERATIONS, TASK_SCHEMA, TASK_STATUS, canonicalJson, defaultAgentState, mintNodeCredential,
  projectAgent, sha256Hex,
} from "../../src/control-plane/node-agent.js";
import worker, { GhostFleetState } from "../../src/adapters/cloudflare/worker.js";

// Every clock in these tests is injected: the probe has no sleeps, no wall-clock
// dependency and no network. Synthetic times are deliberately in the future.
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");
const AGENT_VERSION = "0.1.0-synthetic";
const ADAPTER_EVIDENCE = DEFAULT_ACCEPTANCE_EVIDENCE.filter((type) => !CORE_OWNED_EVIDENCE.includes(type));
const PREFLIGHT = "sha256:" + "a".repeat(64);
// The AEAD handoff key is derived from the operator secret. Tests inject a
// synthetic one so the recoverable credential round-trip is deterministic.
const HANDOFF_SECRET = "synthetic-operator-handoff-material";
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
    credentialHandoffSecret: HANDOFF_SECRET,
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
  return {
    attempt, claim, report, completed,
    token: completed.node_credential.token,
    handoff_id: completed.node_credential.handoff_id,
    node_uid: completed.attempt.node_uid,
  };
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

// The seq is scoped to one node and one boot: the control plane now rejects a
// same-boot regression, so a shared global counter would make unrelated tests
// interfere. Explicit options.seq always wins for the sequence-focused cases.
const sequences = new Map();
function nextSeq(node_uid, boot_id) {
  const key = node_uid + "|" + boot_id;
  const value = (sequences.get(key) ?? -1) + 1;
  sequences.set(key, value);
  return value;
}

function agentEnvelope(clock, node_uid, extra = {}, options = {}) {
  const boot_id = options.boot_id ?? "boot-synthetic-1";
  return {
    schema: AGENT_SCHEMA,
    node_uid,
    nonce: options.nonce ?? randomBytes(18).toString("base64url"),
    sent_at: options.sent_at ?? new Date(clock.now()).toISOString(),
    boot_id,
    seq: options.seq ?? nextSeq(node_uid, boot_id),
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

// Operator-facing JSON helper: the adapter injects the bearer, so the handler
// itself is exercised without credentials here.
async function plainRequest(handler, path, options = {}) {
  const method = options.method ?? "POST";
  const headers = { "content-type": "application/json" };
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await handler(new Request("https://ghostfleet.invalid" + path, { method, headers, body: payload }));
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

// The authoritative result envelope, field-for-field from na-core's
// protocol.py make_result (schema/task_id/node_uid/operation/status/observed_at
// plus optional data/code). A cross-branch contract drift fails here.
function taskResult(task, status, extra = {}) {
  return {
    schema: TASK_SCHEMA,
    task_id: task.task_id,
    node_uid: task.node_uid,
    operation: task.operation,
    status,
    observed_at: new Date(START_MS).toISOString(),
    ...extra,
  };
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
  // The Python agent client dispatches 401/409 by this field (na-core
  // client.py _extract_error_code), so the node plane must always carry it:
  // without it a retryable nonce/seq/boot conflict is classified as terminal.
  assert.equal(result.json.code, code, "node-plane errors must expose the stable code to the agent");
  assert.deepEqual(parts.store.snapshot(), before, "a rejected node request must not mutate state");
  return result;
}

function suspendNode(store, node_uid) {
  const record = store.getNode(node_uid);
  store.putNode({ ...record, lifecycle: NodeLifecycle.SUSPENDED });
}

test("enrollment completion mints exactly one node credential, redelivered by the resume capability", async () => {
  const parts = makeController();
  const flow = await completeEnrollmentFlow(parts);
  const token = flow.token;
  assert.equal(typeof token, "string");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(flow.completed.credential_handoff, "AVAILABLE");
  assert.equal(typeof flow.handoff_id, "string");
  // The handoff contract is pinned, not inferred: a silent KDF/cipher change
  // would leave old sealed tokens unopenable and must show up as a test diff.
  assert.equal(CREDENTIAL_HANDOFF_SALT, "");
  assert.equal(CREDENTIAL_HANDOFF_INFO, "ghostfleet/node-credential-handoff/v1");
  assert.equal(CREDENTIAL_HANDOFF_CIPHER, "aes-256-gcm");
  assert.equal(CREDENTIAL_HANDOFF_KEY_BYTES, 32);
  assert.equal(CREDENTIAL_HANDOFF_IV_BYTES, 12);
  assert.equal(CREDENTIAL_HANDOFF_TAG_BYTES, 16);
  assert.equal(CREDENTIAL_HANDOFF_TTL_SECONDS, 86400);
  assert.equal(CREDENTIAL_HANDOFF_MAX_DELIVERIES, 20);
  assert.deepEqual(CREDENTIAL_HANDOFF_STATES, ["SEALED", "CONSUMED", "EXPIRED"]);
  const record = parts.store.getNode(flow.node_uid);
  assert.equal(record.lifecycle, NodeLifecycle.PROVISIONAL);
  assert.equal(record.agent.credential_digest, sha256Hex(token));
  assert.equal(record.agent.credential_minted_at, new Date(parts.clock.now()).toISOString());
  assert.equal(record.agent.credential_handoff_state, "SEALED");
  assert.equal(record.agent.credential_handoff.deliveries, 1);
  // Envelope shape: 12-byte IV, ciphertext = sealed bytes + 16-byte GCM tag.
  const sealedBytes = Buffer.from(record.agent.credential_handoff.ciphertext, "base64url");
  assert.equal(Buffer.from(record.agent.credential_handoff.iv, "base64url").length, CREDENTIAL_HANDOFF_IV_BYTES);
  assert.equal(sealedBytes.length, Buffer.byteLength(token, "utf8") + CREDENTIAL_HANDOFF_TAG_BYTES);
  // The plaintext token is never durable; only the digest and the sealed copy.
  const durable = JSON.stringify(parts.store.snapshot());
  assert.equal(durable.includes(token), false);
  assert.equal(durable.includes(record.agent.credential_handoff.ciphertext), true, "the sealed handoff is durable");

  const replay = parts.controller.completeEnrollmentTicket({ resume_session: flow.claim.resume_session, report: flow.report });
  assert.equal(replay.ticket.state, "COMPLETED");
  assert.equal(replay.credential_handoff, "AVAILABLE");
  assert.equal(replay.node_credential.token, token, "a retried completion returns the same token");
  assert.equal(replay.node_credential.handoff_id, flow.handoff_id);
  assert.equal(replay.node_credential.node_uid, flow.node_uid);
  assert.equal(replay.node_credential.token, flow.completed.node_credential.token, "byte-identical token");
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_handoff.deliveries, 2);
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_handoff_state, "SEALED");
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_digest, record.agent.credential_digest);
  assert.throws(
    () => parts.controller.completeEnrollmentTicket({ resume_session: flow.claim.resume_session, report: { ...flow.report, node_id: "different-node" } }),
    /BOOTSTRAP_COMPLETION_CONFLICT/,
  );
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_digest, record.agent.credential_digest);
});

test("the recoverable handoff survives a durable snapshot and dies on first authenticated use", async () => {
  const parts = makeController();
  const flow = await completeEnrollmentFlow(parts);
  const token = flow.token;

  // §10: the Durable Object stores one blob. A reload must still be able to hand
  // the same credential to a client whose completion response was lost.
  const snapshot = parts.store.snapshot();
  const reloadedStore = new InMemoryStore(snapshot);
  const reloaded = new GhostFleetController({
    store: reloadedStore,
    clock: parts.clock.Clock,
    credentialHandoffSecret: HANDOFF_SECRET,
  });
  const refetched = reloaded.completeEnrollmentTicket({ resume_session: flow.claim.resume_session, report: flow.report });
  assert.equal(refetched.credential_handoff, "AVAILABLE");
  assert.equal(refetched.node_credential.token, token);
  assert.equal(refetched.node_credential.handoff_id, flow.handoff_id);

  // The first authenticated node request consumes the handoff (§5.1).
  const beat = await heartbeat(parts.handler, parts.clock, flow.node_uid, token);
  assert.equal(beat.status, 200);
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_handoff, null);
  const afterUse = parts.controller.completeEnrollmentTicket({ resume_session: flow.claim.resume_session, report: flow.report });
  assert.equal(afterUse.node_credential, null);
  assert.equal(afterUse.credential_handoff, "CONSUMED", "the node already took the token");
  assert.equal(parts.store.getNode(flow.node_uid).agent.credential_handoff_state, "CONSUMED");
  assert.equal(JSON.stringify(afterUse).includes(token), false);
});

test("the handoff expires and refuses tampered ciphertext without leaking a token", async () => {
  const expiredParts = makeController();
  const expiredFlow = await completeEnrollmentFlow({ ...expiredParts });
  expiredParts.clock.advance(86401);
  const expired = expiredParts.controller.completeEnrollmentTicket({
    resume_session: expiredFlow.claim.resume_session, report: expiredFlow.report,
  });
  assert.equal(expired.node_credential, null);
  assert.equal(expired.credential_handoff, "EXPIRED");
  assert.equal(expiredParts.store.getNode(expiredFlow.node_uid).agent.credential_handoff, null);
  assert.equal(expiredParts.store.getNode(expiredFlow.node_uid).agent.credential_handoff_state, "EXPIRED");

  // A tampered sealed blob is an integrity failure: 500, never a wrong token.
  const tamperedParts = makeController();
  const tamperedFlow = await completeEnrollmentFlow(tamperedParts);
  const record = tamperedParts.store.getNode(tamperedFlow.node_uid);
  const sealed = record.agent.credential_handoff;
  const flipped = Buffer.from(sealed.ciphertext, "base64url");
  flipped[0] ^= 0xff;
  tamperedParts.store.putNodeAgent(tamperedFlow.node_uid, {
    ...record.agent,
    credential_handoff: { ...sealed, ciphertext: flipped.toString("base64url") },
  });
  const before = tamperedParts.store.snapshot();
  let failure = null;
  try {
    tamperedParts.controller.completeEnrollmentTicket({
      resume_session: tamperedFlow.claim.resume_session, report: tamperedFlow.report,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "tampered ciphertext must not produce a response");
  assert.equal(failure.status, 500);
  assert.equal(failure.code, "NODE_CREDENTIAL_HANDOFF_INVALID");
  assert.deepEqual(tamperedParts.store.snapshot(), before, "an integrity failure writes nothing");
});

test("node credential material never reaches public responses, events or projections", async () => {
  const parts = makeController();
  const flow = await completeEnrollmentFlow(parts);
  const token = flow.token;
  const digest = parts.store.getNode(flow.node_uid).agent.credential_digest;

  // The sealed handoff is durable, so the public surface must not leak it either.
  const sealed = parts.store.getNode(flow.node_uid).agent.credential_handoff;
  const nodes = await parts.handler(new Request("https://ghostfleet.invalid/v0/nodes"));
  const nodesText = await nodes.text();
  assert.equal(nodes.status, 200);
  assertNoCredentialMaterial(nodesText, token, digest);
  assert.equal(nodesText.includes(sealed.ciphertext), false, "the sealed handoff must not be public");
  assert.equal(nodesText.includes(sealed.iv), false);
  assert.equal(nodesText.includes("credential_digest"), false);
  assert.equal(nodesText.includes("credential_handoff"), false);
  assert.equal(nodesText.includes("credential_handoff_state"), false);
  assert.equal(nodesText.includes("nonces"), false);

  const events = await parts.handler(new Request("https://ghostfleet.invalid/v0/events"));
  const eventsText = await events.text();
  assert.equal(events.status, 200);
  assertNoCredentialMaterial(eventsText, token, digest);
  assert.equal(eventsText.includes(sealed.ciphertext), false);

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
  assert.equal(declared.json.error, "NODE_BODY_TOO_LARGE");

  for (const [path, limit] of [
    ["/v0/nodes/" + node_uid + "/heartbeat", NODE_BODY_LIMITS.heartbeat],
    ["/v0/nodes/" + node_uid + "/tasks/poll", NODE_BODY_LIMITS.poll],
  ]) {
    const before = parts.store.snapshot();
    const result = await nodePost(parts.handler, path, {
      token: credential.token, headerUid: node_uid, raw: oversized(limit + 64),
    });
    assert.equal(result.status, 413);
    assert.equal(result.json.error, "NODE_BODY_TOO_LARGE");
    assert.deepEqual(parts.store.snapshot(), before);
  }

  const task = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity"] } });
  const result = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, {
    ...taskResult(task, "SUCCEEDED"), data: { note: "y".repeat(NODE_BODY_LIMITS.result + 64) },
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.error, "NODE_BODY_TOO_LARGE");
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
  parts.store.putNodeAgent(node_uid, {
    ...record.agent, rate: { tokens: 0, updated_at_ms: parts.clock.now() },
  });
  const limited = await expectRejection(parts, () => poll(parts.handler, parts.clock, node_uid, credential.token), 429, "NODE_RATE_LIMITED");
  assert.equal(limited.json.retry_after_s, NODE_RATE_LIMIT.refill_seconds);
  assert.equal(limited.response.headers.get("retry-after"), String(NODE_RATE_LIMIT.refill_seconds));

  // After one refill window the same node is served again.
  parts.clock.advance(NODE_RATE_LIMIT.refill_seconds);
  const refilled = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(refilled.status, 200);
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
  // A byte-for-byte replay is caught by the sequence rule before the nonce ring.
  const exact = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token: credential.token, headerUid: node_uid, body,
  });
  assert.equal(exact.status, 409);
  assert.equal(exact.json.error, "NODE_SEQ_REGRESSION");
  assert.equal(exact.json.code, "NODE_SEQ_REGRESSION");
  assert.deepEqual(parts.store.snapshot(), afterFirst);

  // The ring is the second line: a fresh seq cannot smuggle a used nonce back in.
  const second = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token: credential.token, headerUid: node_uid, body: { ...body, seq: body.seq + 1 },
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "NODE_NONCE_REPLAY");
  assert.equal(second.json.code, "NODE_NONCE_REPLAY");
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

  // na-core's exact shape: the result is bound to schema/task/node/operation and
  // carries status (not outcome — the round-1 fixture used the wrong key and
  // would have hidden the whole §7 vocabulary collapsing to UNKNOWN).
  const result = taskResult(task, "SUCCEEDED", { data: { identity: "synthetic-node", uptime_s: 42 } });
  const first = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, result);
  assert.equal(first.status, 200);
  assert.equal(first.json.idempotent, false);
  assert.equal(first.json.task.status, TASK_STATUS.COMPLETED);
  assert.equal(first.json.task.result_outcome, "SUCCEEDED");
  assert.equal(first.json.task.result_digest, sha256Hex(canonicalJson(result)), "the digest is server-derived");
  assert.match(first.json.result_digest, /^[a-z0-9]{64}$/);
  const completedAt = first.json.task.completed_at;

  const replay = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, result);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.result_digest, first.json.result_digest);
  assert.equal(replay.json.task.completed_at, completedAt);

  await expectRejection(parts, () => sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id,
    taskResult(task, "FAILED", { data: { identity: "tampered" } })), 409, "TASK_RESULT_CONFLICT");

  const other = makeId("task");
  await expectRejection(parts, () => sendResult(parts.handler, parts.clock, node_uid, credential.token, other,
    taskResult({ ...task, task_id: other }, "SUCCEEDED")), 404, "TASK_NOT_FOUND");

  await expectRejection(parts, () => nodePost(parts.handler, "/v0/nodes/" + node_uid + "/tasks/" + task.task_id + "/result", {
    token: credential.token, headerUid: node_uid,
    body: agentEnvelope(parts.clock, node_uid, { task_id: other, result }),
  }), 400, "NODE_REQUEST_INVALID");

  const completed = parts.controller.listNodeTasks(node_uid).find((item) => item.task_id === task.task_id);
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  assert.equal(completed.completed_at, completedAt);
  const afterResult = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.deepEqual(afterResult.json.tasks, []);
});

test("result status stays inside na-core's four-value vocabulary and fails closed to UNKNOWN", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "status-device");
  const credential = giveCredential(parts.controller, node_uid);

  // Pinned to na-core protocol.py:57-61; a rename on either side must fail here.
  assert.deepEqual(RESULT_STATUSES, ["SUCCEEDED", "REFUSED", "FAILED", "UNKNOWN"]);

  const send = async (status) => {
    const task = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity"] } });
    const response = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, taskResult(task, status));
    assert.equal(response.status, 200, "unexpected result for status " + JSON.stringify(status));
    return response;
  };

  for (const status of RESULT_STATUSES) {
    const response = await send(status);
    assert.equal(response.json.task.result_outcome, status, "status is projected verbatim");
  }

  // Anything outside the vocabulary fails closed: it is never echoed back, so a
  // consumer cannot be told "SUCCEEDED" by a malformed node.
  for (const status of ["BOGUS", "succeeded", "", 42, { a: 1 }, ["SUCCEEDED"]]) {
    const response = await send(status);
    assert.equal(response.json.task.result_outcome, "UNKNOWN", "unexpected projection for " + JSON.stringify(status));
  }
  // A body that omits the status key entirely is also UNKNOWN, not an error.
  const missingTask = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity"] } });
  const withoutStatus = taskResult(missingTask, "SUCCEEDED");
  delete withoutStatus.status;
  const missingResponse = await sendResult(parts.handler, parts.clock, node_uid, credential.token, missingTask.task_id, withoutStatus);
  assert.equal(missingResponse.status, 200);
  assert.equal(missingResponse.json.task.result_outcome, "UNKNOWN");
});

test("result envelopes must be bound to the task path and the queued operation", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "binding-device");
  const other_uid = admitNode(parts.controller, "binding-other-device");
  const credential = giveCredential(parts.controller, node_uid);
  const task = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity"] } });
  const send = (result) => sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id, result);

  await expectRejection(parts, () => send({ ...taskResult(task, "SUCCEEDED"), schema: "ghostfleet-node-task/v1" }),
    400, "TASK_RESULT_SCHEMA_UNSUPPORTED");
  await expectRejection(parts, () => send({ ...taskResult(task, "SUCCEEDED"), task_id: makeId("task") }),
    409, "TASK_RESULT_SCOPE_MISMATCH");
  await expectRejection(parts, () => send({ ...taskResult(task, "SUCCEEDED"), operation: "service.status.read" }),
    409, "TASK_OPERATION_MISMATCH");
  await expectRejection(parts, () => send({ ...taskResult(task, "SUCCEEDED"), node_uid: other_uid }),
    403, "NODE_SCOPE_MISMATCH");

  // The task was untouched by all four rejections and still completes normally.
  const ok = await send(taskResult(task, "SUCCEEDED"));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.task.status, TASK_STATUS.COMPLETED);
  assert.equal(ok.json.task.result_outcome, "SUCCEEDED");
});

test("a node-supplied result_digest is advisory and never decides idempotency", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "digest-device");
  const credential = giveCredential(parts.controller, node_uid);
  const task = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["uptime"] } });
  const result = taskResult(task, "REFUSED", { code: "OBSERVE_NOT_PERMITTED" });
  const expected = sha256Hex(canonicalJson(result));

  const send = (advisory_digest) => nodePost(parts.handler, "/v0/nodes/" + node_uid + "/tasks/" + task.task_id + "/result", {
    token: credential.token, headerUid: node_uid,
    body: agentEnvelope(parts.clock, node_uid, { task_id: task.task_id, result, result_digest: advisory_digest }),
  });

  const wrong = "f".repeat(64);
  const first = await send(wrong);
  assert.equal(first.status, 200);
  assert.equal(first.json.result_digest, expected, "the stored digest is the server-derived one");
  assert.notEqual(first.json.result_digest, wrong);
  assert.equal(first.json.task.result_digest, expected);

  // A different advisory digest with the same result is still an idempotent
  // replay: the client value never participates in the comparison.
  const replay = await send("0".repeat(64));
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  assert.equal(replay.json.result_digest, expected);
  assert.equal(replay.json.task.result_outcome, "REFUSED");
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
  assert.equal(Object.hasOwn(projected, "credential_handoff"), false);
  assert.equal(Object.hasOwn(projected, "credential_handoff_state"), false);

  const listed = store.listNodes().find((item) => item.node_uid === node.node_uid);
  assert.equal(JSON.stringify(listed).includes("credential_digest"), false);
  assert.equal(JSON.stringify(listed).includes("credential_handoff"), false);
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

test("node-plane errors expose the stable code the Python agent dispatches on", async () => {
  // Cross-branch contract (na-core client.py _classify): 401/409 handling is
  // decided by the body's stable code, not by the HTTP status alone. Losing the
  // field silently turns a retryable nonce/seq conflict into a dropped request.
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "contract-device");
  const credential = giveCredential(parts.controller, node_uid);
  const beatPath = "/v0/nodes/" + node_uid + "/heartbeat";
  const body = agentEnvelope(parts.clock, node_uid);

  const anonymous = await nodePost(parts.handler, beatPath, { token: null, headerUid: node_uid, body });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, "NODE_AUTH_INVALID");
  assert.equal(anonymous.json.code, "NODE_AUTH_INVALID");

  const accepted = await nodePost(parts.handler, beatPath, { token: credential.token, headerUid: node_uid, body });
  assert.equal(accepted.status, 200);

  const intrusive = await nodePost(parts.handler, beatPath, {
    token: credential.token, headerUid: node_uid, body: { ...body, seq: body.seq + 1 },
  });
  assert.equal(intrusive.status, 409);
  assert.equal(intrusive.json.code, "NODE_NONCE_REPLAY");
  assert.equal(intrusive.json.error, "NODE_NONCE_REPLAY");

  parts.clock.advance(600);
  const bucket = parts.store.getNode(node_uid).agent;
  parts.store.putNodeAgent(node_uid, { ...bucket, rate: { tokens: 0, updated_at_ms: parts.clock.now() } });
  const limited = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, "NODE_RATE_LIMITED");
  assert.equal(limited.response.headers.get("retry-after"), String(limited.json.retry_after_s));

  const task = parts.controller.createNodeTask(node_uid, { operation: "node.observe", params: { want: ["identity"] } });
  // Each accepted request costs one bucket token, so a refill precedes each call.
  parts.clock.advance(NODE_RATE_LIMIT.refill_seconds);
  const lease = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(lease.status, 200);
  parts.clock.advance(NODE_RATE_LIMIT.refill_seconds);
  const first = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id,
    taskResult(task, "SUCCEEDED"));
  assert.equal(first.status, 200);
  parts.clock.advance(NODE_RATE_LIMIT.refill_seconds);
  const conflict = await sendResult(parts.handler, parts.clock, node_uid, credential.token, task.task_id,
    taskResult(task, "FAILED", { code: "OBSERVE_FAILED" }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "TASK_RESULT_CONFLICT");
  assert.equal(conflict.json.error, "TASK_RESULT_CONFLICT");
});

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

test("the token bucket tolerates a slow cadence and rejects a burst without writes", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "bucket-device");
  const credential = giveCredential(parts.controller, node_uid);

  // Steady state: two requests every 30s consumes 2 and refills 3 tokens.
  for (let step = 0; step < 10; step += 1) {
    const first = await heartbeat(parts.handler, parts.clock, node_uid, credential.token);
    assert.equal(first.status, 200, first.text);
    const second = await poll(parts.handler, parts.clock, node_uid, credential.token);
    assert.equal(second.status, 200, second.text);
    parts.clock.advance(30);
  }

  // Drain the full bucket at one instant, then the next request must be limited.
  for (let request = 0; request < NODE_RATE_LIMIT.capacity; request += 1) {
    const allowed = await poll(parts.handler, parts.clock, node_uid, credential.token);
    assert.equal(allowed.status, 200, "request " + request + " should still be inside the bucket: " + allowed.text);
  }
  await expectRejection(parts, () => poll(parts.handler, parts.clock, node_uid, credential.token), 429, "NODE_RATE_LIMITED");
  parts.clock.advance(NODE_RATE_LIMIT.refill_seconds);
  const refilled = await poll(parts.handler, parts.clock, node_uid, credential.token);
  assert.equal(refilled.status, 200);
});

test("rotation replaces the node credential and clears replay state", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "rotate-device");
  const old = giveCredential(parts.controller, node_uid);
  assert.equal((await heartbeat(parts.handler, parts.clock, node_uid, old.token)).status, 200);

  const rotated = await plainRequest(parts.handler, "/v0/node-credential/rotate", {
    body: { node_uid },
  });
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal(rotated.json.ok, true);
  assert.equal(rotated.json.node_uid, node_uid);
  assert.match(rotated.json.node_credential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(parts.store.snapshot()).includes(rotated.json.node_credential), false);
  assert.equal(parts.store.getNode(node_uid).agent.credential_digest, sha256Hex(rotated.json.node_credential));
  assert.equal(parts.store.getNode(node_uid).agent.credential_handoff, null, "rotation kills any pending handoff");
  assert.equal(parts.store.getNode(node_uid).agent.credential_handoff_state, null);

  // The old token is dead immediately: the digest was replaced.
  await expectRejection(parts, () => heartbeat(parts.handler, parts.clock, node_uid, old.token), 401, "NODE_AUTH_INVALID");

  // Rotated state restarts the replay window, so a fresh boot may begin at seq 0.
  const newToken = rotated.json.node_credential;
  const fresh = await nodePost(parts.handler, "/v0/nodes/" + node_uid + "/heartbeat", {
    token: newToken, headerUid: node_uid, body: agentEnvelope(parts.clock, node_uid, {}, { boot_id: "boot-rotated", seq: 0 }),
  });
  assert.equal(fresh.status, 200, fresh.text);

  const unknown = await plainRequest(parts.handler, "/v0/node-credential/rotate", { body: { node_uid: makeId("node") } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, "NODE_NOT_FOUND");
  const missing = await plainRequest(parts.handler, "/v0/node-credential/rotate", { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, "NODE_REQUEST_INVALID");
});

test("operator node task routes validate input and summarise without echoing params", async () => {
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "operator-task-device");

  const forbiddenOperation = await plainRequest(parts.handler, "/v0/node-tasks", {
    body: { node_uid, operation: "node.exec", params: {} },
  });
  assert.equal(forbiddenOperation.status, 400);
  assert.equal(forbiddenOperation.json.error, "TASK_OPERATION_FORBIDDEN");

  const forbiddenParam = await plainRequest(parts.handler, "/v0/node-tasks", {
    body: { node_uid, operation: "node.observe", params: { nested: { shell: true } } },
  });
  assert.equal(forbiddenParam.status, 400);
  assert.equal(forbiddenParam.json.error, "TASK_PARAMS_FORBIDDEN");

  const tooLong = await plainRequest(parts.handler, "/v0/node-tasks", {
    body: { node_uid, operation: "node.observe", params: { want: ["identity"] }, ttl_seconds: 601 },
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error, "TASK_REQUEST_INVALID");

  const extraKey = await plainRequest(parts.handler, "/v0/node-tasks", {
    body: { node_uid, operation: "node.observe", params: { want: ["identity"] }, urgent: true },
  });
  assert.equal(extraKey.status, 400);
  assert.equal(extraKey.json.error, "NODE_REQUEST_INVALID");

  const unknownNode = await plainRequest(parts.handler, "/v0/node-tasks", {
    body: { node_uid: makeId("node"), operation: "node.observe", params: { want: ["identity"] } },
  });
  assert.equal(unknownNode.status, 404);
  assert.equal(unknownNode.json.error, "NODE_NOT_FOUND");

  const created = await plainRequest(parts.handler, "/v0/node-tasks", {
    body: { node_uid, operation: "service.status.read", params: { units: ["ssh.service"] }, ttl_seconds: 120 },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.ok, true);
  assert.equal(created.json.node_uid, node_uid);
  assert.equal(created.json.operation, "service.status.read");
  assert.match(created.json.task_id, /^task-/);

  const listed = await plainRequest(parts.handler, "/v0/node-tasks?node_uid=" + encodeURIComponent(node_uid), { method: "GET" });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.tasks.length, 1);
  const summary = listed.json.tasks[0];
  assert.equal(summary.task_id, created.json.task_id);
  assert.equal(summary.status, TASK_STATUS.PENDING);
  assert.equal(Object.hasOwn(summary, "params"), false, "the operator view never echoes task params");
  assert.equal(listed.text.includes("ssh.service"), false);

  const missingUid = await plainRequest(parts.handler, "/v0/node-tasks", { method: "GET" });
  assert.equal(missingUid.status, 400);
  assert.equal(missingUid.json.error, "NODE_REQUEST_INVALID");
});

test("operator node routes still require the operator bearer", async () => {
  const fixture = workerFixture();
  for (const [method, path] of [
    ["POST", "/v0/node-tasks"],
    ["GET", "/v0/node-tasks?node_uid=" + makeId("node")],
    ["POST", "/v0/node-credential/rotate"],
  ]) {
    const denied = await fixture.request(path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal([401, 403].includes(denied.status), true, path + " must stay operator-gated");
  }
});

test("the durable object persists only successful node mutations", async () => {
  const fixture = workerFixture();
  const parts = makeController();
  const node_uid = admitNode(parts.controller, "persist-device");
  const credential = giveCredential(parts.controller, node_uid);
  fixture.values.set("ghostfleet-state", parts.store.snapshot());
  const blob = () => JSON.stringify(fixture.values.get("ghostfleet-state"));
  const nodeHeaders = (token) => {
    const headers = {
      "content-type": "application/json",
      "x-ghostfleet-node-uid": node_uid,
      "x-ghostfleet-agent-version": AGENT_VERSION,
    };
    if (token) headers.authorization = "Bearer " + token;
    return headers;
  };
  const envelope = (nonce, seq, boot_id = "boot-worker-1") => JSON.stringify({
    schema: AGENT_SCHEMA, node_uid, nonce, sent_at: new Date().toISOString(), boot_id, seq,
  });
  const nonce = randomBytes(18).toString("base64url");

  const seeded = blob();
  const anonymous = await fixture.request("/v0/nodes/" + node_uid + "/heartbeat", {
    headers: nodeHeaders(null), body: envelope(nonce, 0),
  });
  assert.equal(anonymous.status, 401);
  assert.equal(blob(), seeded, "an unauthenticated request must not rewrite the durable blob");

  const accepted = await fixture.request("/v0/nodes/" + node_uid + "/heartbeat", {
    headers: nodeHeaders(credential.token), body: envelope(nonce, 0),
  });
  assert.equal(accepted.status, 200);
  const afterAccepted = blob();
  assert.notEqual(afterAccepted, seeded, "a successful request is what commits the blob");

  for (const [label, body] of [
    ["byte-for-byte replay", envelope(nonce, 0)],
    ["used nonce with a fresh seq", envelope(nonce, 1)],
  ]) {
    const rejected = await fixture.request("/v0/nodes/" + node_uid + "/heartbeat", {
      headers: nodeHeaders(credential.token), body,
    });
    assert.equal(rejected.status, 409, label);
    assert.equal(blob(), afterAccepted, "a rejected replay must not rewrite the durable blob");
  }

  const oversized = await fixture.request("/v0/nodes/" + node_uid + "/heartbeat", {
    headers: nodeHeaders(credential.token), body: "x".repeat(NODE_BODY_LIMITS.heartbeat + 64),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, "NODE_BODY_TOO_LARGE");
  assert.equal(blob(), afterAccepted, "an oversized body must not rewrite the durable blob");

  // Seed an exhausted bucket: the rate limit must also be a non-mutating refusal.
  const record = parts.store.getNode(node_uid);
  parts.store.putNodeAgent(node_uid, { ...record.agent, rate: { tokens: 0, updated_at_ms: Date.now() } });
  fixture.values.set("ghostfleet-state", parts.store.snapshot());
  const limitedSeed = blob();
  const limited = await fixture.request("/v0/nodes/" + node_uid + "/tasks/poll", {
    headers: nodeHeaders(credential.token), body: envelope(randomBytes(18).toString("base64url"), 2),
  });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "NODE_RATE_LIMITED");
  assert.equal(limited.headers.get("retry-after"), String(NODE_RATE_LIMIT.refill_seconds));
  assert.equal(blob(), limitedSeed, "a rate-limited request must not rewrite the durable blob");
});
