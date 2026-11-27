import { randomUUID } from 'node:crypto';

export const UID = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ENROLLMENT_TTL = 600_000;
export const MAX_NODES = 256;
export const MAX_INVITATIONS = 2 * MAX_NODES;

export function credentialGeneration(node) {
  const reporting = node.reporting;
  // Existing snapshots and v2 invitations used this fingerprint before generations were explicit.
  return reporting?.generation ??
    [reporting?.digest ?? null, reporting?.registered_at ?? null, reporting?.revoked_at ?? null].join('/');
}

export function revokeLegacyTickets(state, uid) {
  for (const ticket of Object.values(state.presence_tickets ?? {})) {
    if (ticket.node_uid === uid && ticket.state === 'ISSUED') {
      ticket.state = 'REVOKED';
      ticket.code_digest = null;
    }
  }
}

export function revokeNextgenInvitations(state, uid, pendingOnly = false) {
  let removed = false;
  for (const [key, invitation] of Object.entries(state.nextgen_invitations ?? {})) {
    if (invitation.node_uid === uid && !(pendingOnly && invitation.consumed)) {
      delete state.nextgen_invitations[key];
      removed = true;
    }
  }
  return removed;
}

export function revokeReporting(state, node, now) {
  node.reporting ??= {};
  if (!node.reporting.revoked_at) {
    node.reporting.revoked_at = new Date(now).toISOString();
    node.reporting.generation = randomUUID();
  }
  if (node.reporting.digest) node.reporting.previous_digest = node.reporting.digest;
  node.reporting.digest = null;
  revokeLegacyTickets(state, node.node_uid);
  revokeNextgenInvitations(state, node.node_uid);
}

export function pruneExpiredEnrollments(state, now) {
  let changed = false;
  for (const [key, ticket] of Object.entries(state.presence_tickets ?? {})) {
    const expiry = Date.parse(ticket.expires_at);
    if (!Number.isFinite(expiry) || expiry + ENROLLMENT_TTL <= now) {
      delete state.presence_tickets[key];
      changed = true;
    } else if (expiry <= now && ticket.state === 'ISSUED') {
      // Keep a bounded grace period for legacy claim clients that distinguish 410 from 404.
      ticket.state = 'EXPIRED';
      ticket.code_digest = null;
      changed = true;
    } else if (ticket.state !== 'ISSUED' && ticket.code_digest !== null) {
      ticket.code_digest = null;
      changed = true;
    }
  }
  for (const [key, invitation] of Object.entries(state.nextgen_invitations ?? {})) {
    if (!(invitation.expires_at > now)) {
      delete state.nextgen_invitations[key];
      changed = true;
    }
  }
  return changed;
}
