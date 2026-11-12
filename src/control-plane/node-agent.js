// GhostFleet node agent protocol v0 — control-plane side.
//
// Every protocol constant, the §5.1 authentication ladder, and the task-queue
// transitions live here as pure functions: the HTTP layer only bounds and reads
// bytes, and the controller only persists the value this module returns. That
// keeps the checks in NODE_AGENT_V0.md §5 auditable in one place and keeps all
// state writes out of the request-verification path.
//
// Contract: docs/architecture/NODE_AGENT_V0.md §5 (protocol) and §10 (durability).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { publicClone } from "../core/security.js";

export const AGENT_SCHEMA = "ghostfleet-node-agent/v0";
export const TASK_SCHEMA = "ghostfleet-node-task/v0";

// §5.1 step 1: per-endpoint request body caps in bytes.
export const NODE_BODY_LIMITS = Object.freeze({
  heartbeat: 16384,
  poll: 4096,
  result: 65536,
});

// §5.1 steps 5-7: freshness, replay and rate budget.
export const NONCE_WINDOW_SECONDS = 600;
export const SENT_AT_TOLERANCE_SECONDS = 300;
export const NONCE_RING_LIMIT = 256;
export const NODE_RATE_LIMIT = Object.freeze({ requests: 120, window_seconds: 3600 });

// §5.2 task lease and lifetime limits.
export const TASK_LEASE_SECONDS = 300;
export const TASK_MAX_TTL_SECONDS = 600;
export const TASK_ATTEMPT_MAX = 3;
export const MAX_TASKS_PER_POLL = 4;
export const MAX_TASKS_PER_HEARTBEAT = 2;
export const TASK_QUEUE_LIMIT = 64;
export const TASK_RETENTION_LIMIT = 256;
export const HEARTBEAT_INTERVAL = Object.freeze({ min: 15, max: 300, default: 30 });

// §5.3 v0 vocabulary: read-only and non-privileged by construction. There is no
// generic execute operation, and no remote shell.
export const TASK_OPERATIONS = Object.freeze([
  "node.observe",
  "service.status.read",
  "capability.inspect",
  "agent.self.test",
]);
export const OBSERVE_WANTS = Object.freeze([
  "identity",
  "os",
  "uptime",
  "disk",
  "services",
  "capability",
]);
export const SERVICE_UNIT_PATTERN = /^[a-z][a-z0-9_.@-]{0,63}\.service$/;
export const MAX_SERVICE_UNITS = 8;
export const AGENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
export const NODE_UID_PATTERN = /^node-[A-Za-z0-9-]{1,80}$/;
export const CAPABILITY_DIGEST_PATTERN = /^sha256:[a-z0-9]{64}$/;
export const RESULT_DIGEST_PATTERN = /^[a-z0-9]{64}$/;
export const HEALTH_VALUES = Object.freeze(["OK", "DEGRADED", "FAILING"]);
export const TASK_STATUS = Object.freeze({
  PENDING: "PENDING",
  LEASED: "LEASED",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
});

// Nodes may authenticate while they are still provisional: admission is the
// operator's job, and the agent plane only needs a minted credential.
export const NODE_AGENT_LIFECYCLES = Object.freeze(["PROVISIONAL", "ACTIVE"]);

// §5.3: parameter keys that would turn the agent into a remote execution
// surface. Checked case-insensitively at every depth before anything is queued.
export const TASK_FORBIDDEN_PARAM_KEYS = Object.freeze([
  "command",
  "commands",
  "cmd",
  "script",
  "scripts",
  "shell",
  "sh",
  "bash",
  "args",
  "argv",
  "exec",
  "execute",
  "run",
  "spawn",
  "system",
  "subprocess",
  "pipe",
  "redirect",
  "url",
  "uri",
  "endpoint",
  "sudo",
  "privilege",
  "privileges",
  "install",
  "uninstall",
  "write",
  "delete",
  "remove",
  "env",
  "environment",
  "cwd",
  "chdir",
]);
export const PARAM_MAX_DEPTH = 3;
export const PARAM_MAX_BYTES = 4096;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BEARER_PATTERN = /^Bearer +([A-Za-z0-9._~+/=-]{16,512})$/i;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export class NodeAgentError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "NodeAgentError";
    this.code = code;
    this.status = status;
  }
}

