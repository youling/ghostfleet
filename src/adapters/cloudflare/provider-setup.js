const ENROLLMENT_OPERATION_SCOPE = "auth_keys";
const VALID_TAG_RE = /^tag:[A-Za-z0-9_-]{1,63}$/;
const SCOPE_PROOF_TYPE = "tailscale-oauth-token-scope/v1";
const AUTHORITY_GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCOPE_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Only deterministic private input/credential rejections may be surfaced;
// never relay arbitrary private error text, including credential material.
const DETERMINISTIC_ERRORS = Object.freeze({
  400: new Set(["PROVIDER_SETUP_INPUT_INVALID", "PROVIDER_CLIENT_ID_INVALID", "PROVIDER_CLIENT_SECRET_INVALID"]),
  409: new Set(["PROVIDER_CREDENTIAL_REJECTED"]),
});
const unknownResult = () => ({ status: 503, payload: { ok: false, error: "PROVIDER_AUTHORITY_SETUP_UNKNOWN" } });

function validGeneration(value) {
  return typeof value === "string" && value !== "MISSING"
    && AUTHORITY_GENERATION_RE.test(value);
}

// Explicit report from the Fleet-private authority service. These fields are
// claims from a trusted service binding, NOT independent proof that Tailscale
// credentials remain valid now. The private implementation must verify scope
// against a real successful OAuth token response, never fill these from constants.
function parseGrantedScopes(value) {
  // This describes one observed access token, not the OAuth client's maximum grants.
  if (typeof value !== "string" || value.length > 1024 || value.trim() === "") return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length > 32 || parts.some((scope) => !/^[a-z][a-z0-9:_-]{1,63}$/.test(scope))) return null;
  const unique = new Set(parts);
  if (unique.size !== parts.length) return null;
  return [...unique].sort();
}

function hasVerifiedScopeClaim(authority, expectedTag = null) {
  const proof = authority?.verification;
  const timeText = proof?.verified_at;
  const time = typeof timeText === "string" ? Date.parse(timeText) : NaN;
  const validTime = Number.isFinite(time) && new Date(time).toISOString() === timeText
    && time <= Date.now() + 60_000
    && time >= Date.now() - SCOPE_PROOF_MAX_AGE_MS;
  const observed = parseGrantedScopes(authority?.scope);
  const verified = parseGrantedScopes(proof?.granted_scope);
  const tag = authority?.tag;
  return authority?.provider === "tailscale"
    && validTime
    && !!observed && !!verified && (observed.includes(ENROLLMENT_OPERATION_SCOPE) || observed.includes("all"))
    && observed.length === verified.length && observed.every((scope, i) => scope === verified[i])
    && typeof tag === "string" && VALID_TAG_RE.test(tag)
    && (expectedTag === null || tag === expectedTag)
    && proof?.type === SCOPE_PROOF_TYPE
    && proof?.status === "VERIFIED"
    && proof?.requested_tag === tag
    && validGeneration(authority?.generation);
}

export async function providerSetupSnapshot(env) {
  const service = env?.GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER;
  const enabled = env?.GHOSTFLEET_ENROLLMENT_CLAIM_READY === "1";
  const expectedTag = env?.GHOSTFLEET_ENROLL_TAG ?? null;
  const tagConfigValid = expectedTag === null || (typeof expectedTag === "string" && VALID_TAG_RE.test(expectedTag));
  let readiness = null;
  let serviceObserved = false;

  if (enabled && service && typeof service.fetch === "function") {
    try {
      const response = await service.fetch(new Request("https://service.invalid/readiness", {
        method: "GET", headers: { accept: "application/json" },
      }));
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data === "object" && !Array.isArray(data)
          && data.secrets && typeof data.secrets === "object"
          && ["PRESENT", "MISSING"].includes(data.secrets.TAILSCALE_ENROLL_OAUTH_CLIENT_ID)
          && ["PRESENT", "MISSING"].includes(data.secrets.TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET)) {
          readiness = data;
          serviceObserved = true;
        }
      }
    } catch {
      // Service outage is UNKNOWN, never a claim that no credentials exist.
    }
  }

  const clientId = readiness?.secrets?.TAILSCALE_ENROLL_OAUTH_CLIENT_ID === "PRESENT";
  const clientSecret = readiness?.secrets?.TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET === "PRESENT";
  const anyCredential = clientId || clientSecret;
  const generation = validGeneration(readiness?.authority?.generation) ? readiness.authority.generation : null;
  const ready = serviceObserved && clientId && clientSecret && !!generation && tagConfigValid
    && hasVerifiedScopeClaim(readiness?.authority, expectedTag);
  const status = !serviceObserved ? "SERVICE_UNKNOWN" : ready ? "READY"
    : anyCredential ? "CONFIGURED_UNVERIFIED" : "MISSING";
  return {
    providers: {
      tailscale: {
        provider: "tailscale",
        purpose: "enrollment_authority",
        status,
        requirements: {
          scope: ENROLLMENT_OPERATION_SCOPE,
          tag: tagConfigValid ? (expectedTag ?? readiness?.authority?.tag ?? null) : null,
        },
        granted_scope: ready ? readiness.authority.verification.granted_scope : null,
        authority_generation: generation,
        secret_state: {
          client_id: !serviceObserved ? "UNKNOWN" : clientId ? "PRESENT" : "MISSING",
          client_secret: !serviceObserved ? "UNKNOWN" : clientSecret ? "PRESENT" : "MISSING",
        },
        private_authority_service: enabled && service ? "PRESENT" : "MISSING",
      },
    },
  };
}

