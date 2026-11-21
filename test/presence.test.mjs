import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, presence } from '../src/control-plane/presence.js';
import { prepare } from '../src/control-plane/http.js';
import worker, { GhostFleetState } from '../src/adapters/cloudflare/worker.js';

const clock = Date.parse('2026-11-01T00:00:00Z');
const operator = 'synthetic-operator-'.repeat(4), reader = 'synthetic-reader-'.repeat(4);
const env = { GHOSTFLEET_OPERATOR_TOKEN: operator, GHOSTFLEET_READ_TOKEN: reader,
  GHOSTFLEET_PANEL_ORIGIN: 'https://panel.example.invalid', GHOSTFLEET_NODE_ORIGIN: 'https://node.example.invalid' };
const report = { protocol: 'ghostfleet-heartbeat/v1', boot_id: '11111111-1111-4111-8111-111111111111',
  reporter_version: '1', services: { ssh: 'active', cloudflared: 'not_found', tailscaled: 'active' } };
function send(state, method, path, body = {}, access = 'operator', authorization = '', now = clock) {
  return dispatch({ method, path, body, access, authorization }, state, now);
}
function issue(state, extra = {}) {
  return send(state, 'POST', '/v0/enrollment-tickets', { label: 'synthetic-linux', ...extra }).data;
}
function claim(state, delivery, extra = {}, now = clock) {
  return send(state, 'POST', '/v1/enrollment-tickets/' + delivery.ticket.ticket_id + '/claim',
    { short_code: delivery.short_code, ...extra }, null, '', now);
}
function enrolled() {
  const state = { nodes: {} }, delivery = issue(state), claimed = claim(state, delivery);
  assert.equal(claimed.status, 200);
  return { state, delivery, uid: claimed.data.node_uid, token: claimed.data.reporting_token };
}
const heartbeat = (s, uid, token, body = report, now = clock) =>
  send(s, 'POST', '/v1/nodes/' + uid + '/heartbeat', body, null, 'Bearer ' + token, now);

