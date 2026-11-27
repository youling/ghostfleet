import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { authorizeApi, authorizeObserver, checkObservationGrant } from '../../src/adapters/cloudflare/auth.js';

const panel = 'https://panel.example.invalid';
const node = 'https://node.example.invalid';
const key = () => randomBytes(35).toString('hex');
const token = () => 'gf_hb_' + randomBytes(32).toString('base64url');
const operator = key();
const reader = key();
const observer = 'gf_obs_' + randomBytes(32).toString('base64url');
const secondary = 'gf_obs_' + randomBytes(32).toString('base64url');
const legacyObserver = key();
const grant = (bearer, node_uid, scope) => ({
  token_sha256: createHash('sha256').update(bearer).digest('hex'),
  node_uid, scope, streams: ['ssh-probe/management'],
});
const profile = { channel: 'canary', platform: 'debian13-amd64', config_revision: 'a'.repeat(64), desired: null };
const heartbeat = { protocol: 'ghostfleet-heartbeat/v1', boot_id: null, reporter_version: '1',
  services: { ssh: 'active', tailscaled: 'not_found', cloudflared: 'not_found' } };

async function start(entryPoint, persistence, grants = [], limits = { claim: 12, report: 24 }) {
  const built = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'node', write: false });
  const claimBinding = entryPoint.startsWith('nextgen/') ? 'NEXTGEN_CLAIM_LIMIT' : 'GHOSTFLEET_CLAIM_LIMIT';
  return new Miniflare(convertV4MiniflareOptions({
    name: 'isolated-ghostfleet',
    modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GHOSTFLEET_STATE: { className: 'GhostFleetState', useSQLite: true } },
    ratelimits: {
      [claimBinding]: { namespace_id: '14103', simple: { limit: limits.claim, period: 60 } },
      GHOSTFLEET_REPORT_LIMIT: { namespace_id: '14106', simple: { limit: limits.report, period: 60 } },
    },
    resourcePersistencePath: persistence,
    bindings: {
      GHOSTFLEET_PANEL_ORIGIN: panel, GHOSTFLEET_NODE_ORIGIN: node, GHOSTFLEET_OPERATOR_TOKEN: operator,
      GHOSTFLEET_READ_TOKEN: reader, GHOSTFLEET_OBSERVER_TOKEN: legacyObserver,
      GHOSTFLEET_OBSERVER_GRANTS: JSON.stringify(grants),
    },
  }));
}

