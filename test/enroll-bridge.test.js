import test from "node:test";
import assert from "node:assert/strict";
import bridge from "../workers/enroll/src/index.js";

const origin = "https://enroll.example.invalid";
const ticketId = "ticket-12345678-1234-1234-1234-123456789abc";

function controlPlane(status = 200, body = '{"ok":true}') {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      // Snapshot on entry: the body stream is consumed here, and the header
      // guard is what this stub is proving.
      const headers = new Headers(init.headers);
      const text = init.body ? await new Response(init.body).text() : "";
      calls.push({ url, init: { method: init.method }, headers, body: text });
      return new Response(body, { status, headers: { "content-type": "application/json", "x-upstream": "internal" } });
    },
  };
}

const post = (init = {}) => ({ method: "POST", ...init });

test("forwards the two public enrollment routes to the private control plane", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  for (const path of ["/v1/enrollment-tickets/" + ticketId + "/claim", "/v1/enroll/complete"]) {
    const response = await bridge.fetch(new Request(origin + path, post({ body: "12345678" })), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-upstream"), null, "upstream headers are not forwarded");
    const forwarded = env.GHOSTFLEET_CONTROL_PLANE.calls.at(-1);
    assert.equal(new URL(forwarded.url).pathname, path);
    assert.equal(new URL(forwarded.url).origin, "https://control-plane.invalid");
    assert.equal(forwarded.init.method, "POST");
    assert.equal(forwarded.body, "12345678");
  }
});

test("never forwards or injects Console credentials", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({
    body: "{}",
    headers: { authorization: "Bearer " + "console-token", cookie: "CF_Authorization=secret", "content-type": "application/json" },
  })), env);
  const headers = env.GHOSTFLEET_CONTROL_PLANE.calls[0].headers;
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("content-type"), "application/json");
});

test("only the two POST routes exist", async () => {
  const env = { GHOSTFLEET_CONTROL_PLANE: controlPlane() };
  const cases = [
    { method: "GET", path: "/v1/enrollment-tickets/" + ticketId + "/claim", status: 405 },
    { method: "POST", path: "/v1/bootstrap.sh", status: 404 },
    { method: "POST", path: "/v0/enrollment-attempts", status: 404 },
    { method: "POST", path: "/v1/enrollment-tickets/" + ticketId, status: 404 },
    { method: "POST", path: "/v1/enrollment-tickets/ticket-not-a-uuid/claim", status: 404 },
    { method: "POST", path: "/v1/enrollment-tickets/" + ticketId + "/claim/extra", status: 404 },
    { method: "POST", path: "/v1/enroll/complete?resume=1", status: 404 },
    { method: "POST", path: "/", status: 404 },
  ];
  for (const item of cases) {
    const response = await bridge.fetch(new Request(origin + item.path, { method: item.method }), env);
    assert.equal(response.status, item.status, item.method + " " + item.path);
  }
  assert.equal(env.GHOSTFLEET_CONTROL_PLANE.calls.length, 0, "a refused request never reaches the control plane");
});

test("an unavailable control plane is reported as 503, not retried", async () => {
  const missing = await bridge.fetch(new Request(origin + "/v1/enroll/complete", post({ body: "{}" })), {});
  assert.equal(missing.status, 503);
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
