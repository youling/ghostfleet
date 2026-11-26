import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const panel = 'https://panel.example.invalid';
const node = 'https://node.example.invalid';
const key = () => randomBytes(35).toString('hex');
const token = () => 'gf_hb_' + randomBytes(32).toString('base64url');
const operator = key();
const reader = key();
const observer = key();
const profile = { channel: 'canary', platform: 'debian13-amd64', config_revision: 'a'.repeat(64), desired: null };
const heartbeat = { protocol: 'ghostfleet-heartbeat/v1', boot_id: null, reporter_version: '1',
  services: { ssh: 'active', tailscaled: 'not_found', cloudflared: 'not_found' } };

async function start(entryPoint, persistence) {
  const built = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'node', write: false });
  return new Miniflare(convertV4MiniflareOptions({
    name: 'isolated-ghostfleet',
    modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GHOSTFLEET_STATE: { className: 'GhostFleetState', useSQLite: true } },
    resourcePersistencePath: persistence,
    bindings: {
      GHOSTFLEET_PANEL_ORIGIN: panel, GHOSTFLEET_NODE_ORIGIN: node, GHOSTFLEET_OPERATOR_TOKEN: operator,
      GHOSTFLEET_READ_TOKEN: reader, GHOSTFLEET_OBSERVER_TOKEN: observer,
    },
  }));
}

async function call(environment, origin, path, body, bearer, from) {
  const response = await environment.dispatchFetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(from ? { origin: from } : {}),
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
    runtime = await start('nextgen/worker.mjs', persistence);

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
    assert.equal((await call(runtime, panel, observe, observation, observer)).status, 200);
    assert.equal((await list()).body.nodes[0].health.management.verdict, 'UNAVAILABLE');
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
