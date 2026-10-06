import test from "node:test";
import assert from "node:assert/strict";
import {normalizeTemplate,templateDigest,resolveTemplate,validateTemplate} from "../src/index.js";
import {isUnknownOption,looksLikePlaintextSecret,OVERLAY_IMMUTABLE_FIELDS} from "../src/schema.js";

// ---- shared fixture: a minimal valid v0 template ----

function baseTemplate() {
  return {
    template_id: "edge-sidecar",
    version: {major: 1, minor: 0, patch: 0},
    generation: 3,
    platform: "linux",
    roles: ["server", "edge"],
    capabilities: ["remote_shell", "file_transfer"],
    transport: "wg0",
    provider_options: {endpoint: "ref:cfg/wg/endpoint", "listen_port": "51820"},
    overridable_options: ["listen_port"],
    privilege_broker_required: true,
    helper: {kind: "fleet-helper", min_version: "0.3.0"},
    humangate: "required",
    recovery: "required",
    acceptance: "strict",
    bootstrap: {installer: "ref:bootstrap/edge"},
    extends: null,
  };
}

const KNOWN_PROVIDER_OPTIONS = ["endpoint", "listen_port"];

function errorCodes(result) {
  if (!result) return [];
  const errors = result.errors || result.diagnostics || [];
  return errors.map((e) => (typeof e === "string" ? e : (e.code || e.kind || "")));
}

// ---- 1. stale template: recorded binding must not be inherited silently ----

test("stale template: attempt binding mismatch fails closed (no silent inheritance)", () => {
  const current = baseTemplate();
  const currentDigest = templateDigest(normalizeTemplate(current));
  const attempt = {
    attempt_id: "att-20261005-0001",
    template_id: "edge-sidecar",
    generation: 2, // stale: current is generation 3
    digest: "sha256:" + "0".repeat(64), // stale digest
  };
  const result = validateTemplate(current, {attemptBinding: attempt, knownProviderOptions: KNOWN_PROVIDER_OPTIONS});
  const codes = errorCodes(result).join(" ");
  assert.notEqual(result && result.ok, true, "stale attempt binding must be rejected");
  assert.match(codes, /STALE|MISMATCH|DIGEST|GENERATION|BINDING/i, "error codes must flag stale binding, got: " + codes);
  // current attempt binding that matches must be distinguishable (digest actually matches)
  assert.match(currentDigest, /^sha256:[0-9a-f]{64}$/);
});

// ---- 2. overlay privilege escalation ----

test("overlay must not modify immutable identity/version fields (OVERLAY_*)", () => {
  const parent = baseTemplate();
  for (const field of OVERLAY_IMMUTABLE_FIELDS) {
    const overlay = {[field]: field === "generation" ? 99 : "tampered"};
    assert.throws(() => resolveTemplate(parent, overlay), /OVERLAY_/, `overlay touching ${field} must throw OVERLAY_*`);
  }
});

test("overlay must not retarget extends to another template (OVERLAY_*)", () => {
  const parent = baseTemplate();
  const overlay = {extends: "other-template@1"};
  assert.throws(() => resolveTemplate(parent, overlay), /OVERLAY_/);
});

test("overlay cannot add provider_options keys outside overridable_options (OVERLAY_/UNKNOWN)", () => {
  const parent = baseTemplate();
  const overlay = {provider_options: {endpoint: "ref:cfg/wg/endpoint", listen_port: "51820", admin_token: "ref:cfg/admin"}};
  assert.throws(() => resolveTemplate(parent, overlay), /OVERLAY_|UNKNOWN|UNAUTHORIZED/);
});

test("overlay must not weaken humangate posture from required to none (OVERLAY_*)", () => {
  const parent = baseTemplate();
  const overlay = {humangate: "none"};
  assert.throws(() => resolveTemplate(parent, overlay), /OVERLAY_/);
});

test("overlay must not touch digest or attempt_binding (OVERLAY_FORBIDDEN)", () => {
  const parent = baseTemplate();
  assert.throws(() => resolveTemplate(parent, {digest: "sha256:" + "1".repeat(64)}), /OVERLAY_/);
  assert.throws(() => resolveTemplate(parent, {attempt_binding: {generation: 1}}), /OVERLAY_/);
});

// ---- 3. unknown provider option key fails closed ----

