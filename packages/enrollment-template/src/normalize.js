import { assertSecretSafe } from "./security.js";
import { canonicalize, canonicalStringify, deepFreeze, sha256 } from "./util.js";
import { validateProviderOptions } from "./provider-options.js";

function sortedUnique(values=[]) {
  return [...new Set(values.map(String))].sort();
}

export function normalizePosture(posture={},providerRegistry) {
  assertSecretSafe(posture);
  validateProviderOptions(posture,providerRegistry);
  const normalized=canonicalize({
    platforms:sortedUnique(posture.platforms ?? []),
    roles:sortedUnique(posture.roles ?? []),
    capabilities:sortedUnique(posture.capabilities ?? []),
    providers:posture.providers ?? {},
    privilege:{
      broker_required:Boolean(posture.privilege?.broker_required),
      helper_required:Boolean(posture.privilege?.helper_required),
    },
    human_gate:posture.human_gate ?? "POLICY",
    recovery:{
      break_glass_required:Boolean(posture.recovery?.break_glass_required),
    },
    consumer_acceptance:posture.consumer_acceptance ?? "STANDARD",
    bootstrap:{
      root_ceremony:posture.bootstrap?.root_ceremony ?? "ONE_TIME",
      requirements:sortedUnique(posture.bootstrap?.requirements ?? []),
    },
  });
  return deepFreeze(normalized);
}

export function normalizeResolvedTemplate(resolved,providerRegistry) {
  const normalized=canonicalize({
    template_id:resolved.template_id,
    version:resolved.version,
    generation:resolved.generation,
    posture:normalizePosture(resolved.posture,providerRegistry),
    allowed_override_paths:sortedUnique(resolved.allowed_override_paths ?? []),
    overlay_refs:(resolved.overlay_refs ?? []).map((item)=>canonicalize(item)).sort((a,b)=>canonicalStringify(a).localeCompare(canonicalStringify(b))),
  });
  return deepFreeze(normalized);
}

export function templateDigest(resolved,providerRegistry) {
  return sha256(normalizeResolvedTemplate(resolved,providerRegistry));
}
