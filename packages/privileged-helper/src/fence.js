export function createHelperEffectFenceStore() {
  const states=new Map();
  return Object.freeze({
    reserve(ref) {
      if(!ref) return {ok:false,code:"EFFECT_REF_REQUIRED"};
      if(states.has(ref)) return {ok:false,code:"EFFECT_FENCE_REPLAY",state:states.get(ref)};
      states.set(ref,"RESERVED"); return {ok:true,state:"RESERVED"};
    },
    commit(ref) {
      if(states.get(ref)!=="RESERVED") return {ok:false,code:"EFFECT_FENCE_NOT_RESERVED"};
      states.set(ref,"COMMITTED"); return {ok:true,state:"COMMITTED"};
    },
    reconcile(ref) {
      if(states.get(ref)!=="RESERVED") return {ok:false,code:"EFFECT_FENCE_NOT_RESERVED"};
      states.set(ref,"RECONCILE_REQUIRED"); return {ok:true,state:"RECONCILE_REQUIRED"};
    },
    state:(ref)=>states.get(ref) ?? "AVAILABLE",
  });
}
