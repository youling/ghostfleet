import { assertSecretSafe } from "./security.js";
import { deepFreeze, deepMerge, clone, setPath } from "./util.js";
import { normalizeResolvedTemplate, templateDigest } from "./normalize.js";
import { providerOptionAllowsUserOverride, validateProviderOptions } from "./provider-options.js";

const IMMUTABLE_OVERLAY_KEYS=new Set(["template_id","version","generation","extends"]);

function indexBy(items,key) {
  const map=new Map();
  for(const item of items ?? []) {
    const id=String(item?.[key] ?? "");
    if(!id) throw new Error(key.toUpperCase()+"_REQUIRED");
    if(map.has(id)) throw new Error("DUPLICATE_"+key.toUpperCase());
    map.set(id,item);
  }
  return map;
}

function resolveBase(id,templates,stack=[]) {
  if(stack.includes(id)) throw new Error("TEMPLATE_EXTENDS_CYCLE");
  const template=templates.get(id);
  if(!template) throw new Error("TEMPLATE_NOT_FOUND:"+id);
  assertSecretSafe(template);
  for(const key of ["template_id","version","generation"]) if(template[key]===undefined || template[key]===null || template[key]==="") throw new Error("TEMPLATE_IDENTITY_REQUIRED:"+key);
  if(!template.extends) return {
    template_id:template.template_id,
    version:template.version,
    generation:template.generation,
    posture:clone(template.posture ?? {}),
    allowed_override_paths:[...(template.allowed_override_paths ?? [])],
    overlay_refs:[],
  };
  const parent=resolveBase(template.extends,templates,[...stack,id]);
  return {
    template_id:template.template_id,
    version:template.version,
    generation:template.generation,
    posture:deepMerge(parent.posture,template.posture ?? {}),
    allowed_override_paths:[...new Set([...(parent.allowed_override_paths ?? []),...(template.allowed_override_paths ?? [])])],
    overlay_refs:[],
  };
}

export function resolveEnrollmentTemplate({template_id,templates=[],overlays=[],providerRegistry}) {
  const templateMap=indexBy(templates,"template_id");
  let resolved=resolveBase(template_id,templateMap);
  const matching=(overlays ?? []).filter((overlay)=>overlay.target_template_id===template_id)
    .sort((a,b)=>String(a.overlay_id).localeCompare(String(b.overlay_id)));
  for(const overlay of matching) {
    assertSecretSafe(overlay);
    for(const key of IMMUTABLE_OVERLAY_KEYS) {
      if(Object.hasOwn(overlay,key) && key!=="generation") throw new Error("OVERLAY_IMMUTABLE_FIELD:"+key);
    }
    if(!overlay.overlay_id) throw new Error("OVERLAY_ID_REQUIRED");
    if(String(overlay.base_generation)!==String(resolved.generation)) throw new Error("OVERLAY_STALE_BASE_GENERATION");
    resolved={
      ...resolved,
      posture:deepMerge(resolved.posture,overlay.posture ?? {}),
      overlay_refs:[...resolved.overlay_refs,{overlay_id:overlay.overlay_id,generation:overlay.generation ?? null}],
    };
  }
  validateProviderOptions(resolved.posture,providerRegistry);
  const normalized=normalizeResolvedTemplate(resolved,providerRegistry);
  return deepFreeze({...normalized,digest:templateDigest(normalized,providerRegistry)});
}

export function applyUserOverrides(resolved,overrides={},providerRegistry) {
  const allowed=new Set(resolved.allowed_override_paths ?? []);
  const next=clone(resolved);
  next.posture=clone(resolved.posture);
  for(const [path,value] of Object.entries(overrides ?? {})) {
    if(!allowed.has(path)) throw new Error("OVERRIDE_PATH_NOT_ALLOWED:"+path);
    if(!providerOptionAllowsUserOverride(path,providerRegistry)) throw new Error("PROVIDER_OPTION_NOT_USER_OVERRIDABLE:"+path);
    setPath(next.posture,path,value);
  }
  validateProviderOptions(next.posture,providerRegistry);
  assertSecretSafe(next.posture);
  const normalized=normalizeResolvedTemplate(next,providerRegistry);
  return deepFreeze({...normalized,digest:templateDigest(normalized,providerRegistry)});
}

export function bindTemplateToAttempt({attempt_id,resolved_template}) {
  if(!attempt_id) throw new Error("ATTEMPT_ID_REQUIRED");
  return deepFreeze({
    attempt_id,
    template_id:resolved_template.template_id,
    template_version:resolved_template.version,
    template_generation:resolved_template.generation,
    template_digest:resolved_template.digest,
  });
}

export function assertAttemptTemplateCurrent(binding,resolvedTemplate) {
  if(binding.template_id!==resolvedTemplate.template_id) throw new Error("ATTEMPT_TEMPLATE_ID_MISMATCH");
  if(String(binding.template_generation)!==String(resolvedTemplate.generation)) throw new Error("ATTEMPT_TEMPLATE_GENERATION_STALE");
  if(binding.template_digest!==resolvedTemplate.digest) throw new Error("ATTEMPT_TEMPLATE_DIGEST_STALE");
  return true;
}