function deny(code, status) {
  return { ok: false, code, status };
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Mints the one credential a node agent ever receives. The caller returns the
 * token to the node exactly once and persists the digest only (§5.1, §9).
 */
export function mintNodeCredential() {
  const token = randomBytes(32).toString("base64url");
  return { token, digestHex: sha256Hex(token) };
}

/** Constant-time comparison of two SHA-256 hex digests. */
export function hexDigestEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bodySizeBytes(body) {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body && typeof body.byteLength === "number") return body.byteLength;
  return 0;
}

/**
 * Reads a header from either a WHATWG Headers instance or a plain object.
 * Always returns a string or null, never an array.
 */
export function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value : null;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.join(",");
    if (value === undefined || value === null) return null;
    return String(value);
  }
  return null;
}

export function mediaTypeOf(headers) {
  const value = headerValue(headers, "content-type");
  if (typeof value !== "string") return "";
  return value.split(";")[0].trim().toLowerCase();
}

/** True when the declared Content-Length already exceeds the endpoint cap. */
export function declaredBodyTooLarge(headers, limit) {
  const declared = headerValue(headers, "content-length");
  if (typeof declared !== "string") return false;
  const bytes = Number(declared);
  return Number.isFinite(bytes) && bytes > limit;
}

/**
 * Canonical JSON: object keys sorted recursively, so a result digest is stable
 * across transports (JS object order is not a wire contract).
 */
export function canonicalJson(value) {
  const seen = new Set();
  const walk = (item) => {
    if (item === null) return "null";
    const type = typeof item;
    if (type === "string") return JSON.stringify(item);
    if (type === "number") {
      if (!Number.isFinite(item)) throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
      return JSON.stringify(item);
    }
    if (type === "boolean") return item ? "true" : "false";
    if (type === "undefined" || type === "function" || type === "symbol") {
      throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    }
    if (seen.has(item)) throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    seen.add(item);
    let encoded;
    if (Array.isArray(item)) {
      encoded = "[" + item.map((entry) => walk(entry)).join(",") + "]";
    } else {
      const keys = Object.keys(item).sort();
      encoded =
        "{" +
        keys.map((key) => JSON.stringify(key) + ":" + walk(item[key])).join(",") +
        "}";
    }
    seen.delete(item);
    return encoded;
  };
  return walk(value);
}

export function defaultAgentState() {
  return {
    credential_digest: null,
    nonces: [],
    rate: { window_start_ms: null, count: 0 },
    tasks: {},
    last_heartbeat_at: null,
    health: null,
    agent_version: null,
    capability_digest: null,
    queue_depth: null,
    drift_count: 0,
  };
}

/**
 * Repairs a persisted agent record. Old snapshots may predate the agent plane,
 * and §10 has no CAS, so every read tolerates a partial record.
 */
export function normalizeAgentState(agent) {
  const base = defaultAgentState();
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return base;
  const rate =
    agent.rate && typeof agent.rate === "object" && !Array.isArray(agent.rate) ? agent.rate : {};
  const tasks =
    agent.tasks && typeof agent.tasks === "object" && !Array.isArray(agent.tasks) ? agent.tasks : {};
  return {
    ...base,
    ...agent,
    nonces: Array.isArray(agent.nonces) ? agent.nonces : [],
    rate: { ...base.rate, ...rate },
    tasks,
  };
}

/**
 * Public projection of the agent record. It carries only operational facts:
 * the credential digest, the nonce ring, the rate window and the result digests
 * never leave the durable state (§9). core/security.js rejects any key matching
 * /credential/i, so the digest cannot be projected even by accident.
 */
