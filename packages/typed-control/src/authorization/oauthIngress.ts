/** Bounds public OAuth traffic before the provider parses bodies or fetches metadata. */
export interface OAuthIngressEnv {
  OAUTH_EDGE_BUDGET?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  OAUTH_SOURCE_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
const PATHS = new Set(["/authorize", "/oauth/token", "/oauth/register"]);
const MAX_BODY = 32768;
function denied(code: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: {
    "content-type": "application/json", "cache-control": "no-store",
    ...(status === 429 ? { "retry-after": "60" } : {}),
  } });
}
export async function guardOAuthRequest(request: Request, env: OAuthIngressEnv): Promise<Request | Response> {
  const url = new URL(request.url);
  if (!PATHS.has(url.pathname)) return request;
  if (url.search.length > 8192) return denied("OAUTH_QUERY_TOO_LARGE", 414);
  if (request.method !== "POST" && !(url.pathname === "/authorize" && request.method === "GET")) {
    return denied("METHOD_NOT_ALLOWED", 405);
  }
  if (!env.OAUTH_EDGE_BUDGET || !env.OAUTH_SOURCE_LIMIT) return denied("OAUTH_RATE_LIMIT_UNAVAILABLE", 503);
  try {
    const source = request.headers.get("cf-connecting-ip") ?? "unknown";
    const prefix = `fleet-control-oauth-v1:${url.pathname}`;
    const budget = await env.OAUTH_EDGE_BUDGET.limit({ key: prefix });
    if (!budget.success) return denied("OAUTH_RATE_LIMITED", 429);
    const burst = await env.OAUTH_SOURCE_LIMIT.limit({ key: `${prefix}:${source.slice(0,64)}` });
    if (!burst.success) return denied("OAUTH_RATE_LIMITED", 429);
  } catch { return denied("OAUTH_RATE_LIMIT_UNAVAILABLE", 503); }
  if (request.method !== "POST") return request;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY) return denied("OAUTH_BODY_TOO_LARGE", 413);
  if (!request.body) return request;
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return denied("OAUTH_BODY_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } catch { return denied("OAUTH_BODY_INVALID", 400); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part,offset); offset += part.byteLength; }
  return new Request(request, { body: bytes });
}
