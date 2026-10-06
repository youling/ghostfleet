import { deepFreeze } from "../util.js";

export const CREDENTIAL_CLASSES = deepFreeze([
  "TRANSPORT_IDENTITY",
  "NODE_IDENTITY",
  "LEASE_SIGNING_AUTHORITY",
  "NODE_HELPER_TRUST_ROOT",
  "SECRET_REFERENCE",
  "BREAK_GLASS_RECOVERY_AUTHORITY",
]);

export function validateCredentialClassBindings(bindings = {}) {
  const seen = new Map();
  for (const credentialClass of CREDENTIAL_CLASSES) {
    const ref = bindings[credentialClass];
    if (!ref) continue;
    if (seen.has(ref)) {
      return deepFreeze({
        ok:false,
        code:"CREDENTIAL_CLASS_COLLAPSE",
        classes:[seen.get(ref), credentialClass],
        ref,
      });
    }
    seen.set(ref, credentialClass);
  }
  return deepFreeze({ ok:true });
}
