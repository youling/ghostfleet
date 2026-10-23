import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/adapters/cloudflare/worker.js";
import { providerSetupSnapshot } from "../src/adapters/cloudflare/provider-setup.js";
import { renderProviders } from "../console/providers/view.js";

const operator = "synthetic-operator-".repeat(3);
const reader = "synthetic-reader-".repeat(3);
const credential = "synthetic-client-secret-" + "z".repeat(48);
const generation = "ghostfleet-tailscale-auth-v1";
const validProof = () => ({
  type: "tailscale-oauth-token-scope/v1",
  status: "VERIFIED",
  granted_scope: "auth_keys",
  requested_tag: "tag:fleet-ssh-target",
  verified_at: new Date().toISOString(),
});
const authority = () => ({
  provider: "tailscale",
  generation,
  scope: "auth_keys",
  tag: "tag:fleet-ssh-target",
  verification: validProof(),
});
const basePrivateResponse = () => ({
  ok: true, status: "READY", provider: "tailscale",
  authority_generation: generation, scope: "auth_keys",
  tag: "tag:fleet-ssh-target", verification: validProof(),
});
const secrets = {
  TAILSCALE_ENROLL_OAUTH_CLIENT_ID: "PRESENT",
  TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET: "PRESENT",
};
const setupRequest = (token = operator) => new Request(
  "https://ghostfleet.example.invalid/v0/providers/tailscale/setup", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({client_id: "synthetic-client-id", client_secret: credential}),
  },
);
const envFor = (reply, count) => ({
  GHOSTFLEET_OPERATOR_TOKEN: operator,
  GHOSTFLEET_READ_TOKEN: reader,
  GHOSTFLEET_ENROLLMENT_CLAIM_READY: "1",
  GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: {
    async fetch(request) {
      count.calls++;
      assert.equal(new URL(request.url).pathname, "/v1/provider/tailscale/setup");
      assert.equal(request.method, "POST");
      return reply;
    },
  },
});

test("private POST malformed 2xx never signals success after possible custody mutation", async () => {
  const invalid = [
    ["ok false", {...basePrivateResponse(), ok: false}],
    ["ok missing", {...basePrivateResponse(), ok: undefined}],
    ["generation missing literal", {...basePrivateResponse(), authority_generation: "MISSING"}],
    ["generation empty", {...basePrivateResponse(), authority_generation: ""}],
    ["generation spaces", {...basePrivateResponse(), authority_generation: "   "}],
    ["generation with disallowed shape", {...basePrivateResponse(), authority_generation: "bad generation"}],
    ["status missing", {...basePrivateResponse(), status: undefined}],
    ["provider wrong", {...basePrivateResponse(), provider: "not-tailscale"}],
    ["proof missing", {...basePrivateResponse(), verification: undefined}],
  ];
  for (const [name, reply] of invalid) {
    const c = { calls: 0 };
    const r = await worker.fetch(setupRequest(), envFor(Response.json(reply), c));
    assert.equal(c.calls, 1, name);
    assert.equal(r.status, 503, name);
    assert.deepEqual(await r.json(), {ok: false, error: "PROVIDER_AUTHORITY_SETUP_UNKNOWN"}, name);
  }
  for (const [name, response] of [
    ["empty object", Response.json({})],
    ["non json", new Response("not json", { status: 200 })],
    ["empty 204", new Response(null, { status: 204 })],
    ["server status without body", Response.json({}, { status: 202 })],
  ]) {
    const r = await worker.fetch(setupRequest(), envFor(response, { calls: 0 }));
    assert.equal(r.status, 503, name);
    assert.deepEqual(await r.json(), {ok: false, error: "PROVIDER_AUTHORITY_SETUP_UNKNOWN"}, name);
  }
});

test("private 5xx / timeout / secret echo never escapes into public error", async () => {
  const attempts = [
    Response.json({error: "INTERNAL"}, {status: 500}),
    Response.json({error: credential}, {status: 409}),
    Response.json({error: credential}, {status: 500}),
    Response.json({error: "UNRECOGNIZED_PROVIDER_CODE"}, {status: 409}),
    Response.json({error: "INTERNAL"}, {status: 502}),
    Response.json({error: "INTERNAL"}, {status: 504}),
    Response.json({error: "INTERNAL"}, {status: 408}),
    new Response("<html>error</html>", {status: 500}),
  ];
  for (const upstream of attempts) {
    const res = await worker.fetch(setupRequest(), envFor(upstream, {calls: 0}));
    const payload = await res.json();
    assert.equal(res.status, 503);
    assert.deepEqual(payload, {ok: false, error: "PROVIDER_AUTHORITY_SETUP_UNKNOWN"});
    assert.equal(JSON.stringify(payload).includes(credential), false);
  }
  const env = envFor(Response.json({}), {calls: 0});
  env.GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER.fetch = async () => { throw Error(credential); };
  const unknown = await worker.fetch(setupRequest(), env);
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), {ok: false, error: "PROVIDER_AUTHORITY_SETUP_UNKNOWN"});
});

