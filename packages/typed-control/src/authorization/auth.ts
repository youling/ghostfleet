function extractBearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : null;
}

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function bearerTokenMatches(supplied: string, expected: string): Promise<boolean> {
  if (!expected || expected.length < 24 || /\s/.test(expected)) return false;
  if (!supplied || /\s/.test(supplied)) return false;
  const [left, right] = await Promise.all([sha256(supplied), sha256(expected)]);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

export async function bearerAuthorized(request: Request, expected: string): Promise<boolean> {
  const supplied = extractBearer(request);
  return supplied ? bearerTokenMatches(supplied, expected) : false;
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, error: "UNAUTHORIZED" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'Bearer realm="ghostfleet-control"',
    },
  });
}
