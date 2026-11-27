import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import worker, { GhostFleetState } from '../src/adapters/cloudflare/worker.js';
import { dispatch, MANAGED_PROFILE, readManagedPanelDecision } from '../src/control-plane/presence.js';
import { apply } from '../nextgen/core.mjs';

const clock = Date.parse('2026-11-01T00:00:00Z');
const hash = value => createHash('sha256').update(value).digest('hex');
const pin = hash('synthetic managed bootstrap');
const artifact = {
  version: '0.3.0~rc3', platform: 'debian13-amd64', source_revision: 'a'.repeat(40), sha256: 'b'.repeat(64),
};
const profile = { channel: 'canary', platform: artifact.platform, config_revision: 'c'.repeat(64), desired: artifact };
const heartbeat = {
  protocol: 'ghostfleet-heartbeat/v1', boot_id: null, reporter_version: '1',
  services: { ssh: 'active', cloudflared: 'active', tailscaled: 'active' },
};

function legacy(state, path, body, { now = clock, token = '' } = {}) {
  return dispatch({
    method: body === undefined ? 'GET' : 'POST', path, body, access: 'operator',
    authorization: token ? 'Bearer ' + token : '', managedBootstrapSha: pin,
  }, state, now);
}

function nextgen(state, operation, uid, body, { now = clock, token = '' } = {}) {
  return apply(state, operation, { uid, body, role: 'operator', token }, now);
}

function managedTicket(state, uid, now = clock) {
  const request_secret = randomBytes(32).toString('hex');
  const request_id = hash(request_secret);
  assert.equal(legacy(state, '/v1/managed-enrollment/requests', { request_id }, { now }).status, 201);
  const issueBody = {
    label: 'Synthetic managed node', request_id, profile: MANAGED_PROFILE, attempt_id: randomUUID(),
    ...(uid ? { node_uid: uid } : {}),
  };
  const issue = legacy(state, '/v0/enrollment-tickets', issueBody, { now });
  assert.equal(issue.status, 201);
  const { ticket, short_code } = issue.data;
  const claimBody = { request_id, request_secret, short_code, expected_node_uid: ticket.node_uid };
  return { ticket, claimBody, issueBody };
}

function legacyManagedNode(state) {
  const { ticket, claimBody } = managedTicket(state);
  const claim = legacy(state, '/v1/managed-enrollment/claim', claimBody);
  assert.equal(claim.status, 200);
  return { uid: ticket.node_uid, ticket, token: claim.data.reporting_token };
}

function invitation(state, uid) {
  const issue = nextgen(state, 'issue', undefined, { label: 'Synthetic nextgen node', profile, ...(uid ? { node_uid: uid } : {}) });
  assert.equal(issue.status, 201);
  return {
    invitation: issue.body.invitation, expected_node_uid: issue.body.node_uid, config_revision: profile.config_revision,
    reporting_token: 'gf_hb_' + randomBytes(32).toString('base64url'),
  };
}

test('v1 heartbeat, v2 adoption and evidence, and the original managed decision coexist for one UID', () => {
  const state = {};
  const { uid, ticket, token } = legacyManagedNode(state);
  const old = readManagedPanelDecision(state, uid, ticket.ticket_id, pin);
  assert.equal(old.ok, true);
  assert.equal(legacy(state, '/v1/nodes/' + uid + '/heartbeat', heartbeat, { token }).status, 200);
  assert.equal(nextgen(state, 'adopt', uid, { profile }).status, 200);
  assert.equal(nextgen(state, 'report', uid, { installed: artifact, runtime: artifact }, { token }).status, 200);
  const nodes = nextgen(state, 'list').body.nodes;
  assert.equal(nodes.length, 1);
  assert.deepEqual([nodes[0].node_uid, nodes[0].versions.state, nodes[0].versions.legacy_reporter], [uid, 'CURRENT', '1']);
  assert.deepEqual([nodes[0].versions.desired, nodes[0].versions.installed, nodes[0].versions.runtime],
    [artifact, artifact, artifact]);
  assert.deepEqual(readManagedPanelDecision(state, uid, ticket.ticket_id, pin), old);
});

