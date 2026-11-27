// The existing node_uid and ghostfleet-state remain canonical. Presence is a
// reporting projection, not a promotion to NodeLifecycle.ACTIVE or SSH access.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { revokeLegacyTickets, revokeNextgenInvitations, revokeReporting } from './enrollment.js';

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UID = new RegExp('^node-' + UUID_V4 + '$');
const TICKET = new RegExp('^ticket-' + UUID_V4 + '$');
const ATTEMPT = new RegExp('^' + UUID_V4 + '$');
const TOKEN = /^gf_hb_[A-Za-z0-9_-]{43}$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'not_found', 'unknown']);
const ROLES = ['ssh', 'cloudflared', 'tailscaled'];
export const MANAGED_PROFILE = 'FULL_MANAGED_LOWER_NODE';
const PAIR = /^[0-9a-f]{64}$/;
const SHORT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TICKET_TTL_MS = 600_000;
const MAX_PAIRING_REQUESTS = 128;
const MAX_RETAINED_MANAGED_DECISION_PINS = 4;
const validManagedPin = pin => typeof pin === 'string' && pin.length === 64 && /^[0-9a-f]{64}$/.test(pin);
const own = (o, k) => o && Object.hasOwn(o, k);
const digest = s => createHash('sha256').update(s).digest('hex');
const iso = ms => new Date(ms).toISOString();
class Rejection extends Error {
  constructor(code, status = 400, dirty = false) { super(code); this.status = status; this.dirty = dirty; }
}
function reject(code, status = 400, dirty = false) { throw new Rejection(code, status, dirty); }
function shape(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !own(value, k))) reject('INVALID_BODY');
}
function equalDigest(secret, expected) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(digest(secret), 'hex'), Buffer.from(expected, 'hex'));
}
export function presence(node, now = Date.now()) {
  const p = node.reporting;
  if (!p) return 'UNREGISTERED';
  if (p.revoked_at) return 'REVOKED';
  if (!p.last_seen_at) return 'PENDING';
  const age = now - Date.parse(p.last_seen_at);
  if (!Number.isFinite(age) || age < 0) return 'UNKNOWN';
  return age <= 180_000 ? 'ONLINE' : age <= 600_000 ? 'STALE' : 'OFFLINE';
}
export function publicNode(node, now) {
  const p = node.reporting;
  return { node_uid: node.node_uid, label: node.label ?? node.node_id ?? node.node_uid,
    lifecycle: node.lifecycle ?? 'PROVISIONAL', presence: presence(node, now),
    registered_at: p?.registered_at ?? null, revoked_at: p?.revoked_at ?? null,
    last_seen_at: p?.last_seen_at ?? null, report: p?.last_report ?? null };
}
function nodeAt(state, uid) {
  if (!UID.test(uid) || !own(state.nodes, uid)) reject('NODE_NOT_FOUND', 404);
  return state.nodes[uid];
}
function reportingAuth(state, uid, authorization) {
  // Do not expose whether a node exists to an unauthenticated sender.
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const node = UID.test(uid) && own(state.nodes, uid) ? state.nodes[uid] : null;
  if (!TOKEN.test(token) || !node?.reporting || node.reporting.revoked_at ||
      !equalDigest(token, node.reporting.digest)) reject('UNAUTHORIZED', 401);
  return node;
}
function validateReport(body) {
  shape(body, ['protocol', 'boot_id', 'reporter_version', 'services']);
  if (body.protocol !== 'ghostfleet-heartbeat/v1' ||
      !(body.boot_id === null || (typeof body.boot_id === 'string' && BOOT.test(body.boot_id))) ||
      typeof body.reporter_version !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(body.reporter_version)) reject('INVALID_HEARTBEAT');
  shape(body.services, ROLES);
  if (ROLES.some(k => !STATES.has(body.services[k]))) reject('INVALID_SERVICE_STATE');
  return structuredClone(body);
}

