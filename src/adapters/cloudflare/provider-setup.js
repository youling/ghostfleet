const REQUIRED_SCOPE = "auth_keys";
const REQUIRED_TAG = "tag:fleet-ssh-target";
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
function hasVerifiedScopeClaim(authority) {
  const proof = authority?.verification;
  const at = proof?.verified_at;
  const time = typeof at === "string" ? Date.parse(at) : NaN;
  // The exact ISO instant prevents accepting loosely parsed or ambiguous
  // timestamps; 24h is a presentation freshness bound, not revocation proof.
  const validTime = Number.isFinite(time) && new Date(time).toISOString() === at
    && time <= Date.now() + 60_000
    && time >= Date.now() - SCOPE_PROOF_MAX_AGE_MS;
  return authority?.provider === "tailscale"
    && validTime
    && authority?.scope === REQUIRED_SCOPE
    && authority?.tag === REQUIRED_TAG
    && proof?.type === SCOPE_PROOF_TYPE
    && proof?.status === "VERIFIED"
    && proof?.granted_scope === REQUIRED_SCOPE
    && proof?.requested_tag === REQUIRED_TAG
    && validGeneration(authority?.generation);
}

export async function providerSetupSnapshot(env) {
  const service = env?.GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER;
  const enabled = env?.GHOSTFLEET_ENROLLMENT_CLAIM_READY === "1";
  let readiness = null;

  if (enabled && service && typeof service.fetch === "function") {
    try {
      const response = await service.fetch(new Request("https://service.invalid/readiness", {
        method: "GET",
        headers: { accept: "application/json" },
      }));
      if (response.ok) readiness = await response.json();
    } catch {
      readiness = null;
    }
  }

  const clientId = readiness?.secrets?.TAILSCALE_ENROLL_OAUTH_CLIENT_ID === "PRESENT";
  const clientSecret = readiness?.secrets?.TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET === "PRESENT";
  const generation = validGeneration(readiness?.authority?.generation)
    ? readiness.authority.generation
    : null;
  // Presence is not proof of valid authority. Even with a missing/bad
  // generation, existing custody must not be offered a blind overwrite.
  const configured = !!(enabled && clientId && clientSecret);
  const ready = configured && !!generation && hasVerifiedScopeClaim(readiness?.authority);

  return {
    providers: {
      tailscale: {
        provider: "tailscale",
        purpose: "enrollment_authority",
        status: ready ? "READY" : configured ? "CONFIGURED_UNVERIFIED" : "MISSING",
        requirements: {
          scope: REQUIRED_SCOPE,
          tag: REQUIRED_TAG,
          forbidden: ["devices", "dns", "acl", "tailnet_admin"],
        },
        authority_generation: generation,
        secret_state: {
          client_id: clientId ? "PRESENT" : "MISSING",
          client_secret: clientSecret ? "PRESENT" : "MISSING",
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
    if (data?.ok === false && allowed?.has(data?.error)) {
      return { status: response.status, payload: { ok: false, error: data.error } };
    }
    return unknownResult();
  }
  // An apparently successful upstream response does not prove that the
  // underlying encrypted custody write did or did not happen.
  if (data?.ok !== true || data?.status !== "READY"
      || data?.provider !== "tailscale" || !validGeneration(data?.authority_generation)
      || !hasVerifiedScopeClaim({ ...data, generation: data.authority_generation })) {
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
