export function providerSetupSnapshot(env) {
  return {
    providers: {
      tailscale: {
        provider: "tailscale",
        purpose: "enrollment_authority",
        status: hasAuthority(env) ? "READY" : "MISSING",
        requirements: {
          scope: "auth_keys",
          tag: "tag:fleet-ssh-target",
          forbidden: ["devices", "dns", "acl", "tailnet_admin"],
        },
        authority_generation: env.TAILSCALE_ENROLL_OAUTH_GENERATION || null,
        secret_state: {
          client_id: present(env.TAILSCALE_ENROLL_OAUTH_CLIENT_ID),
          client_secret: present(env.TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET),
        },
      },
    },
  };
}

function present(value) {
  return typeof value === "string" && value.length > 0 ? "PRESENT" : "MISSING";
}

function hasAuthority(env) {
  return present(env.TAILSCALE_ENROLL_OAUTH_CLIENT_ID) === "PRESENT"
    && present(env.TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET) === "PRESENT";
}