function ticketDelivery(ticket, shortCode) {
  return { ticket: { ticket_id: ticket.ticket_id, node_uid: ticket.node_uid, expires_at: ticket.expires_at },
    short_code: shortCode };
}

function managedDelivery(ticket, shortCode) {
  const delivery = ticketDelivery(ticket, shortCode);
  return { ...delivery, ticket: { ...delivery.ticket, profile: MANAGED_PROFILE, role: 'managed',
    bootstrap_sha256: ticket.bootstrap_sha256 } };
}

function managedEnrollment(state, node, now) {
  const ticket = state.managed_enrollment_tickets?.[node.managed_enrollment?.ticket_id];
  if (!ticket) return {};
  const status = ticket.state === 'ISSUED' && Date.parse(ticket.expires_at) <= now ? 'EXPIRED' : ticket.state;
  return { enrollment: { profile: MANAGED_PROFILE, role: 'managed', ticket_state: status, expires_at: ticket.expires_at } };
}

// Service-binding readback only. A successful reporter claim does not create
// transport, provider or execution authority.
export function readManagedPanelDecision(state, nodeUid, ticketId, bootstrapSha, retainedPins) {
  const denied = { ok: false, error: 'MANAGED_PANEL_DECISION_UNAVAILABLE' };
  if (typeof nodeUid !== 'string' || !UID.test(nodeUid) || typeof ticketId !== 'string' || !TICKET.test(ticketId) ||
      !validManagedPin(bootstrapSha)) return denied;
  const node = state.nodes?.[nodeUid];
  const ticket = state.managed_enrollment_tickets?.[ticketId];
  if (node?.managed_enrollment?.claimed_ticket_id !== ticketId || !node.reporting?.digest || node.reporting.revoked_at ||
      ticket?.node_uid !== nodeUid || ticket.state !== 'CONSUMED' || ticket.profile !== MANAGED_PROFILE ||
      !ticket.claimed_at || node.reporting?.registered_at !== ticket.claimed_at) return denied;
  const ticketPin = ticket.bootstrap_sha256;
  if (!validManagedPin(ticketPin)) return denied;
  if (ticketPin !== bootstrapSha && (!Array.isArray(retainedPins) || retainedPins.length > MAX_RETAINED_MANAGED_DECISION_PINS ||
      !retainedPins.every(validManagedPin) || !retainedPins.includes(ticketPin))) return denied;
  const issued = Date.parse(ticket.created_at), claimed = Date.parse(ticket.claimed_at), deadline = Date.parse(ticket.expires_at);
  if (!(issued <= claimed && claimed < deadline && deadline - issued === TICKET_TTL_MS)) return denied;
  const decision = { protocol: 'ghostfleet-managed-panel-decision/v1', node_uid: nodeUid, panel_ticket_id: ticketId,
    profile: MANAGED_PROFILE, role: 'managed', bootstrap_sha256: ticketPin,
    issued_at: ticket.created_at, claimed_at: ticket.claimed_at, code_expires_at: ticket.expires_at };
  return { ok: true, decision, owner_decision_digest: 'sha256:' + digest(JSON.stringify(decision)) };
}

