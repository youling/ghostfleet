// GhostFleet node agent protocol v0 — control-plane side.
//
// Every protocol constant, the §5.1 authentication ladder, and the task-queue
// transitions live here as pure functions: the HTTP layer only bounds and reads
// bytes, and the controller only persists the value this module returns. That
// keeps the checks in NODE_AGENT_V0.md §5 auditable in one place and keeps all
// state writes out of the request-verification path.
//
// Contract: docs/architecture/NODE_AGENT_V0.md §5 (protocol) and §10 (durability).
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
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
// ADR 8085ea8 §5.1 item 7: a per-node token bucket, not a fixed window. Capacity
// 24 with one token every 10 s is ~360 requests/hour, which leaves room above the
// 30 s heartbeat cadence (2 requests per 30 s = 240/hour) for polls and results.
export const NODE_RATE_LIMIT = Object.freeze({ capacity: 24, refill_tokens: 1, refill_seconds: 10 });

// §5.2 task lease and lifetime limits.
export const TASK_LEASE_SECONDS = 300;
export const TASK_MAX_TTL_SECONDS = 600;
export const TASK_ATTEMPT_MAX = 3;
export const MAX_TASKS_PER_POLL = 4;
export const MAX_TASKS_PER_HEARTBEAT = 2;
export const TASK_QUEUE_LIMIT = 64;
// §10: terminal task history is bounded by count and by bytes. The whole control
// plane lives in one blob, so a queue that only compacts COMPLETED entries keeps
// growing forever: an expired task was never pruned.
export const TASK_RETENTION_LIMIT = 64;
export const TASK_STORAGE_BYTES_LIMIT = 64 * 1024;
export const TASK_RECORD_OVERHEAD_BYTES = 256;
// ADR 8085ea8 §5.1 item 7 also fixes the node cadence floor at 30 s. Handing a
// drifting node a 15 s interval would make it beat and poll at 480 requests/hour
// against a 360/hour bucket, so the server never goes below one beat per 30 s.
export const HEARTBEAT_INTERVAL = Object.freeze({ min: 30, max: 300, default: 30 });
// A canonical JSON walk is bounded: a deeply nested body must be refused as a
// contract error instead of overflowing the stack with an internal message.
export const CANONICAL_JSON_MAX_DEPTH = 64;

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
// na-core protocol.py TASK_ID_RE: the id becomes a URL path segment and an agent
// ledger/log key, so it only allows protocol-safe characters and at most 96 of
// them. Accepting a looser id here would only defer the refusal to the agent
// (REFUSED TASK_ENVELOPE_INVALID) after the operator already saw a 201.
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
// na-core protocol.py NONCE_RE: 16+ bytes rendered as base64url (22..64 chars).
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
export const CAPABILITY_DIGEST_PATTERN = /^sha256:[a-z0-9]{64}$/;
export const RESULT_DIGEST_PATTERN = /^[a-z0-9]{64}$/;
export const HEALTH_VALUES = Object.freeze(["OK", "DEGRADED", "FAILING"]);
export const TASK_STATUS = Object.freeze({
  PENDING: "PENDING",
  LEASED: "LEASED",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
});

// The crash-safety vocabulary of §7, byte-identical to na-core's
// protocol.py RESULT_STATUSES. The projection may only ever carry one of these
// four values: REFUSED/FAILED mean "safe to repeat", SUCCEEDED means "done",
// and UNKNOWN means "may have executed, never repeat". Any other value the node
// sends is downgraded to UNKNOWN instead of being echoed into a public
// projection a consumer might trust.
export const RESULT_STATUSES = Object.freeze(["SUCCEEDED", "REFUSED", "FAILED", "UNKNOWN"]);

// Nodes may authenticate while they are still provisional: admission is the
// operator's job, and the agent plane only needs a minted credential.
export const NODE_AGENT_LIFECYCLES = Object.freeze(["PROVISIONAL", "ACTIVE"]);

