/**
 * M2 SOURCE_ONLY: offline projection of independently collected provider facts.
 *
 * No network/credentials/storage, no provider ID -> Fleet UID inference,
 * no node enrollment, no TS/CF/SSH admission, no heartbeat deprecation.
 * A private Owner must bind each provider device/tunnel to immutable node_uid
 * BEFORE providing these sanitized records.
 */
export const PROVIDER_SHADOW_SCHEMA = "ghostfleet-provider-shadow/v0.1";

const UID = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = ["node_uid", "source_kind", "source_state", "collected_at_ms", "valid_until_ms"];
const SOURCES = ["TAILSCALE_DEVICES", "CLOUDFLARE_TUNNEL", "GHOSTFLEET_HEARTBEAT"];
const STATES = {
  TAILSCALE_DEVICES: new Set(["CONTROL_CONNECTED", "CONTROL_DISCONNECTED"]),
  CLOUDFLARE_TUNNEL: new Set(["EDGE_HEALTHY", "EDGE_DEGRADED", "EDGE_DOWN", "INACTIVE"]),
  GHOSTFLEET_HEARTBEAT: new Set(["PENDING", "ONLINE", "STALE", "OFFLINE", "REVOKED", "UNKNOWN"]),
};
const MAX_RECORDS = 32;
const MAX_TTL_MS = 15 * 60 * 1000;

export class ProviderShadowError extends Error {
  constructor() {
    super("PROVIDER_SHADOW_INVALID");
    this.name = "ProviderShadowError";
  }
}

function fail() {
  throw new ProviderShadowError();
}

function validate(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).length !== FIELDS.length ||
      FIELDS.some(k => !Object.hasOwn(record, k)) ||
      Object.keys(record).some(k => !FIELDS.includes(k))) fail();
  if (typeof record.node_uid !== "string" || !UID.test(record.node_uid)) fail();
  if (typeof record.source_kind !== "string" || !SOURCES.includes(record.source_kind)) fail();
  if (typeof record.source_state !== "string" ||
      !STATES[record.source_kind].has(record.source_state)) fail();
  if (!Number.isSafeInteger(record.collected_at_ms) || record.collected_at_ms < 0 ||
      !Number.isSafeInteger(record.valid_until_ms) ||
      record.valid_until_ms < record.collected_at_ms ||
      record.valid_until_ms - record.collected_at_ms > MAX_TTL_MS) fail();
}

function selected(records, now) {
  if (!records.length) return {state:"UNKNOWN", source_state:null, age_ms:null};
  const valid = records.filter(r =>
    r.collected_at_ms <= now && r.valid_until_ms >= now
  );
  if (!valid.length) return {state:"STALE", source_state:null, age_ms:null};
  const latest = Math.max(...valid.map(r=>r.collected_at_ms));
  const newest = valid.filter(r=>r.collected_at_ms===latest);
  const states = new Set(newest.map(r=>r.source_state));
  if (states.size !== 1) return {state:"CONFLICT", source_state:null, age_ms:null};
  return {state:"CURRENT", source_state:newest[0].source_state, age_ms:now-latest};
}

/**
 * Pure evidence overlay for a single pre-reviewed Fleet UID.
 *
 * Source records carry an already-reviewed node UID; the projector MUST NOT
 * infer it from hostname, MAC, Tailscale IP/device ID or Cloudflare Tunnel ID.
 *
 * Semantics intentionally independent:
 * - Tailscale connectedToControl is not OS/SSH online.
 * - Tunnel EDGE_HEALTHY is not Access/origin authentication.
 * - GhostFleet heartbeat ONLINE is not Tailnet authorization/job readiness.
 * - Missing/stale observations NEVER imply DOWN/OFFLINE.
 */
export function projectProviderShadow(node_uid, observations, now_ms) {
  if (typeof node_uid !== "string" || !UID.test(node_uid) ||
      !Array.isArray(observations) || observations.length > MAX_RECORDS ||
      !Number.isSafeInteger(now_ms) || now_ms < 0) fail();
  for (const record of observations) validate(record);

  const group = Object.fromEntries(SOURCES.map(s => [s, []]));
  for (const record of observations) {
    if (record.node_uid===node_uid) group[record.source_kind].push(record);
  }
  return {
    schema: PROVIDER_SHADOW_SCHEMA,
    node_uid,
    tailscale: selected(group.TAILSCALE_DEVICES, now_ms),
    cloudflare: selected(group.CLOUDFLARE_TUNNEL, now_ms),
    ghostfleet: selected(group.GHOSTFLEET_HEARTBEAT, now_ms),
    canonical_node_uid_mapping: "OWNER_REVIEWED_INPUT_REQUIRED",
    authorization: "NOT_EVALUATED",
    ssh_authentication: "NOT_EVALUATED",
    job_admission: "NOT_EVALUATED",
    network_connectivity_effect: "NONE",
    execution_effect: "NONE",
    heartbeat_configuration_effect: "NONE",
  };
}
