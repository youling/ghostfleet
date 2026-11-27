import { createHash } from 'node:crypto';
import { authorizePanel } from '../adapters/cloudflare/auth.js';
import { MANAGED_PROFILE } from './presence.js';
export const MAX_BODY_BYTES = 4096;
const MAX_MANAGED_BOOTSTRAP_BYTES = 262144;
export const json = (data, status = 200) => Response.json(data, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
} });
const deny = (error, status) => json({ ok: false, error }, status);

export async function cancelBody(request) {
  if (!request.body?.locked) await request.body?.cancel().catch(() => {});
}

export function managedBootstrap(env) {
  const sha256 = env.GHOSTFLEET_MANAGED_BOOTSTRAP_SHA256;
  if (!env.ASSETS || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) ||
      sha256 === env.GHOSTFLEET_BOOTSTRAP_SHA256 || sha256 === env.GHOSTFLEET_INSTALLER_SHA256) return null;
  return { url: env.GHOSTFLEET_NODE_ORIGIN + '/bootstrap/' + sha256 + '.managed.sh', sha256 };
}

async function verifiedManagedBootstrap(env) {
  const bootstrap = managedBootstrap(env);
  if (!bootstrap) return null;
  try {
    const response = await env.ASSETS.fetch(new Request(bootstrap.url, { redirect: 'manual' }));
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MANAGED_BOOTSTRAP_BYTES) { await reader.cancel(); return null; }
      hash.update(value);
    }
    return bytes > 0 && hash.digest('hex') === bootstrap.sha256 ? bootstrap : null;
  } catch {
    return null;
  }
}

export async function prepare(request, env) {
  const url = new URL(request.url);
  if (url.search || url.hash) return { response: deny('INVALID_URL', 400) };
  if (!['GET', 'POST'].includes(request.method)) return { response: deny('METHOD_NOT_ALLOWED', 405) };
  let access = null;
  if (url.pathname.startsWith('/v0/')) {
    const authority = await authorizePanel(request, env);
    if (authority instanceof Response) return { response: authority };
    access = authority.access;
    if (request.method === 'GET' && url.pathname === '/v0/access') {
      const sha = env.GHOSTFLEET_INSTALLER_SHA256;
      const bootstrapSha = env.GHOSTFLEET_BOOTSTRAP_SHA256;
      const installerReady = typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha);
      const bootstrapReady = typeof bootstrapSha === 'string' && /^[0-9a-f]{64}$/.test(bootstrapSha);
      return { response: json({ ok: true, access, node_origin: env.GHOSTFLEET_NODE_ORIGIN,
        ...(authority.authMode === 'cloudflare_access' ? { auth_mode: authority.authMode } : {}),
        installer: installerReady && bootstrapReady ? {
          url: env.GHOSTFLEET_NODE_ORIGIN + '/bootstrap/' + sha + '.py', sha256: sha,
          bootstrap: { url: env.GHOSTFLEET_NODE_ORIGIN + '/bootstrap/' + bootstrapSha + '.sh', sha256: bootstrapSha },
        } : null, managed_bootstrap: await verifiedManagedBootstrap(env) }) };
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
  const managed = url.pathname === '/v0/enrollment-tickets' && body?.profile === MANAGED_PROFILE
    ? await verifiedManagedBootstrap(env) : managedBootstrap(env);
  return { input: { method: request.method, path: url.pathname, body, access,
    managedBootstrapSha: managed?.sha256 ?? null,
    authorization: request.headers.get('authorization') ?? '' } };
}