async function call(environment, origin, path, body, bearer, from, source = '192.0.2.4') {
  const response = await environment.dispatchFetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(from ? { origin: from } : {}),
      ...(source ? { 'cf-connecting-ip': source } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('Workerd preserves preexisting storage, v1 credentials and new v2 enrollment boundaries', async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'ghostfleet-nextgen-'));
  let runtime;
  try {
    runtime = await start('src/adapters/cloudflare/worker.js', persistence);
    let result = await call(runtime, panel, '/v0/enrollment-tickets', { label: 'Legacy fixture' }, operator);
    assert.equal(result.status, 201);
    const { ticket, short_code } = result.body;
    result = await call(runtime, node, '/v1/enrollment-tickets/' + ticket.ticket_id + '/claim', { short_code });
    assert.equal(result.status, 200);
    const legacyToken = result.body.reporting_token;
    const uid = ticket.node_uid;
    const oldHeartbeat = '/v1/nodes/' + uid + '/heartbeat';
    assert.equal((await call(runtime, node, oldHeartbeat, heartbeat, legacyToken)).status, 200);
    await runtime.dispose();
    runtime = await start('nextgen/worker.mjs', persistence,
      [grant(observer, uid, 'primary'), grant(secondary, uid, 'secondary')]);

    const list = () => call(runtime, panel, '/v2/nodes', undefined, reader);
    assert.equal((await list()).body.nodes[0].node_uid, uid);
    assert.equal((await list()).body.nodes[0].versions.legacy_reporter, '1');
    assert.equal((await call(runtime, node, oldHeartbeat, heartbeat, legacyToken)).status, 200);
    assert.equal((await call(runtime, node, '/v2/nodes', undefined, operator)).status, 404);
    assert.equal((await call(runtime, panel, '/v2/invitations', { node_uid: uid, profile }, reader)).status, 403);
    assert.equal((await call(runtime, panel, '/v2/invitations', { node_uid: uid, profile }, operator, node)).status, 403);
    assert.equal((await call(runtime, node, '/v2/claim', { padding: 'x'.repeat(4096) })).status, 413);
    assert.equal((await call(runtime, node, '/v1/managed-enrollment/requests', {})).status, 404);

    result = await call(runtime, panel, '/v2/invitations', { node_uid: uid, profile }, operator);
    assert.equal(result.status, 201);
    assert.equal((await call(runtime, node, oldHeartbeat, heartbeat, legacyToken)).status, 200);
    const invitation = result.body.invitation;
    const claim = { invitation, config_revision: profile.config_revision, expected_node_uid: uid,
      reporting_token: token() };
    const competitor = { ...claim, reporting_token: token() };
    assert.equal((await call(runtime, node, '/v2/claim', claim, null, null, 'invalid')).status, 503);
    const outcomes = await Promise.all([claim, competitor].map((body) => call(runtime, node, '/v2/claim', body)));
    assert.deepEqual(outcomes.map((item) => item.status).sort(), [200, 409]);
    const current = outcomes[0].status === 200 ? claim : competitor;
    assert.equal((await call(runtime, node, '/v2/claim', current)).body.registration, 'ALREADY_APPLIED');
    assert.equal((await call(runtime, node, oldHeartbeat, heartbeat, legacyToken)).status, 401);
    assert.equal((await call(runtime, node, oldHeartbeat, heartbeat, current.reporting_token)).status, 200);
    const evidence = '/v2/nodes/' + uid + '/evidence';
    const artifact = { version: '0.3.0~rc1', source_revision: '1'.repeat(40), sha256: '2'.repeat(64),
      platform: profile.platform };
    assert.equal((await call(runtime, panel, '/v2/nodes/' + uid + '/desired', { desired: artifact }, operator)).status, 200);
    const report = { installed: artifact, runtime: artifact };
    assert.equal((await call(runtime, node, evidence, report, current.reporting_token)).status, 200);
    const projection = (await list()).body.nodes[0];
    assert.equal(projection.versions.state, 'CURRENT');
    assert.equal(projection.versions.provenance, 'node-self-report');
    const observation = { source: 'ssh-probe', dimension: 'management', verdict: 'UNAVAILABLE',
      observed_at: new Date().toISOString() };
    const observe = '/v2/nodes/' + uid + '/observation';
    assert.equal((await call(runtime, panel, observe, observation, current.reporting_token)).status, 401);
    assert.equal((await call(runtime, panel, observe, observation, legacyObserver)).status, 401);
    assert.equal((await call(runtime, panel, observe, observation, observer)).status, 200);
    assert.equal((await list()).body.nodes[0].health.management.verdict, 'UNAVAILABLE');
    const secondaryReport = { ...observation, scope: 'secondary', verdict: 'READY' };
    assert.equal((await call(runtime, panel, observe, secondaryReport, secondary)).status, 200);
    assert.equal((await list()).body.nodes[0].health.management.verdict, 'CONFLICT');
    assert.equal((await call(runtime, panel, '/v0/nodes', undefined, observer)).status, 401);
    assert.equal((await call(runtime, panel, '/v2/nodes/' + uid + '/revoke', {}, operator)).status, 200);
    assert.equal((await call(runtime, node, evidence, report, current.reporting_token)).status, 401);
    assert.equal((await call(runtime, node, oldHeartbeat, heartbeat, current.reporting_token)).status, 401);
    const listing = await list();
    assert.equal(listing.body.nodes[0].node_uid, uid);
    assert.equal(listing.body.nodes[0].versions.installed, null);
    assert.doesNotMatch(JSON.stringify(listing.body), /gf_hb_|credential_generation|digest/);
  } finally {
    await runtime?.dispose();
    await rm(persistence, { force: true, recursive: true });
  }
});