test('a newer legacy ticket supersedes an outstanding v2 invitation and preserves the bound profile', () => {
  const state = {};
  const { uid, token } = legacyManagedNode(state);
  assert.equal(nextgen(state, 'adopt', uid, { profile }).status, 200);
  assert.equal(nextgen(state, 'report', uid, { installed: artifact, runtime: artifact }, { token }).status, 200);
  const stale = invitation(state, uid);
  const replacement = managedTicket(state, uid, clock + 1);
  assert.equal(nextgen(state, 'claim', undefined, stale).status, 403);
  const claim = legacy(state, '/v1/managed-enrollment/claim', replacement.claimBody, { now: clock + 1 });
  assert.equal(claim.status, 200);
  const { profile: observed, versions } = nextgen(state, 'list').body.nodes[0];
  assert.deepEqual(observed, profile);
  assert.equal(versions.installed, null);
  assert.equal(nextgen(state, 'report', uid, { installed: artifact, runtime: artifact }, { token }).status, 401);
  assert.equal(nextgen(state, 'report', uid, { installed: artifact, runtime: artifact },
    { token: claim.data.reporting_token }).status, 200);
});

test('v2 invitation retires only pending legacy tickets, and its claim retires the previous decision', () => {
  const state = {};
  const { uid, ticket, token } = legacyManagedNode(state);
  const pending = managedTicket(state, uid);
  const replacement = invitation(state, uid);
  assert.equal(legacy(state, '/v1/managed-enrollment/claim', pending.claimBody).status, 409);
  assert.equal(readManagedPanelDecision(state, uid, ticket.ticket_id, pin).ok, true);
  assert.equal(nextgen(state, 'claim', undefined, replacement).body.registration, 'APPLIED');
  assert.equal(nextgen(state, 'claim', undefined, replacement).body.registration, 'ALREADY_APPLIED');
  assert.equal(readManagedPanelDecision(state, uid, ticket.ticket_id, pin).ok, false);
  assert.equal(state.managed_enrollment_tickets[ticket.ticket_id].state, 'CONSUMED');
  assert.equal(legacy(state, '/v1/nodes/' + uid + '/heartbeat', heartbeat, { token }).status, 401);
});

test('both revoke routes disable reporting and remove pending claims from both protocols', () => {
  for (const protocol of ['v0', 'v2']) {
    const state = {};
    const { uid, ticket, token } = legacyManagedNode(state);
    assert.equal(nextgen(state, 'adopt', uid, { profile }).status, 200);
    const pending = managedTicket(state, uid);
    const replacement = invitation(state, uid);
    // Model competing already-issued records encountered during an upgrade.
    Object.assign(state.managed_enrollment_tickets[pending.ticket.ticket_id], { state: 'ISSUED' });
    const result = protocol === 'v0'
      ? legacy(state, '/v0/nodes/' + uid + '/revoke', {})
      : nextgen(state, 'revoke', uid, {});
    assert.equal(result.status, 200);
    assert.equal(legacy(state, '/v1/managed-enrollment/claim', pending.claimBody).status, 409);
    assert.equal(nextgen(state, 'claim', undefined, replacement).status, 403);
    assert.equal(legacy(state, '/v1/nodes/' + uid + '/heartbeat', heartbeat, { token }).status, 401);
    assert.equal(nextgen(state, 'report', uid, { installed: artifact, runtime: artifact }, { token }).status, 401);
    assert.equal(readManagedPanelDecision(state, uid, ticket.ticket_id, pin).ok, false);
    assert.deepEqual(nextgen(state, 'list').body.nodes[0].profile, profile);
  }
});

test('credential state changed by the old deployment refuses a pending invitation after roll-forward', () => {
  const state = {};
  const first = invitation(state);
  assert.equal(nextgen(state, 'claim', undefined, first).status, 200);
  const uid = first.expected_node_uid;
  const stale = invitation(state, uid);
  // The previous deployed code clears these fields without updating generation.
  state.nodes[uid].reporting.revoked_at = new Date(clock + 1).toISOString();
  state.nodes[uid].reporting.digest = null;
  assert.equal(nextgen(state, 'claim', undefined, stale, { now: clock + 2 }).body.error, 'ENROLLMENT_BINDING_MISMATCH');
  assert.equal(state.nodes[uid].reporting.digest, null);
});

test('old attempt receipts and explicitly retained artifact decisions keep their original shape', () => {
  const state = {};
  const { ticket, claimBody, issueBody } = managedTicket(state);
  assert.equal(legacy(state, '/v1/managed-enrollment/claim', claimBody).status, 200);
  const uid = ticket.node_uid;
  const original = readManagedPanelDecision(state, uid, ticket.ticket_id, pin);
  const nextPin = hash('future managed bootstrap');
  assert.equal(readManagedPanelDecision(state, uid, ticket.ticket_id, nextPin).ok, false);
  assert.equal(readManagedPanelDecision(state, uid, ticket.ticket_id, undefined, [pin]).ok, false);
  assert.equal(readManagedPanelDecision(state, uid, ticket.ticket_id, nextPin, [pin, 'invalid']).ok, false);
  assert.deepEqual(readManagedPanelDecision(state, uid, ticket.ticket_id, nextPin, [pin]), original);
  invitation(state, uid);
  const replay = legacy(state, '/v0/enrollment-tickets', issueBody, { now: clock + 1200_000 });
  assert.deepEqual(replay.data.ticket, ticket);
  assert.equal(replay.data.short_code, null);
});

