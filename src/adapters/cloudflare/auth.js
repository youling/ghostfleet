function denied(error, status) {
  return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
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

// Reference single-tenant deployment credentials, never provider/device secrets.
// Each platform integrating the provider-neutral handler must enforce its own authority boundary.
export async function authorizeApi(request, env) {
  const configured = [env.GHOSTFLEET_OPERATOR_TOKEN, env.GHOSTFLEET_READ_TOKEN].some((token) => typeof token === "string" && token.length >= 32);
  if (!configured) return denied("AUTH_NOT_CONFIGURED", 503);
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ") || authorization.length > 4096) return denied("UNAUTHORIZED", 401);
  const token = authorization.slice(7);
  if (await matches(token, env.GHOSTFLEET_OPERATOR_TOKEN)) return null;
  if (await matches(token, env.GHOSTFLEET_READ_TOKEN)) {
    return request.method === "GET" ? null : denied("READ_ONLY_CREDENTIAL", 403);
  }
  return denied("UNAUTHORIZED", 401);
}
