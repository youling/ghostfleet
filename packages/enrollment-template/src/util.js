import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonicalize(value[key])]));
}
export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}
export function sha256(value) {
  return "sha256:" + createHash("sha256").update(typeof value === "string" ? value : canonicalStringify(value)).digest("hex");
}
export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export function deepMerge(base, patch) {
  if (patch === undefined) return clone(base);
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const out = (base && typeof base === "object" && !Array.isArray(base)) ? clone(base) : {};
  for (const [key,value] of Object.entries(patch)) out[key]=deepMerge(out[key],value);
  return out;
}
export function getPath(obj,path) {
  return String(path).split(".").reduce((value,key)=>value?.[key],obj);
}
export function setPath(obj,path,value) {
  const parts=String(path).split(".");
  let current=obj;
  for(let i=0;i<parts.length-1;i++) current=current[parts[i]] ??= {};
  current[parts.at(-1)]=clone(value);
}
