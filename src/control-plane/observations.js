import { MAX_NODES, UID } from './enrollment.js';

export const OBSERVATION_SOURCES = {
  'tailscale-api': ['network'],
  'cloudflare-api': ['edge'],
  'ssh-probe': ['management', 'origin', 'rescue'],
  'kubernetes-api': ['compute'],
};
const streams = new Set(Object.entries(OBSERVATION_SOURCES).flatMap(([source, dimensions]) =>
  dimensions.map((dimension) => `${source}/${dimension}`)));
export const OBSERVATION_SCOPES = ['primary', 'secondary'];
const grantBinding = /^GHOSTFLEET_OBSERVER_GRANTS(?:_(?:0[1-9]|[12]\d|3[0-2]))?$/;

export function parseObserverGrants(env) {
  const grants = [];
  for (const [name, serialized] of Object.entries(env)) {
    if (!grantBinding.test(name) || serialized === '') continue;
    if (typeof serialized !== 'string' || serialized.length > 5120) return null;
    let chunk;
    try { chunk = JSON.parse(serialized); } catch { return null; }
    if (!Array.isArray(chunk) || grants.length + chunk.length > MAX_NODES * OBSERVATION_SCOPES.length) return null;
    grants.push(...chunk);
  }

  const digests = new Set();
  const slots = new Set();
  for (const grant of grants) {
    if (!grant || typeof grant !== 'object' || Object.keys(grant).length !== 4 ||
      !Object.hasOwn(grant, 'token_sha256') || !Object.hasOwn(grant, 'node_uid') ||
      !Object.hasOwn(grant, 'scope') || !Object.hasOwn(grant, 'streams') ||
      typeof grant.token_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(grant.token_sha256) ||
      typeof grant.node_uid !== 'string' || !UID.test(grant.node_uid) ||
      !OBSERVATION_SCOPES.includes(grant.scope) ||
      !Array.isArray(grant.streams) || !grant.streams.length || grant.streams.length > streams.size ||
      digests.has(grant.token_sha256)) return null;

    digests.add(grant.token_sha256);
    for (const stream of grant.streams) {
      if (!streams.has(stream)) return null;
      const slot = `${grant.node_uid}/${grant.scope}/${stream}`;
      if (slots.has(slot)) return null;
      slots.add(slot);
    }
  }
  return grants;
}
