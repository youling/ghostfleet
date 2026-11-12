import test from "node:test";
import assert from "node:assert/strict";
import bridge, { BODY_LIMITS, CONTENT_TYPES, FORWARDED_HEADERS, RATE_LIMIT_RETRY_SECONDS } from "../workers/node/src/index.js";

// The public node plane is a strict bridge (§5.4): three POST routes, a body cap
// before the service binding, an allowlisted header set, and a flat 404 for
// everything else. It never authenticates; the control plane does.
const origin = "https://nodes.example.invalid";
const nodeUid = "node-alpha-01";
const otherUid = "node-beta-02";
const taskId = "task-01";
const heartbeatPath = "/v0/nodes/" + nodeUid + "/heartbeat";
const pollPath = "/v0/nodes/" + nodeUid + "/tasks/poll";
const resultPath = "/v0/nodes/" + nodeUid + "/tasks/" + taskId + "/result";
const envelope = JSON.stringify({ schema: "ghostfleet-node-agent/v0", node_uid: nodeUid, nonce: "synthetic-nonce-value", sent_at: "2026-01-01T00:00:00.000Z", boot_id: "boot-synthetic-1", seq: 0 });

function controlPlane(status = 200, body = '{"ok":true}') {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      // Snapshot on entry: the body stream is consumed here, and the header
      // allowlist is what this stub is proving.
      const headers = new Headers(init.headers);
      const text = init.body ? await new Response(init.body).text() : "";
      calls.push({ url, method: init.method, headers, body: text });
      return new Response(body, {
        status,
        headers: { "content-type": "application/json", "x-upstream": "internal", "retry-after": "7" },
      });
    },
  };
}

function limiter(answer) {
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      if (typeof answer === "function") return answer(key);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const post = (init = {}) => ({ method: "POST", ...init });
const json = (body, extra = {}) => post({ body, headers: { "content-type": CONTENT_TYPES.node }, ...extra });

test("forwards exactly the three node routes to the private control plane", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  for (const path of [heartbeatPath, pollPath, resultPath]) {
    const response = await bridge.fetch(new Request(origin + path, json(envelope, {
      headers: {
        "content-type": CONTENT_TYPES.node,
        authorization: "Bearer " + "node-credential-material",
        "x-ghostfleet-node-uid": nodeUid,
        "x-ghostfleet-agent-version": "0.1.0-synthetic",
      },
    })), env);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-upstream"), null, "upstream headers are not forwarded");
    assert.equal(response.headers.get("retry-after"), "7", "retry-after is the one advisory header that crosses");
    const forwarded = env.GHOSTFLEET_CONTROL_PLANE.calls.at(-1);
    assert.equal(new URL(forwarded.url).pathname, path);
    assert.equal(new URL(forwarded.url).origin, "https://control-plane.invalid");
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.body, envelope);
    assert.equal(forwarded.headers.get("authorization"), "Bearer " + "node-credential-material");
    assert.equal(forwarded.headers.get("x-ghostfleet-node-uid"), nodeUid);
    assert.equal(forwarded.headers.get("x-ghostfleet-agent-version"), "0.1.0-synthetic");
  }
});

test("everything else is a flat 404, so the bridge does not confirm route existence", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  const cases = [
    { path: "/v0/nodes", init: json(envelope) },
    { path: "/v0/nodes/" + nodeUid, init: json(envelope) },
    { path: heartbeatPath, init: { method: "GET" } },
    { path: heartbeatPath + "/", init: json(envelope) },
    { path: heartbeatPath + "/extra", init: json(envelope) },
    { path: heartbeatPath + "?trace=1", init: json(envelope) },
    { path: "/v0/nodes/" + nodeUid.toUpperCase() + "/heartbeat", init: json(envelope) },
    { path: "/v0/nodes/" + nodeUid + "/tasks/unknown", init: json(envelope) },
    { path: "/v1/enroll/complete", init: json(envelope) },
    { path: "/mcp", init: json(envelope) },
  ];
  for (const item of cases) {
    const response = await bridge.fetch(new Request(origin + item.path, item.init), env);
    assert.equal(response.status, 404, item.path);
    assert.equal((await response.json()).error, "NOT_FOUND");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 0, "a 404 never reaches the control plane");
});

test("the body cap is enforced before the service binding", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  for (const [path, limit] of [[heartbeatPath, BODY_LIMITS.heartbeat], [pollPath, BODY_LIMITS.poll], [resultPath, BODY_LIMITS.result]]) {
    const response = await bridge.fetch(new Request(origin + path, json("x".repeat(limit + 64))), env);
    assert.equal(response.status, 413, path);
    assert.equal((await response.json()).error, "NODE_BODY_TOO_LARGE");
  }
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 0, "an oversized anonymous body never reaches the control plane");
});

test("the media type is fixed before the body is read", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, {}]) {
    const response = await bridge.fetch(new Request(origin + pollPath, post({ body: envelope, headers })), env);
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, "UNSUPPORTED_CONTENT_TYPE");
  }
  // Media type parameters are tolerated.
  const withCharset = await bridge.fetch(new Request(origin + pollPath, post({
    body: envelope, headers: { "content-type": CONTENT_TYPES.node + "; charset=utf-8" },
  })), env);
  assert.equal(withCharset.status, 200);
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 1);
});

