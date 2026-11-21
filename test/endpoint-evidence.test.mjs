import test from "node:test";
import assert from "node:assert/strict";
import { inspectEndpointEvidence as inspect, EndpointEvidenceError } from "../src/control-plane/endpoint-evidence.js";

const UID = ["node","11111111","1111","4111","8111","111111111111"].join("-");
const OTHER_UID = ["node","22222222","2222","4222","8222","222222222222"].join("-");
const NOW = 1_800_000_000_000;
const QUERY = Object.freeze({
  node_uid: UID,
  service_ref: "host-proxy",
  namespace_ref: "rootless-worker",
  purpose_ref: "runner-bootstrap",
  caller_ref: "runner-listener",
});
const FACT = Object.freeze({
  ...QUERY,
  locator_ref: "locator-aaaaaaaaaaaaaaaa",
  binding_kind: "http_connect",
  source_ref: "evidence-bbbbbbbbbbbbbbbb",
  observed_at_ms: NOW - 1000,
  expires_at_ms: NOW + 5000,
  path_state: "REACHABLE",
  target_identity_state: "PIN_MATCH",
});
const row = (changes = {}) => ({ ...FACT, ...changes });
const view = (observations, q = QUERY, at = NOW) => inspect(q, observations, at);
const noAuthority = output => {
  assert.equal(output.authorization, "NOT_EVALUATED");
  assert.equal(output.provenance_authentication, "NOT_EVALUATED");
  assert.equal(output.network_connectivity_effect, "NONE");
  assert.equal(output.execution_effect, "NONE");
  assert.equal(output.fallback_or_retry, "NONE");
};
const refused = fn => assert.throws(fn, e =>
  e instanceof EndpointEvidenceError && e.message === "ENDPOINT_EVIDENCE_INVALID"
);

test("matching fresh observation yields opaque candidate evidence only, never authority", () => {
  const result = view([row()]);
  assert.equal(result.state, "CANDIDATE_EVIDENCE_ONLY");
  assert.deepEqual(result.candidate_refs, [FACT.locator_ref]);
  noAuthority(result);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /https?:|10\.0\.|private.key|socket|source_ref|host-key/);
});

test("stable node UID cannot be inferred from identical locator or shared hostname", () => {
  const result = view([row({ node_uid: OTHER_UID })]);
  assert.equal(result.state, "UNKNOWN");
  assert.deepEqual(result.candidate_refs, []);
  noAuthority(result);
});

test("logical namespace, purpose and caller must all match", () => {
  for (const field of ["service_ref", "namespace_ref", "purpose_ref", "caller_ref"]) {
    const output = view([row({ [field]: "other-ref" })]);
    assert.equal(output.state, "UNKNOWN", field);
    assert.deepEqual(output.candidate_refs, []);
  }
});

test("network DENIED blocks candidate fallback even if another provider is reachable", () => {
  const result = view([
    row({ path_state: "DENIED" }),
    row({ locator_ref: "locator-cccccccccccccccc", binding_kind: "tunnel" }),
  ]);
  assert.equal(result.state, "DENIED");
  assert.deepEqual(result.candidate_refs, []);
  noAuthority(result);
});

test("host identity mismatch blocks candidate despite other reachable paths", () => {
  const result = view([
    row({ target_identity_state: "MISMATCH" }),
    row({ locator_ref: "locator-cccccccccccccccc", binding_kind: "mesh" }),
  ]);
  assert.equal(result.state, "IDENTITY_CONFLICT");
  assert.deepEqual(result.candidate_refs, []);
});

test("unverified, unknown and unreachable path reports never form usable candidate", () => {
  for (const delta of [
    { target_identity_state: "UNVERIFIED" },
    { path_state: "UNREACHABLE" },
    { path_state: "UNKNOWN" },
  ]) {
    assert.equal(view([row(delta)]).state, "UNKNOWN");
  }
});