// Synchronous mutation, called once per durable storage transaction attempt.
// There are no network/provider effects here. Responses are returned only after commit.
export function dispatch(input, state, now = Date.now()) {
  const { method, path, body, authorization = '', access = null, managedBootstrapSha = null } = input;
  const ok = (data = {}, dirty = false, status = 200) => ({ status, dirty, data: { ok: true, ...data } });
  try {
    if (path.startsWith('/v0/')) {
      if (!['operator', 'read_only'].includes(access)) reject('UNAUTHORIZED', 401);
      if (method !== 'GET' && access !== 'operator') reject('READ_ONLY_CREDENTIAL', 403);
    }
    if (method === 'GET' && path === '/v0/nodes') {
      return ok({ nodes: Object.values(state.nodes ?? {}).map(n => ({ ...publicNode(n, now),
        ...managedEnrollment(state, n, now) })), received_at: iso(now) });
    }
    if (method === 'GET' && path === '/v0/managed-enrollment-requests') {
      if (access !== 'operator') reject('READ_ONLY_CREDENTIAL', 403);
      const requests = Object.entries(state.managed_enrollment_requests ?? {})
        .filter(([, pair]) => !pair.ticket_id && Date.parse(pair.expires_at) > now)
        .map(([request_id, pair]) => ({ request_id, expires_at: pair.expires_at }));
      return ok({ requests });
    }
    if (method === 'POST' && path === '/v1/managed-enrollment/requests') {
      shape(body, ['request_id']);
      const id = body.request_id;
      if (typeof id !== 'string' || !PAIR.test(id)) reject('ENROLLMENT_REQUEST_INVALID');
      if (!managedBootstrapSha) reject('MANAGED_BOOTSTRAP_UNAVAILABLE', 503);
      const requests = state.managed_enrollment_requests ?? {};
      const previous = requests[id];
      if (previous && Date.parse(previous.expires_at) > now) return ok({ expires_at: previous.expires_at });
      const current = Object.fromEntries(Object.entries(requests).filter(([, pair]) => Date.parse(pair.expires_at) > now));
      if (Object.keys(current).length >= MAX_PAIRING_REQUESTS) reject('ENROLLMENT_REQUESTS_BUSY', 429);
      const expires_at = iso(now + TICKET_TTL_MS);
      current[id] = { expires_at };
      state.managed_enrollment_requests = current;
      return ok({ expires_at }, true, 201);
    }
    if (method === 'POST' && path === '/v0/enrollment-tickets') {
      shape(body, ['label', 'node_uid', 'attempt_id', 'profile', 'request_id'], []);
      const managed = body.profile === MANAGED_PROFILE;
      if (own(body, 'profile') && !managed) reject('INVALID_ENROLLMENT_PROFILE');
      if (managed ? typeof body.request_id !== 'string' || !PAIR.test(body.request_id) : own(body, 'request_id')) {
        reject('ENROLLMENT_REQUEST_INVALID');
      }
      if (body.node_uid !== undefined && (typeof body.node_uid !== 'string' || !UID.test(body.node_uid))) reject('INVALID_NODE_UID');
      const label = typeof body.label === 'string' ? body.label.trim() : undefined;
      const attempt = body.attempt_id;
      const deliver = managed ? managedDelivery : ticketDelivery;
      if (managed && !attempt) reject('INVALID_ENROLLMENT_ATTEMPT');
      if (own(body, 'attempt_id')) {
        if ((!managed && body.node_uid) || typeof attempt !== 'string' || !ATTEMPT.test(attempt)) {
          reject('INVALID_ENROLLMENT_ATTEMPT');
        }
        const matchesAttempt = ticket => ticket.attempt_id === attempt;
        const prior = Object.values(state.presence_tickets ?? {}).find(matchesAttempt) ??
          Object.values(state.managed_enrollment_tickets ?? {}).find(matchesAttempt);
        if (prior) {
          // The enrollment code was delivered once. A replay only recovers the original identity.
          const priorManaged = prior.profile === MANAGED_PROFILE;
          const delivery = (priorManaged ? managedDelivery : ticketDelivery)(prior, null);
          if (priorManaged !== managed || prior.attempt_label !== label || prior.attempt_node_uid !== body.node_uid ||
              prior.request_id !== body.request_id) {
            return { status: 409, dirty: false, data: {
              ok: false, error: 'ENROLLMENT_ATTEMPT_CONFLICT', ...delivery,
            } };
          }
          return ok(delivery);
        }
      }
      if (body.label !== undefined && (!label || body.label.length > 80 || /[\x00-\x1f\x7f]/.test(body.label))) reject('INVALID_LABEL');
      if (!body.node_uid && !label) reject('LABEL_REQUIRED');
      const uid = body.node_uid ?? 'node-' + randomUUID();
      const existing = body.node_uid ? nodeAt(state, uid) : null;
      if (existing?.managed_enrollment && !managed) reject('ENROLLMENT_PROFILE_CONFLICT', 409);
      if (managed && !managedBootstrapSha) reject('MANAGED_BOOTSTRAP_UNAVAILABLE', 503);
      const pairing = managed ? state.managed_enrollment_requests?.[body.request_id] : null;
      if (managed && (!pairing || pairing.ticket_id || Date.parse(pairing.expires_at) <= now)) {
        reject('ENROLLMENT_REQUEST_UNAVAILABLE', 409);
      }
      const ticketId = 'ticket-' + randomUUID();
      const code = managed ? Array.from({ length: 6 }, () => SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)]).join('')
        : String(randomInt(100_000_000)).padStart(8, '0');
      const ticket = { ticket_id: ticketId, node_uid: uid, code_digest: digest(code),
        state: 'ISSUED', created_at: iso(now), expires_at: iso(now + TICKET_TTL_MS), failed_claims: 0,
        ...(attempt ? { attempt_id: attempt, attempt_label: label } : {}),
        ...(managed ? { profile: MANAGED_PROFILE, bootstrap_sha256: managedBootstrapSha, request_id: body.request_id,
          ...(body.node_uid ? { attempt_node_uid: body.node_uid } : {}) } : {}) };
      state.nodes ??= {};
      const tickets = managed ? (state.managed_enrollment_tickets ??= {}) : (state.presence_tickets ??= {});
      revokeLegacyTickets(state, uid);
      revokeNextgenInvitations(state, uid, true);
      // A managed replacement keeps the current reporter active until claim.
      // Reporter-only replacement retains the original immediate revocation behavior.
      state.nodes[uid] = { ...(existing ?? { node_uid: uid, node_id: uid, platform: 'linux', lifecycle: 'PROVISIONAL' }),
        label: label ?? existing.label ?? existing.node_id,
        reporting: (managed && existing?.reporting) ||
          { registered_at: null, last_seen_at: null, last_report: null, digest: null, revoked_at: null,
            previous_digest: existing?.reporting?.digest ?? existing?.reporting?.previous_digest ?? null },
        ...(managed ? { managed_enrollment: { ...(existing?.managed_enrollment ?? {}), ticket_id: ticketId } } : {}) };
      tickets[ticketId] = ticket;
      if (pairing) { pairing.ticket_id = ticketId; pairing.expires_at = ticket.expires_at; }
      return ok(deliver(ticket, code), true, 201);
    }
    let match = /^\/v0\/enrollment-tickets\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && match) {
      shape(body, [], []);
      const t = TICKET.test(match[1]) && (state.managed_enrollment_tickets?.[match[1]] ?? state.presence_tickets?.[match[1]]);
      if (!t) reject('TICKET_NOT_FOUND', 404);
      if (t.state === 'CONSUMED') reject('TICKET_ALREADY_CONSUMED', 409);
      t.state = 'REVOKED'; t.code_digest = null;
      return ok({}, true);
    }
    match = /^\/v0\/nodes\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && match) {
      shape(body, [], []);
      const node = nodeAt(state, match[1]);
      if (!node.reporting) reject('NODE_NOT_REGISTERED', 409);
      revokeReporting(state, node, now);
      return ok({ node: publicNode(node, now), scope: 'reporting_only' }, true);
    }
    match = /^\/v1\/enrollment-tickets\/([^/]+)\/claim$/.exec(path);
    const managedClaim = path === '/v1/managed-enrollment/claim';
    if (method === 'POST' && (match || managedClaim)) {
      shape(body, managedClaim ? ['short_code', 'request_id', 'request_secret', 'expected_node_uid'] : ['short_code', 'expected_node_uid'],
        managedClaim ? ['short_code', 'request_id', 'request_secret'] : ['short_code']);
      if (body.expected_node_uid !== undefined &&
          (typeof body.expected_node_uid !== 'string' || !UID.test(body.expected_node_uid))) reject('INVALID_NODE_UID');
      let t;
      if (managedClaim) {
        if (typeof body.request_id !== 'string' || typeof body.request_secret !== 'string' ||
            !PAIR.test(body.request_id) || !PAIR.test(body.request_secret) ||
            !equalDigest(body.request_secret, body.request_id)) reject('ENROLLMENT_REQUEST_INVALID', 403);
        const pair = state.managed_enrollment_requests?.[body.request_id];
        t = state.managed_enrollment_tickets?.[pair?.ticket_id];
        if (t?.request_id !== body.request_id) reject('ENROLLMENT_REQUEST_UNAVAILABLE', 409);
      } else {
        t = TICKET.test(match[1]) && state.presence_tickets?.[match[1]];
      }
      if (!t) reject('TICKET_NOT_FOUND', 404);
      if (t.state !== 'ISSUED') reject('TICKET_NOT_CLAIMABLE', 409);
      if (Date.parse(t.expires_at) <= now) { t.state = 'EXPIRED'; t.code_digest = null; reject('TICKET_EXPIRED', 410, true); }
      if (managedClaim && (!managedBootstrapSha || managedBootstrapSha !== t.bootstrap_sha256)) reject('MANAGED_BOOTSTRAP_CHANGED', 409);
      const candidate = typeof body.short_code === 'string' ? body.short_code : '';
      const code = managedClaim && /^[A-Za-z0-9]{6}$/.test(candidate) ? candidate.toUpperCase() : candidate;
      const valid = managedClaim ? code.length === 6 && [...code].every(char => SHORT_CODE_ALPHABET.includes(char)) : /^[0-9]{8}$/.test(code);
      if (!valid || !equalDigest(code, t.code_digest)) {
        t.failed_claims++;
        if (t.failed_claims >= 5) { t.state = 'LOCKED'; t.code_digest = null; }
        reject('TICKET_CODE_INVALID', 403, true);
      }
      if (body.expected_node_uid && body.expected_node_uid !== t.node_uid) reject('NODE_IDENTITY_CONFLICT', 409);
      const node = nodeAt(state, t.node_uid);
      const previousDigest = node.reporting?.digest ?? node.reporting?.previous_digest ?? null;
      if (managedClaim) {
        if (node.managed_enrollment?.ticket_id !== t.ticket_id) reject('TICKET_NOT_CLAIMABLE', 409);
        node.reporting = { registered_at: null, last_seen_at: null, last_report: null, digest: null, revoked_at: null };
      } else if (node.managed_enrollment) reject('ENROLLMENT_PROFILE_CONFLICT', 409);
      const token = 'gf_hb_' + randomBytes(32).toString('base64url');
      node.reporting.digest = digest(token); node.reporting.registered_at = iso(now);
      node.reporting.generation = randomUUID(); node.reporting.previous_digest = previousDigest;
      t.state = 'CONSUMED'; t.code_digest = null;
      if (managedClaim) {
        t.claimed_at = iso(now);
        node.managed_enrollment.claimed_ticket_id = t.ticket_id;
      }
      revokeLegacyTickets(state, node.node_uid);
      revokeNextgenInvitations(state, node.node_uid, true);
      return ok({ node_uid: node.node_uid, reporting_token: token, ...(managedClaim ? { profile: MANAGED_PROFILE } : {}) }, true);
    }
    match = /^\/v1\/nodes\/([^/]+)\/heartbeat$/.exec(path);
    if (method === 'POST' && match) {
      const node = reportingAuth(state, match[1], authorization);
      const report = validateReport(body);
      node.reporting.last_report = report; node.reporting.last_seen_at = iso(now);
      return ok({ node_uid: node.node_uid, received_at: iso(now) }, true);
    }
    reject('NOT_FOUND', 404);
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    return { status: error.status, dirty: error.dirty, data: { ok: false, error: error.message } };
  }
}
