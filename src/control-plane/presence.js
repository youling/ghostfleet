// The existing node_uid and ghostfleet-state remain canonical. Presence is a
// reporting projection, not a promotion to NodeLifecycle.ACTIVE or SSH access.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UID = new RegExp('^node-' + UUID_V4 + '$');
const TICKET = new RegExp('^ticket-' + UUID_V4 + '$');
const ATTEMPT = new RegExp('^' + UUID_V4 + '$');
const TOKEN = /^gf_hb_[A-Za-z0-9_-]{43}$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'not_found', 'unknown']);
const ROLES = ['ssh', 'cloudflared', 'tailscaled'];
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

// Synchronous mutation, called once per durable storage transaction attempt.
// There are no network/provider effects here. Responses are returned only after commit.
export function dispatch(input, state, now = Date.now()) {
  const { method, path, body, authorization = '', access = null } = input;
  const ok = (data = {}, dirty = false, status = 200) => ({ status, dirty, data: { ok: true, ...data } });
  try {
    if (path.startsWith('/v0/')) {
      if (!['operator', 'read_only'].includes(access)) reject('UNAUTHORIZED', 401);
      if (method !== 'GET' && access !== 'operator') reject('READ_ONLY_CREDENTIAL', 403);
    }
    if (method === 'GET' && path === '/v0/nodes') {
      return ok({ nodes: Object.values(state.nodes ?? {}).map(n => publicNode(n, now)), received_at: iso(now) });
    }
    if (method === 'POST' && path === '/v0/enrollment-tickets') {
      shape(body, ['label', 'node_uid', 'attempt_id'], []);
      if (body.node_uid !== undefined && (typeof body.node_uid !== 'string' || !UID.test(body.node_uid))) reject('INVALID_NODE_UID');
      if (body.label !== undefined && (typeof body.label !== 'string' || !body.label.trim() ||
          body.label.length > 80 || /[\x00-\x1f\x7f]/.test(body.label))) reject('INVALID_LABEL');
      if (!body.node_uid && !body.label) reject('LABEL_REQUIRED');
      const label = body.label?.trim();
      const attempt = body.attempt_id;
      if (own(body, 'attempt_id')) {
        if (body.node_uid || typeof attempt !== 'string' || !ATTEMPT.test(attempt)) {
          reject('INVALID_ENROLLMENT_ATTEMPT');
        }
        const prior = Object.values(state.presence_tickets ?? {}).find(ticket => ticket.attempt_id === attempt);
        if (prior) {
          if (prior.attempt_label !== label) reject('ENROLLMENT_ATTEMPT_CONFLICT', 409);
          // The enrollment code was delivered once. A replay only recovers the original identity.
          return ok(ticketDelivery(prior, null));
        }
      }
      const uid = body.node_uid ?? 'node-' + randomUUID();
      const existing = body.node_uid ? nodeAt(state, uid) : null;
      const ticketId = 'ticket-' + randomUUID();
      const code = String(randomInt(100_000_000)).padStart(8, '0');
      const ticket = { ticket_id: ticketId, node_uid: uid, code_digest: digest(code),
        state: 'ISSUED', created_at: iso(now), expires_at: iso(now + 600_000), failed_claims: 0,
        ...(attempt ? { attempt_id: attempt, attempt_label: label } : {}) };
      state.nodes ??= {};
      state.presence_tickets ??= {};
      for (const t of Object.values(state.presence_tickets)) {
        if (t.node_uid === uid && t.state === 'ISSUED') t.state = 'REVOKED';
      }
      // Reissue invalidates the former reporting credential without changing SSH
      // keys, OS accounts, provider access, or the existing lifecycle/identity.
      state.nodes[uid] = { ...(existing ?? { node_uid: uid, node_id: uid, platform: 'linux', lifecycle: 'PROVISIONAL' }),
        label: label ?? existing.label ?? existing.node_id,
        reporting: { registered_at: null, last_seen_at: null, last_report: null, digest: null, revoked_at: null } };
      state.presence_tickets[ticketId] = ticket;
      return ok(ticketDelivery(ticket, code), true, 201);
    }
    let match = /^\/v0\/enrollment-tickets\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && match) {
      shape(body, [], []);
      const t = TICKET.test(match[1]) && own(state.presence_tickets, match[1]) ? state.presence_tickets[match[1]] : null;
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
      node.reporting.revoked_at ??= iso(now); node.reporting.digest = null;
      for (const t of Object.values(state.presence_tickets ?? {})) {
        if (t.node_uid === node.node_uid && t.state === 'ISSUED') { t.state = 'REVOKED'; t.code_digest = null; }
      }
      return ok({ node: publicNode(node, now), scope: 'reporting_only' }, true);
    }
    match = /^\/v1\/enrollment-tickets\/([^/]+)\/claim$/.exec(path);
    if (method === 'POST' && match) {
      shape(body, ['short_code', 'expected_node_uid'], ['short_code']);
      if (body.expected_node_uid !== undefined && (typeof body.expected_node_uid !== 'string' || !UID.test(body.expected_node_uid))) reject('INVALID_NODE_UID');
      const t = TICKET.test(match[1]) && own(state.presence_tickets, match[1]) ? state.presence_tickets[match[1]] : null;
      if (!t) reject('TICKET_NOT_FOUND', 404);
      if (t.state !== 'ISSUED') reject('TICKET_NOT_CLAIMABLE', 409);
      if (Date.parse(t.expires_at) <= now) { t.state = 'EXPIRED'; t.code_digest = null; reject('TICKET_EXPIRED', 410, true); }
      if (typeof body.short_code !== 'string' || !/^[0-9]{8}$/.test(body.short_code) || !equalDigest(body.short_code, t.code_digest)) {
        t.failed_claims++;
        if (t.failed_claims >= 5) { t.state = 'LOCKED'; t.code_digest = null; }
        reject('TICKET_CODE_INVALID', 403, true);
      }
      if (body.expected_node_uid && body.expected_node_uid !== t.node_uid) reject('NODE_IDENTITY_CONFLICT', 409);
      const node = nodeAt(state, t.node_uid);
      const token = 'gf_hb_' + randomBytes(32).toString('base64url');
      node.reporting.digest = digest(token); node.reporting.registered_at = iso(now);
      t.state = 'CONSUMED'; t.code_digest = null;
      return ok({ node_uid: node.node_uid, reporting_token: token }, true);
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