test('ticket reserves one stable node; claim and heartbeat never promote lifecycle', () => {
  const { state, delivery, uid, token } = enrolled();
  assert.equal(uid, delivery.ticket.node_uid);
  assert.equal(state.nodes[uid].lifecycle, 'PROVISIONAL');
  assert.equal(presence(state.nodes[uid], clock), 'PENDING');
  assert.equal(heartbeat(state, uid, token).status, 200);
  assert.equal(presence(state.nodes[uid], clock), 'ONLINE');
  assert.equal(state.nodes[uid].lifecycle, 'PROVISIONAL');
});
test('raw reporting token and short code never enter server snapshot or list', () => {
  const { state, delivery, token } = enrolled();
  assert.ok(!JSON.stringify(state).includes(token));
  assert.ok(!JSON.stringify(state).includes(delivery.short_code));
  const view = send(state, 'GET', '/v0/nodes').data;
  assert.ok(!JSON.stringify(view).includes('digest'));
  assert.ok(!JSON.stringify(view).includes(token));
});
test('replayed claim is refused; no second credential or identity', () => {
  const { state, delivery } = enrolled(), before = JSON.stringify(state);
  assert.equal(claim(state, delivery).status, 409);
  assert.equal(JSON.stringify(state), before);
});
test('ticket expires at the exact boundary and destroys code digest', () => {
  const state = {}, delivery = issue(state);
  const result = claim(state, delivery, {}, clock + 600_000);
  assert.equal(result.status, 410); assert.equal(result.dirty, true);
  assert.equal(state.presence_tickets[delivery.ticket.ticket_id].code_digest, null);
});
test('five wrong codes lock a ticket; known correct code no longer claims it', () => {
  const state = {}, delivery = issue(state);
  for (let i = 0; i < 5; i++) {
    const r = claim(state, { ...delivery, short_code: 'invalid' });
    assert.equal(r.status, 403); assert.equal(r.dirty, true);
  }
  assert.equal(claim(state, delivery).status, 409);
});
test('ticket cancellation rejects later claims', () => {
  const state = {}, d = issue(state);
  assert.equal(send(state, 'POST', '/v0/enrollment-tickets/' + d.ticket.ticket_id + '/revoke').status, 200);
  assert.equal(claim(state, d).status, 409);
});
test('identity conflict is rejected before ticket consumption', () => {
  const state = {}, d = issue(state), wrong = 'node-' + '22222222-2222-4222-8222-222222222222';
  assert.equal(claim(state, d, { expected_node_uid: wrong }).status, 409);
  assert.equal(claim(state, d, { expected_node_uid: d.ticket.node_uid }).status, 200);
});
test('identity values must be strings, not coercible arrays or objects', () => {
  const { state, delivery, uid } = enrolled();
  assert.equal(send(state, 'POST', '/v0/enrollment-tickets', { node_uid: [uid] }).status, 400);
  const d = issue(state, { node_uid: uid });
  assert.equal(claim(state, d, { expected_node_uid: [uid] }).status, 400);
  assert.equal(claim(state, d, { expected_node_uid: uid }).status, 200);
});
test('lost claim response recovery reissues for SAME node and invalidates old token', () => {
  const { state, uid, token } = enrolled();
  const replacement = issue(state, { node_uid: uid });
  assert.equal(replacement.ticket.node_uid, uid);
  assert.equal(Object.keys(state.nodes).length, 1);
  assert.equal(heartbeat(state, uid, token).status, 401);
  const next = claim(state, replacement).data;
  assert.notEqual(next.reporting_token, token);
  assert.equal(heartbeat(state, uid, next.reporting_token).status, 200);
});
test('replaying an initial issue after a lost response returns the original ticket without its code', () => {
  const state = { nodes: {} };
  const attempt = { label: 'synthetic-node', attempt_id: '11111111-1111-4111-8111-111111111111' };
  const first = send(state, 'POST', '/v0/enrollment-tickets', attempt);
  assert.equal(first.status, 201);
  assert.match(first.data.short_code, /^\d{8}$/);

  const restored = structuredClone(state);
  const replay = send(restored, 'POST', '/v0/enrollment-tickets', attempt);
  assert.deepEqual(replay, {
    status: 200, dirty: false, data: { ok: true, ticket: first.data.ticket, short_code: null },
  });
  assert.deepEqual(restored, state);
  assert.equal(Object.keys(restored.nodes).length, 1);
  assert.equal(Object.keys(restored.presence_tickets).length, 1);

  const originalUid = first.data.ticket.node_uid;
  const replacement = issue(restored, { node_uid: originalUid });
  const claimed = claim(restored, replacement);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.node_uid, originalUid);
  const afterClaim = structuredClone(restored);
  assert.deepEqual(send(restored, 'POST', '/v0/enrollment-tickets', attempt), replay);
  assert.deepEqual(restored, afterClaim);
});
test('initial issue attempt cannot be changed or used to reissue an existing node', () => {
  const state = { nodes: {} };
  const attempt = { label: 'synthetic-node', attempt_id: '11111111-1111-4111-8111-111111111111' };
  const first = send(state, 'POST', '/v0/enrollment-tickets', attempt);
  const snapshot = structuredClone(state);
  const conflict = send(state, 'POST', '/v0/enrollment-tickets', { ...attempt, label: 'other' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'ENROLLMENT_ATTEMPT_CONFLICT');
  const invalid = send(state, 'POST', '/v0/enrollment-tickets', { ...attempt, node_uid: first.data.ticket.node_uid });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error, 'INVALID_ENROLLMENT_ATTEMPT');
  assert.deepEqual(state, snapshot);
});
test('revocation is idempotent, disables reporting only, preserves identity and other state', () => {
  const { state, uid, token } = enrolled();
  state.nodes[uid].asset_ref = 'synthetic-asset'; state.nodes[uid].lifecycle = 'ACTIVE';
  state.legacy_example = { keep: true };
  heartbeat(state, uid, token);
  for (let i = 0; i < 2; i++) assert.equal(send(state, 'POST', '/v0/nodes/' + uid + '/revoke').status, 200);
  assert.equal(heartbeat(state, uid, token).status, 401);
  assert.equal(state.nodes[uid].lifecycle, 'ACTIVE');
  assert.equal(state.nodes[uid].asset_ref, 'synthetic-asset');
  assert.deepEqual(state.legacy_example, { keep: true });
  assert.equal(presence(state.nodes[uid], clock), 'REVOKED');
});
test('one node token cannot write another node or call admin APIs', () => {
  const { state, uid, token } = enrolled(), second = issue(state).ticket.node_uid;
  assert.equal(heartbeat(state, second, token).status, 401);
  assert.equal(send(state, 'POST', '/v0/nodes/' + uid + '/revoke', {}, null, 'Bearer ' + token).status, 401);
});
test('server receive time, not client wall clock, determines freshness', () => {
  const { state, uid, token } = enrolled();
  assert.equal(heartbeat(state, uid, token, { ...report, sent_at: '2999-01-01' }).status, 400);
  heartbeat(state, uid, token, report, clock);
  assert.equal(state.nodes[uid].reporting.last_seen_at, new Date(clock).toISOString());
  for (const [elapsed, expected] of [[180000, 'ONLINE'], [180001, 'STALE'], [600000, 'STALE'], [600001, 'OFFLINE'], [-1, 'UNKNOWN']]) {
    assert.equal(presence(state.nodes[uid], clock + elapsed), expected);
  }
});
test('legacy ACTIVE is not online; invalid timestamp is UNKNOWN', () => {
  const n = { lifecycle: 'ACTIVE' }; assert.equal(presence(n), 'UNREGISTERED');
  n.reporting = { last_seen_at: 'bad-time' }; assert.equal(presence(n), 'UNKNOWN');
});
test('all local states including missing units are preserved, not inferred connectivity', () => {
  const { state, uid, token } = enrolled();
  for (const v of ['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'not_found', 'unknown']) {
    assert.equal(heartbeat(state, uid, token, { ...report, services: { ...report.services, ssh: v } }).status, 200);
    assert.equal(state.nodes[uid].reporting.last_report.services.ssh, v);
  }
});
test('invalid packets and remote-command fields cannot update last_seen', () => {
  const { state, uid, token } = enrolled(), before = JSON.stringify(state);
  const cases = [null, [], {}, { ...report, command: 'echo forbidden' }, { ...report, services: {} },
    { ...report, services: { ...report.services, ssh: 'online' } }, { ...report, boot_id: 'not-a-uuid' },
    { ...report, protocol: 'old' }, { ...report, reporter_version: 'x'.repeat(41) }];
  for (const body of cases) assert.equal(heartbeat(state, uid, token, body).status, 400);
  assert.equal(JSON.stringify(state), before);
});
test('snapshot restart preserves successful reporting authentication', () => {
  const { state, uid, token } = enrolled();
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(heartbeat(restored, uid, token).status, 200);
});
test('read token cannot issue/reissue/revoke; prototype paths and body fields refused', () => {
  const state = {};
  assert.equal(send(state, 'POST', '/v0/enrollment-tickets', { label: 'a' }, 'read_only').status, 403);
  assert.equal(send(state, 'POST', '/v0/enrollment-tickets', JSON.parse('{"label":"a","__proto__":{}}')).status, 400);
  assert.equal(send(state, 'POST', '/v0/nodes/__proto__/revoke').status, 404);
  assert.deepEqual(state, {});
});

function request(path, { method = 'GET', token = operator, body, origin = env.GHOSTFLEET_PANEL_ORIGIN, headers = {} } = {}) {
  return new Request(origin + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
test('access metadata exposes both pinned installer and POSIX bootstrap only when both hashes are configured', async () => {
  const configured = { ...env, GHOSTFLEET_INSTALLER_SHA256: 'a'.repeat(64),
    GHOSTFLEET_BOOTSTRAP_SHA256: 'b'.repeat(64) };
  const ready = await prepare(request('/v0/access'), configured);
  assert.equal(ready.response.status, 200);
  const data = await ready.response.json();
  assert.deepEqual(data.installer, {
    url: env.GHOSTFLEET_NODE_ORIGIN + '/bootstrap/' + 'a'.repeat(64) + '.py',
    sha256: 'a'.repeat(64),
    bootstrap: {
      url: env.GHOSTFLEET_NODE_ORIGIN + '/bootstrap/' + 'b'.repeat(64) + '.sh',
      sha256: 'b'.repeat(64),
    },
  });
  const incomplete = await prepare(request('/v0/access'), {
    ...configured, GHOSTFLEET_BOOTSTRAP_SHA256: 'not-a-digest',
  });
  assert.equal((await incomplete.response.json()).installer, null);
});

test('reuse existing auth: missing roots, missing bearer, read token and same-token conflict', async () => {
  assert.equal((await prepare(request('/v0/access', { token: '' }), {})).response.status, 503);
  assert.equal((await prepare(request('/v0/access', { token: '' }), env)).response.status, 401);
  assert.equal((await (await prepare(request('/v0/access', { token: reader }), env)).response.json()).access, 'read_only');
  assert.equal((await prepare(request('/v0/access'), { ...env, GHOSTFLEET_READ_TOKEN: operator })).response.status, 503);
});

test('unverified Cloudflare Access assertion cannot replace the application bearer credential', async () => {
  const forged = 'synthetic.unverified.access.assertion';
  const missingBearer = await prepare(request('/v0/access', {
    token: '',
    headers: { 'cf-access-jwt-assertion': forged },
  }), env);
  assert.equal(missingBearer.response.status, 401);

  const readOnlyWrite = await prepare(request('/v0/enrollment-tickets', {
    method: 'POST', token: reader, body: { label: 'forged-access-role-fixture' },
    headers: { 'cf-access-jwt-assertion': forged },
  }), env);
  assert.equal(readOnlyWrite.response.status, 403);
  assert.equal((await readOnlyWrite.response.json()).error, 'READ_ONLY_CREDENTIAL');
});

test('authentication denials include no-store and browser hardening headers', async () => {
  const denied = [
    (await prepare(request('/v0/access', { token: '' }), {})).response,
    (await prepare(request('/v0/access', { token: '' }), env)).response,
    (await prepare(request('/v0/nodes', { method: 'POST', token: reader, body: {} }), env)).response,
  ];
  assert.deepEqual(denied.map(response => response.status), [503, 401, 403]);
  for (const response of denied) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
});
test('body limits, content-type, malformed JSON and forged Origin are refused', async () => {
  const path = '/v0/enrollment-tickets';
  const big = await prepare(request(path, { method: 'POST', body: { label: 'x'.repeat(5000) } }), env);
  assert.equal(big.response.status, 413);
  assert.equal((await prepare(request(path, { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } }), env)).response.status, 415);
  assert.equal((await prepare(request(path, { method: 'POST', body: {}, headers: { origin: 'https://evil.example.invalid' } }), env)).response.status, 403);
  const malformed = new Request(env.GHOSTFLEET_NODE_ORIGIN + '/v1/nodes/x/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal((await prepare(malformed, env)).response.status, 400);
});
function mockBindings() {
  let snapshot = null, tail = Promise.resolve();
  const storage = { transaction(fn) {
    const next = tail.then(async () => {
      let pending = structuredClone(snapshot);
      const result = await fn({ get: async () => structuredClone(pending), put: async (k, v) => { pending = structuredClone(v); } });
      snapshot = pending; return result;
    }); tail = next.catch(() => {}); return next;
  } };
  const bindings = { ...env };
  const object = new GhostFleetState({ storage }, bindings);
  bindings.GHOSTFLEET_STATE = { idFromName: n => n, get: () => object };
  bindings.ASSETS = { fetch: async () => new Response('synthetic static asset') };
  return bindings;
}
function mockBindingsWithDistinctObjectsPerId() {
  const objects = new Map(), requestedIds = [];
  const bindings = { ...env };
  bindings.GHOSTFLEET_STATE = {
    idFromName(name) { requestedIds.push(name); return 'id:' + name; },
    get(id) {
      if (!objects.has(id)) {
        let snapshot = null, tail = Promise.resolve();
        const storage = { transaction(fn) {
          const next = tail.then(async () => {
            let pending = structuredClone(snapshot);
            const result = await fn({
              get: async () => structuredClone(pending),
              put: async (_key, value) => { pending = structuredClone(value); },
            });
            snapshot = pending;
            return result;
          });
          tail = next.catch(() => {});
          return next;
        } };
        objects.set(id, new GhostFleetState({ storage }, bindings));
      }
      return objects.get(id);
    },
  };
  bindings.ASSETS = { fetch: async () => new Response('synthetic static asset') };
  return { bindings, requestedIds };
}

test('panel and node origins share the same global Durable Object identity', async () => {
  const { bindings, requestedIds } = mockBindingsWithDistinctObjectsPerId();

  const createdResponse = await worker.fetch(request('/v0/enrollment-tickets', {
    method: 'POST', body: { label: 'same-global-do-fixture' },
  }), bindings);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const claimResponse = await worker.fetch(request(
    '/v1/enrollment-tickets/' + created.ticket.ticket_id + '/claim',
    { method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: '',
      body: { short_code: created.short_code } },
  ), bindings);
  assert.equal(claimResponse.status, 200);
  const claimed = await claimResponse.json();

  const heartbeatResponse = await worker.fetch(request(
    '/v1/nodes/' + claimed.node_uid + '/heartbeat',
    { method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN,
      token: claimed.reporting_token, body: report },
  ), bindings);
  assert.equal(heartbeatResponse.status, 200);

  const inventoryResponse = await worker.fetch(request('/v0/nodes'), bindings);
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  assert.equal(inventory.nodes.length, 1);
  assert.equal(inventory.nodes[0].node_uid, claimed.node_uid);
  assert.equal(inventory.nodes[0].presence, 'ONLINE');
  assert.ok(requestedIds.length >= 4);
  assert.deepEqual([...new Set(requestedIds)], ['global']);
});

test('Worker origin routing fails closed for invalid, shared-public and cross-origin requests', async () => {
  const bindings = mockBindings();
  const sharedPublic = { ...bindings, GHOSTFLEET_NODE_ORIGIN: env.GHOSTFLEET_PANEL_ORIGIN };
  assert.equal((await worker.fetch(request('/v0/nodes'), sharedPublic)).status, 503);

  const insecure = { ...bindings, GHOSTFLEET_PANEL_ORIGIN: 'http://panel.example.invalid' };
  assert.equal((await worker.fetch(request('/v0/nodes'), insecure)).status, 503);

  assert.equal((await worker.fetch(request('/v0/nodes?unexpected=1'), bindings)).status, 404);
  assert.equal((await worker.fetch(request('/v0/nodes', {
    origin: 'https://attacker.example.invalid',
  }), bindings)).status, 404);

  const ticket = 'ticket-11111111-1111-4111-8111-111111111111';
  const panelClaim = await worker.fetch(request(
    '/v1/enrollment-tickets/' + ticket + '/claim',
    { method: 'POST', body: { short_code: '12345678' } },
  ), bindings);
  assert.equal(panelClaim.status, 404);
});

test('real Worker handler rejects admin access on node host and old command routes', async () => {
  const bindings = mockBindings();
  assert.equal((await worker.fetch(request('/v0/nodes', { origin: env.GHOSTFLEET_NODE_ORIGIN }), bindings)).status, 404);
  assert.equal((await worker.fetch(request('/v1/nodes/x/heartbeat', { method: 'POST', body: report }), bindings)).status, 404);
  for (const p of ['/mcp', '/v0/jobs', '/v0/capabilities', '/v1/enroll/complete', '/unknown']) {
    assert.equal((await worker.fetch(request(p), bindings)).status, 404);
  }
});
test('Worker/DO path rejects Read-token ticket creation before state mutation', async () => {
  const bindings = mockBindings();
  const denied = await worker.fetch(request('/v0/enrollment-tickets', {
    method: 'POST', token: reader, body: { label: 'read-only-denial-fixture' },
  }), bindings);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'READ_ONLY_CREDENTIAL');

  const list = await worker.fetch(request('/v0/nodes', { token: operator }), bindings);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).nodes, []);
});

