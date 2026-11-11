import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import bridge, { BODY_LIMITS, FORWARDED_HEADERS, RATE_LIMIT_RETRY_SECONDS } from "../workers/enroll/src/index.js";

const origin = "https://enroll.example.invalid";
const ticketId = "ticket-12345678-1234-1234-1234-123456789abc";
const claimPath = "/v1/enrollment-tickets/" + ticketId + "/claim";

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
      return new Response(body, { status, headers: { "content-type": "application/json", "x-upstream": "internal" } });
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

test("forwards exactly the two public routes to the private control plane", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  for (const path of [claimPath, "/v1/enroll/complete"]) {
    const response = await bridge.fetch(new Request(origin + path, post({ body: "12345678" })), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-upstream"), null, "upstream headers are not forwarded");
    const forwarded = env.GHOSTFLEET_CONTROL_PLANE.calls.at(-1);
    assert.equal(new URL(forwarded.url).pathname, path);
    assert.equal(new URL(forwarded.url).origin, "https://control-plane.invalid");
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.body, "12345678");
  }
});

test("only the allowlisted headers cross, so Console credentials cannot", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({
    body: "{}",
    headers: {
      authorization: "Bearer " + "console-token",
      cookie: "CF_Authorization=secret",
      "cf-access-jwt-assertion": "synthetic-jwt",
      "cf-connecting-ip": "203.0.113.7",
      "x-ghostfleet-preflight-digest": "sha256:" + "a".repeat(64),
      "x-fleet-os-family": "debian-family",
      "x-fleet-os-id": "ubuntu",
      "content-type": "application/json",
      "x-unreviewed": "drop-me",
    },
  })), env);
  const headers = env.GHOSTFLEET_CONTROL_PLANE.calls[0].headers;
  assert.deepEqual([...headers.keys()].sort(), [...FORWARDED_HEADERS].sort());
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("cf-access-jwt-assertion"), null);
  assert.equal(headers.get("cf-connecting-ip"), null, "the edge address is not the control plane's business");
  assert.equal(headers.get("x-unreviewed"), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-ghostfleet-preflight-digest"), "sha256:" + "a".repeat(64));
  assert.equal(headers.get("x-fleet-os-family"), "debian-family");
  assert.equal(headers.get("x-fleet-os-id"), "ubuntu");
});

test("only the two POST routes exist", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  const cases = [
    { method: "GET", path: claimPath, status: 405, error: "METHOD_NOT_ALLOWED" },
    { method: "POST", path: "/v1/bootstrap.sh", status: 404, error: "NOT_FOUND" },
    { method: "POST", path: "/v0/enrollment-attempts", status: 404, error: "NOT_FOUND" },
    { method: "POST", path: "/v1/enrollment-tickets/" + ticketId, status: 404, error: "NOT_FOUND" },
    { method: "POST", path: "/v1/enrollment-tickets/ticket-not-a-uuid/claim", status: 404, error: "NOT_FOUND" },
    { method: "POST", path: claimPath + "/extra", status: 404, error: "NOT_FOUND" },
    { method: "POST", path: "/v1/enroll/complete?resume=1", status: 404, error: "NOT_FOUND" },
    { method: "POST", path: "/", status: 404, error: "NOT_FOUND" },
  ];
  for (const item of cases) {
    const response = await bridge.fetch(new Request(origin + item.path, { method: item.method }), env);
    assert.equal(response.status, item.status, item.method + " " + item.path);
    assert.equal((await response.json()).error, item.error, item.method + " " + item.path);
  }
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 0, "a refused request never reaches the control plane");
});

test("an oversized public body is refused before the control plane is touched", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  // A claim is one 8-digit code. A megabyte of anonymous bytes must never reach
  // the single serialized control-plane object.
  const claim = await bridge.fetch(new Request(origin + claimPath, post({ body: "9".repeat(BODY_LIMITS.claim + 1024) })), env);
  assert.equal(claim.status, 413);
  assert.deepEqual(await claim.json(), { ok: false, error: "REQUEST_BODY_TOO_LARGE" });
  const complete = await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({ body: "x".repeat(BODY_LIMITS.complete + 1024) })), env);
  assert.equal(complete.status, 413);
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 0, "nothing crossed the binding");
  // A normal body still crosses.
  const ok = await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({ body: "{}" })), env);
  assert.equal(ok.status, 200);
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 1);
});

