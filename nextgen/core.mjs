import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ENROLLMENT_TTL, MAX_INVITATIONS, MAX_NODES, UID, credentialGeneration,
  hasPendingLegacyTicket, pruneExpiredInvitations, reportingRevision, revokeLegacyTickets,
  revokeNextgenInvitations, revokeReporting } from '../src/control-plane/enrollment.js';
import { OBSERVATION_SOURCES, OBSERVATION_SCOPES } from '../src/control-plane/observations.js';

export { UID };
const TOKEN = /^gf_hb_[A-Za-z0-9_-]{43}$/;
const INVITE = /^gf_inv_[A-Za-z0-9_-]{43}$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CHANNEL = /^(?:canary|stable)$/;
const PLATFORM = /^debian13-(?:amd64|arm64)$/;
const VERSION = /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:~[a-z0-9.]{1,24})?(?:\+[a-z0-9.]{1,24})?$/;
const TEN_MINUTES = 600_000;
const DIMENSIONS = [...new Set(Object.values(OBSERVATION_SOURCES).flat())];
const VERDICTS = new Set(['READY', 'UNAVAILABLE', 'UNKNOWN']);
const iso = (time) => new Date(time).toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const keyed = (record, key) => record && Object.hasOwn(record, key) ? record[key] : undefined;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

function equalHash(actual, expected) {
  return matches(SHA, expected) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function response(status, body, dirty = false) {
  return { status, body: { ok: status < 300, ...body }, dirty };
}

class Rejected extends Error {
  constructor(code, status = 400, dirty = false) { super(code); this.status = status; this.dirty = dirty; }
}

function requireThat(condition, code, status) {
  if (!condition) throw new Rejected(code, status);
}

function shape(value, required, optional = []) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)), 'INVALID_BODY');
}

function artifact(value) {
  shape(value, ['version', 'source_revision', 'sha256', 'platform']);
  requireThat(matches(VERSION, value.version) && matches(COMMIT, value.source_revision) &&
    matches(SHA, value.sha256) && matches(PLATFORM, value.platform), 'INVALID_ARTIFACT');
  return value;
}

export function profile(value) {
  shape(value, ['channel', 'platform', 'config_revision', 'desired']);
  requireThat(matches(CHANNEL, value.channel) && matches(PLATFORM, value.platform) &&
    matches(SHA, value.config_revision), 'INVALID_PROFILE');
  if (value.desired !== null) {
    requireThat(artifact(value.desired).platform === value.platform, 'PLATFORM_MISMATCH');
  }
  return value;
}

function catalogNode(node, now) {
  const extension = node.nextgen;
  const reporting = node.reporting;
  const self = extension?.self;
  const currentReport = self && !reporting?.revoked_at &&
    self.credential_generation === credentialGeneration(node) ? self : null;
  const desired = extension?.profile?.desired ?? null;
  const reporters = extension?.observations ?? {};
  const health = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const observations = Object.values(reporters).filter((item) => item.dimension === dimension)
      .map((item) => ({ ...item, freshness: now <= Date.parse(item.observed_at) + TEN_MINUTES ? 'CURRENT' : 'STALE' }));
    const current = [...new Set(observations.filter((item) => item.freshness === 'CURRENT' && item.verdict !== 'UNKNOWN')
      .map((item) => item.verdict))];
    const verdict = current.length > 1 ? 'CONFLICT' : current[0] ??
      (observations.some((item) => item.freshness === 'CURRENT') || !observations.length ? 'UNKNOWN' : 'STALE');
    return [dimension, { verdict, observations }];
  }));
  const installed = currentReport?.installed ?? null;
  const runtime = currentReport?.runtime ?? null;
  const fresh = currentReport && now <= Date.parse(currentReport.received_at) + TEN_MINUTES;
  const sameArtifact = (left, right) => left && right && Object.keys(right).every((key) => left[key] === right[key]);
  const v1 = reporting?.last_report?.protocol === 'ghostfleet-heartbeat/v1' ? reporting.last_report : null;
  return {
    node_uid: node.node_uid,
    label: node.label ?? node.node_id ?? node.node_uid,
    reporting: reporting?.revoked_at ? 'REVOKED' : reporting?.digest ? 'REGISTERED' : 'PENDING',
    profile: extension?.profile ?? null,
    versions: {
      desired, installed, runtime, legacy_reporter: v1?.reporter_version ?? null,
      previous_legacy_reporter: extension?.previous_legacy_reporter ?? null,
      provenance: currentReport ? 'node-self-report' : v1 ? 'legacy-node-self-report' : null,
      received_at: currentReport?.received_at ?? reporting?.last_seen_at ?? null,
      state: !currentReport ? 'UNKNOWN' : !fresh ? 'STALE' : !desired || !installed ? 'UNKNOWN'
        : !sameArtifact(installed, desired) ? 'DIFFERENT_FROM_TARGET'
          : !sameArtifact(runtime, installed) ? 'RUNTIME_UNVERIFIED' : 'CURRENT',
    },
    health,
  };
}

