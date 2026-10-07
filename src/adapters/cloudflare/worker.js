import { GhostFleetController } from "../../control-plane/controller.js";
import { createHttpHandler } from "../../control-plane/http.js";
import { InMemoryStore } from "../../control-plane/store.js";
import { authorizeApi, getAccessLevel } from "./auth.js";
import { handleMcpRequest } from "../../integrations/mcp-http.js";
import { BOOTSTRAP_SH } from "../../../packages/bootstrap/src/bootstrap.js";
import { createEnrollmentClaimMaterializer, createEnrollmentClaimPreparer } from "./enrollment-materializer.js";
import { createDeploymentEnrollmentTemplateCatalog } from "./deployment-templates.js";

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
      });
      if (new URL(request.url).pathname.replace(/\/+$/, "") === "/mcp") return handleMcpRequest(controller, request);
      const handler = createHttpHandler(controller);
      const response = await handler(request);
      if (request.method !== "GET" && response.status < 500) await txn.put("ghostfleet-state", store.snapshot());
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
    if (request.method === "GET" && path === "/v1/bootstrap.sh") {
      return new Response(BOOTSTRAP_SH, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path.startsWith("/v0/") || isMcp) {
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
