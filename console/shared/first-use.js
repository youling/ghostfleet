export const FIRST_USE = Object.freeze({
  CHECKING: "checkingAccess",
  UNKNOWN: "unknown",
  NOT_INITIALIZED: "missing",
  TOKEN_REQUIRED: "required",
  SESSION_REQUIRED: "accessRequired",
  IDENTITY_DENIED: "accessDenied",
  ACCESS_NOT_CONFIGURED: "accessMissing",
  DISCONNECTED: "accessDisconnected",
});

export function classifyFirstUseResponse(response, payload) {
  // Edge login responses never reveal the application's authentication mode.
  if (response?.type === "opaqueredirect" || response?.redirected) return FIRST_USE.SESSION_REQUIRED;
  const status = response?.status;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.ok !== false) {
    return FIRST_USE.UNKNOWN;
  }
  if (status === 503 && payload.error === "AUTH_NOT_CONFIGURED") return FIRST_USE.NOT_INITIALIZED;
  if (status === 401 && payload.error === "UNAUTHORIZED") return FIRST_USE.TOKEN_REQUIRED;
  if (status === 401 && payload.error === "ACCESS_SESSION_REQUIRED") return FIRST_USE.SESSION_REQUIRED;
  if (status === 403 && payload.error === "ACCESS_IDENTITY_DENIED") return FIRST_USE.IDENTITY_DENIED;
  if (status === 503 && payload.error === "ACCESS_AUTH_NOT_CONFIGURED") return FIRST_USE.ACCESS_NOT_CONFIGURED;
  return FIRST_USE.UNKNOWN;
}
