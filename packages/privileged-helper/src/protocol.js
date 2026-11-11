const FORBIDDEN_KEYS=/(command|shell|argv|script|password|private[_-]?key|auth[_-]?key|api[_-]?token|credential|secret)/i;

// IPC carries JSON data, never executable getters, custom objects or live references.
// Bound traversal so malformed in-process callers also fail closed before verification.
function snapshotParameters(value) {
  const ancestors=new Set();
  let remaining=10000;
  function copy(item,depth=0) {
    if(--remaining<0 || depth>64) throw new Error("IPC_PARAMETERS_INVALID");
    if(item===null || typeof item==="string" || typeof item==="boolean") return item;
    if(typeof item==="number" && Number.isFinite(item)) return item;
    if(typeof item!=="object" || ancestors.has(item)) throw new Error("IPC_PARAMETERS_INVALID");
    const array=Array.isArray(item);
    const prototype=Object.getPrototypeOf(item);
    if(!array && prototype!==Object.prototype && prototype!==null) throw new Error("IPC_PARAMETERS_INVALID");
    const descriptors=Object.getOwnPropertyDescriptors(item);
    const keys=Reflect.ownKeys(descriptors).filter(key=>!(array && key==="length"));
    if(keys.length>remaining || (array && item.length!==keys.length)) throw new Error("IPC_PARAMETERS_INVALID");
    const result=array?[]:{};
    ancestors.add(item);
    for(const key of keys) {
      const descriptor=descriptors[key];
      if(typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor) ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key)>=item.length))) throw new Error("IPC_PARAMETERS_INVALID");
      Object.defineProperty(result,key,{value:copy(descriptor.value,depth+1),enumerable:true});
    }
    ancestors.delete(item);
    return Object.freeze(result);
  }
  return copy(value);
}

export function validateIpcEnvelope(input={}) {
  if(!input || typeof input!=="object" || Array.isArray(input)) return {ok:false,code:"IPC_OBJECT_REQUIRED"};
  try {
  // Read each field once without invoking accessors, then use only captured values.
  const fields=Object.getOwnPropertyDescriptors(input);
  for(const key of Object.keys(input)) if(FORBIDDEN_KEYS.test(key)) return {ok:false,code:"IPC_FORBIDDEN_FIELD",field:key};
  const values={};
  for(const key of ["request_id","lease_id","operation_id","target_ref","effect_ref"]) {
    const value=fields[key]?.value;
    if(typeof value!=="string" || !value) return {ok:false,code:"IPC_FIELD_REQUIRED",field:key};
    values[key]=value;
  }
  if(fields.parameters && !("value" in fields.parameters)) return {ok:false,code:"IPC_PARAMETERS_INVALID"};
  const parameters=fields.parameters?.value;
  if(parameters!==undefined && (parameters===null || typeof parameters!=="object" || Array.isArray(parameters))) {
    return {ok:false,code:"IPC_PARAMETERS_OBJECT_REQUIRED"};
  }
  return {ok:true,envelope:Object.freeze({
    ...values,
    parameters:snapshotParameters(parameters ?? {}),
  })};
  } catch {
    return {ok:false,code:"IPC_PARAMETERS_INVALID"};
  }
}