// §5.3: parameter keys that would turn the agent into a remote execution
// surface. Checked case-insensitively at every depth before anything is queued.
/**
 * The credential handoff (§5.1). The node token is sealed with AEAD so the same
 * resume capability can re-fetch it after a lost completion response, until the
 * node authenticates once. The key is derived from the operator secret, so no
 * new deployment secret exists; only the sealed copy is durable.
 */
export const CREDENTIAL_HANDOFF_TTL_SECONDS = 86400;
export const CREDENTIAL_HANDOFF_MAX_DELIVERIES = 20;

// Pinned constants: §5.1 names the info string and no salt (an absent HKDF salt
// is the empty salt), a 32-byte key, AES-256-GCM, a 12-byte IV, and the 16-byte
// tag appended to the ciphertext — both parts base64url on the record. Exported
// so tests and reviewers diff this contract instead of inferring it. Verified on
// a real workerd runtime (wrangler 4.147 dev --local, compatibility_flags
// ["nodejs_compat"]): createCipheriv/createDecipheriv/hkdfSync/timingSafeEqual
// from node:crypto behave normally, so this module keeps exactly one
// implementation and never grows a WebCrypto fallback — a second code path for
// the same secret would be its own vulnerability.
export const CREDENTIAL_HANDOFF_SALT = "";
export const CREDENTIAL_HANDOFF_INFO = "ghostfleet/node-credential-handoff/v1";
export const CREDENTIAL_HANDOFF_CIPHER = "aes-256-gcm";
export const CREDENTIAL_HANDOFF_KEY_BYTES = 32;
export const CREDENTIAL_HANDOFF_IV_BYTES = 12;
export const CREDENTIAL_HANDOFF_TAG_BYTES = 16;
// SEALED until the first authenticated request proves delivery; CONSUMED once
// the node has used the token; EXPIRED once the TTL/budget is gone.
export const CREDENTIAL_HANDOFF_STATES = Object.freeze(["SEALED", "CONSUMED", "EXPIRED"]);

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

/**
 * (boot_id, seq) is the replay uniqueness unit, not the nonce alone. Within one
 * boot a seq must strictly increase and may not jump more than SEQ_MAX_JUMP, so
 * a handful of out-of-order retries still pass. A reboot restarts at zero under
 * a fresh boot_id; a retired boot_id may never return.
 */
export const SEQ_MAX_JUMP = 64;
// A retired boot id may never return, so its history is never silently evicted:
// forgetting one would let that whole (boot_id, seq) space be replayed and would
// let a stale boot take the active slot. At capacity the new boot is refused with
// NODE_BOOT_ID_CAPACITY_REACHED instead; the active boot keeps working and an
// operator credential rotation clears the history.
export const BOOT_ID_HISTORY_LIMIT = 64;
export const BOOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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

function deny(code, status, extra = {}) {
  return { ok: false, code, status, ...extra };
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
export function canonicalJson(value, depthExceededCode = "TASK_PARAMS_INVALID") {
  const seen = new Set();
  const walk = (item, depth) => {
    if (depth > CANONICAL_JSON_MAX_DEPTH) throw new NodeAgentError(depthExceededCode, 400);
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
      encoded = "[" + item.map((entry) => walk(entry, depth + 1)).join(",") + "]";
    } else {
      const keys = Object.keys(item).sort();
      encoded =
        "{" +
        keys.map((key) => JSON.stringify(key) + ":" + walk(item[key], depth + 1)).join(",") +
        "}";
    }
    seen.delete(item);
    return encoded;
  };
  return walk(value, 0);
}


/**
 * Token-bucket repair. Rates are persisted as integer tokens plus the instant
 * they were last refilled; a snapshot that predates the bucket shape starts full
 * rather than locking a node out.
 */
function normalizeRateBucket(rate) {
  const capacity = NODE_RATE_LIMIT.capacity;
  if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
    return { tokens: capacity, updated_at_ms: null };
  }
  const tokens = Number.isFinite(rate.tokens) ? Math.max(0, Math.min(capacity, Math.floor(rate.tokens))) : capacity;
  const updatedAt = Number.isFinite(rate.updated_at_ms) ? rate.updated_at_ms : null;
  return { tokens, updated_at_ms: updatedAt };
}

