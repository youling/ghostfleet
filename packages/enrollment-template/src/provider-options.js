import { getPath } from "./util.js";

export function createProviderOptionRegistry(manifests=[]) {
  const adapters=new Map();
  for(const manifest of manifests) {
    const adapter_id=String(manifest?.adapter_id ?? "");
    if(!adapter_id) throw new Error("ADAPTER_ID_REQUIRED");
    if(adapters.has(adapter_id)) throw new Error("DUPLICATE_ADAPTER");
    const options={};
    for(const option of manifest.options ?? []) {
      const id=String(option?.option_id ?? "");
      if(!id) throw new Error("OPTION_ID_REQUIRED");
      if(options[id]) throw new Error("DUPLICATE_OPTION");
      options[id]=Object.freeze({
        option_id:id,
        type:option.type ?? "boolean",
        user_overridable:Boolean(option.user_overridable),
      });
    }
    adapters.set(adapter_id,Object.freeze({adapter_id,options:Object.freeze(options)}));
  }
  return Object.freeze({
    get:(id)=>adapters.get(id) ?? null,
    list:()=>[...adapters.values()],
  });
}

function validType(value,type) {
  if(type==="boolean") return typeof value==="boolean";
  if(type==="string") return typeof value==="string";
  if(type==="number") return typeof value==="number" && Number.isFinite(value);
  return true;
}

export function validateProviderOptions(posture,registry) {
  const providers=posture?.providers ?? {};
  for(const [adapterId,settings] of Object.entries(providers)) {
    const manifest=registry?.get(adapterId);
    if(!manifest) throw new Error("UNKNOWN_PROVIDER_ADAPTER:"+adapterId);
    for(const [optionId,value] of Object.entries(settings ?? {})) {
      const option=manifest.options[optionId];
      if(!option) throw new Error("UNKNOWN_PROVIDER_OPTION:"+adapterId+"."+optionId);
      if(!validType(value,option.type)) throw new Error("INVALID_PROVIDER_OPTION_TYPE:"+adapterId+"."+optionId);
    }
  }
  return true;
}

export function providerOptionAllowsUserOverride(path,registry) {
  const parts=String(path).split(".");
  if(parts.length<3 || parts[0]!=="providers") return true;
  const manifest=registry?.get(parts[1]);
  return Boolean(manifest?.options?.[parts[2]]?.user_overridable);
}

export function currentProviderValue(posture,path) {
  return getPath(posture,path);
}
