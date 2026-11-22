import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { FIRST_USE, classifyFirstUseResponse } from '../console/shared/first-use.js';

const html = readFileSync(new URL('../console/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8').replace(/^import [^\n]*\n/, '');
const settled = () => new Promise(resolve => setImmediate(resolve));
const deny = (error, status) => Response.json({ ok: false, error }, { status });
const accessSession = () => Response.json({
  ok: true, auth_mode: 'cloudflare_access', access: 'operator', node_origin: 'https://node.example.invalid',
  installer: { bootstrap: { url: 'https://node.example.invalid/bootstrap/synthetic.sh', sha256: 'a'.repeat(64) } },
});
const nodeSnapshot = () => Response.json({
  ok: true, nodes: [{ node_uid: 'node-test', label: 'Test node', presence: 'ONLINE' }], received_at: null,
});

function openPanel(respond) {
  const elements = new Map(), requests = [], listeners = new Map(), timers = new Map();
  let nextTimer = 0, reloads = 0;
  function element() {
    return {
      value: '', hidden: false, textContent: '', children: [], listeners: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    };
  }
  const get = id => {
    if (!elements.has(id)) {
      const match = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`));
      assert.ok(match, `Missing HTML element ${id}`);
      elements.set(id, Object.assign(element(), { hidden: /\bhidden\b/.test(match[0]) }));
    }
    return elements.get(id);
  };
  const window = {
    location: { reload: () => { reloads++; } },
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  runInNewContext(source, {
    document: { getElementById: get, createElement: element, documentElement: { dataset: {} } },
    window, AbortController, AbortSignal, FIRST_USE, classifyFirstUseResponse,
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    async fetch(path, init) { requests.push({ path, ...init }); return respond(path, init); },
  });
  return { get, requests, listeners, timers, reloadCount: () => reloads };
}

test('an existing Access session opens the fleet and polls without Authorization', async () => {
  const panel = openPanel(path => path === '/v0/access' ? accessSession() : nodeSnapshot());
  assert.equal(panel.get('login-form').hidden, true);
  await settled();
  assert.equal(panel.get('fleet-card').hidden, false);
  assert.equal(panel.get('login-card').hidden, true);
  assert.equal(panel.get('create-ticket').disabled, false);
  assert.deepEqual(panel.requests.map(r => r.path), ['/v0/access', '/v0/nodes']);
  for (const request of panel.requests) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers['x-requested-with'], 'XMLHttpRequest');
  }
  assert.equal([...panel.timers.values()][0].delay, 30000);
  panel.get('disconnect').listeners.click();
  assert.equal(panel.get('fleet-card').hidden, true);
  assert.equal(panel.get('login-form').hidden, true);
  assert.equal(panel.get('reconnect').hidden, false);
  assert.equal(panel.timers.size, 0);
  panel.get('reconnect').listeners.click();
  assert.equal(panel.reloadCount(), 1);
});

test('Access setup, denial, and edge session errors never show an application token form', async () => {
  for (const [response, message, canReopen] of [
    [deny('ACCESS_SESSION_REQUIRED', 401), /会话不可用/, true],
    [deny('ACCESS_IDENTITY_DENIED', 403), /没有面板权限/, false],
    [deny('ACCESS_AUTH_NOT_CONFIGURED', 503), /尚未配置完成/, false],
    [new Response('<html></html>', { status: 401, headers: { 'content-type': 'text/html' } }), /会话不可用/, true],
    [{ type: 'opaqueredirect', status: 0, headers: new Headers() }, /会话不可用/, true],
  ]) {
    const panel = openPanel(() => response);
    await settled();
    assert.equal(panel.get('login-form').hidden, true);
    assert.equal(panel.get('credential-help').hidden, true);
    assert.equal(panel.get('fleet-card').hidden, true);
    assert.equal(panel.get('reconnect').hidden, !canReopen);
    assert.match(panel.get('first-use').textContent, message);
    assert.deepEqual(panel.requests.map(r => r.path), ['/v0/access']);
  }
});

test('no token is sent before the legacy Bearer endpoint requests one', async () => {
  const credential = 'synthetic-operator-token'.padEnd(32, '0');
  const panel = openPanel((path, request) => {
    if (path !== '/v0/access') return nodeSnapshot();
    return request.headers.authorization === `Bearer ${credential}`
      ? Response.json({ ok: true, access: 'read_only', installer: null })
      : deny('UNAUTHORIZED', 401);
  });
  await settled();
  assert.equal(panel.requests[0].headers.authorization, undefined);
  assert.equal(panel.get('login-form').hidden, false);
  panel.get('token').value = credential;
  await panel.get('login-form').listeners.submit({ preventDefault() {} });
  assert.deepEqual(panel.requests.slice(1).map(r => r.headers.authorization), [`Bearer ${credential}`, `Bearer ${credential}`]);
  assert.equal(panel.get('token').value, '');
  assert.equal(panel.get('fleet-card').hidden, false);
  assert.equal(panel.get('create-ticket').disabled, true);
  panel.get('disconnect').listeners.click();
  assert.equal(panel.get('login-form').hidden, false);
});

test('session expiry during a node write closes the panel without retrying the write', async () => {
  const panel = openPanel((path, request) => {
    if (path === '/v0/access') return accessSession();
    return request.method === 'POST' ? deny('ACCESS_SESSION_REQUIRED', 401) : nodeSnapshot();
  });
  await settled();
  panel.get('enroll-form').listeners.submit({ preventDefault() {} });
  await settled();
  assert.equal(panel.get('fleet-card').hidden, true);
  assert.equal(panel.get('delivery').hidden, true);
  assert.equal(panel.get('login-form').hidden, true);
  assert.equal(panel.get('reconnect').hidden, false);
  assert.equal(panel.timers.size, 0);
  assert.match(panel.get('feedback').textContent, /操作结果不确定/);
  assert.deepEqual(panel.requests.map(r => [r.path, r.method]), [
    ['/v0/access', 'GET'], ['/v0/nodes', 'GET'], ['/v0/enrollment-tickets', 'POST'],
  ]);
});

for (const [name, rejection] of [
  ['session expiry', () => deny('ACCESS_SESSION_REQUIRED', 401)],
  ['Cloudflare HTML policy denial', () => new Response('<h1>Forbidden</h1>', {
    status: 403, headers: { 'content-type': 'text/html' },
  })],
]) test(name + ' on refresh clears previously displayed enrollment materials', async () => {
  let rejected = false;
  const panel = openPanel((path, request) => {
    if (path === '/v0/access') return accessSession();
    if (request.method === 'POST') return Response.json({
      ok: true, ticket: { ticket_id: 'ticket-test', node_uid: 'node-test', expires_at: null }, short_code: '12345678',
    });
    return rejected ? rejection() : nodeSnapshot();
  });
  await settled();
  panel.get('enroll-form').listeners.submit({ preventDefault() {} });
  await settled();
  assert.equal(panel.get('delivery').hidden, false);
  assert.equal(panel.get('short-code').textContent, '12345678');
  rejected = true;
  await panel.get('refresh').listeners.click();
  assert.equal(panel.get('fleet-card').hidden, true);
  assert.equal(panel.get('delivery').hidden, true);
  assert.equal(panel.get('short-code').textContent, '');
  assert.equal(panel.get('command').textContent, '');
  assert.equal(panel.timers.size, 0);
});

test('pagehide invalidates a delayed Access probe and a restored page rechecks the session', async () => {
  let finishFirstProbe;
  const pending = new Promise(resolve => { finishFirstProbe = resolve; });
  let probes = 0;
  const panel = openPanel(path => {
    if (path === '/v0/nodes') return nodeSnapshot();
    return ++probes === 1 ? pending : accessSession();
  });
  panel.listeners.get('pagehide')();
  assert.equal(panel.requests[0].signal.aborted, true);
  finishFirstProbe(accessSession());
  await settled();
  assert.equal(panel.get('fleet-card').hidden, true);
  assert.deepEqual(panel.requests.map(r => r.path), ['/v0/access']);
  panel.listeners.get('pageshow')({ persisted: true });
  await settled();
  assert.equal(panel.get('fleet-card').hidden, false);
  assert.deepEqual(panel.requests.map(r => r.path), ['/v0/access', '/v0/access', '/v0/nodes']);
});