/** Refills one token per refill window, capped at capacity. Pure. */
export function refillRateBucket(rate, nowMs) {
  const bucket = normalizeRateBucket(rate);
  const capacity = NODE_RATE_LIMIT.capacity;
  if (bucket.updated_at_ms === null || nowMs <= bucket.updated_at_ms) {
    return { tokens: bucket.tokens, updated_at_ms: bucket.updated_at_ms ?? nowMs };
  }
  const elapsedMs = nowMs - bucket.updated_at_ms;
  const refill = Math.floor(elapsedMs / (NODE_RATE_LIMIT.refill_seconds * 1000)) * NODE_RATE_LIMIT.refill_tokens;
  return { tokens: Math.min(capacity, bucket.tokens + refill), updated_at_ms: bucket.updated_at_ms };
}

/** Seconds until the next token, at least one, for the Retry-After header. */
export function rateLimitRetryAfterSeconds(rate, nowMs) {
  const bucket = refillRateBucket(rate, nowMs);
  if (bucket.updated_at_ms === null) return NODE_RATE_LIMIT.refill_seconds;
  const elapsedMs = Math.max(0, nowMs - bucket.updated_at_ms);
  const remainingMs = NODE_RATE_LIMIT.refill_seconds * 1000 - (elapsedMs % (NODE_RATE_LIMIT.refill_seconds * 1000));
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/** HKDF-SHA256 over the operator secret. No salt is named by §5.1, so none is used. */
export function deriveCredentialHandoffKey(operatorSecret) {
  if (typeof operatorSecret !== "string" || operatorSecret.length === 0) return null;
  const key = hkdfSync(
    "sha256",
    Buffer.from(operatorSecret, "utf8"),
    Buffer.from(CREDENTIAL_HANDOFF_SALT, "utf8"),
    Buffer.from(CREDENTIAL_HANDOFF_INFO, "utf8"),
    CREDENTIAL_HANDOFF_KEY_BYTES,
  );
  return Buffer.from(key);
}

function handoffAad({ node_uid, ticket_id, handoff_id }) {
  return Buffer.from(canonicalJson({ node_uid, ticket_id, handoff_id }), "utf8");
}

/**
 * Seals the one-time node token for the resume capability (§5.1). Returns null
 * when the deployment has no operator secret, in which case the token is handed
 * out exactly once and no recoverable copy exists.
 */
export function sealCredentialHandoff({ operatorSecret, token, node_uid, ticket_id, handoff_id, nowMs }) {
  const key = deriveCredentialHandoffKey(operatorSecret);
  if (!key) return null;
  if (typeof token !== "string" || token.length === 0) throw new NodeAgentError("NODE_CREDENTIAL_HANDOFF_INVALID", 500);
  const iv = randomBytes(CREDENTIAL_HANDOFF_IV_BYTES);
  const cipher = createCipheriv(CREDENTIAL_HANDOFF_CIPHER, key, iv);
  cipher.setAAD(handoffAad({ node_uid, ticket_id, handoff_id }));
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    handoff_id,
    ticket_id,
    iv: iv.toString("base64url"),
    ciphertext: sealed.toString("base64url"),
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + CREDENTIAL_HANDOFF_TTL_SECONDS * 1000).toISOString(),
    deliveries: 1,
  };
}

/**
 * Opens a sealed handoff. A record that cannot be authenticated (tampered bytes,
 * rotated operator secret, mismatched node/ticket binding) is a server-side
 * integrity failure: throw instead of returning a token.
 */