test("known deterministic 4xx preserve only exact safe error codes", async () => {
  for (const [status, error] of [
    [400, "PROVIDER_SETUP_INPUT_INVALID"],
    [400, "PROVIDER_CLIENT_ID_INVALID"],
    [400, "PROVIDER_CLIENT_SECRET_INVALID"],
    [409, "PROVIDER_CREDENTIAL_REJECTED"],
  ]) {
    const res = await worker.fetch(setupRequest(), envFor(Response.json({ok:false,error}, {status}), {calls:0}));
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), {ok:false,error});
  }

  // Existing private adapter returns deterministic 409 without an ok field.
  const legacyKnown = await worker.fetch(setupRequest(), envFor(Response.json({
    error:"PROVIDER_CREDENTIAL_REJECTED",
  }, {status:409}), {calls:0}));
  assert.equal(legacyKnown.status,409);
  assert.deepEqual(await legacyKnown.json(),{
    ok:false,error:"PROVIDER_CREDENTIAL_REJECTED",
  });
  const unsafe = await worker.fetch(setupRequest(), envFor(Response.json({
    ok:true, error:"PROVIDER_CREDENTIAL_REJECTED"
  }, {status:409}), {calls:0}));
  assert.equal(unsafe.status,503);
  assert.deepEqual(await unsafe.json(),{ok:false,error:"PROVIDER_AUTHORITY_SETUP_UNKNOWN"});
});

test("scope proof freshness and authority identity are necessary for GET READY", async () => {
  const cases = [
    ["fresh, exact", authority(), "READY"],
    ["provider mismatch", {...authority(), provider:"not-tailscale"}, "CONFIGURED_UNVERIFIED"],
    ["generation MISSING", {...authority(), generation:"MISSING"}, "CONFIGURED_UNVERIFIED"],
    ["generation empty", {...authority(), generation:""}, "CONFIGURED_UNVERIFIED"],
    ["generation spaces", {...authority(), generation:"    "}, "CONFIGURED_UNVERIFIED"],
    ["generation bad syntax", {...authority(), generation:"not valid"}, "CONFIGURED_UNVERIFIED"],
    ["scope proof mismatch", {...authority(), scope:"auth_keys devices"}, "CONFIGURED_UNVERIFIED"],
    ["broader verified scopes", {...authority(), scope:"devices auth_keys", verification:{...validProof(),granted_scope:"auth_keys devices"}}, "READY"],
    ["required scope absent", {...authority(), scope:"devices", verification:{...validProof(),granted_scope:"devices"}}, "CONFIGURED_UNVERIFIED"],
    ["duplicate scope", {...authority(), scope:"auth_keys auth_keys", verification:{...validProof(),granted_scope:"auth_keys auth_keys"}}, "CONFIGURED_UNVERIFIED"],
    ["verified custom tag", {...authority(),tag:"tag:public-canary",verification:{...validProof(),requested_tag:"tag:public-canary"}}, "READY"],
    ["2000 receipt", {...authority(), verification:{...validProof(),verified_at:"2000-01-01T00:00:00.000Z"}}, "CONFIGURED_UNVERIFIED"],
    ["26h receipt", {...authority(), verification:{...validProof(),verified_at:new Date(Date.now()-26*3600000).toISOString()}}, "CONFIGURED_UNVERIFIED"],
    ["future receipt", {...authority(), verification:{...validProof(),verified_at:"2999-01-01T00:00:00.000Z"}}, "CONFIGURED_UNVERIFIED"],
    ["wrong timestamp format", {...authority(), verification:{...validProof(),verified_at:"2026-01-01"}}, "CONFIGURED_UNVERIFIED"],
  ];
  for (const [name, auth, expected] of cases) {
    const snap = await providerSetupSnapshot({
      GHOSTFLEET_ENROLLMENT_CLAIM_READY:"1",
      GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER:{
        async fetch() { return Response.json({ authority:auth, secrets }); }
      },
    });
    const p = snap.providers.tailscale;
    assert.equal(p.status,expected,name);
    const html = renderProviders(snap);
    assert.equal(html.includes('data-provider-setup="tailscale"'),false,name);
    if (expected !== "READY") {
      assert.match(html,/provider-unverified-note/,name);
      assert.doesNotMatch(html,/provider-ready-note/,name);
    }
    assert.equal(JSON.stringify(snap).includes(credential),false);
  }
});