test("expired and future observations stay UNKNOWN; never infer recovered network", () => {
  assert.equal(view([row({ observed_at_ms: NOW - 4000, expires_at_ms: NOW - 1000 })]).state, "UNKNOWN");
  assert.equal(view([row({ observed_at_ms: NOW + 50, expires_at_ms: NOW + 2000 })]).state, "UNKNOWN");
  assert.equal(view([row({ observed_at_ms: NOW + 60_000, expires_at_ms: NOW + 61_000 })]).state, "UNKNOWN");
});

test("older DENIED cannot override fresh evidence, but no automatic remote action follows", () => {
  const result = view([
    row({ path_state: "DENIED", observed_at_ms: NOW - 8000, expires_at_ms: NOW - 1000 }),
    row({ locator_ref: "locator-cccccccccccccccc" }),
  ]);
  assert.equal(result.state, "CANDIDATE_EVIDENCE_ONLY");
  noAuthority(result);
});

test("matching opaque candidates are stable and sorted, never a selected route", () => {
  const result = view([
    row({ locator_ref: "locator-cccccccccccccccc", source_ref: "evidence-cccccccccccccccc" }),
    row({ locator_ref: "locator-aaaaaaaaaaaaaaaa" }),
    row({ locator_ref: "locator-aaaaaaaaaaaaaaaa" }),
  ]);
  assert.deepEqual(result.candidate_refs, ["locator-aaaaaaaaaaaaaaaa", "locator-cccccccccccccccc"]);
  noAuthority(result);
});

test("conflicting evidence for same locator is not silently combined", () => {
  const result = view([
    row(),
    row({ binding_kind: "private_ipv4" }),
  ]);
  assert.equal(result.state, "EVIDENCE_CONFLICT");
  assert.deepEqual(result.candidate_refs, []);
});

test("raw IPs, URLs, paths, credential-looking refs cannot be locators", () => {
  for (const locator_ref of [
    "127.0.0.1:7890", "https://proxy.example.invalid", "/run/mihomo.sock",
    "locator-secret", "locator-AAAAAAAAAAAAAAAA",
  ]) refused(() => view([row({ locator_ref })]));
});

test("unknown fields cannot affect authority or leak through result", () => {
  refused(() => view([row({ token: "SECRET" })]));
  refused(() => view([{ ...row(), credentials: { key: "secret" } }]));
  refused(() => view([row()], { ...QUERY, admin: true }));
});

test("invalid node identity and unbounded service/namespace strings fail closed", () => {
  refused(() => view([row()], { ...QUERY, node_uid: "node-fake" }));
  refused(() => view([row({ node_uid: "node-fake" })]));
  refused(() => view([row()], { ...QUERY, namespace_ref: "rootless/../host" }));
  refused(() => view([row()], { ...QUERY, service_ref: "A".repeat(100) }));
});

test("malformed timestamps, oversized lifetime and unknown enumerations are rejected", () => {
  for (const changes of [
    { observed_at_ms: "today" },
    { expires_at_ms: NOW + 600_000 },
    { expires_at_ms: NOW - 6000 },
    { path_state: "HEALTHY" },
    { target_identity_state: "ADMIN_GRANTED" },
    { binding_kind: "arbitrary_tcp" },
    { source_ref: "evidence-untrusted" },
  ]) refused(() => view([row(changes)]));
});

test("bounded evidence list rejects 33 records and invalid now", () => {
  refused(() => view(Array.from({ length: 33 }, () => row())));
  refused(() => view([row()], QUERY, Number.NaN));
  refused(() => view([row()], QUERY, -1));
  refused(() => view("not-an-array"));
});

test("records and query are not mutated; credentials or raw network data never appear", () => {
  const observations = Object.freeze([Object.freeze(row())]);
  const before = JSON.stringify(observations);
  const result = view(observations);
  assert.equal(JSON.stringify(observations), before);
  assert.equal(result.authorization, "NOT_EVALUATED");
  assert.deepEqual(Object.keys(result).sort(), [
    "authorization", "candidate_refs", "execution_effect", "fallback_or_retry",
    "network_connectivity_effect", "provenance_authentication", "schema", "state",
  ].sort());
});
