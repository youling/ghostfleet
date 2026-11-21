/**
 * M1 SOURCE_ONLY: bounded, offline HostServiceEndpoint evidence inspection.
 *
 * Returns opaque candidate references, NEVER URLs, IPs, sockets, credentials,
 * permissions, routed connections, retries or remote execution authority.
 * The caller must independently authenticate evidence provenance, check its
 * actual authorization and prove the target/namespace before using any ref.
 */
export const ENDPOINT_EVIDENCE_SCHEMA = "ghostfleet-host-endpoint-evidence/v0.1";

const UID = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const OPAQUE = /^(?:locator|evidence)-[0-9a-f]{16}$/;
const KINDS = new Set(["unix_socket", "http_connect", "private_ipv4", "mesh", "tunnel"]);
const PATH_STATES = new Set(["REACHABLE", "DENIED", "UNREACHABLE", "UNKNOWN"]);
const IDENTITIES = new Set(["PIN_MATCH", "MISMATCH", "UNVERIFIED"]);
const QUERY_KEYS = ["node_uid", "service_ref", "namespace_ref", "purpose_ref", "caller_ref"];
const FACT_KEYS = [
  ...QUERY_KEYS, "locator_ref", "binding_kind", "source_ref",
  "observed_at_ms", "expires_at_ms", "path_state", "target_identity_state",
];
const MAX_RECORDS = 32;
const MAX_TTL_MS = 5 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 30 * 1000;

export class EndpointEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "EndpointEvidenceError";
  }
}

function denyContract() {
  throw new EndpointEvidenceError("ENDPOINT_EVIDENCE_INVALID");
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      Object.keys(value).some(key => !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(value, key))) denyContract();
}

function validQuery(q) {
  exactObject(q, QUERY_KEYS);
  if (!UID.test(q.node_uid)) denyContract();
  for (const key of QUERY_KEYS.slice(1)) {
    if (typeof q[key] !== "string" || !NAME.test(q[key])) denyContract();
  }
}

function validRecord(r) {
  exactObject(r, FACT_KEYS);
  validQuery(Object.fromEntries(QUERY_KEYS.map(k => [k, r[k]])));
  if (typeof r.locator_ref !== "string" || !OPAQUE.test(r.locator_ref) ||
      !r.locator_ref.startsWith("locator-") ||
      typeof r.source_ref !== "string" || !OPAQUE.test(r.source_ref) ||
      !r.source_ref.startsWith("evidence-") ||
      !KINDS.has(r.binding_kind) || !PATH_STATES.has(r.path_state) ||
      !IDENTITIES.has(r.target_identity_state) ||
      !Number.isSafeInteger(r.observed_at_ms) || r.observed_at_ms < 0 ||
      !Number.isSafeInteger(r.expires_at_ms) ||
      r.expires_at_ms < r.observed_at_ms ||
      r.expires_at_ms - r.observed_at_ms > MAX_TTL_MS) denyContract();
}

function result(state, candidate_refs = []) {
  return {
    schema: ENDPOINT_EVIDENCE_SCHEMA,
    state,
    candidate_refs,
    authorization: "NOT_EVALUATED",
    provenance_authentication: "NOT_EVALUATED",
    network_connectivity_effect: "NONE",
    execution_effect: "NONE",
    fallback_or_retry: "NONE",
  };
}

/**
 * Inspect HostServiceEndpoint evidence, without resolving any real locator.
 *
 * Critical: even if a record says PIN_MATCH and REACHABLE it is *untrusted*
 * input until an authorized private Host/Fleet reader verifies its provenance.
 * "CANDIDATE_EVIDENCE_ONLY" is not a connection grant or success verdict.
 * A recorded DENIED must never become a cross-provider fallback.
 */
export function inspectEndpointEvidence(query, observations, now_ms) {
  validQuery(query);
  if (!Array.isArray(observations) || observations.length > MAX_RECORDS ||
      !Number.isSafeInteger(now_ms) || now_ms < 0) denyContract();

  for (const record of observations) validRecord(record);
  const matches = observations.filter(record =>
    QUERY_KEYS.every(key => record[key] === query[key])
  );
  if (!matches.length) return result("UNKNOWN");

  const fresh = matches.filter(record =>
    record.observed_at_ms <= now_ms + FUTURE_TOLERANCE_MS &&
    record.expires_at_ms >= now_ms
  );
  if (!fresh.length) return result("UNKNOWN");
  if (fresh.some(record => record.path_state === "DENIED")) return result("DENIED");
  if (fresh.some(record => record.target_identity_state === "MISMATCH")) {
    return result("IDENTITY_CONFLICT");
  }
  if (fresh.some(record => record.observed_at_ms > now_ms)) {
    // Future observations are not stronger proof than current observations.
    return result("UNKNOWN");
  }
  const usable = fresh.filter(record =>
    record.path_state === "REACHABLE" && record.target_identity_state === "PIN_MATCH"
  );
  if (!usable.length) return result("UNKNOWN");

  const byRef = new Map();
  for (const record of usable) {
    const previous = byRef.get(record.locator_ref);
    if (previous && (previous.binding_kind !== record.binding_kind ||
                     previous.source_ref !== record.source_ref)) {
      return result("EVIDENCE_CONFLICT");
    }
    byRef.set(record.locator_ref, record);
  }
  return result("CANDIDATE_EVIDENCE_ONLY", [...byRef.keys()].sort());
}