test("private service outage never masquerades as missing credentials", async () => {
  const p = await providerSetupSnapshot({
    GHOSTFLEET_ENROLLMENT_CLAIM_READY: "1",
    GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: {async fetch() {return Response.json({error:"DOWN"}, {status:503});}},
  });
  assert.equal(p.providers.tailscale.status,"SERVICE_UNKNOWN");
  assert.equal(p.providers.tailscale.secret_state.client_id,"UNKNOWN");
  const html=renderProviders(p);
  assert.match(html,/provider-unknown-note/);
  assert.doesNotMatch(html,/data-provider-setup="tailscale"/);
});

test("scope/tag requirement may be selected per deployment without global forbiddens", async () => {
  const p=await providerSetupSnapshot({
    GHOSTFLEET_ENROLLMENT_CLAIM_READY: "1", GHOSTFLEET_ENROLL_TAG: "tag:public-canary",
    GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: {async fetch() {
      return Response.json({authority:{...authority(),scope:"auth_keys devices",tag:"tag:public-canary",
        verification:{...validProof(),granted_scope:"devices auth_keys",requested_tag:"tag:public-canary"}},secrets});
    }},
  });
  assert.equal(p.providers.tailscale.status,"READY");
  assert.equal(p.providers.tailscale.requirements.tag,"tag:public-canary");
  assert.equal(p.providers.tailscale.granted_scope,"devices auth_keys");
  assert.equal("forbidden" in p.providers.tailscale.requirements,false);
  const mismatch=await providerSetupSnapshot({
    GHOSTFLEET_ENROLLMENT_CLAIM_READY: "1", GHOSTFLEET_ENROLL_TAG: "tag:other",
    GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: {async fetch() {
      return Response.json({authority:{...authority(),scope:"auth_keys devices",tag:"tag:public-canary",
        verification:{...validProof(),granted_scope:"devices auth_keys",requested_tag:"tag:public-canary"}},secrets});
    }},
  });
  assert.equal(mismatch.providers.tailscale.status,"CONFIGURED_UNVERIFIED");
});

test("credentials present with invalid or absent generation never permits blind setup", async () => {
  for (const gen of ["MISSING", "", "  ", null, undefined]) {
    const p = await providerSetupSnapshot({
      GHOSTFLEET_ENROLLMENT_CLAIM_READY:"1",
      GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER:{
        async fetch() {
          return Response.json({authority:{...authority(),generation:gen}, secrets});
        }
      },
    });
    assert.equal(p.providers.tailscale.status,"CONFIGURED_UNVERIFIED");
    assert.equal(p.providers.tailscale.authority_generation,null);
    assert.equal(renderProviders(p).includes('data-provider-setup="tailscale"'), false);
  }
});

test("private provider setup accepts verified broad token scopes and selected tag", async () => {
  const response=Response.json({...basePrivateResponse(),scope:"auth_keys devices",tag:"tag:public-canary",
    verification:{...validProof(),granted_scope:"devices auth_keys",requested_tag:"tag:public-canary"}});
  const env=envFor(response,{calls:0});
  env.GHOSTFLEET_ENROLL_TAG="tag:public-canary";
  const allowed=await worker.fetch(setupRequest(),env);
  assert.equal(allowed.status,200);
  const body=await allowed.json();
  assert.equal(body.scope,"auth_keys devices");
  assert.equal(body.tag,"tag:public-canary");
  const wrongTag=envFor(Response.json({...basePrivateResponse(),scope:"auth_keys devices",tag:"tag:public-canary",
    verification:{...validProof(),granted_scope:"devices auth_keys",requested_tag:"tag:public-canary"}}),{calls:0});
  wrongTag.GHOSTFLEET_ENROLL_TAG="tag:elsewhere";
  const denied=await worker.fetch(setupRequest(),wrongTag);
  assert.equal(denied.status,503);
});

test("read-only credential cannot call private provider setup, and valid operator proof remains accepted", async () => {
  const count={calls:0};
  const env=envFor(Response.json(basePrivateResponse()),count);
  const denied=await worker.fetch(setupRequest(reader), env);
  assert.equal(denied.status,403);
  assert.equal(count.calls,0);
  const allowed=await worker.fetch(setupRequest(), env);
  assert.equal(allowed.status,200);
  assert.deepEqual(await allowed.json(),{
    ok:true,provider:"tailscale",status:"READY",authority_generation:generation,
    scope:"auth_keys",tag:"tag:fleet-ssh-target",
  });
  assert.equal(count.calls,1);
});