export function openCredentialHandoff({ operatorSecret, handoff, node_uid, ticket_id }) {
  const key = deriveCredentialHandoffKey(operatorSecret);
  if (!key) throw new NodeAgentError("NODE_CREDENTIAL_HANDOFF_INVALID", 500);
  if (!handoff || typeof handoff !== "object") throw new NodeAgentError("NODE_CREDENTIAL_HANDOFF_INVALID", 500);
  const sealed = Buffer.from(String(handoff.ciphertext ?? ""), "base64url");
  const iv = Buffer.from(String(handoff.iv ?? ""), "base64url");
  if (sealed.length <= CREDENTIAL_HANDOFF_TAG_BYTES || iv.length !== CREDENTIAL_HANDOFF_IV_BYTES) {
    throw new NodeAgentError("NODE_CREDENTIAL_HANDOFF_INVALID", 500);
  }
  const tag = sealed.subarray(sealed.length - CREDENTIAL_HANDOFF_TAG_BYTES);
  const body = sealed.subarray(0, sealed.length - CREDENTIAL_HANDOFF_TAG_BYTES);
  try {
    const decipher = createDecipheriv(CREDENTIAL_HANDOFF_CIPHER, key, iv);
    decipher.setAAD(handoffAad({ node_uid, ticket_id, handoff_id: handoff.handoff_id }));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new NodeAgentError("NODE_CREDENTIAL_HANDOFF_INVALID", 500);
  }
}

/** A handoff stops being usable after its TTL or its delivery budget (§5.1). */
export function credentialHandoffUsable(handoff, nowMs) {
  if (!handoff || typeof handoff !== "object") return false;
  const expiresAt = Date.parse(handoff.expires_at);
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) return false;
  // A counter that is not a non-negative integer cannot be trusted: coercing it
  // would make "7" become "71" and the delivery budget would never trip. A
  // malformed record is treated as unusable, so no token is handed out.
  if (!Number.isInteger(handoff.deliveries) || handoff.deliveries < 0) return false;
  return handoff.deliveries < CREDENTIAL_HANDOFF_MAX_DELIVERIES;
}

export function defaultAgentState() {
  return {
    credential_digest: null,
    credential_handoff: null,
    credential_handoff_state: null,
    nonces: [],
    rate: { tokens: NODE_RATE_LIMIT.capacity, updated_at_ms: null },
    tasks: {},
    last_heartbeat_at: null,
    health: null,
    agent_version: null,
    capability_digest: null,
    queue_depth: null,
    drift_count: 0,
    last_boot_id: null,
    last_seq: null,
    retired_boot_ids: [],
  };
}

/**
 * Repairs a persisted agent record. Old snapshots may predate the agent plane,
 * and §10 has no CAS, so every read tolerates a partial record.
 */
export function normalizeAgentState(agent) {
  const base = defaultAgentState();
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return base;
  const tasks =
    agent.tasks && typeof agent.tasks === "object" && !Array.isArray(agent.tasks) ? agent.tasks : {};
  return {
    ...base,
    ...agent,
    nonces: Array.isArray(agent.nonces) ? agent.nonces : [],

    tasks,
    rate: normalizeRateBucket(agent.rate),
    credential_handoff:
      agent.credential_handoff && typeof agent.credential_handoff === "object" && !Array.isArray(agent.credential_handoff)
        ? agent.credential_handoff
        : null,
    credential_handoff_state: CREDENTIAL_HANDOFF_STATES.includes(agent.credential_handoff_state)
      ? agent.credential_handoff_state
      : null,
    last_boot_id: typeof agent.last_boot_id === "string" ? agent.last_boot_id : null,
    last_seq: Number.isInteger(agent.last_seq) ? agent.last_seq : null,
    retired_boot_ids: Array.isArray(agent.retired_boot_ids)
      ? agent.retired_boot_ids.filter((entry) => typeof entry === "string").slice(-BOOT_ID_HISTORY_LIMIT)
      : [],
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
    // The public projection may only ever carry the crash-safety vocabulary. A
    // durable record written by an older build (or a hand-edited blob) must not
    // echo an unknown status a consumer might trust, so anything else reads as
    // UNKNOWN; a missing outcome still reads as null.
    result_outcome:
      task.result_outcome === null || task.result_outcome === undefined
        ? null
        : RESULT_STATUSES.includes(task.result_outcome)
          ? task.result_outcome
          : "UNKNOWN",
  };
}

/** Operator-facing task status: the params payload is never echoed back. */
export function publicTaskSummary(task) {
  const projected = publicTask(task);
  if (!projected) return null;
  const { params, ...rest } = projected;
  return rest;
}