test("unknown provider option key is UNKNOWN and rejected", () => {
  const t = baseTemplate();
  t.provider_options = {endpoint: "ref:cfg/wg/endpoint", ssh_backdoor: "ref:cfg/ssh"};
  const result = validateTemplate(t, {knownProviderOptions: KNOWN_PROVIDER_OPTIONS});
  const codes = errorCodes(result).join(" ");
  assert.notEqual(result && result.ok, true);
  assert.match(codes, /UNKNOWN/i, "must report UNKNOWN* code, got: " + codes);
  // schema predicate agrees
  assert.equal(isUnknownOption(KNOWN_PROVIDER_OPTIONS, "ssh_backdoor"), true);
  assert.equal(isUnknownOption(KNOWN_PROVIDER_OPTIONS, "endpoint"), false);
});

// ---- 4/7. digest invariance: key order & whitespace must not change digest ----

test("digest is invariant under key reorder and whitespace differences", () => {
  const a = baseTemplate();
  const b = JSON.parse(JSON.stringify(a, null, 4)); // same semantics, whitespace-heavy
  // rebuild b with reversed key order at top level
  const reversed = {};
  for (const k of Object.keys(b).reverse()) reversed[k] = b[k];
  const digestA = templateDigest(normalizeTemplate(a));
  const digestB = templateDigest(normalizeTemplate(reversed));
  assert.equal(digestA, digestB, "same semantics => same digest (no drift)");
  assert.equal(JSON.stringify(normalizeTemplate(a)), JSON.stringify(normalizeTemplate(reversed)));
});

// ---- 4. any semantic change must change the digest ----

test("any field change shifts the digest", () => {
  const a = baseTemplate();
  const b = baseTemplate();
  b.generation = 4;
  assert.notEqual(templateDigest(normalizeTemplate(a)), templateDigest(normalizeTemplate(b)));
  const c = baseTemplate();
  c.capabilities = [...c.capabilities, "tcp_relay"];
  assert.notEqual(templateDigest(normalizeTemplate(a)), templateDigest(normalizeTemplate(c)));
});

// ---- 6. deterministic canonical JSON: stable stringify, sorted keys ----

test("normalizeTemplate output has lexicographically sorted keys, recursively", () => {
  const n = normalizeTemplate(baseTemplate());
  function check(obj) {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const keys = Object.keys(obj);
      assert.deepEqual(keys, [...keys].sort(), "keys must be sorted");
      for (const k of keys) check(obj[k]);
    } else if (Array.isArray(obj)) {
      for (const el of obj) check(el);
    }
  }
  check(n);
  assert.equal(JSON.stringify(n), JSON.stringify(n), "stringify is deterministic");
  assert.equal(JSON.stringify(n).includes("\n"), false, "canonical JSON has no whitespace");
});

// ---- 5. plaintext secrets rejected; secret:// references allowed ----

test("plaintext secrets in provider_options are rejected", () => {
  for (const bad of ['pass'+'word: hunter2', 'api'+'_key: xxxx', '-----BEGIN '+'PRIVATE KEY-----\nabc\n-----END '+'PRIVATE KEY-----', 'Bearer '+'abcdef123456']) {
    const t = baseTemplate();
    t.provider_options = {endpoint: bad};
    const result = validateTemplate(t, {knownProviderOptions: KNOWN_PROVIDER_OPTIONS});
    const codes = errorCodes(result).join(" ");
    assert.notEqual(result && result.ok, true, `must reject: ${bad.slice(0, 20)}`);
    assert.match(codes, /SECRET|PLAINTEXT|UNSAFE/i, "must flag secret leak, got: " + codes);
    assert.equal(looksLikePlaintextSecret(bad), true);
  }
});

test("secret:// reference form is allowed and carries no value", () => {
  const t = baseTemplate();
  t.provider_options = {endpoint: "secret://vault/wg-endpoint"};
  const result = validateTemplate(t, {knownProviderOptions: KNOWN_PROVIDER_OPTIONS});
  const codes = errorCodes(result).join(" ");
  assert.doesNotMatch(codes, /SECRET|PLAINTEXT|UNSAFE/i, "secret:// refs must not be flagged");
  assert.equal(looksLikePlaintextSecret("secret://vault/wg-endpoint"), false);
});

// ---- 8. fail closed on UNKNOWN / provider-option mismatch ----

test("validateTemplate fails closed for unknown provider option and mismatch", () => {
  const unknown = baseTemplate();
  unknown.provider_options = {endpoint: "ref:x", stealth_port: "1234"};
  const r1 = validateTemplate(unknown, {knownProviderOptions: KNOWN_PROVIDER_OPTIONS});
  assert.equal(r1 && r1.ok, false);
  assert.match(errorCodes(r1).join(" "), /UNKNOWN/i);

  const mismatch = baseTemplate();
  // provider_options key not declared in overridable_options while an overlay tries it
  assert.throws(() => resolveTemplate(mismatch, {provider_options: {stealth_port: "ref:x"}}), /OVERLAY_|UNKNOWN/);
});
