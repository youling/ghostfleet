export const CONVERGENCE_PHASES = Object.freeze([
  "DETECT",
  "CLASSIFY",
  "PLAN",
  "APPLY_MINIMAL_DELTA",
  "VERIFY",
  "CHECKPOINT",
]);
export const COMPONENT_STATES = Object.freeze([
  "ABSENT",
  "COMPLIANT",
  "DRIFT_REPAIRABLE",
  "CONFLICT",
  "UNKNOWN",
]);
// V2R1 courier convergence core is provider-independent; secondary Tunnel is not a primary component.
const SAFE_NODE_UID = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_FINGERPRINT = /^(?:SHA256:)?[A-Za-z0-9+/=_:. -]{1,200}$/;
const SECRET_KEY = /(ticket|session|auth.?key|tunnel.?token|private.?key|password|api.?token|credential|secret)/i;
export function detectSystemFacts(input = {}) {
  return {
    os_family: typeof input.os_family === "string" ? input.os_family : "unknown",
    os_id: typeof input.os_id === "string" ? input.os_id : "unknown",
    os_version_id: typeof input.os_version_id === "string" ? input.os_version_id : "unknown",
    node_uid: typeof input.node_uid === "string" ? input.node_uid : null,
    tailscale: input.tailscale ?? { present: false, identity: null, status: "absent" },
    controller_key_present: input.controller_key_present === true,
  };
}
function component(state, reason, action = null) { return { state, reason, action }; }
export function classifyComponents(observed, desired) {
  const facts = detectSystemFacts(observed);
  const target = desired ?? {};
  const result = {};
  result.os = facts.os_family === "debian-family" ? component("COMPLIANT", "supported OS family") : component("UNKNOWN", "unsupported OS family");
  if (facts.node_uid && target.node_uid && facts.node_uid !== target.node_uid) result.identity = component("CONFLICT", "immutable node_uid mismatch");
  else if (facts.node_uid == null) result.identity = component("ABSENT", "immutable node_uid not yet observed", "verify_identity");
  else result.identity = component("COMPLIANT", "immutable node_uid matches");
  const ts = facts.tailscale;
  if (ts.status === "ambiguous" || (ts.identity && target.node_uid && ts.identity !== target.node_uid)) result.tailscale = component("CONFLICT", "existing Tailscale identity is ambiguous or mismatched");
  else if (ts.status === "ready" && ts.identity === target.node_uid) result.tailscale = component("COMPLIANT", "existing Tailscale identity matches");
  else if (ts.status === "drift") result.tailscale = component("DRIFT_REPAIRABLE", "Tailscale is present but not converged", "reconcile_tailscale");
  else result.tailscale = component("ABSENT", "Tailscale is not converged", "install_and_join_tailscale");
  result.controller_key = facts.controller_key_present ? component("COMPLIANT", "controller key already exists; append is unnecessary") : component("ABSENT", "controller key is absent", "append_controller_key");
  return result;
}
export function planConvergence({ observed = {}, desired = {}, checkpoint: _checkpointHint = null } = {}) {
  const components = classifyComponents(observed, desired);
  const blocking = Object.entries(components).filter(([, value]) => ["CONFLICT", "UNKNOWN"].includes(value.state));
  if (blocking.length > 0) return { phase: "PLAN", status: "FAIL_CLOSED", components, actions: [], request_tailscale: false, reason: blocking.map(([name, value]) => `${name}:${value.reason}`) };
  const actions = Object.values(components).flatMap((value) => value.action ? [value.action] : []);
  return { phase: "PLAN", status: actions.length === 0 ? "COMPLIANT" : "CONVERGE", components, actions, request_tailscale: actions.includes("install_and_join_tailscale") || actions.includes("reconcile_tailscale") };
}
export function sanitizeCheckpoint(input = {}) {
  const allowed = ["schema", "phase", "status", "node_uid", "node_id", "os_family", "os_id", "os_version_id", "profile", "bootstrap_version", "ssh_host_key_sha256", "controller_key_required", "controller_key_fingerprint", "controller_authorized_keys", "components"];
  const output = {};
  for (const key of allowed) {
    if (input[key] == null) continue;
    if (key === "components") {
      if (!input.components || typeof input.components !== "object" || Array.isArray(input.components)) continue;
      output.components = Object.fromEntries(Object.entries(input.components).filter(([name, value]) => typeof name === "string" && COMPONENT_STATES.includes(value)));
    } else if (typeof input[key] === "string" && input[key].length <= 200) output[key] = input[key];
  }
  output.schema = "fleet-enroll-checkpoint/v1";
  if (output.node_uid && !SAFE_NODE_UID.test(output.node_uid)) throw new Error("INVALID_CHECKPOINT_NODE_UID");
  for (const key of ["ssh_host_key_sha256"]) {
    if (output[key] && !SAFE_FINGERPRINT.test(output[key])) throw new Error(`INVALID_CHECKPOINT_${key.toUpperCase()}`);
  }
  if (JSON.stringify(output).match(SECRET_KEY)) throw new Error("SECRET_IN_CHECKPOINT");
  return output;
}
export function isSecretFreeCheckpoint(checkpoint) {
  const text = JSON.stringify(checkpoint);
  return !SECRET_KEY.test(text);
}