function findNode(state, uid) {
  const node = matches(UID, uid) && keyed(state.nodes, uid);
  requireThat(node, 'NODE_NOT_FOUND', 404);
  return node;
}

function guardReporter(state, uid, token) {
  const node = matches(UID, uid) && keyed(state.nodes, uid);
  requireThat(matches(TOKEN, token) && node && !node.reporting?.revoked_at &&
    equalHash(hash(token), node.reporting?.digest), 'UNAUTHORIZED', 401);
  return node;
}

function issue(state, body, now) {
  shape(body, ['profile'], ['label', 'node_uid']);
  const chosenProfile = profile(body.profile);
  if (Object.hasOwn(body, 'label')) {
    requireThat(typeof body.label === 'string' && body.label.trim().length > 0 && body.label.length <= 80 &&
      !/[\x00-\x1f\x7f]/u.test(body.label), 'INVALID_LABEL');
  }
  const existing = Object.hasOwn(body, 'node_uid') ? findNode(state, body.node_uid) : null;
  const pruned = pruneExpiredInvitations(state, now);
  if (!existing && !(body.label && Object.keys(state.nodes ?? {}).length < MAX_NODES)) {
    throw new Rejected('NODE_LABEL_OR_CAPACITY', 409, pruned);
  }
  const uid = existing?.node_uid ?? 'node-' + randomUUID();
  const node = existing ?? { node_uid: uid, node_id: uid, platform: 'linux', lifecycle: 'PROVISIONAL', label: body.label.trim() };
  const retained = Object.values(state.nextgen_invitations ?? {}).filter((entry) => entry.node_uid !== uid || entry.consumed);
  if (retained.length >= MAX_INVITATIONS) throw new Rejected('INVITATION_CAPACITY', 429, pruned);
  revokeNextgenInvitations(state, uid, true);
  revokeLegacyTickets(state, uid);
  state.nextgen_invitations ??= {};
  const invitation = 'gf_inv_' + randomBytes(32).toString('base64url');
  state.nextgen_invitations[hash(invitation)] = {
    node_uid: uid, profile: chosenProfile, expires_at: now + ENROLLMENT_TTL,
    generation: credentialGeneration(node), reporting_revision: reportingRevision(node),
    label: body.label?.trim() ?? node.label ?? uid, reserved_node: !existing,
  };
  // A pending enrollment has no node record until claim.
  return response(201, { node_uid: uid, invitation, expires_at: iso(now + ENROLLMENT_TTL) }, true);
}