export function projectAgent(agent) {
  const record = normalizeAgentState(agent);
  const pending = Object.values(record.tasks).filter(
    (task) =>
      task && task.status !== TASK_STATUS.COMPLETED && task.status !== TASK_STATUS.EXPIRED,
  ).length;
  return {
    last_heartbeat_at: record.last_heartbeat_at,
    health: record.health,
    agent_version: record.agent_version,
    capability_digest: record.capability_digest,
    queue_depth: record.queue_depth,
    drift_count: record.drift_count,
    pending_tasks: pending,
  };
}

/** Public node projection: the whole agent subtree is reduced to safe facts. */
export function projectNode(node) {
  if (!node || typeof node !== "object") return node;
  const { agent, ...rest } = node;
  return publicClone({ ...rest, agent: projectAgent(agent) });
}

export function publicTask(task) {
  if (!task || typeof task !== "object") return null;
  return {
    task_id: task.task_id,
    node_uid: task.node_uid,
    operation: task.operation,
    params: task.params,
    status: task.status,
    attempt: task.attempt,
    issued_at: task.issued_at,
    expires_at: task.expires_at,
    lease_expires_at: task.lease_expires_at ?? null,
    dispatched_at: task.dispatched_at ?? null,
    completed_at: task.completed_at ?? null,
    result_digest: task.result_digest ?? null,
    result_outcome: task.result_outcome ?? null,
  };
}

export function taskEnvelope(task) {
  return {
    schema: TASK_SCHEMA,
    task_id: task.task_id,
    node_uid: task.node_uid,
    operation: task.operation,
    params: task.params,
    issued_at: task.issued_at,
    expires_at: task.expires_at,
    attempt: task.attempt,
    lease_expires_at: task.lease_expires_at,
  };
}

function base64urlByteLength(value) {
  const normalized = value.replace(/=+$/, "");
  const remainder = normalized.length % 4;
  if (remainder === 1) return -1;
  const full = Math.floor(normalized.length / 4);
  return full * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
}

function parseSentAt(value) {
  if (typeof value !== "string" || !RFC3339_UTC_PATTERN.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function requireTaskId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) {
    throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
  }
  return value;
}

/**
 * §5.1 request verification, in the ADR's order: body cap, content-type,
 * credential, lifecycle, clock, replay, rate. Every failure is returned before
 * any state is touched; on success the caller receives a commit token (the
 * nonce plus the next rate window) that it applies together with its own write.
 */
