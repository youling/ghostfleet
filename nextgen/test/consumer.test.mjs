import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply } from '../core.mjs';

test('an isolated consumer requires its explicit admission beyond fresh fleet evidence', () => {
  const state = {};
  const instant = Date.parse('2026-11-26T12:00:00Z');
  const profile = { channel: 'canary', platform: 'debian13-amd64', config_revision: 'a'.repeat(64), desired: null };
  const invitation = apply(state, 'issue', { role: 'operator', body: { label: 'Synthetic consumer', profile } }, instant).body;
  const uid = invitation.node_uid;
  const reporter = 'gf_hb_' + randomBytes(32).toString('base64url');
  const claim = { invitation: invitation.invitation, reporting_token: reporter,
    expected_node_uid: uid, config_revision: profile.config_revision };
  assert.equal(apply(state, 'claim', { body: claim }, instant).status, 200);
  const observation = { source: 'ssh-probe', dimension: 'management', verdict: 'READY',
    observed_at: new Date(instant).toISOString() };
  assert.equal(apply(state, 'observe', { uid, body: observation, role: 'observer' }, instant).status, 200);
  const catalog = (now) => apply(state, 'list', { role: 'read_only' }, now).body.nodes;

  // This is only a fixture for the instance's private admission seam.
  // Real instance authority, target host keys and Work scopes are not stored in the public projection.
  function admitted(decision, requestedUid, rows, now) {
    const target = rows.find((node) => node.node_uid === requestedUid);
    return decision?.node_uid === requestedUid && decision.action === 'native-ssh' &&
      decision.state === 'APPROVED' && decision.expires > now &&
      target?.reporting === 'REGISTERED' && target.health.management.verdict === 'READY';
  }
  assert.equal(admitted(null, uid, catalog(instant), instant), false);
  const reviewed = { node_uid: uid, action: 'native-ssh', state: 'APPROVED', expires: instant + 900_000 };
  assert.equal(admitted(reviewed, uid, catalog(instant), instant), true);
  assert.equal(admitted(reviewed, 'node-' + randomUUID(), catalog(instant), instant), false);
  assert.equal(admitted(reviewed, uid, catalog(instant + 601_000), instant + 601_000), false);
  assert.equal(apply(state, 'revoke', { uid, body: {}, role: 'operator' }, instant + 1).status, 200);
  assert.equal(admitted(reviewed, uid, catalog(instant + 1), instant + 1), false);
});