test("rate limiting is advisory: missing, failing or malformed bindings never block first use", async () => {
  const throwingGetter = new Proxy({}, { get() { throw new Error("binding getter failed"); } });
  for (const env of [
    { GHOSTFLEET_CONTROL_PLANE: controlPlane() },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: limiter(new Error("limiter down")) },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: limiter(null), RATE_LIMITER_TICKET: limiter(undefined) },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: { limit: "not-a-function" } },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: limiter({}) },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: limiter([]) },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: limiter("false") },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: limiter({ success: 0 }) },
    { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: throwingGetter },
  ]) {
    const response = await bridge.fetch(new Request(origin + claimPath, post({
      body: "12345678", headers: { "cf-connecting-ip": "203.0.113.9" },
    })), env);
    assert.equal(response.status, 200, "a limiter problem must fail open");
    assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 1);
  }
});

test("an environment without WebCrypto still allows the request through a limiter", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: limiter({ success: false }) };
    const response = await bridge.fetch(new Request(origin + claimPath, post({
      body: "12345678", headers: { "cf-connecting-ip": "203.0.113.9" },
    })), env);
    assert.equal(response.status, 200, "an unavailable digester must fail open, never 500");
    assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
  }
});

test("an explicit limiter denial is a 429 that never reaches the control plane", async () => {
  const ipLimiter = limiter({ success: false });
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: ipLimiter };
  const response = await bridge.fetch(new Request(origin + claimPath, post({
    body: "12345678", headers: { "cf-connecting-ip": "203.0.113.9" },
  })), env);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, error: "ENROLLMENT_RATE_LIMITED", retry_after_seconds: RATE_LIMIT_RETRY_SECONDS });
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 0);
  assert.equal(ipLimiter.keys.length, 1);
});

test("per-ticket and per-IP limits are independent, and keys are derived rather than raw", async () => {
  const ipLimiter = limiter({ success: true });
  const ticketLimiter = limiter((key) => ({ success: !key.includes("deny") }));
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane(), RATE_LIMITER_IP: ipLimiter, RATE_LIMITER_TICKET: ticketLimiter };
  await bridge.fetch(new Request(origin + claimPath, post({
    body: "12345678", headers: { "cf-connecting-ip": "203.0.113.9" },
  })), env);
  assert.equal(ipLimiter.keys.length, 1);
  assert.equal(ticketLimiter.keys.length, 1);
  const digest32 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
  assert.equal(ipLimiter.keys[0], "ip:" + digest32("203.0.113.9"), "the address key is the exact derived digest");
  assert.equal(ticketLimiter.keys[0], "ticket:" + digest32(ticketId), "the ticket key is the exact derived digest");
  assert.equal(ipLimiter.keys[0].includes("203.0.113.9"), false);
  assert.equal(ticketLimiter.keys[0].includes(ticketId), false);
  // A ticket-key denial alone is enough to answer 429.
  const denied = await bridge.fetch(new Request(origin + claimPath, post({
    body: "12345678", headers: { "cf-connecting-ip": "203.0.113.9" },
  })), { ...env, RATE_LIMITER_TICKET: limiter({ success: false }) });
  assert.equal(denied.status, 429);
});

test("a successful rate limit is not authorization", async () => {
  // Allow the request through the limiter; the control plane still decides, and
  // its refusal is preserved verbatim.
  const env = {
    GHOSTFLEET_CONTROL_PLANE: controlPlane(409, '{"ok":false,"error":"TICKET_EXPIRED"}'),
    RATE_LIMITER_IP: limiter({ success: true }),
    RATE_LIMITER_TICKET: limiter({ success: true }),
  };
  const response = await bridge.fetch(new Request(origin + claimPath, post({
    body: "00000000", headers: { "cf-connecting-ip": "203.0.113.9" },
  })), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: "TICKET_EXPIRED" });
});

test("an unavailable control plane is reported as 503, not retried", async () => {
  const missing = await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({ body: "{}" })), {});
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { ok: false, error: "ENROLLMENT_BRIDGE_UNAVAILABLE" });
  const failing = await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({ body: "{}" })), {
    GHOSTFLEET_CONTROL_PLANE: { fetch: async () => { throw new Error("binding down"); } },
  });
  assert.equal(failing.status, 503);
});

test("the control plane's own status and body are preserved", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane(409, '{"ok":false,"error":"TICKET_EXPIRED"}') };
  const response = await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({ body: "{}" })), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: "TICKET_EXPIRED" });
});
