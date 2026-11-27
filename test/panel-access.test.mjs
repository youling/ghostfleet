import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker, { GhostFleetState } from '../src/adapters/cloudflare/worker.js';

const panel = 'https://panel.example.invalid';
const node = 'https://node.example.invalid';
// Build protocol-shaped test issuers without relying on any real team hostname.
const teamIssuer = name => new URL('https://' + name + '.cloudflareaccess.com').origin;
const issuer = teamIssuer('ghostfleet-synthetic-team');
const audience = 'a'.repeat(64);
const owner = 'owner@example.invalid';
const legacy = 'synthetic-operator-'.repeat(4);
const env = {
  GHOSTFLEET_PANEL_AUTH_MODE: 'cloudflare_access',
  GHOSTFLEET_PANEL_ORIGIN: panel,
  GHOSTFLEET_NODE_ORIGIN: node,
  GHOSTFLEET_PANEL_ACCESS_ISSUER: issuer,
  GHOSTFLEET_PANEL_ACCESS_AUD: audience,
  GHOSTFLEET_PANEL_ACCESS_OWNER_EMAIL: owner,
  GHOSTFLEET_OPERATOR_TOKEN: legacy,
};

function fixture(baseEnv = env) {
  const values = new Map();
  const instance = new GhostFleetState({ storage: {
    transaction: fn => fn({
      get: key => structuredClone(values.get(key)),
      put: (key, value) => values.set(key, structuredClone(value)),
    }),
  } }, baseEnv);
  const bindings = { ...baseEnv, GHOSTFLEET_STATE: { idFromName: name => name, get: () => instance } };
  return { instance, values, fetch: (url, init) => worker.fetch(new Request(url, init), bindings) };
}

