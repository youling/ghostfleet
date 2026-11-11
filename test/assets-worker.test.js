import test from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/assets/src/index.js";

const digest = "a".repeat(64);
const origin = "https://assets.example.invalid";

function binding(bytes = "reviewed bytes\n") {
  const requests = [];
  return {
    requests,
    async fetch(request) {
      requests.push({ url: request.url, method: request.method });
      const path = new URL(request.url).pathname;
      if (path !== "/sha256/" + digest) return new Response("missing", { status: 404 });
      return new Response(request.method === "HEAD" ? null : bytes, { headers: { "content-type": "text/plain", "x-secret": "leak" } });
    },
  };
}

const call = (path, init = {}, env = { ASSETS: binding() }) => worker.fetch(new Request(origin + path, init), env);

test("serves exactly the content address with immutable, sandboxed headers", async () => {
  const env = { ASSETS: binding("reviewed bytes\n") };
  const response = await call("/sha256/" + digest, {}, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "reviewed bytes\n");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  // Upstream headers must not be forwarded blindly.
  assert.equal(response.headers.get("x-secret"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(env.ASSETS.requests, [{ url: origin + "/sha256/" + digest, method: "GET" }]);
});

test("HEAD returns the same address without a body", async () => {
  const env = { ASSETS: binding() };
  const response = await call("/sha256/" + digest, { method: "HEAD" }, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(env.ASSETS.requests[0].method, "HEAD");
});

test("only a 64-hex content address is reachable", async () => {
  for (const path of [
    "/",
    "/manifest.json",
    "/sha256",
    "/sha256/",
    "/sha256/" + "a".repeat(63),
    "/sha256/" + "a".repeat(65),
    "/sha256/" + "A".repeat(64),
    "/sha256/../../secret",
    "/sha256/" + digest + "/extra",
    "/sha256/" + digest + "?download=1",
  ]) {
    const response = await call(path);
    assert.equal(response.status, 404, path + " must not be served");
  }
});

test("mutating methods are refused with an explicit allow list", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await call("/sha256/" + digest, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
});

test("an unwired asset binding fails closed instead of falling back", async () => {
  const response = await worker.fetch(new Request(origin + "/sha256/" + digest), {});
  assert.equal(response.status, 503);
});

test("the asset worker never proxies a miss to a dynamic origin", async () => {
  const env = { ASSETS: binding() };
  const response = await call("/sha256/" + "b".repeat(64), {}, env);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "not found\n");
});
