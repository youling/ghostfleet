function clone(value) { return structuredClone(value); }
function setPath(object,path,value) {
  const parts=String(path).split(".");
  let current=object;
  for(let i=0;i<parts.length-1;i++) current=current[parts[i]] ??= {};
  current[parts.at(-1)]=value;
}
function getPath(object,path) {
  return String(path).split(".").reduce((value,key)=>value?.[key],object);
}
export function templateDisplay(template,language="zh-CN") {
  const display=template?.display?.[language] ?? template?.display?.en ?? {};
  return {name:display.name ?? template?.template_id ?? "unknown",description:display.description ?? ""};
}
export function applyTemplatePreviewOverrides(template,overrides={}) {
  if(!template) throw new Error("TEMPLATE_REQUIRED");
  const allowed=new Set(template.allowed_override_paths ?? []);
  const posture=clone(template.effective_posture ?? {});
  for(const [path,value] of Object.entries(overrides)) {
    if(!allowed.has(path)) throw new Error("OVERRIDE_PATH_NOT_ALLOWED:"+path);
    setPath(posture,path,value);
  }
  return Object.freeze({template_id:template.template_id,posture,overrides:Object.freeze({...overrides})});
}
export function templateSelectionPayload(template,overrides={}) {
  applyTemplatePreviewOverrides(template,overrides);
  return Object.freeze({template_id:template.template_id,overrides:Object.freeze({...overrides})});
}
export function templatePostureSummary(template,overrides={}) {
  const resolved=applyTemplatePreviewOverrides(template,overrides).posture;
  return Object.freeze({
    tailscale_enabled:getPath(resolved,"providers.tailscale.enabled") === true,
    tailscale_ssh:getPath(resolved,"providers.tailscale.ssh") === true,
    privilege_broker:getPath(resolved,"privilege.broker_required") === true,
    privileged_helper:getPath(resolved,"privilege.helper_required") === true,
    break_glass:getPath(resolved,"recovery.break_glass_required") === true,
    consumer_acceptance:resolved.consumer_acceptance ?? "STANDARD",
    root_ceremony:resolved.bootstrap?.root_ceremony ?? "UNKNOWN",
  });
}