test('Worker/DO path rejects a revoked reporter token with 401', async () => {
  const bindings = mockBindings();
  const created = await (await worker.fetch(request('/v0/enrollment-tickets', {
    method: 'POST', body: { label: 'revocation-fixture' },
  }), bindings)).json();
  const claimed = await (await worker.fetch(request(
    '/v1/enrollment-tickets/' + created.ticket.ticket_id + '/claim',
    { method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: '', body: { short_code: created.short_code } },
  ), bindings)).json();

  const revoked = await worker.fetch(request('/v0/nodes/' + claimed.node_uid + '/revoke', {
    method: 'POST', body: {},
  }), bindings);
  assert.equal(revoked.status, 200);

  const stale = await worker.fetch(request('/v1/nodes/' + claimed.node_uid + '/heartbeat', {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: claimed.reporting_token, body: report,
  }), bindings);
  assert.equal(stale.status, 401);

  const list = await worker.fetch(request('/v0/nodes', { token: operator }), bindings);
  const nodes = (await list.json()).nodes;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].node_uid, claimed.node_uid);
  assert.equal(nodes[0].presence, 'REVOKED');
});

test('Worker/DO keeps two node identities and reporting credentials isolated', async () => {
  const bindings = mockBindings();
  async function enroll(label) {
    const created = await (await worker.fetch(request('/v0/enrollment-tickets', {
      method: 'POST', body: { label },
    }), bindings)).json();
    const claimed = await (await worker.fetch(request(
      '/v1/enrollment-tickets/' + created.ticket.ticket_id + '/claim',
      { method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: '', body: { short_code: created.short_code } },
    ), bindings)).json();
    return claimed;
  }

  const first = await enroll('m4-node-one-fixture');
  const second = await enroll('m4-node-two-fixture');
  assert.notEqual(first.node_uid, second.node_uid);
  assert.notEqual(first.reporting_token, second.reporting_token);

  const firstBeat = await worker.fetch(request('/v1/nodes/' + first.node_uid + '/heartbeat', {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: first.reporting_token, body: report,
  }), bindings);
  const secondBeat = await worker.fetch(request('/v1/nodes/' + second.node_uid + '/heartbeat', {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: second.reporting_token, body: report,
  }), bindings);
  assert.equal(firstBeat.status, 200);
  assert.equal(secondBeat.status, 200);

  const crossNode = await worker.fetch(request('/v1/nodes/' + second.node_uid + '/heartbeat', {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: first.reporting_token, body: report,
  }), bindings);
  assert.equal(crossNode.status, 401);

  const revokeFirst = await worker.fetch(request('/v0/nodes/' + first.node_uid + '/revoke', {
    method: 'POST', body: {},
  }), bindings);
  assert.equal(revokeFirst.status, 200);
  const firstAfterRevoke = await worker.fetch(request('/v1/nodes/' + first.node_uid + '/heartbeat', {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: first.reporting_token, body: report,
  }), bindings);
  const secondAfterRevoke = await worker.fetch(request('/v1/nodes/' + second.node_uid + '/heartbeat', {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: second.reporting_token, body: report,
  }), bindings);
  assert.equal(firstAfterRevoke.status, 401);
  assert.equal(secondAfterRevoke.status, 200);

  const listed = await worker.fetch(request('/v0/nodes', { token: operator }), bindings);
  const nodes = (await listed.json()).nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes.find(n => n.node_uid === first.node_uid).presence, 'REVOKED');
  assert.equal(nodes.find(n => n.node_uid === second.node_uid).presence, 'ONLINE');
});

