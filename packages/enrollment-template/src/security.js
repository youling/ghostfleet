const SENSITIVE_KEY=/(password|passwd|private[_-]?key|access[_-]?token|auth[_-]?key|secret(?:_value)?)/i;
const SAFE_REFERENCE=/(?:_ref|_reference|reference)$/i;

export function findPlaintextSecret(value,path="") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i=0;i<value.length;i++) {
      const found=findPlaintextSecret(value[i],path+"["+i+"]");
      if(found) return found;
    }
    return null;
  }
  for(const [key,child] of Object.entries(value)) {
    const next=path ? path+"."+key : key;
    if (SENSITIVE_KEY.test(key) && !SAFE_REFERENCE.test(key)) {
      if (child !== null && child !== undefined && child !== false) return next;
    }
    const found=findPlaintextSecret(child,next);
    if(found) return found;
  }
  return null;
}
export function assertSecretSafe(value) {
  const path=findPlaintextSecret(value);
  if(path) throw new Error("SECRET_PLAINTEXT_FORBIDDEN:"+path);
  return true;
}