function claim(state, body, now) {
  shape(body, ['invitation', 'expected_node_uid', 'reporting_token', 'config_revision']);
  requireThat(matches(INVITE, body.invitation) && matches(TOKEN, body.reporting_token), 'INVALID_CLAIM');
  const ticket = keyed(state.nextgen_invitations, hash(body.invitation));
  requireThat(ticket && ticket.expires_at > now, 'INVITATION_UNAVAILABLE', 403);
  requireThat(ticket.node_uid === body.expected_node_uid &&
    ticket.profile.config_revision === body.config_revision, 'ENROLLMENT_BINDING_MISMATCH', 409);
  const prior = keyed(state.nodes, ticket.node_uid);
  const digest = hash(body.reporting_token);
  if (ticket.consumed) {
    requireThat(prior && !prior.reporting?.revoked_at && equalHash(digest, prior.reporting?.digest) &&
      equalHash(digest, ticket.consumed) &&
      (ticket.consumed_generation === undefined ? prior.reporting?.generation === undefined
        : ticket.consumed_generation === credentialGeneration(prior)), 'INVITATION_CONSUMED', 409);
    return response(200, { node_uid: ticket.node_uid, registration: 'ALREADY_APPLIED' });
  }
  const node = prior ?? {
    node_uid: ticket.node_uid, node_id: ticket.node_uid, platform: 'linux', lifecycle: 'PROVISIONAL', label: ticket.label,
  };
  requireThat((prior || ticket.reserved_node) && ticket.generation === credentialGeneration(node),
    'ENROLLMENT_BINDING_MISMATCH', 409);
  requireThat((ticket.reporting_revision === undefined || ticket.reporting_revision === reportingRevision(node)) &&
    !hasPendingLegacyTicket(state, node.node_uid, now), 'ENROLLMENT_BINDING_MISMATCH', 409);
  requireThat(prior || Object.keys(state.nodes ?? {}).length < MAX_NODES, 'NODE_CAPACITY', 409);
  const { digest: activeDigest, previous_digest: previousDigest } = node.reporting ?? {};
  const usedByEarlierClaim = Object.values(state.nextgen_invitations).some((other) =>
    other.node_uid === node.node_uid && other.expires_at > now && equalHash(digest, other.consumed));
  requireThat(!equalHash(digest, activeDigest) && !equalHash(digest, previousDigest) && !usedByEarlierClaim,
    'NEW_REPORTING_CREDENTIAL_REQUIRED', 409);
  state.nodes ??= {};
  state.nodes[node.node_uid] = node;
  node.label = ticket.label;
  const priorReport = node.reporting?.last_report;
  const previousLegacy = priorReport?.protocol === 'ghostfleet-heartbeat/v1' ? {
    version: priorReport.reporter_version,
    received_at: node.reporting.last_seen_at,
  } : node.nextgen?.previous_legacy_reporter;
  const sameBinding = node.nextgen?.profile?.config_revision === ticket.profile.config_revision;
  const observations = sameBinding ? node.nextgen?.observations : undefined;
  const generation = randomUUID();
  node.reporting = { digest, registered_at: iso(now), revoked_at: null, last_seen_at: null, last_report: null,
    generation, previous_digest: activeDigest ?? previousDigest ?? null };
  // The old reader also runs during code rollback. A credential replacement
  // must retire the old consumed decision even at the same timestamp.
  if (node.managed_enrollment) delete node.managed_enrollment.claimed_ticket_id;
  node.nextgen = { profile: ticket.profile, ...(observations ? { observations } : {}),
    ...(previousLegacy ? { previous_legacy_reporter: previousLegacy } : {}) };
  ticket.consumed = digest;
  ticket.consumed_generation = generation;
  revokeLegacyTickets(state, node.node_uid);
  return response(200, { node_uid: node.node_uid, registration: 'APPLIED' }, true);
}