// The exact envelope keys na-core tasks.py validate_envelope accepts (and rejects
// every other key on): schema, task_id, node_uid, operation, params, issued_at,
// expires_at, attempt, lease_expires_at. Kept as a list so a test can assert the
// emitted key set instead of relying on the two branches drifting apart.
export const TASK_ENVELOPE_FIELDS = Object.freeze([
  "schema", "task_id", "node_uid", "operation", "params",
  "issued_at", "expires_at", "attempt", "lease_expires_at",
]);

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
  if (typeof value !== "string" || !TASK_ID_PATTERN.test(value)) {
    throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
  }
  return value;
}

/**
 * The caller may hand over the whole durable state ({ nodes }) or a read-only
 * accessor pair ({ getNode, credentialDigests }). The accessor form is what the
 * controller uses: verification is on the unauthenticated hot path, so it must
 * read one record and a list of digest strings, never clone every node.
 */
function resolveNodeRecord(state, node_uid) {
  if (state && typeof state.getNode === "function") return state.getNode(node_uid);
  const nodes = state && typeof state.nodes === "object" && state.nodes !== null ? state.nodes : {};
  return Object.hasOwn(nodes, node_uid) ? nodes[node_uid] : null;
}

function credentialDigests(state) {
  if (state && typeof state.credentialDigests === "function") {
    return state.credentialDigests().filter((digest) => typeof digest === "string" && digest);
  }
  const nodes = state && typeof state.nodes === "object" && state.nodes !== null ? state.nodes : {};
  return Object.values(nodes)
    .map((node) => normalizeAgentState(node?.agent).credential_digest)
    .filter((digest) => typeof digest === "string" && digest);
}

