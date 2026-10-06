import { validateIpcEnvelope } from "./protocol.js";

function publicReceipt(envelope,result) {
  return Object.freeze({
    schema:"ghostfleet-privileged-helper-receipt/v1",
    request_id:envelope.request_id,
    lease_id:envelope.lease_id,
    operation_id:envelope.operation_id,
    target_ref:envelope.target_ref,
    effect_ref:envelope.effect_ref,
    result:result.result,
    code:result.code ?? null,
    before_state_ref:result.before_state_ref ?? null,
    after_state_ref:result.after_state_ref ?? null,
    recovery_ref:result.recovery_ref ?? null,
  });
}

export function createPrivilegedHelper({leaseVerifier,operations,effectFences}) {
  if(typeof leaseVerifier!=="function") throw new Error("LEASE_VERIFIER_REQUIRED");
  if(!operations?.get) throw new Error("OPERATIONS_REQUIRED");
  if(!effectFences) throw new Error("EFFECT_FENCES_REQUIRED");

  return Object.freeze({
    async handle(input,{caller_ref,helper_ref,node_uid}={}) {
      const validated=validateIpcEnvelope(input);
      if(!validated.ok) return Object.freeze({ok:false,receipt:null,code:validated.code});
      const envelope=validated.envelope;
      const operation=operations.get(envelope.operation_id);
      if(!operation) return Object.freeze({ok:false,receipt:publicReceipt(envelope,{result:"DENIED",code:"UNKNOWN_TYPED_OPERATION"}),code:"UNKNOWN_TYPED_OPERATION"});

      const authority=await leaseVerifier({
        lease_id:envelope.lease_id,
        context:{subject_ref:caller_ref,audience_ref:helper_ref,node_uid,operation_id:envelope.operation_id,scope_ref:envelope.target_ref,parameters:envelope.parameters},
      });
      if(!authority?.ok) return Object.freeze({ok:false,receipt:publicReceipt(envelope,{result:"DENIED",code:authority?.code ?? "LEASE_DENIED"}),code:authority?.code ?? "LEASE_DENIED"});

      if(operation.mutating) {
        const reserved=effectFences.reserve(envelope.effect_ref);
        if(!reserved.ok) return Object.freeze({ok:false,receipt:publicReceipt(envelope,{result:"DENIED",code:reserved.code}),code:reserved.code});
      }

      let result;
      try {
        result=await operation.execute(envelope);
      } catch {
        result={result:operation.mutating?"RECONCILE_REQUIRED":"FAILED",code:"OPERATION_EXCEPTION"};
      }

      if(operation.mutating) {
        if(result.result==="SUCCESS") effectFences.commit(envelope.effect_ref);
        else if(result.result==="RECONCILE_REQUIRED") effectFences.reconcile(envelope.effect_ref);
        else effectFences.reconcile(envelope.effect_ref);
      }
      const receipt=publicReceipt(envelope,result);
      return Object.freeze({ok:result.result==="SUCCESS",receipt,code:result.code ?? null});
    },
  });
}
