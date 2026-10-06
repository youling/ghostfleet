const FORBIDDEN_KEYS=/(command|shell|argv|script|password|private[_-]?key|auth[_-]?key|api[_-]?token|credential|secret)/i;

export function validateIpcEnvelope(input={}) {
  if(!input || typeof input!=="object" || Array.isArray(input)) return {ok:false,code:"IPC_OBJECT_REQUIRED"};
  for(const key of Object.keys(input)) if(FORBIDDEN_KEYS.test(key)) return {ok:false,code:"IPC_FORBIDDEN_FIELD",field:key};
  for(const key of ["request_id","lease_id","operation_id","target_ref","effect_ref"]) {
    if(typeof input[key]!=="string" || !input[key]) return {ok:false,code:"IPC_FIELD_REQUIRED",field:key};
  }
  if(input.parameters!==undefined && (input.parameters===null || typeof input.parameters!=="object" || Array.isArray(input.parameters))) {
    return {ok:false,code:"IPC_PARAMETERS_OBJECT_REQUIRED"};
  }
  return {ok:true,envelope:Object.freeze({
    request_id:input.request_id,
    lease_id:input.lease_id,
    operation_id:input.operation_id,
    target_ref:input.target_ref,
    effect_ref:input.effect_ref,
    parameters:Object.freeze({...input.parameters}),
  })};
}