/**
 * §5.1 request verification, in the ADR's order: body cap, content-type,
 * credential, lifecycle, clock, nonce replay, rate, then the boot/seq replay
 * extension. Every failure is returned before any state is touched; on success
 * the caller receives a commit token (the nonce plus the next rate window) that
 * it applies together with its own write.
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
  // ADR §5.1 requires all three headers. A missing uid is not a wildcard: the
  // path uid alone must never identify the caller.
  const claimedUid = headerValue(headers, "x-ghostfleet-node-uid");
  if (claimedUid === null) return deny("NODE_AUTH_INVALID", 401);
  if (claimedUid !== node_uid) return deny("NODE_SCOPE_MISMATCH", 403);
  const authorization = headerValue(headers, "authorization");
  const bearer = typeof authorization === "string" ? BEARER_PATTERN.exec(authorization) : null;
  if (!bearer) return deny("NODE_AUTH_INVALID", 401);

  const node = resolveNodeRecord(state, node_uid);
  if (!node || typeof node !== "object") return deny("NODE_AUTH_INVALID", 401);
  const agent = normalizeAgentState(node.agent);
  const presentedDigest = sha256Hex(bearer[1]);
  if (!agent.credential_digest || !hexDigestEquals(presentedDigest, agent.credential_digest)) {
    // A credential minted for another node must be reported as a scope violation,
    // not as an ordinary bad credential. Only digest strings are compared: an
    // unauthenticated request must never deep-clone the durable node map.
    for (const otherDigest of credentialDigests(state)) {
      if (otherDigest === agent.credential_digest) continue;
      if (hexDigestEquals(presentedDigest, otherDigest)) return deny("NODE_SCOPE_MISMATCH", 403);
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
  if (typeof payload.boot_id !== "string" || !BOOT_ID_PATTERN.test(payload.boot_id)) {
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

  // 6. Replay, first line: the nonce ring. §5.1 checks the nonce window before
  //    the rate budget, and it is checked before the boot/seq rule so a
  //    byte-for-byte replay reports NODE_NONCE_REPLAY, not a seq regression. The
  //    ring is bounded per node so durable state cannot grow without bound (§10).
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

  // 7. Rate, per-node token bucket (§5.1 item 7): one token per request, refilled
  //    on a fixed cadence. The refusal carries Retry-After so an agent can back off.
  const rate = refillRateBucket(agent.rate, nowMs);
  if (rate.tokens < 1) {
    return deny("NODE_RATE_LIMITED", 429, {
      retry_after_s: rateLimitRetryAfterSeconds(agent.rate, nowMs),
    });
  }

  // 8. Replay, second line: boot identity and sequence. A retried request inside
  //    one boot must move the seq forward but not race ahead; a reboot may reset
  //    the seq to zero only under a boot id that has never been retired.
  const lastBootId = agent.last_boot_id;
  const lastSeq = agent.last_seq;
  let nextRetiredBootIds = agent.retired_boot_ids;
  if (payload.boot_id === lastBootId) {
    if (Number.isInteger(lastSeq) && (payload.seq <= lastSeq || payload.seq > lastSeq + SEQ_MAX_JUMP)) {
      return deny("NODE_SEQ_REGRESSION", 409);
    }
  } else {
    if (agent.retired_boot_ids.includes(payload.boot_id)) return deny("NODE_BOOT_REPLAY", 409);
    // The retired history is never silently evicted: a forgotten boot id could be
    // replayed and a stale boot could take the active slot. At capacity the new
    // boot is refused instead, leaving the active boot usable; an operator
    // credential rotation clears the history.
    if (lastBootId && agent.retired_boot_ids.length >= BOOT_ID_HISTORY_LIMIT) {
      return deny("NODE_BOOT_ID_CAPACITY_REACHED", 409);
    }
    nextRetiredBootIds = lastBootId
      ? [...agent.retired_boot_ids, lastBootId].slice(-BOOT_ID_HISTORY_LIMIT)
      : agent.retired_boot_ids;
  }

  const nextNonces = [...liveNonces, { nonce, at_ms: nowMs }].slice(-NONCE_RING_LIMIT);
  return {
    ok: true,
    node,
    agent,
    agent_version,
    payload,
    commit: {
      nonces: nextNonces,
      rate: { tokens: rate.tokens - 1, updated_at_ms: nowMs },
      last_boot_id: payload.boot_id,
      last_seq: payload.seq,
      retired_boot_ids: nextRetiredBootIds,
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

// Every operation has exactly the parameter keys na-core's
// _validate_operation_params tolerates. An extra key would be queued here and then
// REFUSED by the agent (TASK_PARAMS_FORBIDDEN), so it is rejected at submission.
function requireOnlyParams(params, allowed) {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new NodeAgentError("TASK_PARAMS_FORBIDDEN", 400);
  }
}

function validateObserveParams(params) {
  requireOnlyParams(params, ["want"]);
  const want = params.want;
  if (want === undefined) return;
  // na-core requires a non-empty list without duplicates. A scalar would be
  // queued, dispatched and then REFUSED, so it is a submission error instead.
  if (!Array.isArray(want) || want.length === 0 || want.length > OBSERVE_WANTS.length) {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
  const seen = new Set();
  for (const entry of want) {
    if (typeof entry !== "string" || !OBSERVE_WANTS.includes(entry) || seen.has(entry)) {
      throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    }
    seen.add(entry);
  }
}

function validateServiceReadParams(params) {
  requireOnlyParams(params, ["units"]);
  const units = params.units;
  if (!Array.isArray(units) || units.length === 0 || units.length > MAX_SERVICE_UNITS) {
    throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
  }
  const seen = new Set();
  for (const unit of units) {
    // Duplicates are refused by na-core as well, so they never reach the queue.
    if (typeof unit !== "string" || !SERVICE_UNIT_PATTERN.test(unit) || seen.has(unit)) {
      throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
    }
    seen.add(unit);
  }
}

function validateCapabilityInspectParams(params) {
  if (Object.keys(params).length > 0) throw new NodeAgentError("TASK_PARAMS_INVALID", 400);
}

function validateSelfTestParams(params) {
  requireOnlyParams(params, ["nonce"]);
  if (params.nonce === undefined) return;
  // Same shape the agent's protocol layer enforces (>=16 bytes base64url); a
  // short human-readable string would only be REFUSED after dispatch.
  if (typeof params.nonce !== "string" || !NONCE_PATTERN.test(params.nonce)) {
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

const TERMINAL_TASK_STATUSES = Object.freeze([TASK_STATUS.COMPLETED, TASK_STATUS.EXPIRED]);

function isTerminalTask(task) {
  return TERMINAL_TASK_STATUSES.includes(task?.status);
}

function taskStorageBytes(task) {
  return Number.isInteger(task?.size_bytes) ? task.size_bytes : TASK_RECORD_OVERHEAD_BYTES + 512;
}

/**
 * Terminal history is evicted oldest first, and EXPIRED before COMPLETED: an
 * expired task is a tombstone with no audit value, so keeping it while dropping a
 * completed result would be backwards. Only terminal tasks are ever evicted; a
 * pending or leased task is operator work and never disappears silently.
 */
