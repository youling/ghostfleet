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

export function reportingRevision(node) {
  const reporting = node.reporting;
  // A legacy rollback can replace or revoke reporting without changing its generation.
  return [reporting?.generation, reporting?.digest, reporting?.registered_at, reporting?.revoked_at,
    node.managed_enrollment?.ticket_id].join('/');
}

export function revokeLegacyTickets(state, uid) {
  for (const tickets of [state.presence_tickets, state.managed_enrollment_tickets]) {
    for (const ticket of Object.values(tickets ?? {})) {
      if (ticket.node_uid === uid && ticket.state === 'ISSUED') {
        ticket.state = 'REVOKED';
        ticket.code_digest = null;
      }
    }
  }
}

export function hasPendingLegacyTicket(state, uid, now) {
  return [state.presence_tickets, state.managed_enrollment_tickets].some(tickets =>
    Object.values(tickets ?? {}).some(ticket => ticket.node_uid === uid && ticket.state === 'ISSUED' &&
      Date.parse(ticket.expires_at) > now));
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

export function pruneExpiredInvitations(state, now) {
  let changed = false;
  for (const [key, invitation] of Object.entries(state.nextgen_invitations ?? {})) {
    if (!(invitation.expires_at > now)) {
      delete state.nextgen_invitations[key];
      changed = true;
    }
  }
  return changed;
}
