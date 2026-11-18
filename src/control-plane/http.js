import { authorizeApi, getAccessLevel } from '../adapters/cloudflare/auth.js';
export const MAX_BODY_BYTES = 4096;
export const json = (data, status = 200) => Response.json(data, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
} });
const deny = (error, status) => json({ ok: false, error }, status);

export async function prepare(request, env) {
  const url = new URL(request.url);
  if (url.search || url.hash) return { response: deny('INVALID_URL', 400) };
  if (!['GET', 'POST'].includes(request.method)) return { response: deny('METHOD_NOT_ALLOWED', 405) };
  let access = null;
  if (url.pathname.startsWith('/v0/')) {
    if (env.GHOSTFLEET_OPERATOR_TOKEN && env.GHOSTFLEET_OPERATOR_TOKEN === env.GHOSTFLEET_READ_TOKEN) {
      return { response: deny('AUTH_CONFIG_CONFLICT', 503) };
    }
    const denial = await authorizeApi(request, env);
    if (denial) return { response: denial };
    access = await getAccessLevel(request, env);
    const origin = request.headers.get('origin');
    if (request.method === 'POST' && origin && origin !== env.GHOSTFLEET_PANEL_ORIGIN) {
      return { response: deny('ORIGIN_DENIED', 403) };
    }
    if (request.method === 'GET' && url.pathname === '/v0/access') {
      const sha = env.GHOSTFLEET_INSTALLER_SHA256;
      const bootstrapSha = env.GHOSTFLEET_BOOTSTRAP_SHA256;
      const installerReady = typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha);
      const bootstrapReady = typeof bootstrapSha === 'string' && /^[0-9a-f]{64}$/.test(bootstrapSha);
      return { response: json({ ok: true, access, node_origin: env.GHOSTFLEET_NODE_ORIGIN,
        installer: installerReady && bootstrapReady ? {
          url: env.GHOSTFLEET_NODE_ORIGIN + '/bootstrap/' + sha + '.py', sha256: sha,
          bootstrap: { url: env.GHOSTFLEET_NODE_ORIGIN + '/bootstrap/' + bootstrapSha + '.sh', sha256: bootstrapSha },
        } : null }) };
    }
  }
  let body = {};
  if (request.method === 'POST') {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return { response: deny('UNSUPPORTED_CONTENT_TYPE', 415) };
    }
    const declared = request.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
      return { response: deny('REQUEST_BODY_TOO_LARGE', 413) };
    }
    const reader = request.body?.getReader();
    const chunks = []; let size = 0;
    try {
      if (reader) for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); return { response: deny('REQUEST_BODY_TOO_LARGE', 413) }; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { return { response: deny('INVALID_JSON', 400) }; }
  }
  return { input: { method: request.method, path: url.pathname, body, access,
    authorization: request.headers.get('authorization') ?? '' } };
}