export function verifyNodeRequest(state, input) {
  const nowMs = input?.nowMs;
  const headers = input?.headers;
  const body = input?.body;
  const node_uid = input?.node_uid;
  const limit = Number.isInteger(input?.limit) ? input.limit : NODE_BODY_LIMITS.result;

  // 1. Body cap. Cheap declared-length refusal first, then the measured size.
  if (declaredBodyTooLarge(headers, limit)) return deny("NODE_BODY_TOO_LARGE", 413);
  if (bodySizeBytes(body) > limit) return deny("NODE_BODY_TOO_LARGE", 413);

  // 2. Content type.
  if (mediaTypeOf(headers) !== "application/json") {
    return deny("UNSUPPORTED_CONTENT_TYPE", 415);
  }

  // 3. Credential digest, constant time, plus node identity agreement.
  if (!Number.isFinite(nowMs)) throw new TypeError("verifyNodeRequest requires nowMs");
  if (typeof node_uid !== "string" || !NODE_UID_PATTERN.test(node_uid)) {
    return deny("NODE_AUTH_INVALID", 401);
  }
  const claimedUid = headerValue(headers, "x-ghostfleet-node-uid");
  if (claimedUid !== null && claimedUid !== node_uid) return deny("NODE_SCOPE_MISMATCH", 403);
  const authorization = headerValue(headers, "authorization");
  const bearer = typeof authorization === "string" ? BEARER_PATTERN.exec(authorization) : null;
  if (!bearer) return deny("NODE_AUTH_INVALID", 401);

  const nodes = state && typeof state.nodes === "object" && state.nodes !== null ? state.nodes : {};
  const node = Object.hasOwn(nodes, node_uid) ? nodes[node_uid] : null;
  if (!node || typeof node !== "object") return deny("NODE_AUTH_INVALID", 401);
  const agent = normalizeAgentState(node.agent);
  const presentedDigest = sha256Hex(bearer[1]);
  if (!agent.credential_digest || !hexDigestEquals(presentedDigest, agent.credential_digest)) {
    // A credential minted for another node must be reported as a scope violation,
    // not as an ordinary bad credential. Comparison stays constant time.
    for (const [otherUid, other] of Object.entries(nodes)) {
      if (otherUid === node_uid) continue;
      const otherDigest = normalizeAgentState(other?.agent).credential_digest;
      if (otherDigest && hexDigestEquals(presentedDigest, otherDigest)) {
        return deny("NODE_SCOPE_MISMATCH", 403);
      }
    }
    return deny("NODE_AUTH_INVALID", 401);
  }

  // 4. Lifecycle admission.
  if (!NODE_AGENT_LIFECYCLES.includes(node.lifecycle)) return deny("NODE_NOT_ADMITTED", 403);

  // 5. Clock skew, then body semantics. The body cannot be interpreted before
  //    the caller is authenticated, so schema checks live behind steps 3 and 4.
  const agent_version = headerValue(headers, "x-ghostfleet-agent-version");
  if (typeof agent_version !== "string" || !AGENT_VERSION_PATTERN.test(agent_version)) {
    return deny("NODE_REQUEST_INVALID", 400);
  }
  let payload;
  if (typeof body === "string") {
    try {
      payload = JSON.parse(body);
    } catch {
      return deny("INVALID_JSON", 400);
    }
  } else if (body && typeof body === "object") {
    payload = body;
  } else {
    return deny("INVALID_JSON", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return deny("NODE_REQUEST_INVALID", 400);
  }
  if (payload.schema !== AGENT_SCHEMA) return deny("NODE_SCHEMA_UNSUPPORTED", 400);
  if (payload.node_uid !== node_uid) return deny("NODE_SCOPE_MISMATCH", 403);
  const nonce = payload.nonce;
  if (
    typeof nonce !== "string" ||
    !BASE64URL_PATTERN.test(nonce) ||
    base64urlByteLength(nonce) < 16 ||
    nonce.length > 128
  ) {
    return deny("NODE_REQUEST_INVALID", 400);
  }
  if (
    typeof payload.boot_id !== "string" ||
    payload.boot_id.length === 0 ||
    payload.boot_id.length > 128
  ) {
    return deny("NODE_REQUEST_INVALID", 400);
  }
  if (!Number.isInteger(payload.seq) || payload.seq < 0) {
    return deny("NODE_REQUEST_INVALID", 400);
  }
  const sentAtMs = parseSentAt(payload.sent_at);
  if (sentAtMs === null) return deny("NODE_REQUEST_INVALID", 400);
  if (Math.abs(nowMs - sentAtMs) > SENT_AT_TOLERANCE_SECONDS * 1000) {
    return deny("NODE_CLOCK_SKEW", 401);
  }

  // 6. Replay: a nonce is remembered for the freshness window, up to a fixed
  //    ring size per node so durable state cannot grow without bound (§10).
  const nonceWindowMs = NONCE_WINDOW_SECONDS * 1000;
  const liveNonces = agent.nonces.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      Number.isFinite(entry.at_ms) &&
      entry.at_ms > nowMs - nonceWindowMs,
  );
  if (liveNonces.some((entry) => entry.nonce === nonce)) {
    return deny("NODE_NONCE_REPLAY", 409);
  }

  // 7. Rate.
  const rateWindowMs = NODE_RATE_LIMIT.window_seconds * 1000;
  const windowStart = agent.rate.window_start_ms;
  const staleWindow =
    !Number.isFinite(windowStart) || nowMs < windowStart || nowMs - windowStart >= rateWindowMs;
  const count = staleWindow ? 0 : Number(agent.rate.count) || 0;
  if (count >= NODE_RATE_LIMIT.requests) return deny("NODE_RATE_LIMITED", 429);

  const nextNonces = [...liveNonces, { nonce, at_ms: nowMs }].slice(-NONCE_RING_LIMIT);
  return {
    ok: true,
    node,
    agent,
    agent_version,
    payload,
    commit: {
      nonces: nextNonces,
      rate: { window_start_ms: staleWindow ? nowMs : windowStart, count: count + 1 },
    },
  };
}

