const SECRETISH = /(secret|password|private.?key|bearer|access.?token|refresh.?token|api.?token|auth.?key|credential)/i;

function isReferenceKey(key) { return /(_ref|_reference|_id)$/.test(key); }

export class UnsafePublicPayloadError extends Error {
  constructor(path) {
    super("raw secret-bearing field is not allowed on the public contract: " + path);
    this.name = "UnsafePublicPayloadError";
    this.code = "UNSAFE_PUBLIC_PAYLOAD";
  }
}

export function assertPublicSafe(value, path = "$") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertPublicSafe(item, path + "[" + index + "]")); return; }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path + "." + key;
    if (SECRETISH.test(key) && !isReferenceKey(key)) throw new UnsafePublicPayloadError(childPath);
    assertPublicSafe(child, childPath);
  }
}

export function publicClone(value) { assertPublicSafe(value); return structuredClone(value); }
