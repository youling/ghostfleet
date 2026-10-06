export function createEffectFenceStore() {
  const states = new Map();
  return Object.freeze({
    reserve(effect_ref) {
      if (!effect_ref) return { ok:false, code:"EFFECT_REF_REQUIRED" };
      if (states.has(effect_ref)) return { ok:false, code:"EFFECT_FENCE_REPLAY", state:states.get(effect_ref) };
      states.set(effect_ref, "RESERVED");
      return { ok:true, state:"RESERVED" };
    },
    commit(effect_ref) {
      if (states.get(effect_ref) !== "RESERVED") return { ok:false, code:"EFFECT_FENCE_NOT_RESERVED", state:states.get(effect_ref) ?? null };
      states.set(effect_ref, "COMMITTED");
      return { ok:true, state:"COMMITTED" };
    },
    reconcile(effect_ref) {
      if (states.get(effect_ref) !== "RESERVED") return { ok:false, code:"EFFECT_FENCE_NOT_RESERVED", state:states.get(effect_ref) ?? null };
      states.set(effect_ref, "RECONCILE_REQUIRED");
      return { ok:true, state:"RECONCILE_REQUIRED" };
    },
    state(effect_ref) { return states.get(effect_ref) ?? "AVAILABLE"; },
  });
}
