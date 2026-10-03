import { GhostFleetController } from "../../control-plane/controller.js";
import { createHttpHandler } from "../../control-plane/http.js";
import { InMemoryStore } from "../../control-plane/store.js";
import { authorizeApi } from "./auth.js";

export class GhostFleetState {
  constructor(state) { this.state = state; }

  async fetch(request) {
    return this.state.storage.transaction(async (txn) => {
      const snapshot = (await txn.get("ghostfleet-state")) || null;
      const store = new InMemoryStore(snapshot);
      const controller = new GhostFleetController({ store });
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
    if (path.startsWith("/v0/")) {
      const denial = await authorizeApi(request, env);
      if (denial) return denial;
    }
    if (path === "/healthz" || path.startsWith("/v0/")) {
      const id = env.GHOSTFLEET_STATE.idFromName("global");
      return env.GHOSTFLEET_STATE.get(id).fetch(request);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("GhostFleet Console is not built.", { status: 404 });
  },
};