function privateAuthorityService(env) {
  const service = env?.GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER;
  const enabled = env?.GHOSTFLEET_ENROLLMENT_CLAIM_READY === "1";
  return enabled && service && typeof service.fetch === "function" ? service : null;
}

export function validateTailscaleSetupInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("PROVIDER_SETUP_INPUT_INVALID");
  if (Object.keys(input).some((key) => !["client_id", "client_secret"].includes(key))) throw new Error("PROVIDER_SETUP_INPUT_INVALID");
  const clientId = typeof input.client_id === "string" ? input.client_id.trim() : "";
  const clientSecret = typeof input.client_secret === "string" ? input.client_secret : "";
  if (clientId.length < 8 || clientId.length > 256 || /\s/.test(clientId)) throw new Error("PROVIDER_CLIENT_ID_INVALID");
  if (clientSecret.length < 24 || clientSecret.length > 1024 || /[\r\n]/.test(clientSecret)) throw new Error("PROVIDER_CLIENT_SECRET_INVALID");
  return { clientId, clientSecret };
}

export async function configureTailscaleProvider(env, input) {
  const service = privateAuthorityService(env);
  if (!service) return { status: 503, payload: { ok: false, error: "PROVIDER_AUTHORITY_SERVICE_UNAVAILABLE" } };
  let credentials;
  try {
    credentials = validateTailscaleSetupInput(input);
  } catch (error) {
    return { status: 400, payload: { ok: false, error: error.message } };
  }

  let response;
  try {
    response = await service.fetch(new Request("https://service.invalid/v1/provider/tailscale/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "fleet-provider-authority-setup/v1",
        provider: "tailscale",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    }));
  } catch {
    return { status: 503, payload: { ok: false, error: "PROVIDER_AUTHORITY_SETUP_UNKNOWN" } };
  }

  let data;
  try { data = await response.json(); } catch { return unknownResult(); }

  if (!response.ok) {
    // 408/5xx and unknown private replies may have followed a custody write.
    // Only explicitly defined, deterministic 4xx statuses/codes survive.
    const allowed = DETERMINISTIC_ERRORS[response.status];
    if (data?.ok !== true && allowed?.has(data?.error)) {
      return { status: response.status, payload: { ok: false, error: data.error } };
    }
    return unknownResult();
  }
  // A private write may have happened even when its response is unknown.
  const expectedTag = env?.GHOSTFLEET_ENROLL_TAG ?? null;
  if (expectedTag !== null && (typeof expectedTag !== "string" || !VALID_TAG_RE.test(expectedTag))) return unknownResult();
  if (response.status !== 200 || data?.ok !== true || data?.status !== "READY"
      || data?.provider !== "tailscale" || !validGeneration(data?.authority_generation)
      || !hasVerifiedScopeClaim({ ...data, generation: data.authority_generation }, expectedTag)) {
    return unknownResult();
  }
  return {
    status: 200,
    payload: {
      ok: true,
      provider: "tailscale",
      status: "READY",
      authority_generation: data.authority_generation,
      scope: data.scope,
      tag: data.tag,
    },
  };
}
