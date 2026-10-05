import { Buffer } from "buffer";
import type { AccessOwner } from "./access.js";

const COOKIE = "__Host-fleet-consent";
const TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const encoder = new TextEncoder();
const securityHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
function fail(code: string, status = 403): Response {
  return new Response(code, { status, headers: securityHeaders });
}
function usableSecret(secret: string): boolean {
  return !!secret && secret.length >= 24 && secret.length <= 4096 && !/\s/.test(secret);
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function canonicalOrigin(origin:string):boolean {
  try {const url=new URL(origin);return url.protocol==="https:" && url.origin===origin && !url.username && !url.password;} catch {return false;}
}
export async function ownerConsentForm(request: Request, secret: string, clientName: string, owner: AccessOwner, origin:string): Promise<Response> {
  if (!usableSecret(secret)) return fail("OWNER_AUTH_NOT_CONFIGURED", 503);
  if(!canonicalOrigin(origin) || new URL(request.url).origin!==origin) return fail("CONSENT_URL_ORIGIN_REJECTED");
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ nonce, origin, subject: owner.subject, email: owner.email, query: new URL(request.url).search, expires: Date.now() + TTL_MS })).toString("base64url");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(`ghostfleet-consent-v2:${payload}`));
  const proof = `${payload}.${Buffer.from(signature).toString("base64url")}`;
  const requested = new URL(request.url).searchParams.get("scope") ?? "";
  const descriptions:Record<string,string> = {
    "fleet.read":"Read configured node observations and service status.",
    "fleet.operate":"Run explicitly allowed bounded service operations.",
    "fleet.exec":"Run arbitrary shell commands with the target account's ordinary authority.",
    "fleet.privileged":"Run only explicitly policy-allowed privileged Fleet operations through the dedicated ops identity; this is separate from shell authority.",
    "offline_access":"Keep this connection authorized using refresh tokens.",
  };
  const permissions = requested.split(" ").filter(Boolean).map(scope=>`<li>${escape(scope)}: ${escape(descriptions[scope] ?? "Unknown permission")}</li>`).join("");
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fleet Control authorization</title>
<h1>Authorize Fleet Control</h1><p>Client: ${escape(clientName)}</p>
<p>Approve only a connection you started yourself.</p><ul>${permissions}</ul>
<p>Signed in through Cloudflare Access as ${escape(owner.email)}. No SSH key or API token is needed.</p>
<p><a href="/authorize?approval=1&amp;proof=${escape(proof)}">Authorize this connection</a></p></html>`;
  return new Response(body, { headers: {
    ...securityHeaders, "content-type": "text/html; charset=utf-8",
    "set-cookie": `${COOKIE}=${nonce}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict`,
  } });
}
async function readBoundedForm(request: Request): Promise<URLSearchParams> {
  if (!request.body) throw new Error("EMPTY_BODY");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > MAX_BODY) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); } chunks.push(value);
  } } finally { reader.releaseLock(); }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
export async function verifyOwnerConsentLink(request: Request, secret: string, origin: string, owner: AccessOwner): Promise<string | Response> {
  if (!usableSecret(secret)) return fail("OWNER_AUTH_NOT_CONFIGURED", 503);
  const url = new URL(request.url);
  if (!canonicalOrigin(origin) || request.method !== "GET" || url.origin !== origin) return fail("CONSENT_LINK_INVALID");
  if (url.searchParams.getAll("approval").length !== 1 || url.searchParams.get("approval") !== "1" || url.searchParams.getAll("proof").length !== 1) return fail("CONSENT_LINK_INVALID");
  if ([...url.searchParams.keys()].some((key) => key !== "approval" && key !== "proof")) return fail("CONSENT_LINK_INVALID");
  const proof = url.searchParams.get("proof") ?? "";
  const parts = proof.split(".");
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return fail("CONSENT_INVALID");
  try {
    const [payload, signature] = parts;
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), new Uint8Array(Buffer.from(signature!, "base64url")), encoder.encode(`ghostfleet-consent-v2:${payload}`));
    if (!valid) return fail("CONSENT_INVALID");
    const state = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { nonce?: unknown; origin?:unknown; query?: unknown; expires?: unknown; subject?: unknown; email?: unknown };
    if(state.origin!==origin) return fail("CONSENT_PROOF_ORIGIN_MISMATCH");
    if (typeof state.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state.nonce)) return fail("CONSENT_NONCE_INVALID");
    if (typeof state.expires !== "number" || state.expires <= Date.now() || state.expires > Date.now() + TTL_MS) return fail("CONSENT_EXPIRED");
    if (typeof state.query !== "string" || !state.query.startsWith("?") || state.query.length > 8192) return fail("CONSENT_INVALID");
    if (state.subject !== owner.subject || state.email !== owner.email) return fail("CONSENT_OWNER_MISMATCH");
    return state.query;
  } catch { return fail("CONSENT_INVALID"); }
}

export async function verifyOwnerConsent(request: Request, secret: string, origin: string, owner: AccessOwner): Promise<string | Response> {
  if (!usableSecret(secret)) return fail("OWNER_AUTH_NOT_CONFIGURED", 503);
  if (!canonicalOrigin(origin) || new URL(request.url).origin !== origin) return fail("CONSENT_URL_ORIGIN_REJECTED");
  const headerOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return fail("CONSENT_FETCH_SITE_REJECTED");
  if (headerOrigin !== null && headerOrigin !== origin) {
    const accessForwardedSameSite = headerOrigin === "null" && (fetchSite === "same-origin" || fetchSite === "same-site");
    if (!accessForwardedSameSite) return fail(headerOrigin === "null" ? "CONSENT_HEADER_ORIGIN_NULL" : "CONSENT_HEADER_ORIGIN_REJECTED");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/x-www-form-urlencoded") return fail("CONSENT_FORM_REQUIRED", 415);
  try {
    const form = await readBoundedForm(request);
    if (["proof", "consent"].some((key) => form.getAll(key).length !== 1)) return fail("CONSENT_INVALID");
    const parts = (form.get("proof") ?? "").split(".");
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return fail("CONSENT_INVALID");
    const [payload, signature] = parts;
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), new Uint8Array(Buffer.from(signature!, "base64url")), encoder.encode(`ghostfleet-consent-v2:${payload}`));
    if (!valid) return fail("CONSENT_INVALID");
    const state = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { nonce?: unknown; origin?:unknown; query?: unknown; expires?: unknown; subject?: unknown; email?: unknown };
    if(state.origin!==origin) return fail("CONSENT_PROOF_ORIGIN_MISMATCH");
    const cookies = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
    if (typeof state.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state.nonce)) return fail("CONSENT_NONCE_INVALID");
    if (cookies.length > 1) return fail("CONSENT_COOKIE_DUPLICATE");
    if (cookies.length === 1 && cookies[0] !== `${COOKIE}=${state.nonce}`) return fail("CONSENT_COOKIE_MISMATCH");
    if (typeof state.expires !== "number" || state.expires <= Date.now() || state.expires > Date.now() + TTL_MS) return fail("CONSENT_EXPIRED");
    if (typeof state.query !== "string" || !state.query.startsWith("?") || state.query.length > 8192) return fail("CONSENT_INVALID");
    if (form.get("consent") !== "approve") return fail("EXPLICIT_CONSENT_REQUIRED");
    if (state.subject !== owner.subject || state.email !== owner.email) return fail("CONSENT_OWNER_MISMATCH");
    return state.query;
  } catch { return fail("CONSENT_INVALID"); }
}
export function approvedRedirect(location: string): Response {
  return new Response(null, { status: 302, headers: {
    ...securityHeaders, location,
    "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
  } });
}
