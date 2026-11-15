// A one-time, anonymous *classification probe* of the existing read-only access
// endpoint. It never grants authority, configures roots, or proves edge Access.
export const FIRST_USE = Object.freeze({
  UNKNOWN: "UNKNOWN",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  TOKEN_REQUIRED: "TOKEN_REQUIRED",
});

export function classifyFirstUseResponse(response, payload) {
  // Require the exact fail-closed response shape. HTML challenge pages,
  // unexpected success, redirects and all other failures remain UNKNOWN.
  const status = response?.status;
  if (response?.type === "opaqueredirect" || response?.redirected) return FIRST_USE.UNKNOWN;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.ok !== false) {
    return FIRST_USE.UNKNOWN;
  }
  if (status === 503 && payload.error === "AUTH_NOT_CONFIGURED") return FIRST_USE.NOT_INITIALIZED;
  if (status === 401 && payload.error === "UNAUTHORIZED") return FIRST_USE.TOKEN_REQUIRED;
  return FIRST_USE.UNKNOWN;
}

export async function probeFirstUse(fetcher = fetch) {
  try {
    const response = await fetcher("/v0/access", {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return FIRST_USE.UNKNOWN;
    const payload = await response.json();
    return classifyFirstUseResponse(response, payload);
  } catch {
    // Network timeout, IdP challenge, malformed body or cross-origin errors
    // must never be confused with an uninitialized backend.
    return FIRST_USE.UNKNOWN;
  }
}
