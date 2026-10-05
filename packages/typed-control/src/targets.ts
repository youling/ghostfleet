export type SshHostKeyAlgorithm =
  | "ssh-ed25519"
  | "ssh-rsa"
  | "ecdsa-sha2-nistp256"
  | "ecdsa-sha2-nistp384"
  | "ecdsa-sha2-nistp521";

export type ControlTransportMode = "mesh_hostname" | "direct_tunnel" | "local_ssh";

export interface ControlTarget {
  username: string;
  transport_mode: ControlTransportMode;
  ssh_host_key_algorithm: SshHostKeyAlgorithm;
  ssh_host_key_sha256: string;
}

export type ControlTargetMap = Record<string, ControlTarget>;

const NODE_UID_RE = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]+$/;
const HOST_KEY_ALGORITHMS = new Set<SshHostKeyAlgorithm>([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);
// local_ssh is resolved by an explicitly supplied native controller backend.
// The Workers network adapter rejects it; metadata never implies capability.
const TRANSPORT_MODES = new Set<ControlTransportMode>(["mesh_hostname", "direct_tunnel", "local_ssh"]);

export function parseControlTargets(raw: string): ControlTargetMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CONTROL_TARGETS_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CONTROL_TARGETS_INVALID_SHAPE");
  }

  const result: ControlTargetMap = {};
  for (const [nodeUid, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!NODE_UID_RE.test(nodeUid)) throw new Error("CONTROL_TARGETS_INVALID_NODE_UID");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("CONTROL_TARGETS_INVALID_TARGET");
    }
    const record = value as Record<string, unknown>;
    const username = record.username;
    const transportMode = record.transport_mode;
    const algorithm = record.ssh_host_key_algorithm;
    const fingerprint = record.ssh_host_key_sha256;
    if (typeof username !== "string" || !USER_RE.test(username)) {
      throw new Error("CONTROL_TARGETS_INVALID_USERNAME");
    }
    if (typeof transportMode !== "string" || !TRANSPORT_MODES.has(transportMode as ControlTransportMode)) {
      throw new Error("CONTROL_TARGETS_INVALID_TRANSPORT_MODE");
    }
    if (typeof algorithm !== "string" || !HOST_KEY_ALGORITHMS.has(algorithm as SshHostKeyAlgorithm)) {
      throw new Error("CONTROL_TARGETS_INVALID_HOST_KEY_ALGORITHM");
    }
    if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
      throw new Error("CONTROL_TARGETS_INVALID_HOST_FINGERPRINT");
    }
    result[nodeUid] = {
      username,
      transport_mode: transportMode as ControlTransportMode,
      ssh_host_key_algorithm: algorithm as SshHostKeyAlgorithm,
      ssh_host_key_sha256: fingerprint,
    };
  }
  return result;
}

export function resolveControlTarget(raw: string, nodeUid: string): ControlTarget {
  if (typeof nodeUid!=="string" || !NODE_UID_RE.test(nodeUid)) throw new Error("INVALID_NODE_UID");
  const target = parseControlTargets(raw)[nodeUid];
  if (!target) throw new Error("CONTROL_TARGET_NOT_REGISTERED");
  return target;
}
