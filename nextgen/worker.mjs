import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import legacy, { GhostFleetState as LegacyState } from '../src/adapters/cloudflare/worker.js';
import { authorizeApi, getAccessLevel } from '../src/adapters/cloudflare/auth.js';
import { prepare, json } from '../src/control-plane/http.js';
import { apply } from './core.mjs';

const denied = (error, status) => json({ ok: false, error }, status);
const routes = new Map([
  ['GET /v2/nodes', ['panel', 'list']],
  ['POST /v2/invitations', ['panel', 'issue']],
  ['POST /v2/claim', ['node', 'claim']],
]);
const nodeOperations = new Map([
  ['evidence', ['node', 'report']], ['observation', ['observer', 'observe']],
  ['revoke', ['panel', 'revoke']], ['desired', ['panel', 'desired']],
  ['adopt', ['panel', 'adopt']],
]);
const SHA = /^[a-f0-9]{40}$/;
const panelPaths = new Set(['/', '/index.html', '/app.js', '/style.css']);

function route(request, url) {
  const fixed = routes.get(request.method + ' ' + url.pathname);
  if (fixed) return fixed;
  const entry = /^\/v2\/nodes\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (entry && request.method === 'POST' && nodeOperations.has(entry[2])) {
    return [...nodeOperations.get(entry[2]), entry[1]];
  }
  return [];
}

function validOrigin(value, local) {
  try {
    const url = new URL(value);
    return value === url.origin && (url.protocol === 'https:' ||
      (local && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch {
    return false;
  }
}

function observerAuth(token, env) {
  const expected = env.GHOSTFLEET_OBSERVER_TOKEN;
  if (typeof expected !== 'string' || expected.length < 32) return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(token), digest(expected));
}

async function identify(request, env) {
  const url = new URL(request.url);
  const [surface, operation, uid] = route(request, url);
  const panel = env.GHOSTFLEET_PANEL_ORIGIN;
  const node = env.GHOSTFLEET_NODE_ORIGIN;
  const local = env.NEXTGEN_LOCAL_TEST === '1';
  if (!validOrigin(panel, local) || !validOrigin(node, local) ||
    (panel === node && !(local && panel.startsWith('http:')))) return { error: denied('ORIGINS_NOT_CONFIGURED', 503) };
  if (!surface || url.search || url.origin !== (surface === 'node' ? node : panel)) {
    return { error: denied('NOT_FOUND', 404) };
  }
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') && auth.length <= 512 ? auth.slice(7) : '';
  let role = null;
  if (surface !== 'node') {
    const roleTokens = [env.GHOSTFLEET_OPERATOR_TOKEN, env.GHOSTFLEET_READ_TOKEN, env.GHOSTFLEET_OBSERVER_TOKEN]
      .filter((value) => typeof value === 'string' && value.length);
    if (new Set(roleTokens).size !== roleTokens.length || roleTokens.some((value) => value.length < 32 || value.length > 505)) {
      return { error: denied('AUTH_CONFIG_CONFLICT', 503) };
    }
    const from = request.headers.get('origin');
    if (from && request.method === 'POST' && from !== panel) return { error: denied('ORIGIN_DENIED', 403) };
    if (surface === 'observer') {
      if (!observerAuth(token, env)) return { error: denied('UNAUTHORIZED', 401) };
      role = 'observer';
    } else {
      const error = await authorizeApi(request, env);
      if (error) return { error };
      role = await getAccessLevel(request, env);
    }
  }
  return { operation, uid, token, role };
}

async function cancelBody(request) {
  if (!request.body?.locked) await request.body?.cancel().catch(() => {});
}

async function admitClaim(request, env, url) {
  if (env.NEXTGEN_LOCAL_TEST === '1' && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) {
    return null;
  }
  const source = request.headers.get('cf-connecting-ip');
  if (!source || !isIP(source) || !env.NEXTGEN_CLAIM_LIMIT) return denied('CLAIM_INGRESS_UNAVAILABLE', 503);
  try {
    const result = await env.NEXTGEN_CLAIM_LIMIT.limit({ key: source });
    return result.success ? null : denied('CLAIM_RATE_LIMITED', 429);
  } catch {
    return denied('CLAIM_INGRESS_UNAVAILABLE', 503);
  }
}

export class GhostFleetState extends LegacyState {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v2/')) return super.fetch(request);
    const identity = await identify(request, this.env);
    if (identity.error) {
      await cancelBody(request);
      return identity.error;
    }
    const parsed = await prepare(request, this.env);
    if (parsed.response) {
      await cancelBody(request);
      return parsed.response;
    }
    const now = Date.now();
    return this.state.storage.transaction(async (txn) => {
      const state = (await txn.get('ghostfleet-state')) ?? { nodes: {} };
      const result = apply(state, identity.operation, { ...identity, body: parsed.input.body }, now);
      if (result.dirty) await txn.put('ghostfleet-state', state);
      return json(result.body, result.status);
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (env.NEXTGEN_ASSETS && panelPaths.has(path) && ['GET', 'HEAD'].includes(request.method)) {
      if (url.origin !== env.GHOSTFLEET_PANEL_ORIGIN || url.search) return denied('NOT_FOUND', 404);
      const asset = await env.NEXTGEN_ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set('content-security-policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      headers.set('cache-control', 'no-store');
      headers.set('referrer-policy', 'no-referrer');
      headers.set('x-content-type-options', 'nosniff');
      return new Response(asset.body, { status: asset.status, headers });
    }
    if (!path.startsWith('/v2/')) return legacy.fetch(request, env);
    const identity = await identify(request, env);
    if (identity.error) {
      await cancelBody(request);
      return identity.error;
    }
    if (identity.operation === 'claim') {
      const denial = await admitClaim(request, env, url);
      if (denial) {
        await cancelBody(request);
        return denial;
      }
    }
    const parsed = await prepare(request, env);
    if (parsed.response) {
      await cancelBody(request);
      return parsed.response;
    }
    try {
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      const bounded = new Request(request.url, {
        method: request.method, headers,
        ...(request.method === 'POST' ? { body: JSON.stringify(parsed.input.body) } : {}),
      });
      const state = env.GHOSTFLEET_STATE.getByName('global');
      const response = await state.fetch(bounded);
      if (identity.operation !== 'list' || !response.ok) return response;
      const projection = await response.json();
      const binding = env.NEXTGEN_VERSION;
      return json({ ...projection, control_plane: {
        deployment_id: binding?.id ?? null,
        source_revision: SHA.test(env.NEXTGEN_SOURCE_REVISION ?? '') ? env.NEXTGEN_SOURCE_REVISION : null,
        protocols: ['ghostfleet-heartbeat/v1', 'ghostfleet-evidence/v2'],
      } });
    } catch {
      return denied('STATE_UNAVAILABLE', 503);
    }
  },
};