test('Worker/DO path commits one of 12 concurrent claims, then authenticated heartbeat', async () => {
  const bindings = mockBindings();
  const created = await (await worker.fetch(request('/v0/enrollment-tickets', { method: 'POST', body: { label: 'concurrent-fixture' } }), bindings)).json();
  const path = '/v1/enrollment-tickets/' + created.ticket.ticket_id + '/claim';
  const replies = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(request(path, {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: '', body: { short_code: created.short_code },
  }), bindings)));
  assert.equal(replies.filter(r => r.status === 200).length, 1);
  assert.equal(replies.filter(r => r.status === 409).length, 11);
  const good = await replies.find(r => r.status === 200).json();
  const beat = await worker.fetch(request('/v1/nodes/' + good.node_uid + '/heartbeat', {
    method: 'POST', origin: env.GHOSTFLEET_NODE_ORIGIN, token: good.reporting_token, body: report,
  }), bindings);
  assert.equal(beat.status, 200);
  const list = await (await worker.fetch(request('/v0/nodes', { token: reader }), bindings)).json();
  assert.equal(list.nodes.length, 1); assert.equal(list.nodes[0].presence, 'ONLINE');
});
test('node ingress serves only exact pinned installer and join shim; static UI stays panel-only', async () => {
  const bindings = { ...mockBindings(), GHOSTFLEET_INSTALLER_SHA256: 'a'.repeat(64),
    GHOSTFLEET_BOOTSTRAP_SHA256: 'c'.repeat(64) };
  assert.equal((await worker.fetch(request('/', { origin: env.GHOSTFLEET_NODE_ORIGIN }), bindings)).status, 404);
  assert.equal((await worker.fetch(request('/bootstrap/' + 'a'.repeat(64) + '.py', { origin: env.GHOSTFLEET_NODE_ORIGIN }), bindings)).status, 200);
  assert.equal((await worker.fetch(request('/bootstrap/' + 'b'.repeat(64) + '.py', { origin: env.GHOSTFLEET_NODE_ORIGIN }), bindings)).status, 404);
  assert.equal((await worker.fetch(request('/bootstrap/' + 'c'.repeat(64) + '.sh', { origin: env.GHOSTFLEET_NODE_ORIGIN }), bindings)).status, 200);
  assert.equal((await worker.fetch(request('/bootstrap/' + 'd'.repeat(64) + '.sh', { origin: env.GHOSTFLEET_NODE_ORIGIN }), bindings)).status, 404);
  assert.equal((await worker.fetch(request('/bootstrap/' + 'c'.repeat(64) + '.sh'), bindings)).status, 404);
  const page = await worker.fetch(request('/'), bindings);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