function scanParams(value, depth) {
  if (depth > PARAM_MAX_DEPTH) throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  if (value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) scanParams(entry, depth + 1);
    return;
  }
  const type = typeof value;
  if (type === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (TASK_FORBIDDEN_PARAM_KEYS.includes(key.toLowerCase())) {
        throw new NodeAgentError("TASK_PARAMS_FORBIDDEN", 400);
      }
      scanParams(child, depth + 1);
    }
    return;
  }
  if (type === "string") {
    if (value.length > 1024) throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    return;
  }
  if (type === "number") {
    if (!Number.isFinite(value)) throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    return;
  }
  if (type !== "boolean") throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
}

function validateObserveParams(params) {
  const want = params.want;
  if (want === undefined) return;
  const wants = Array.isArray(want) ? want : [want];
  if (wants.length === 0 || wants.length > OBSERVE_WANTS.length) {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
  for (const entry of wants) {
    if (typeof entry !== "string" || !OBSERVE_WANTS.includes(entry)) {
      throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    }
  }
}

function validateServiceReadParams(params) {
  const units = params.units;
  if (!Array.isArray(units) || units.length === 0 || units.length > MAX_SERVICE_UNITS) {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
  for (const unit of units) {
    if (typeof unit !== "string" || !SERVICE_UNIT_PATTERN.test(unit)) {
      throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    }
  }
}

function validateCapabilityInspectParams(params) {
  if (Object.keys(params).length > 0) throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
}

function validateSelfTestParams(params) {
  if (params.nonce === undefined) return;
  if (typeof params.nonce !== "string" || params.nonce.length === 0 || params.nonce.length > 128) {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
}

/**
 * Validates an operator-supplied task request (§5.2/§5.3): allowlisted
 * operation, no execution-shaped parameter keys, bounded size and depth, and a
 * lifetime that cannot exceed TASK_MAX_TTL_SECONDS.
 */
export function validateTaskInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
  }
  for (const key of Object.keys(input)) {
    if (key !== "operation" && key !== "params" && key !== "ttl_seconds") {
      throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
    }
  }
  const operation = input.operation;
  if (typeof operation !== "string" || !TASK_OPERATIONS.includes(operation)) {
    throw new NodeAgentError("TASK_OPERATION_FORBIDDEN", 400);
  }
  const params = input.params === undefined ? {} : input.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
  scanParams(params, 1);
  let serialized;
  try {
    serialized = canonicalJson(params);
  } catch {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
  if (Buffer.byteLength(serialized, "utf8") > PARAM_MAX_BYTES) {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
  if (operation === "node.observe") validateObserveParams(params);
  if (operation === "service.status.read") validateServiceReadParams(params);
  if (operation === "capability.inspect") validateCapabilityInspectParams(params);
  if (operation === "agent.self.test") validateSelfTestParams(params);
  const ttlSeconds = input.ttl_seconds === undefined ? TASK_MAX_TTL_SECONDS : input.ttl_seconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > TASK_MAX_TTL_SECONDS) {
    throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
  }
  return { operation, params, ttl_seconds: ttlSeconds };
}

function isoFromMs(millis) {
  return new Date(millis).toISOString();
}

function taskExpired(task, nowMs) {
  const expiresAt = Date.parse(task.expires_at);
  return Number.isFinite(expiresAt) && nowMs >= expiresAt;
}

function leaseActive(task, nowMs) {
  const leaseExpiresAt = Date.parse(task.lease_expires_at);
  return Number.isFinite(leaseExpiresAt) && nowMs < leaseExpiresAt;
}

function pruneCompletedTasks(tasks) {
  const entries = Object.values(tasks);
  if (entries.length <= TASK_RETENTION_LIMIT) return tasks;
  const completed = entries
    .filter((task) => task.status === TASK_STATUS.COMPLETED)
    .sort((left, right) => String(left.completed_at).localeCompare(String(right.completed_at)));
  const overflow = entries.length - TASK_RETENTION_LIMIT;
  if (overflow <= 0 || completed.length === 0) return tasks;
  const next = { ...tasks };
  for (const task of completed.slice(0, overflow)) delete next[task.task_id];
  return next;
}

/** Queues one validated task on the node's agent record (§5.2). */
export function createTask(agent, input) {
  const record = normalizeAgentState(agent);
  const nowMs = input.nowMs;
  const tasks = { ...record.tasks };
  const pending = Object.values(tasks).filter(
    (task) => task && task.status !== TASK_STATUS.COMPLETED && task.status !== TASK_STATUS.EXPIRED,
  );
  if (pending.length >= TASK_QUEUE_LIMIT) throw new NodeAgentError("TASK_QUEUE_FULL", 409);
  const taskId = requireTaskId(input.task_id);
  if (Object.hasOwn(tasks, taskId)) throw new NodeAgentError("TASK_ALREADY_EXISTS", 409);
  const task = {
    task_id: taskId,
    node_uid: input.node_uid,
    operation: input.operation,
    params: input.params,
    status: TASK_STATUS.PENDING,
    attempt: 0,
    issued_at: isoFromMs(nowMs),
    expires_at: isoFromMs(nowMs + input.ttl_seconds * 1000),
    lease_expires_at: null,
    dispatched_at: null,
    completed_at: null,
    result_digest: null,
    result_outcome: null,
  };
  tasks[taskId] = task;
  return { agent: { ...record, tasks: pruneCompletedTasks(tasks) }, task };
}

/**
 * Leases up to "limit" tasks. Expired tasks are retired and never dispatched;
 * an expired lease may be retried until TASK_ATTEMPT_MAX (§5.2).
 */
export function pollTasks(agent, input) {
  const record = normalizeAgentState(agent);
  const nowMs = input.nowMs;
  const limit = Number.isInteger(input.limit)
    ? Math.min(input.limit, MAX_TASKS_PER_POLL)
    : MAX_TASKS_PER_POLL;
  const tasks = { ...record.tasks };
  const envelopes = [];
  const ordered = Object.values(tasks).sort(
    (left, right) =>
      String(left.issued_at).localeCompare(String(right.issued_at)) ||
      String(left.task_id).localeCompare(String(right.task_id)),
  );
  for (const task of ordered) {
    if (envelopes.length >= limit) break;
    if (!task || typeof task !== "object") continue;
    if (task.status === TASK_STATUS.COMPLETED) continue;
    if (taskExpired(task, nowMs)) {
      tasks[task.task_id] = { ...task, status: TASK_STATUS.EXPIRED };
      continue;
    }
    if (task.status === TASK_STATUS.LEASED) {
      if (leaseActive(task, nowMs)) continue;
      if (task.attempt >= TASK_ATTEMPT_MAX) continue;
    }
    if (task.status !== TASK_STATUS.PENDING && task.status !== TASK_STATUS.LEASED) continue;
    const leased = {
      ...task,
      status: TASK_STATUS.LEASED,
      attempt: task.attempt + 1,
      dispatched_at: isoFromMs(nowMs),
      lease_expires_at: isoFromMs(nowMs + TASK_LEASE_SECONDS * 1000),
    };
    tasks[task.task_id] = leased;
    envelopes.push(taskEnvelope(leased));
  }
  return { agent: { ...record, tasks }, tasks: envelopes };
}

/**
 * Applies a task result. Same task and same digest is an idempotent success;
 * a different digest is a conflict and never overwrites the first result (§10).
 */
export function applyTaskResult(agent, input) {
  const record = normalizeAgentState(agent);
  const tasks = { ...record.tasks };
  const task = Object.hasOwn(tasks, input.task_id) ? tasks[input.task_id] : null;
  if (!task) throw new NodeAgentError("TASK_NOT_FOUND", 404);
  if (task.node_uid !== input.node_uid) throw new NodeAgentError("TASK_SCOPE_MISMATCH", 403);
  const digest = input.result_digest;
  if (typeof digest !== "string" || !RESULT_DIGEST_PATTERN.test(digest)) {
    throw new NodeAgentError("TASK_RESULT_INVALID", 400);
  }
  if (task.result_digest) {
    if (task.result_digest === digest) {
      return { agent: record, task, idempotent: true, result_digest: digest };
    }
    throw new NodeAgentError("TASK_RESULT_CONFLICT", 409);
  }
  const outcome =
    input.result && typeof input.result.outcome === "string" && input.result.outcome.length <= 32
      ? input.result.outcome
      : "UNKNOWN";
  const completed = {
    ...task,
    status: TASK_STATUS.COMPLETED,
    completed_at: isoFromMs(input.nowMs),
    result_digest: digest,
    result_outcome: outcome,
  };
  tasks[task.task_id] = completed;
  return { agent: { ...record, tasks }, task: completed, idempotent: false, result_digest: digest };
}

/** Folds one heartbeat reporting block into the agent record (§5.2). */
export function applyHeartbeat(agent, payload, input) {
  const record = normalizeAgentState(agent);
  const health = payload.health === undefined ? record.health : payload.health;
  if (health !== null && !HEALTH_VALUES.includes(health)) {
    throw new NodeAgentError("NODE_REQUEST_INVALID", 400);
  }
  const agentVersion = payload.agent_version === undefined ? input.agent_version : payload.agent_version;
  if (typeof agentVersion !== "string" || !AGENT_VERSION_PATTERN.test(agentVersion)) {
    throw new NodeAgentError("NODE_REQUEST_INVALID", 400);
  }
  let capabilityDigest = record.capability_digest;
  if (payload.capability_digest !== undefined) {
    const candidate = payload.capability_digest;
    if (typeof candidate !== "string" || !CAPABILITY_DIGEST_PATTERN.test(candidate)) {
      throw new NodeAgentError("NODE_REQUEST_INVALID", 400);
    }
    capabilityDigest = candidate;
  }
  let queueDepth = record.queue_depth;
  if (payload.queue_depth !== undefined) {
    const candidate = payload.queue_depth;
    if (!Number.isInteger(candidate) || candidate < 0 || candidate > 100000) {
      throw new NodeAgentError("NODE_REQUEST_INVALID", 400);
    }
    queueDepth = candidate;
  }
  let driftCount = record.drift_count;
  if (payload.drift !== undefined) {
    if (!Array.isArray(payload.drift) || payload.drift.length > 32) {
      throw new NodeAgentError("NODE_REQUEST_INVALID", 400);
    }
    driftCount = payload.drift.length;
  }
  const base = driftCount > 0 || health === "FAILING" ? HEARTBEAT_INTERVAL.min : HEARTBEAT_INTERVAL.default;
  const interval_s = Math.min(HEARTBEAT_INTERVAL.max, Math.max(HEARTBEAT_INTERVAL.min, base));
  return {
    agent: {
      ...record,
      last_heartbeat_at: isoFromMs(input.nowMs),
      health,
      agent_version: agentVersion,
      capability_digest: capabilityDigest,
      queue_depth: queueDepth,
      drift_count: driftCount,
    },
    interval_s,
  };
}
