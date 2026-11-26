import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply } from '../core.mjs';

const token = () => 'gf_hb_' + randomBytes(32).toString('base64url');
const revision = 'a'.repeat(64);
const profile = { platform: 'debian13-amd64', channel: 'canary', config_revision: revision, desired: null };
const base = Date.parse('2026-11-26T12:00:00.000Z');
const issue = (state, extra = { label: 'Fixture' }, now = base) =>
  apply(state, 'issue', { role: 'operator', body: { profile, ...extra } }, now).body;

function enrollment(invitation, credential) {
  return { invitation: invitation.invitation, expected_node_uid: invitation.node_uid,
    config_revision: revision, reporting_token: credential };
}

test('atomic invitation binding, replay and stale generations', () => {
  const state = {};
  const invitation = issue(state);
  const reporting = token();
  const body = enrollment(invitation, reporting);
  assert.equal(state.nodes, undefined);
  assert.equal(apply(state, 'claim', { body: { ...body, config_revision: 'b'.repeat(64) } }, base).status, 409);
  assert.equal(apply(state, 'claim', {
    body: { ...body, expected_node_uid: 'node-' + randomUUID() },
  }, base).status, 409);
  assert.equal(apply(state, 'claim', { body }, base).body.registration, 'APPLIED');
  assert.equal(apply(state, 'claim', { body }, base).body.registration, 'ALREADY_APPLIED');
  assert.equal(apply(state, 'claim', { body: { ...body, reporting_token: token() } }, base).status, 409);
  const recovery = enrollment(issue(state, { node_uid: invitation.node_uid }), token());
  assert.equal(apply(state, 'report', { uid: invitation.node_uid, token: reporting,
    body: { installed: null, runtime: null } }, base).status, 200);
  assert.equal(apply(state, 'claim', { body: recovery }, base + 1).status, 200);
  assert.equal(apply(state, 'report', { uid: invitation.node_uid, token: reporting,
    body: { installed: null, runtime: null } }, base + 1).status, 401);
  assert.equal(apply(state, 'claim', { body }, base + 1).status, 409);
  assert.equal(apply(state, 'claim', { body: recovery }, base + 600_001).status, 403);
});

test('revocation cancels outstanding recovery and rejects the prior reporting credential', () => {
  const state = {};
  const invitation = issue(state);
  const credential = token();
  assert.equal(apply(state, 'claim', { body: enrollment(invitation, credential) }, base).status, 200);
  const recovery = issue(state, { node_uid: invitation.node_uid });
  const revoked = apply(state, 'revoke', { uid: invitation.node_uid, role: 'operator', body: {} }, base + 1);
  assert.equal(revoked.status, 200);
  assert.equal(apply(state, 'claim', { body: enrollment(recovery, token()) }, base + 2).status, 403);
  assert.equal(apply(state, 'report', { uid: invitation.node_uid, token: credential,
    body: { installed: null, runtime: null } }, base + 2).status, 401);
  const replacement = enrollment(issue(state, { node_uid: invitation.node_uid }, base + 3), token());
  assert.equal(apply(state, 'claim', { body: replacement }, base + 3).body.node_uid, invitation.node_uid);
});

test('legacy identity retains history and a v1 mutation fences a pending v2 recovery', () => {
  const uid = 'node-' + randomUUID();
  const state = { nodes: { [uid]: { node_uid: uid, lifecycle: 'ACTIVE', unrelated: ['preserve'],
    reporting: { digest: 'a'.repeat(64), last_report: { protocol: 'ghostfleet-heartbeat/v1', reporter_version: '1' } } } } };
  const recovery = enrollment(issue(state, { node_uid: uid }), token());
  state.nodes[uid].reporting = { digest: 'b'.repeat(64) };
  assert.equal(apply(state, 'claim', { body: recovery }, base + 1).status, 409);
  const refreshed = enrollment(issue(state, { node_uid: uid }), token());
  assert.equal(apply(state, 'claim', { body: refreshed }, base + 2).status, 200);
  assert.deepEqual(state.nodes[uid].unrelated, ['preserve']);
  assert.equal(state.nodes[uid].lifecycle, 'ACTIVE');
});

test('evidence preserves distinct readiness dimensions, time and provenance', () => {
  const state = {};
  const uid = 'node-' + randomUUID();
  state.nodes = { [uid]: { node_uid: uid } };
  const observe = (source, dimension, verdict, role = 'observer') => apply(state, 'observe', {
    uid, role, body: { source, dimension, verdict, observed_at: new Date(base).toISOString() },
  }, base);
  assert.equal(observe('tailscale-api', 'management', 'READY').status, 400);
  assert.equal(observe('tailscale-api', 'network', 'READY', 'operator').status, 403);
  assert.equal(observe('tailscale-api', 'network', 'READY').status, 200);
  assert.equal(observe('ssh-probe', 'management', 'UNAVAILABLE').status, 200);
  assert.equal(observe('tailscale-api', 'network', 'READY').status, 409);
  const list = (now) => apply(state, 'list', { role: 'read_only' }, now).body.nodes[0];
  assert.equal(list(base).health.network.verdict, 'READY');
  assert.equal(list(base).health.management.verdict, 'UNAVAILABLE');
  assert.equal(list(base).health.rescue.verdict, 'UNKNOWN');
  assert.equal(list(base + 600_001).health.network.verdict, 'STALE');
  assert.equal(list(base).health.network.observations[0].provenance, 'trusted-observer');
  assert.equal(apply(state, 'observe', { uid, role: 'observer', body: { source: 'ssh-probe', dimension: 'management',
    scope: 'secondary', verdict: 'READY', observed_at: new Date(base).toISOString() } }, base).status, 200);
  assert.equal(list(base).health.management.verdict, 'CONFLICT');
});

test('recovery preserves independently observed binding evidence and archives v1 versions', () => {
  const state = {};
  const first = issue(state);
  assert.equal(apply(state, 'claim', { body: enrollment(first, token()) }, base).status, 200);
  const uid = first.node_uid;
  state.nodes[uid].reporting.last_report = { protocol: 'ghostfleet-heartbeat/v1', reporter_version: '1' };
  state.nodes[uid].reporting.last_seen_at = new Date(base).toISOString();
  const evidence = { source: 'ssh-probe', dimension: 'management', verdict: 'READY', observed_at: new Date(base).toISOString() };
  assert.equal(apply(state, 'observe', { uid, role: 'observer', body: evidence }, base).status, 200);
  const same = enrollment(issue(state, { node_uid: uid }, base + 1), token());
  assert.equal(apply(state, 'claim', { body: same }, base + 1).status, 200);
  const read = () => apply(state, 'list', { role: 'read_only' }, base + 2).body.nodes[0];
  assert.equal(read().health.management.verdict, 'READY');
  assert.equal(read().versions.legacy_reporter, null);
  assert.equal(read().versions.previous_legacy_reporter.version, '1');
  const changedProfile = { ...profile, config_revision: 'b'.repeat(64) };
  const changed = enrollment(issue(state, { node_uid: uid, profile: changedProfile }, base + 2), token());
  assert.equal(apply(state, 'claim', { body: { ...changed, config_revision: changedProfile.config_revision } }, base + 2).status, 200);
  assert.equal(read().health.management.verdict, 'UNKNOWN');
  assert.equal(read().versions.previous_legacy_reporter.version, '1');
});
