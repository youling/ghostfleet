import { createRemoteJWKSet, jwtVerify } from 'jose';

function denied(error, status) {
  return Response.json({ ok: false, error }, { status, headers: {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  } });
}

async function matches(value, expected) {
  if (typeof expected !== "string" || expected.length < 32) return false;
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([value, expected].map((text) => crypto.subtle.digest("SHA-256", encode.encode(text))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function bearerAccessLevel(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ") || authorization.length > 4096) return null;
  const token = authorization.slice(7);
  if (await matches(token, env.GHOSTFLEET_OPERATOR_TOKEN)) return "operator";
  if (await matches(token, env.GHOSTFLEET_READ_TOKEN)) return "read_only";
  return null;
}

let accessKeys;

async function cloudflareAccess(request, env) {
  const issuer = env.GHOSTFLEET_PANEL_ACCESS_ISSUER;
  const audience = env.GHOSTFLEET_PANEL_ACCESS_AUD;
  const owner = env.GHOSTFLEET_PANEL_ACCESS_OWNER_EMAIL;
  if (typeof issuer !== 'string' ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer) ||
      typeof audience !== 'string' || !/^[a-f0-9]{64}$/.test(audience) ||
      typeof owner !== 'string' || owner.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(owner)) {
    return denied('ACCESS_AUTH_NOT_CONFIGURED', 503);
  }
  const origin = new URL(request.url).origin;
  if (origin !== env.GHOSTFLEET_PANEL_ORIGIN || !origin.startsWith('https://')) {
    return denied('ORIGIN_DENIED', 403);
  }
  // Cookie-backed sessions can reach this Worker through Access. Require
  // the exact browser Origin for writes, even when a valid JWT is present.
  if (request.method === 'POST' && request.headers.get('origin') !== origin) {
    return denied('ORIGIN_DENIED', 403);
  }
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion || assertion.length > 16384) return denied('ACCESS_SESSION_REQUIRED', 401);
  if (accessKeys?.issuer !== issuer) {
    accessKeys = { issuer, keys: createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer)) };
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(assertion, accessKeys.keys, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['iat', 'exp', 'sub', 'email'],
    }));
  } catch {
    return denied('ACCESS_SESSION_REQUIRED', 401);
  }
  if (typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 30 ||
      typeof payload.sub !== 'string' || !payload.sub ||
      typeof payload.email !== 'string' || payload.email.toLowerCase() !== owner.toLowerCase()) {
    return denied('ACCESS_IDENTITY_DENIED', 403);
  }
  return { access: 'operator', authMode: 'cloudflare_access' };
}

export async function authorizePanel(request, env) {
  const mode = env.GHOSTFLEET_PANEL_AUTH_MODE;
  if (mode === 'cloudflare_access') return cloudflareAccess(request, env);
  if (mode !== undefined && mode !== 'bearer') return denied('AUTH_NOT_CONFIGURED', 503);
  const operator = env.GHOSTFLEET_OPERATOR_TOKEN;
  const reader = env.GHOSTFLEET_READ_TOKEN;
  if (operator && operator === reader) return denied('AUTH_CONFIG_CONFLICT', 503);
  const configured = [operator, reader].some(token => typeof token === 'string' && token.length >= 32);
  if (!configured) return denied('AUTH_NOT_CONFIGURED', 503);
  const access = await bearerAccessLevel(request, env);
  if (!access) return denied('UNAUTHORIZED', 401);
  if (access === 'read_only' && request.method !== 'GET') return denied('READ_ONLY_CREDENTIAL', 403);
  const origin = request.headers.get('origin');
  if (request.method === 'POST' && origin && origin !== env.GHOSTFLEET_PANEL_ORIGIN) {
    return denied('ORIGIN_DENIED', 403);
  }
  return { access, authMode: 'bearer' };
}
