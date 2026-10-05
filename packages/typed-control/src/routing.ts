export const NODE_UID_RE = /^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function controlHostname(nodeUid: string, suffix: string | undefined): string {
  if (typeof nodeUid!=="string" || !NODE_UID_RE.test(nodeUid)) throw new Error("INVALID_NODE_UID");
  if (!suffix || !/^\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}$/.test(suffix)) throw new Error("CONTROL_HOSTNAME_SUFFIX_REQUIRED");
  return `${nodeUid}${suffix}`;
}

export function directTunnelBindingName(nodeUid: string): string {
  if (typeof nodeUid!=="string" || !NODE_UID_RE.test(nodeUid)) throw new Error("INVALID_NODE_UID");
  return `NODE_${nodeUid.slice(5).replace(/-/g, "_").toUpperCase()}`;
}

export function isSshBanner(value: string): boolean {
  return /^SSH-2\.0-[^\r\n]{1,200}\r?\n?$/.test(value);
}