function observe(node, body, now) {
  shape(body, ['source', 'dimension', 'verdict', 'observed_at'], ['version', 'scope']);
  requireThat(typeof body.source === 'string' && keyed(OBSERVATION_SOURCES, body.source)?.includes(body.dimension) &&
    VERDICTS.has(body.verdict) && (!Object.hasOwn(body, 'version') || matches(/^[a-zA-Z0-9._+~-]{1,60}$/, body.version)) &&
    (!Object.hasOwn(body, 'scope') || OBSERVATION_SCOPES.includes(body.scope)), 'INVALID_OBSERVATION');
  const time = typeof body.observed_at === 'string' ? Date.parse(body.observed_at) : NaN;
  requireThat(Number.isFinite(time) && iso(time) === body.observed_at && time <= now &&
    time >= now - TEN_MINUTES, 'OBSERVATION_OUTSIDE_WINDOW');
  node.nextgen ??= {};
  node.nextgen.observations ??= {};
  const key = `${body.source}/${body.dimension}/${body.scope ?? 'primary'}`;
  const oldKey = `${body.source}/${body.dimension}`;
  const isPrimary = !body.scope || body.scope === 'primary';
  const previous = node.nextgen.observations[key] ?? (isPrimary ? node.nextgen.observations[oldKey] : undefined);
  requireThat(!previous || time > Date.parse(previous.observed_at), 'OBSERVATION_REPLAY', 409);
  if (isPrimary) delete node.nextgen.observations[oldKey];
  node.nextgen.observations[key] = { ...body, received_at: iso(now), provenance: 'trusted-observer' };
}

function report(node, body, now) {
  shape(body, ['installed', 'runtime']);
  for (const item of [body.installed, body.runtime]) {
    if (item !== null) {
      requireThat(artifact(item).platform === node.nextgen?.profile?.platform, 'PLATFORM_MISMATCH');
    }
  }
  requireThat(node.nextgen?.profile, 'NEXTGEN_PROFILE_REQUIRED', 409);
  node.nextgen.self = { ...body, received_at: iso(now), credential_generation: credentialGeneration(node) };
}

export function apply(state, operation, { uid, token, body, role }, now = Date.now()) {
  try {
    if (operation === 'claim') return claim(state, body, now);
    if (operation === 'report') {
      const node = guardReporter(state, uid, token);
      report(node, body, now);
      return response(200, { node_uid: uid }, true);
    }
    if (operation === 'observe') {
      requireThat(role === 'observer', 'FORBIDDEN', 403);
      observe(findNode(state, uid), body, now);
      return response(200, { node_uid: uid }, true);
    }
    if (operation === 'list') {
      requireThat(['operator', 'read_only'].includes(role), 'FORBIDDEN', 403);
      return response(200, { schema: 'ghostfleet-evidence/v2', access: role,
        nodes: Object.values(state.nodes ?? {}).map((node) => catalogNode(node, now)) });
    }
    requireThat(role === 'operator', 'FORBIDDEN', 403);
    if (operation === 'issue') return issue(state, body, now);
    if (operation === 'revoke' && matches(UID, uid) && !keyed(state.nodes, uid)) {
      shape(body, []);
      requireThat(revokeNextgenInvitations(state, uid), 'NODE_NOT_FOUND', 404);
      return response(200, { node_uid: uid }, true);
    }
    const node = findNode(state, uid);
    if (operation === 'revoke') {
      shape(body, []);
      revokeReporting(state, node, now);
    } else if (operation === 'desired') {
      requireThat(node.nextgen?.profile, 'NEXTGEN_PROFILE_REQUIRED', 409);
      shape(body, ['desired']);
      node.nextgen.profile = profile({ ...node.nextgen.profile, desired: body.desired });
    } else if (operation === 'adopt') {
      shape(body, ['profile']);
      requireThat(node.reporting?.digest && !node.reporting?.revoked_at, 'ACTIVE_REPORTING_REQUIRED', 409);
      requireThat(!node.nextgen?.profile, 'PROFILE_ALREADY_BOUND', 409);
      const adopted = profile(body.profile);
      node.nextgen ??= {};
      node.nextgen.profile = adopted;
    } else {
      return response(404, { error: 'NOT_FOUND' });
    }
    return response(200, { node_uid: uid }, true);
  } catch (error) {
    if (!(error instanceof Rejected)) throw error;
    return response(error.status, { error: error.message }, error.dirty);
  }
}
