const REQUIRED_SCOPE = "auth_keys";
const REQUIRED_TAG = "tag:fleet-ssh-target";

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
  const generation = typeof readiness?.authority?.generation === "string"
    ? readiness.authority.generation
    : null;
  const ready = enabled && clientId && clientSecret && generation && generation !== "MISSING";

  return {
    providers: {
      tailscale: {
        provider: "tailscale",
        purpose: "enrollment_authority",
        status: ready ? "READY" : "MISSING",
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

  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : "PROVIDER_AUTHORITY_SETUP_FAILED";
    return { status: response.status, payload: { ok: false, error: code } };
  }
  if (data?.status !== "READY" || data?.provider !== "tailscale" || typeof data?.authority_generation !== "string") {
    return { status: 502, payload: { ok: false, error: "PROVIDER_AUTHORITY_SETUP_INVALID" } };
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
