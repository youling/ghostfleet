/**
 * GhostFleet one-time enrollment bridge.
 *
 * Public by necessity, narrow by construction. The ONLY reachable surface is:
 *   POST /v1/enrollment-tickets/<ticket id>/claim
 *   POST /v1/enroll/complete
 *
 * Everything else is 404/405. Both routes are authenticated by the ticket
 * itself (short code + resume session) inside the control plane; this bridge
 * never authenticates, never mints, and never forwards a Console credential.
 * The control plane stays private behind the service binding.
 *
 * This file is the single implementation of that boundary. A deployment only
 * supplies configuration (bindings, routes, body limits unchanged); it must not
 * fork this code. See README.md for the configuration contract.
 */
const CLAIM = /^\/v1\/enrollment-tickets\/(ticket-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/claim$/;
const COMPLETE = "/v1/enroll/complete";

// The bridge is public and unauthenticated, and the control plane is one global
// serialized object. Buffer at most one short code or one bounded completion
// report; anything larger is a 413 before the service binding is touched.
export const BODY_LIMITS = Object.freeze({ claim: 1024, complete: 262144 });

// Advisory only. A rate limiter is not an authorization decision, and its
// absence or failure must never block a legitimate first enrollment.
export const RATE_LIMIT_RETRY_SECONDS = 30;

// Forward only what the control plane actually consumes. Everything else is
// dropped, so a caller cannot smuggle a Console credential, an Access JWT, a
// spoofed client address or an unexpected content type across the boundary.
export const FORWARDED_HEADERS = Object.freeze([
  "content-type",
  "x-ghostfleet-preflight-digest",
  "x-fleet-os-family",
  "x-fleet-os-id",
]);

const problem = (status, error, extra = {}) => new Response(
  JSON.stringify({ ok: false, error, ...extra }) + "\n",
  { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
);

const tooLarge = () => problem(413, "REQUEST_BODY_TOO_LARGE");
const rateLimited = () => problem(429, "ENROLLMENT_RATE_LIMITED", { retry_after_seconds: RATE_LIMIT_RETRY_SECONDS });

async function boundedBody(request, limit) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

// Keys are derived, never raw: the limiter receives a stable digest, and neither
// the address nor the ticket id is written to a log by this Worker.
async function derivedKey(prefix, value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return prefix + hex.slice(0, 32);
}

/**
 * Advisory rate limit. Returns true (deny) only when the binding explicitly
 * answers success:false. Everything else fails open: a missing binding, a
 * throwing property getter, an unavailable WebCrypto, a throw from limit(), or
 * a malformed answer. The limiter may slow abuse; it must never gate a real
 * first enrollment, and a success here is never authorization.
 *
 * The binding is resolved inside the try on purpose: a Proxy/getter that throws
 * or an environment without crypto must still be an "allow", not a 500.
 */
async function advisoryDenied(resolveBinding, prefix, value) {
  try {
    const binding = resolveBinding();
    if (!binding || typeof binding.limit !== "function") return false;
    const outcome = await binding.limit({ key: await derivedKey(prefix, value) });
    if (!outcome || typeof outcome !== "object") return false;
    return outcome.success === false;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return problem(405, "METHOD_NOT_ALLOWED", { allow: "POST" });
    const url = new URL(request.url);
    const claimMatch = CLAIM.exec(url.pathname);
    const route = claimMatch || url.pathname === COMPLETE;
    // A query string would be an unreviewed handle; the ticket is in the path.
    if (url.search || !route) return problem(404, "NOT_FOUND");
    const control = env?.GHOSTFLEET_CONTROL_PLANE;
    if (!control || typeof control.fetch !== "function") return problem(503, "ENROLLMENT_BRIDGE_UNAVAILABLE");

    // Per-IP and per-ticket limits are independent advisory dimensions: an
    // address limit slows a single source, a ticket limit stops replay storms
    // against one one-time handle. Either one denying is enough to answer 429.
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp && (await advisoryDenied(() => env?.RATE_LIMITER_IP, "ip:", clientIp))) return rateLimited();
    if (claimMatch && (await advisoryDenied(() => env?.RATE_LIMITER_TICKET, "ticket:", claimMatch[1]))) return rateLimited();

    const bounded = await boundedBody(request, url.pathname === COMPLETE ? BODY_LIMITS.complete : BODY_LIMITS.claim);
    if (bounded.tooLarge) return tooLarge();

    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    let upstream;
    try {
      upstream = await control.fetch("https://control-plane.invalid" + url.pathname, {
        method: "POST",
        headers,
        body: bounded.text,
        duplex: "half",
      });
    } catch {
      return problem(503, "ENROLLMENT_BRIDGE_UNAVAILABLE");
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