function pruneTerminalTasks(tasks) {
  const next = { ...tasks };
  const entries = Object.values(next).filter((task) => task && typeof task === "object");
  const rank = (task) => (task.status === TASK_STATUS.EXPIRED ? 0 : 1);
  const order = (task) =>
    String(task.completed_at ?? task.dispatched_at ?? task.issued_at ?? "") +
    "|" + String(task.task_id);
  const terminal = entries
    .filter(isTerminalTask)
    .sort((left, right) => rank(left) - rank(right) || order(left).localeCompare(order(right)));
  let terminalCount = terminal.length;
  let totalBytes = entries.reduce((sum, task) => sum + taskStorageBytes(task), 0);
  for (const task of terminal) {
    if (terminalCount <= TASK_RETENTION_LIMIT && totalBytes <= TASK_STORAGE_BYTES_LIMIT) break;
    delete next[task.task_id];
    terminalCount -= 1;
    totalBytes -= taskStorageBytes(task);
  }
  return next;
}

/**
 * Lazily retires tasks whose TTL passed while the node was not polling. Without
 * this a stopped node leaves EXPIRED tasks that never become terminal, the
 * pending count never drops, and every operator submission is 409 TASK_QUEUE_FULL.
 */
function expireDueTasks(tasks, nowMs) {
  const next = { ...tasks };
  for (const [taskId, task] of Object.entries(next)) {
    if (!task || typeof task !== "object" || isTerminalTask(task)) continue;
    if (taskExpired(task, nowMs)) {
      next[taskId] = { ...task, status: TASK_STATUS.EXPIRED, completed_at: isoFromMs(nowMs) };
      continue;
    }
    if (task.status === TASK_STATUS.LEASED && !leaseActive(task, nowMs) && task.attempt >= TASK_ATTEMPT_MAX) {
      // A lease that can never be retried is terminal for the operator too.
      next[taskId] = { ...task, status: TASK_STATUS.EXPIRED, completed_at: isoFromMs(nowMs) };
    }
  }
  return next;
}

