import test from "node:test";
import assert from "node:assert/strict";
import { FIRST_USE, classifyFirstUseResponse, probeFirstUse } from "../console/shared/first-use.js";
import { getLanguage, setLanguage, t } from "../console/shared/i18n.js";

const response = (status, payload, options = {}) => ({
  status,
  type: options.type || "basic",
  redirected: options.redirected || false,
  headers: new Headers({ "content-type": options.contentType || "application/json" }),
  async json() { if (options.throwJson) throw Error("invalid"); return payload; },
});

test("real backend missing-root response is distinguished from invalid bearer", async () => {
  const missing = response(503, { ok: false, error: "AUTH_NOT_CONFIGURED" });
  const unauthorized = response(401, { ok: false, error: "UNAUTHORIZED" });
  assert.equal(classifyFirstUseResponse(missing, await missing.json()), FIRST_USE.NOT_INITIALIZED);
  assert.equal(classifyFirstUseResponse(unauthorized, await unauthorized.json()), FIRST_USE.TOKEN_REQUIRED);
  assert.notEqual(FIRST_USE.NOT_INITIALIZED, FIRST_USE.TOKEN_REQUIRED);
});

test("missing-root probe uses only existing read endpoint, without bearer, mutation or owner authority", async () => {
  const calls = [];
  const state = await probeFirstUse(async (url, options) => {
    calls.push({ url, options });
    return response(503, { ok: false, error: "AUTH_NOT_CONFIGURED" });
  });
  assert.equal(state, FIRST_USE.NOT_INITIALIZED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v0/access");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(Object.keys(calls[0].options.headers), ["accept"]);
  assert.equal(Object.hasOwn(calls[0].options.headers, "authorization"), false);
});

test("response shape and unexpected status never create fake NOT_INITIALIZED", async () => {
  const cases = [
    response(503, { ok: false, error: "UNAUTHORIZED" }),
    response(401, { ok: false, error: "AUTH_NOT_CONFIGURED" }),
    response(503, { error: "AUTH_NOT_CONFIGURED" }),
    response(200, { ok: true, access: "operator" }),
    response(302, { ok: false, error: "AUTH_NOT_CONFIGURED" }),
    response(503, { ok: false, error: "AUTH_NOT_CONFIGURED" }, { redirected: true }),
    response(503, { ok: false, error: "AUTH_NOT_CONFIGURED" }, { type: "opaqueredirect" }),
  ];
  for (const r of cases) assert.equal(await probeFirstUse(async () => r), FIRST_USE.UNKNOWN);
});

test("Cloudflare challenge, invalid body, timeout, network failure all remain UNKNOWN", async () => {
  assert.equal(await probeFirstUse(async () => response(200, "<html>login</html>", { contentType: "text/html" })), FIRST_USE.UNKNOWN);
  assert.equal(await probeFirstUse(async () => response(503, null, { throwJson: true })), FIRST_USE.UNKNOWN);
  assert.equal(await probeFirstUse(async () => { throw Error("network"); }), FIRST_USE.UNKNOWN);
  assert.equal(await probeFirstUse(async () => response(503, null)), FIRST_USE.UNKNOWN);
});

test("public first-use probe does not expose an API for secret creation or credential exchange", async () => {
  const state = await probeFirstUse(async (_, options) => {
    assert.equal(options.method, "GET");
    assert.equal("body" in options, false);
    return response(401, { ok: false, error: "UNAUTHORIZED" });
  });
  assert.equal(state, FIRST_USE.TOKEN_REQUIRED);
});

test("first-use copy explicitly distinguishes app login tokens from deployment-admin credentials", () => {
  const priorLanguage = getLanguage();
  const previousDocument = globalThis.document;
  // i18n.setLanguage updates the browser DOM; exercise translations under a
  // minimal inert Node-only document without contacting any real page.
  globalThis.document = {
    documentElement: { lang: "" },
    title: "",
    querySelector: () => ({ value: "" }),
    querySelectorAll: () => [],
  };
  try {
    for (const language of ["zh-CN", "en"]) {
      setLanguage(language);
      const unknown = t("firstUseUnknownStatus");
      const missing = t("firstUseNotInitializedHelp");
      assert.ok(unknown.includes("GhostFleet Operator/Read"));
      assert.match(unknown, /Cloudflare/);
      assert.match(missing, /Cloudflare/);
      assert.doesNotMatch(unknown, /never accepts deployment root secrets/i);
      assert.doesNotMatch(missing, /cannot create or receive deployment root secrets/i);
      assert.doesNotMatch(missing, /本页面不能创建或接收生产根密钥/);
    }
  } finally {
    setLanguage(priorLanguage);
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
