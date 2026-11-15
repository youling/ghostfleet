import { dispatch } from '../../control-plane/presence.js';
import { prepare, json } from '../../control-plane/http.js';

// Retain the original class, namespace name and snapshot key. Legacy nodes and
// their lifecycle fields survive; obsolete command/helper routes are not mounted.
export class GhostFleetState {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const prepared = await prepare(request, this.env);
    if (prepared.response) return prepared.response;
    return this.state.storage.transaction(async txn => {
      const snapshot = (await txn.get('ghostfleet-state')) ?? { nodes: {} };
      const result = dispatch(prepared.input, snapshot);
      if (result.dirty) await txn.put('ghostfleet-state', snapshot);
      return json(result.data, result.status);
    });
  }
}
function validOrigin(value) {
  try {
    const u = new URL(value);
    return u.origin === value && !u.username && !u.password &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)));
  } catch { return false; }
}
const denied = (error, status) => json({ ok: false, error }, status);
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const panel = env.GHOSTFLEET_PANEL_ORIGIN, node = env.GHOSTFLEET_NODE_ORIGIN;
    if (!validOrigin(panel) || !validOrigin(node) || (panel === node && !panel.startsWith('http://127.0.0.1:') && !panel.startsWith('http://[::1]:'))) {
      return denied('ORIGINS_NOT_CONFIGURED', 503);
    }
    const isPanel = u.origin === panel, isNode = u.origin === node;
    if ((!isPanel && !isNode) || u.search) return denied('NOT_FOUND', 404);
    const nodeRoute = /^\/v1\/enrollment-tickets\/ticket-[0-9a-f-]+\/claim$/.test(u.pathname) ||
      /^\/v1\/nodes\/node-[0-9a-f-]+\/heartbeat$/.test(u.pathname);
    if ((isPanel && u.pathname.startsWith('/v0/')) || (isNode && nodeRoute)) {
      if (!env.GHOSTFLEET_STATE) return denied('STORE_NOT_CONFIGURED', 503);
      try { return await env.GHOSTFLEET_STATE.get(env.GHOSTFLEET_STATE.idFromName('global')).fetch(request); }
      catch { return denied('STATE_UNAVAILABLE', 503); }
    }
    if (isNode && request.method === 'GET' && /^[0-9a-f]{64}$/.test(env.GHOSTFLEET_INSTALLER_SHA256 ?? '') &&
        u.pathname === '/bootstrap/' + env.GHOSTFLEET_INSTALLER_SHA256 + '.py') {
      if (!env.ASSETS) return denied('INSTALLER_NOT_BUILT', 503);
      return env.ASSETS.fetch(request);
    }
    // Explicit static allowlist: node ingress can never serve the panel or any
    // admin API, and arbitrary paths cannot fall through to a SPA or old routes.
    if (isPanel && ['GET', 'HEAD'].includes(request.method) &&
        ['/', '/index.html', '/app.js', '/presence.css', '/shared/console.css', '/shared/appearance.js', '/shared/first-use.js'].includes(u.pathname)) {
      if (!env.ASSETS) return denied('PANEL_NOT_BUILT', 503);
      const original = await env.ASSETS.fetch(request);
      const headers = new Headers(original.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-store');
      return new Response(original.body, { status: original.status, headers });
    }
    return denied('NOT_FOUND', 404);
  },
};