/** Queues one validated task on the node's agent record (§5.2). */
export function createTask(agent, input) {
  const record = normalizeAgentState(agent);
  const nowMs = input.nowMs;
  const taskId = requireTaskId(input.task_id);
  // Expiry and pruning happen on every mutation: a node that stopped polling must
  // not leave tombstones that block operator submissions or grow the blob.
  const live = pruneTerminalTasks(expireDueTasks(record.tasks, nowMs));
  if (Object.hasOwn(live, taskId)) throw new NodeAgentError("TASK_ALREADY_EXISTS", 409);
  const pending = Object.values(live).filter(
    (task) => task && typeof task === "object" && !isTerminalTask(task),
  );
  if (pending.length >= TASK_QUEUE_LIMIT) throw new NodeAgentError("TASK_QUEUE_FULL", 409);
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
    // Durable accounting for the byte bound: recomputing every task body on each
    // mutation would be the same order of work as re-serializing the blob.
    size_bytes: TASK_RECORD_OVERHEAD_BYTES + Buffer.byteLength(canonicalJson(input.params), "utf8"),
  };
  // The queue is bounded by bytes as well as by count: 64 maximal 4 KiB params
  // would be 256 KiB and would overflow the single serialized object (§10).
  const queuedBytes = pending.reduce((sum, entry) => sum + taskStorageBytes(entry), 0);
  if (queuedBytes + task.size_bytes > TASK_STORAGE_BYTES_LIMIT) {
    throw new NodeAgentError("TASK_QUEUE_FULL", 409);
  }
  const tasks = { ...live, [taskId]: task };
  return { agent: { ...record, tasks: pruneTerminalTasks(tasks) }, task };
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
    if (isTerminalTask(task)) continue;
    if (taskExpired(task, nowMs) || task.status === TASK_STATUS.EXPIRED) {
      tasks[task.task_id] = { ...task, status: TASK_STATUS.EXPIRED, completed_at: isoFromMs(nowMs) };
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
  return { agent: { ...record, tasks: pruneTerminalTasks(tasks) }, tasks: envelopes };
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

  // The result envelope must prove which task it answers before it can touch
  // durable state (na-core make_result binds schema/task_id/node_uid/operation).
  // Everything here runs before the digest branch, so a mis-bound replay cannot
  // be mistaken for an idempotent success.
  const result = input.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new NodeAgentError("TASK_RESULT_INVALID", 400);
  }
  if (result.schema !== TASK_SCHEMA) throw new NodeAgentError("TASK_RESULT_SCHEMA_UNSUPPORTED", 400);
  if (result.task_id !== task.task_id) throw new NodeAgentError("TASK_RESULT_SCOPE_MISMATCH", 409);
  if (result.operation !== task.operation) throw new NodeAgentError("TASK_OPERATION_MISMATCH", 409);
  if (result.node_uid !== task.node_uid) throw new NodeAgentError("NODE_SCOPE_MISMATCH", 403);

  // The digest is computed by the caller from canonicalJson(result) on the
  // control-plane side. A result_digest a node puts in its own body is advisory
  // only: it is never read here and never compared, because Python and JS
  // canonical JSON may disagree on float rendering (1.0 vs 1).
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
  // result.status is the na-core field name. Strict equality only: an unknown
  // string, an object, a missing key or a different casing fails closed to
  // UNKNOWN rather than being passed through.
  const outcome = RESULT_STATUSES.includes(result.status) ? result.status : "UNKNOWN";
  const completed = {
    ...task,
    status: TASK_STATUS.COMPLETED,
    completed_at: isoFromMs(input.nowMs),
    result_digest: digest,
    result_outcome: outcome,
  };
  tasks[task.task_id] = completed;
  return {
    agent: { ...record, tasks: pruneTerminalTasks(tasks) },
    task: completed,
    idempotent: false,
    result_digest: digest,
  };
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
  // A real agent reports "capability_digest": null on every beat before the node
  // has a projected capability status: na-core observe.py sets None when
  // /etc/ghostfleet/capability-status.json is absent (a legal state for a
  // PROVISIONAL node) and loop.py always sends the key. null therefore means
  // "explicitly unknown" and is stored as unknown instead of keeping a stale
  // digest; only an omitted key means "no observation, keep the previous value".
  if (payload.capability_digest === null) {
    capabilityDigest = null;
  } else if (payload.capability_digest !== undefined) {
    const candidate = payload.capability_digest;
    if (typeof candidate !== "string" || !CAPABILITY_DIGEST_PATTERN.test(candidate)) {
      throw new NodeAgentError("NODE_REQUEST_INVALID", 400);
    }
    capabilityDigest = candidate;
  }
  // Nullable-by-protocol fields are the exception, not the pattern: health and
  // capability_digest can be explicitly unknown, while queue_depth and drift
  // always carry a definite observation. A null there is a malformed client, not
  // an unknown value, so those two stay strictly typed.
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
  // ADR 8085ea8 §5.1 item 7: the server never accelerates a node. Health and
  // drift choose nothing here, because a 15 s interval would make a beat plus a
  // poll 480 requests/hour against the 360/hour bucket and pin the node on 429.
  const interval_s = HEARTBEAT_INTERVAL.default;
  return {
    agent: {
      ...record,
      last_heartbeat_at: isoFromMs(input.nowMs),
      health,
      agent_version: agentVersion,
      capability_digest: capabilityDigest,
      queue_depth: queueDepth,
      drift_count: driftCount,
      tasks: pruneTerminalTasks(record.tasks),
    },
    interval_s,
  };
}
