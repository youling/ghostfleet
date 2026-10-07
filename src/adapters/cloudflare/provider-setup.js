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
