import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { readManagedPanelDecision } from '../../control-plane/presence.js';
import { managedBootstrap } from '../../control-plane/http.js';
import { GhostFleetState as HttpState } from './worker.js';
export { default } from './worker.js';

// Keep the existing DO class binding and persisted snapshot; RPC has no URL.
export class GhostFleetState extends DurableObject {
  #http;

  constructor(ctx, env) {
    super(ctx, env);
    this.#http = new HttpState(ctx, env);
  }

  fetch(request) { return this.#http.fetch(request); }

  async readManagedEnrollment(nodeUid, ticketId) {
    const snapshot = (await this.ctx.storage.get('ghostfleet-state')) ?? {};
    return readManagedPanelDecision(snapshot, nodeUid, ticketId, managedBootstrap(this.env)?.sha256);
  }
}

export class ManagedPanelDecisionReader extends WorkerEntrypoint {
  async readManagedEnrollment(nodeUid, ticketId) {
    try {
      return await this.env.GHOSTFLEET_STATE.getByName('global').readManagedEnrollment(nodeUid, ticketId);
    } catch {
      return { ok: false, error: 'MANAGED_PANEL_DECISION_UNAVAILABLE' };
    }
  }
}