test('Workerd shares bounded node budgets by source across the two protocol versions', async () => {
  const runtime = await start('nextgen/worker.mjs', undefined, [], { claim: 2, report: 2 });
  try {
    const v2 = await call(runtime, panel, '/v2/invitations', { label: 'Current fixture', profile }, operator);
    const uid = v2.body.node_uid;
    const current = { invitation: v2.body.invitation, expected_node_uid: uid,
      reporting_token: token(), config_revision: profile.config_revision };
    const v1 = await call(runtime, panel, '/v0/enrollment-tickets', { label: 'Legacy fixture' }, operator);
    const ticket = '/v1/enrollment-tickets/' + v1.body.ticket.ticket_id + '/claim';
    const legacy = { short_code: v1.body.short_code };

    assert.equal((await call(runtime, node, '/v2/claim', current)).body.registration, 'APPLIED');
    assert.equal((await call(runtime, node, '/v2/claim', current)).body.registration, 'ALREADY_APPLIED');
    const denied = await call(runtime, node, ticket, legacy);
    assert.equal(denied.status, 429);
    assert.equal(denied.body.error, 'CLAIM_RATE_LIMITED');
    assert.equal((await call(runtime, node, '/v2/claim', current)).status, 429);
    const enrolled = await call(runtime, node, ticket, legacy, null, null, '192.0.2.5');
    assert.equal(enrolled.status, 200);

    const evidence = '/v2/nodes/' + uid + '/evidence';
    const report = { installed: null, runtime: null };
    const beat = '/v1/nodes/' + enrolled.body.node_uid + '/heartbeat';
    const legacyToken = enrolled.body.reporting_token;
    assert.equal((await call(runtime, node, beat, heartbeat, legacyToken)).status, 200);
    assert.equal((await call(runtime, node, evidence, report, current.reporting_token)).status, 200);
    const overBudget = await call(runtime, node, evidence, report, current.reporting_token);
    assert.equal(overBudget.status, 429);
    assert.equal(overBudget.body.error, 'REPORT_RATE_LIMITED');
    assert.equal((await call(runtime, node, beat, heartbeat, legacyToken, null, '192.0.2.5')).status, 200);
    assert.equal((await call(runtime, node, evidence, report, current.reporting_token, null, '2001:db8:11:3::1')).status, 200);
  } finally {
    await runtime.dispose();
  }
});

test('Observer policy authorizes only assigned nodes, streams and independent scopes', () => {
  const uid = 'node-' + randomUUID();
  const otherUid = 'node-' + randomUUID();
  const env = {
    GHOSTFLEET_OPERATOR_TOKEN: operator, GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_OBSERVER_GRANTS: JSON.stringify([grant(observer, uid, 'primary')]),
    GHOSTFLEET_OBSERVER_GRANTS_01: JSON.stringify([grant(secondary, uid, 'secondary')]),
  };
  const request = (bearer) => new Request(panel + '/v2/nodes', { headers: { authorization: 'Bearer ' + bearer } });
  const observation = { source: 'ssh-probe', dimension: 'management' };
  const allowed = (bearer, nodeId, body) => {
    const { grant, response } = authorizeObserver(request(bearer), env);
    return response ?? checkObservationGrant(grant, nodeId, body);
  };
  assert.equal(allowed(observer, uid, observation), null);
  assert.equal(allowed(secondary, uid, { ...observation, scope: 'secondary' }), null);
  assert.equal(allowed(observer, otherUid, observation).status, 403);
  assert.equal(allowed(observer, uid, { ...observation, dimension: 'rescue' }).status, 403);
  assert.equal(allowed(observer, uid, { ...observation, scope: 'secondary' }).status, 403);
  assert.equal(allowed(operator, uid, observation).status, 401);
  assert.equal(allowed(reader, uid, observation).status, 401);
  assert.equal(authorizeApi(request(observer), env).response.status, 401);
  assert.equal(authorizeApi(request(reader), env).access, 'read_only');
  assert.equal(authorizeApi(request(operator), env).access, 'operator');

  const conflict = { ...env, GHOSTFLEET_OBSERVER_GRANTS: JSON.stringify([grant(operator, uid, 'primary')]) };
  assert.equal(authorizeApi(request(operator), conflict).response.status, 503);
  assert.equal(authorizeObserver(request(operator), conflict).response.status, 503);
  const overlapping = { ...env, GHOSTFLEET_OBSERVER_GRANTS_01: JSON.stringify([grant(secondary, uid, 'primary')]) };
  assert.equal(authorizeObserver(request(observer), overlapping).response.status, 503);
  assert.equal(authorizeApi(request(reader), overlapping).access, 'read_only');
});