test('distinct origins, role grants, bounded payloads and v2 ingress rules are enforced at the edge', async () => {
  const panel = 'https://panel.example.invalid';
  const node = 'https://node.example.invalid';
  const reader = 'synthetic-reader-'.repeat(4);
  const operator = 'synthetic-operator-'.repeat(4);
  const lookups = [];
  const env = {
    GHOSTFLEET_PANEL_ORIGIN: panel, GHOSTFLEET_NODE_ORIGIN: node,
    GHOSTFLEET_OPERATOR_TOKEN: operator, GHOSTFLEET_READ_TOKEN: reader,
    NEXTGEN_CLAIM_LIMIT: { async limit({ key }) { lookups.push(key); return { success: false }; } },
  };
  const state = new GhostFleetState({ storage: { transaction: fn => fn({
    get: key => { assert.equal(key, 'ghostfleet-state'); return undefined; },
  }) } }, env);
  env.GHOSTFLEET_STATE = { idFromName: id => { assert.equal(id, 'global'); return id; }, get: () => state };
  const request = (origin, path, token, value, headers = {}) => worker.fetch(new Request(origin + path, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }), env);
  const read = await request(panel, '/v2/nodes', reader);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).access, 'read_only');
  assert.equal((await request(node, '/v2/nodes', reader)).status, 404);
  assert.equal((await request(panel, '/v2/claim', operator, {})).status, 404);
  assert.equal((await request(panel, '/v2/invitations', reader, { profile })).status, 403);
  assert.equal((await request(panel, '/v2/invitations', operator, { profile }, { origin: node })).status, 403);
  assert.equal((await request(panel, '/v2/invitations', operator, { profile, large: 'x'.repeat(4096) })).status, 413);
  assert.equal((await request(panel, '/v2/unknown', operator, {})).status, 404);
  assert.equal((await request(panel, '/v0/execute', operator, {})).status, 404);
  assert.equal((await request(node, '/v2/claim', undefined, {})).status, 503);
  assert.equal((await request(node, '/v2/claim', undefined, {}, { 'cf-connecting-ip': '192.0.2.10' })).status, 429);
  assert.deepEqual(lookups, ['192.0.2.10']);

  const observedUid = 'node-' + randomUUID();
  const legacyClaim = '/v1/enrollment-tickets/ticket-' + randomUUID() + '/claim';
  const legacyReport = '/v1/nodes/' + observedUid + '/heartbeat';
  const edgeSource = { 'cf-connecting-ip': '192.0.2.10' };
  assert.equal((await request(node, legacyClaim, undefined, {})).status, 503);
  assert.equal((await request(node, legacyClaim, undefined, {}, edgeSource)).status, 429);
  assert.equal((await request(node, legacyReport, undefined, heartbeat, edgeSource)).status, 503);
  env.GHOSTFLEET_REPORT_LIMIT = { async limit() { return { success: false }; } };
  assert.equal((await request(node, legacyReport, undefined, heartbeat, edgeSource)).status, 429);
  assert.equal((await request(node, '/v2/nodes/' + observedUid + '/evidence', undefined, {}, edgeSource)).status, 429);
  env.GHOSTFLEET_CLAIM_LIMIT = env.NEXTGEN_CLAIM_LIMIT;
  delete env.NEXTGEN_CLAIM_LIMIT;
  assert.equal((await request(node, legacyClaim, undefined, {}, edgeSource)).status, 429);
  assert.equal((await request(node, '/v2/claim', undefined, {}, edgeSource)).status, 503);

  const observer = 'gf_obs_' + randomBytes(32).toString('base64url');
  env.GHOSTFLEET_OBSERVER_GRANTS = JSON.stringify([{ token_sha256: hash(observer), node_uid: observedUid,
    scope: 'secondary', streams: ['ssh-probe/rescue'] }]);
  const observation = { source: 'ssh-probe', dimension: 'rescue', scope: 'secondary', verdict: 'READY',
    observed_at: new Date().toISOString() };
  const observationPath = '/v2/nodes/' + observedUid + '/observation';
  assert.equal((await request(panel, '/v2/nodes', observer)).status, 401);
  assert.equal((await request(panel, observationPath, operator, observation)).status, 401);
  assert.equal((await request(panel, observationPath, observer, { ...observation, scope: 'primary' })).status, 403);
  assert.equal((await request(panel, observationPath, observer, observation)).status, 404); // No node in this fixture.
});
