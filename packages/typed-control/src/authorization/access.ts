import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_POLICY_AUD?: string;
  ACCESS_OWNER_EMAIL?: string;
}
export interface AccessOwner { subject: string; email: string; }
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function accessConfigured(env: AccessEnv): boolean {
  return /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? "") &&
    /^[a-zA-Z0-9_-]{16,128}$/.test(env.ACCESS_POLICY_AUD ?? "") &&
    /^[^\s,@]+@[^\s,@]+$/.test(env.ACCESS_OWNER_EMAIL ?? "");
}
function denied(code: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: {
    "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}

/** Validate Access independently of the edge. Header presence alone is not identity. */
export async function verifyAccessOwner(
  request: Request, env: AccessEnv, testKeys?: JWTVerifyGetKey,
): Promise<AccessOwner | Response> {
  if (!accessConfigured(env)) return denied("ACCESS_SETUP_REQUIRED", 503);
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion || assertion.length > 16384) return denied("ACCESS_AUTH_REQUIRED", 401);
  try {
    const issuer = env.ACCESS_TEAM_DOMAIN!;
    let jwks = testKeys ?? keys.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
      keys.clear(); // one configured owner issuer; never an unbounded requester-controlled cache
      keys.set(issuer, jwks as ReturnType<typeof createRemoteJWKSet>);
    }
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer, audience: env.ACCESS_POLICY_AUD!, algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "iat", "sub", "email"], clockTolerance: 5,
    });
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" ||
        payload.email.toLowerCase() !== env.ACCESS_OWNER_EMAIL!.toLowerCase() ||
        (payload.type !== undefined && payload.type !== "app")) return denied("ACCESS_OWNER_REQUIRED", 403);
    return { subject: payload.sub, email: payload.email.toLowerCase() };
  } catch {
    return denied("ACCESS_AUTH_INVALID", 401); // do not echo JWTs, headers, or library internals
  }
}