test("only the allowlisted headers cross, so forged edge metadata cannot", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  await bridge.fetch(new Request(origin + resultPath, post({
    body: envelope,
    headers: {
      authorization: "Bearer " + "node-credential-material",
      "content-type": CONTENT_TYPES.node,
      "x-ghostfleet-node-uid": nodeUid,
      "x-ghostfleet-agent-version": "0.1.0-synthetic",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      "cf-connecting-ip": "203.0.113.7",
      "cf-access-jwt-assertion": "synthetic-jwt",
      cookie: "CF_Authorization=synthetic",
      "x-unreviewed": "drop-me",
    },
  })), env);
  const headers = env.GHOSTFLEET_CONTROL_PLANE.calls[0].headers;
  assert.deepEqual([...headers.keys()].sort(), [...FORWARDED_HEADERS].sort());
  assert.equal(headers.get("x-forwarded-for"), null);
  assert.equal(headers.get("cf-connecting-ip"), null);
  assert.equal(headers.get("cf-access-jwt-assertion"), null);
  assert.equal(headers.get("cookie"), null);
});

test("a missing or failing service binding fails closed and never falls back to a URL", async () => {
  for (const env of [{}, { GHOSTFLEET_CONTROL_PLANE: null }, { GHOSTFLEET_CONTROL_PLANE: {} }]) {
    const response = await bridge.fetch(new Request(origin + heartbeatPath, json(envelope)), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "NODE_PLANE_NOT_CONFIGURED");
  }
  const failing = { GHOSTFLEET_CONTROL_PLANE: { async fetch() { throw new Error("binding down"); } } };
  const unavailable = await bridge.fetch(new Request(origin + heartbeatPath, json(envelope)), failing);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "NODE_PLANE_UNAVAILABLE");
});

test("the advisory limiter denies only on an explicit failure and is never authorization", async () => {
  const denied = limiter({ success: false });
  const deniedEnv = { GHOSTFLEET_CONTROL_PLANE: controlPlane(), NODE_PLANE_RATE_LIMITER: denied };
  const limited = await bridge.fetch(new Request(origin + heartbeatPath, json(envelope)), deniedEnv);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "NODE_RATE_LIMITED");
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(denied.keys.length, 1);
  assert.equal(deniedEnv.GHOSTFLEET_CONTROL_PLANE.calls.length, 0, "a limited request never reaches the control plane");

  // Derived keys: the limiter never sees the raw node handle.
  assert.match(denied.keys[0], /^node:[0-9a-f]{32}$/);
  assert.equal(denied.keys[0].includes(nodeUid), false);

  const throwingGetter = () => {
    const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
    Object.defineProperty(env, "NODE_PLANE_RATE_LIMITER", { get() { throw new Error("no binding"); } });
    return env;
  };
  const failOpen = [
    () => ({ GHOSTFLEET_CONTROL_PLANE: controlPlane(), NODE_PLANE_RATE_LIMITER: undefined }),
    () => ({ GHOSTFLEET_CONTROL_PLANE: controlPlane(), NODE_PLANE_RATE_LIMITER: { limit: () => { throw new Error("limiter down"); } } }),
    () => ({ GHOSTFLEET_CONTROL_PLANE: controlPlane(), NODE_PLANE_RATE_LIMITER: limiter(new Error("limiter down")) }),
    () => ({ GHOSTFLEET_CONTROL_PLANE: controlPlane(), NODE_PLANE_RATE_LIMITER: limiter(null) }),
    () => ({ GHOSTFLEET_CONTROL_PLANE: controlPlane(), NODE_PLANE_RATE_LIMITER: limiter({ success: true }) }),
    () => ({ GHOSTFLEET_CONTROL_PLANE: controlPlane(), NODE_PLANE_RATE_LIMITER: { limit: async () => "junk" } }),
    throwingGetter,
  ];
  for (const build of failOpen) {
    const env = build();
    const response = await bridge.fetch(new Request(origin + pollPath, json(envelope)), env);
    assert.equal(response.status, 200, "the limiter must fail open");
    assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 1);
  }

  // A limiter success is not an authorization decision: upstream auth failures
  // still pass through unchanged.
  const conflict = { GHOSTFLEET_CONTROL_PLANE: controlPlane(409, '{"ok":false,"error":"NODE_SEQ_REGRESSION"}'), NODE_PLANE_RATE_LIMITER: limiter({ success: true }) };
  const upstream = await bridge.fetch(new Request(origin + heartbeatPath, json(envelope)), conflict);
  assert.equal(upstream.status, 409);
  assert.deepEqual(await upstream.json(), { ok: false, error: "NODE_SEQ_REGRESSION" });
  assert.equal(conflict.GHOSTFLEET_CONTROL_PLANE.calls.length, 1);
});

test("the bridge forwards the same node handle it matched and keeps its own caps", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  const response = await bridge.fetch(new Request(origin + "/v0/nodes/" + otherUid + "/tasks/poll", json(envelope)), env);
  assert.equal(response.status, 200);
  const forwarded = env.GHOSTFLEET_CONTROL_PLANE.calls[0];
  assert.equal(new URL(forwarded.url).pathname, "/v0/nodes/" + otherUid + "/tasks/poll");
  assert.deepEqual(BODY_LIMITS, { heartbeat: 16 * 1024, poll: 4 * 1024, result: 64 * 1024 });
  assert.equal(RATE_LIMIT_RETRY_SECONDS, 10);
});