test('single Cloudflare Access session authenticates Panel only, with exact write origin and no Bearer fallback', async t => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const { privateKey: foreignKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), issuer + '/cdn-cgi/access/certs');
    return Response.json({ keys: [jwk] });
  });
  const now = Math.floor(Date.now() / 1000);
  function sign({ ea = owner, iss = issuer, aud = audience, exp = now + 300,
    iat = now, subject = 'synthetic-owner-subject', key = privateKey } = {}) {
    return new SignJWT({ email: ea })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(exp).setSubject(subject)
      .sign(key);
  }
  const valid = await sign();
  const headers = { 'cf-access-jwt-assertion': valid };
  const app = fixture();
  const access = await app.fetch(panel + '/v0/access', { headers });
  assert.equal(access.status, 200);
  assert.equal(access.headers.get('cache-control'), 'no-store');
  const authorized = await access.json();
  assert.equal(authorized.auth_mode, 'cloudflare_access');
  assert.equal(authorized.access, 'operator');
  assert.equal(JSON.stringify(authorized).includes(valid), false);

  assert.equal((await app.fetch(panel + '/v0/nodes')).status, 401);
  assert.equal((await app.fetch(panel + '/v0/nodes', { headers: { authorization: 'Bearer ' + legacy } })).status, 401);
  assert.equal((await app.fetch(panel + '/v0/nodes', { headers: { 'cf-access-authenticated-user-email': owner } })).status, 401);
  for (const invalid of [
    await sign({ key: foreignKey }), await sign({ iss: teamIssuer('ghostfleet-other-synthetic-team') }),
    await sign({ aud: 'b'.repeat(64) }), await sign({ exp: now - 1 }),
  ]) {
    const rejected = await app.fetch(panel + '/v0/nodes', { headers: { 'cf-access-jwt-assertion': invalid } });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error, 'ACCESS_SESSION_REQUIRED');
  }
  for (const other of [
    await sign({ ea: 'other@example.invalid' }), await sign({ iat: now + 120 }), await sign({ subject: '' }),
  ]) {
    const rejected = await app.fetch(panel + '/v0/nodes', { headers: { 'cf-access-jwt-assertion': other } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error, 'ACCESS_IDENTITY_DENIED');
  }
  const issue = { body: JSON.stringify({ label: 'fixture' }), method: 'POST' };
  const issueHeaders = { ...headers, 'content-type': 'application/json' };
  const tickets = panel + '/v0/enrollment-tickets';
  for (const origin of [undefined, 'null', node]) {
    const rejected = await app.fetch(tickets, { ...issue, headers: { ...issueHeaders, ...(origin ? { origin } : {}) } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error, 'ORIGIN_DENIED');
  }
  assert.equal(app.values.size, 0);
  const created = await app.fetch(tickets, { ...issue, headers: { ...issueHeaders, origin: panel } });
  assert.equal(created.status, 201);
  const delivery = await created.json();

  const inventory = await app.fetch(panel + '/v0/nodes', { headers });
  assert.equal(inventory.status, 200);
  assert.equal((await inventory.json()).nodes[0].node_uid, delivery.ticket.node_uid);
  const inventoryV2 = await app.fetch(panel + '/v2/nodes', { headers });
  assert.equal(inventoryV2.status, 200);
  assert.equal((await inventoryV2.json()).nodes[0].node_uid, delivery.ticket.node_uid);
  assert.equal((await app.fetch(panel + '/v2/nodes', { headers: { authorization: 'Bearer ' + legacy } })).status, 401);
  assert.equal((await app.fetch(node + '/v2/nodes', { headers })).status, 404);
  const invitation = { method: 'POST', body: JSON.stringify({
    node_uid: delivery.ticket.node_uid,
    profile: { channel: 'canary', platform: 'debian13-amd64', config_revision: 'c'.repeat(64), desired: null },
  }) };
  assert.equal((await app.fetch(panel + '/v2/invitations', { ...invitation, headers: issueHeaders })).status, 403);
  assert.equal((await app.fetch(panel + '/v2/invitations', { ...invitation,
    headers: { ...issueHeaders, origin: node } })).status, 403);
  assert.equal((await app.fetch(node + '/v0/nodes', { headers })).status, 404);
  assert.equal((await app.instance.fetch(new Request(node + '/v0/nodes', { headers }))).status, 403);
  assert.equal((await app.instance.fetch(new Request(panel + '/v0/nodes'))).status, 401);
  const claimed = await app.fetch(node + '/v1/enrollment-tickets/' + delivery.ticket.ticket_id + '/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ short_code: delivery.short_code }),
  });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).node_uid, delivery.ticket.node_uid);
  assert.equal((await app.fetch(panel + '/v2/invitations', { ...invitation,
    headers: { ...issueHeaders, origin: panel } })).status, 201);

  const artifact = '#!/bin/sh\n# Synthetic managed fixture.\nexit 1\n';
  const sha256 = createHash('sha256').update(artifact).digest('hex');
  const managed = fixture({ ...env, GHOSTFLEET_MANAGED_BOOTSTRAP_SHA256: sha256,
    ASSETS: { fetch: async () => new Response(artifact) } });
  const managedAccess = await (await managed.fetch(panel + '/v0/access', { headers })).json();
  assert.equal(managedAccess.auth_mode, 'cloudflare_access');
  assert.equal(managedAccess.managed_bootstrap.sha256, sha256);
  const discovered = await (await managed.fetch(node + '/.well-known/ghostfleet-enrollment')).json();
  assert.deepEqual(discovered.artifact, managedAccess.managed_bootstrap);
  const requestSecret = 'b'.repeat(64);
  const requestId = createHash('sha256').update(requestSecret).digest('hex');
  const pairing = await managed.fetch(node + '/v1/managed-enrollment/requests', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_id: requestId }),
  });
  assert.equal(pairing.status, 201);
  const pending = await (await managed.fetch(panel + '/v0/managed-enrollment-requests', { headers })).json();
  assert.equal(pending.requests[0].request_id, requestId);
  const issued = await managed.fetch(tickets, { method: 'POST', headers: { ...issueHeaders, origin: panel },
    body: JSON.stringify({ label: 'synthetic managed', profile: 'FULL_MANAGED_LOWER_NODE', request_id: requestId,
      attempt_id: crypto.randomUUID() }) });
  assert.equal(issued.status, 201);
  const managedTicket = await issued.json();
  const managedClaim = await managed.fetch(node + '/v1/managed-enrollment/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, request_secret: requestSecret, short_code: managedTicket.short_code }),
  });
  assert.equal(managedClaim.status, 200);
  assert.equal((await managedClaim.json()).node_uid, managedTicket.ticket.node_uid);
});

test('partial Access configuration fails closed even with a legacy Operator credential', async () => {
  for (const invalid of [undefined, issuer + '/path', 'https://other.example.invalid']) {
    const app = fixture({ ...env, GHOSTFLEET_PANEL_ACCESS_ISSUER: invalid });
    const response = await app.fetch(panel + '/v0/access', { headers: { authorization: 'Bearer ' + legacy } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'ACCESS_AUTH_NOT_CONFIGURED');
  }
});
