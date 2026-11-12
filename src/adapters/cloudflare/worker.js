import { GhostFleetController } from "../../control-plane/controller.js";
import { createHttpHandler } from "../../control-plane/http.js";
import { InMemoryStore } from "../../control-plane/store.js";
import { authorizeApi, getAccessLevel } from "./auth.js";
import { handleMcpRequest } from "../../integrations/mcp-http.js";
import { createEnrollmentClaimMaterializer, createEnrollmentClaimPreparer } from "./enrollment-materializer.js";
import { createCapabilitySelectionProvider } from "../../control-plane/capability-selection.js";
import { createDeploymentEnrollmentTemplateCatalog } from "./deployment-templates.js";
import { configureTailscaleProvider, providerSetupSnapshot } from "./provider-setup.js";

export class GhostFleetState {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    return this.state.storage.transaction(async (txn) => {
      const snapshot = (await txn.get("ghostfleet-state")) || null;
      const store = new InMemoryStore(snapshot);
      const controller = new GhostFleetController({
        store,
        enrollmentTemplates: createDeploymentEnrollmentTemplateCatalog(this.env),
        enrollmentClaimPreparer: createEnrollmentClaimPreparer(this.env),
        enrollmentClaimMaterializer: createEnrollmentClaimMaterializer(this.env),
        // Deployment-owned pinned artifacts. Absent configuration keeps every
        // template claimable but the node refuses to install a privileged lane
        // it cannot verify.
        capabilitySelectionProvider: createCapabilitySelectionProvider({
          bundle_base64: typeof this.env?.GHOSTFLEET_CAPABILITY_SELECTION_B64 === "string" ? this.env.GHOSTFLEET_CAPABILITY_SELECTION_B64 : "",
        }),
        // Deployment-owned public coordinates. The asset origin serves the
        // digest-addressed bootstrap; the enrollment bridge owns the ticket URL.
        // Absent configuration keeps every ticket unclaimable rather than
        // delivering a command whose bootstrap cannot be verified.
        enrollmentDelivery: {
          assets_origin: this.env?.GHOSTFLEET_ASSETS_ORIGIN,
          bootstrap_sha256: this.env?.GHOSTFLEET_BOOTSTRAP_SHA256,
          enroll_origin: this.env?.GHOSTFLEET_ENROLL_ORIGIN,
        },
        // §5.1: the recoverable one-time node credential is sealed with a key
        // derived from the operator secret, so no new deployment secret exists.
        credentialHandoffSecret: this.env?.GHOSTFLEET_OPERATOR_TOKEN ?? null,
      });
      if (new URL(request.url).pathname.replace(/\/+$/, "") === "/mcp") return handleMcpRequest(controller, request);
      const handler = createHttpHandler(controller);
      const writes_before = store.writes;
      const response = await handler(request);
      // §10: one blob, no CAS. Rewrite it only when this request actually
      // mutated state and succeeded, so rejected node requests (401/403/409/413/
      // 415/429), rate-limited polls and idempotent replays cost no write on the
      // serialized object. A 5xx is never written back, even if it wrote first.
      const mutated = store.writes !== writes_before;
      if (mutated && response.status >= 200 && response.status < 300) {
        await txn.put("ghostfleet-state", store.snapshot());
      }
      return response;
    });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const isMcp = path.replace(/\/+$/, "") === "/mcp";
    const isEnrollmentClaim = request.method === "POST" && /^\/v1\/enrollment-tickets\/[^/]+\/claim$/.test(path);
    const isEnrollmentComplete = request.method === "POST" && path === "/v1/enroll/complete";
    // The three node agent routes carry the node credential minted at enrollment
    // completion, not the operator bearer. They are exempted by exact path so no
    // other /v0 or /mcp route loses operator authorization.
    const isNodeAgentRoute = request.method === "POST" && (
      /^\/v0\/nodes\/[^/]+\/heartbeat$/.test(path) ||
      /^\/v0\/nodes\/[^/]+\/tasks\/poll$/.test(path) ||
      /^\/v0\/nodes\/[^/]+\/tasks\/[^/]+\/result$/.test(path)
    );
    if (request.method === "GET" && path === "/v1/bootstrap.sh") {
      // Retired: this was an unpinned second entrance to the courier. The only
      // supported delivery is the Console-generated command, which pins the
      // asset origin and the bootstrap SHA-256 and verifies it before execution.
      return Response.json({
        ok: false,
        error: "BOOTSTRAP_ENTRYPOINT_RETIRED",
        remediation: "Use the Console-generated one-click command; it downloads the courier from the asset origin by SHA-256 and verifies it before execution.",
      }, { status: 410, headers: { "cache-control": "no-store" } });
    }
    if (path === "/v0/providers/setup" && request.method === "GET") {
      const denial = await authorizeApi(request, env, { readOnly: true });
      if (denial) return denial;
      return Response.json(await providerSetupSnapshot(env), { headers: { "cache-control": "no-store" } });
    }
    if (path === "/v0/providers/tailscale/setup" && request.method === "POST") {
      const denial = await authorizeApi(request, env);
      if (denial) return denial;
      const length = Number(request.headers.get("content-length") || "0");
      if (length > 4096) return Response.json({ ok: false, error: "PROVIDER_SETUP_INPUT_INVALID" }, { status: 400, headers: { "cache-control": "no-store" } });
      let body;
      try { body = await request.json(); }
      catch { return Response.json({ ok: false, error: "PROVIDER_SETUP_INPUT_INVALID" }, { status: 400, headers: { "cache-control": "no-store" } }); }
      const result = await configureTailscaleProvider(env, body);
      return Response.json(result.payload, { status: result.status, headers: { "cache-control": "no-store" } });
    }
    if ((path.startsWith("/v0/") || isMcp) && !isNodeAgentRoute) {
      const denial = await authorizeApi(request, env, { readOnly: isMcp });
      if (denial) return denial;
    }
    if (path === "/v0/access" && request.method === "GET") {
      return Response.json({ ok: true, access: await getAccessLevel(request, env) }, { headers: { "cache-control": "no-store" } });
    }
    if (path === "/healthz" || path.startsWith("/v0/") || isMcp || isEnrollmentClaim || isEnrollmentComplete) {
      const id = env.GHOSTFLEET_STATE.idFromName("global");
      return env.GHOSTFLEET_STATE.get(id).fetch(request);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("GhostFleet Console is not built.", { status: 404 });
  },
};
