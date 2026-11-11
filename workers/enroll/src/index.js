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
 */
const CLAIM = /^\/v1\/enrollment-tickets\/ticket-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/claim$/;
const COMPLETE = "/v1/enroll/complete";
// The bridge is public and unauthenticated, and the control plane is one global
// serialized object. Buffer at most one short code or one bounded completion
// report; anything larger is a 413 before the service binding is touched.
export const BODY_LIMITS = Object.freeze({ claim: 1024, complete: 262144 });

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

const tooLarge = () => new Response(JSON.stringify({ ok: false, error: "REQUEST_BODY_TOO_LARGE" }) + "\n", {
  status: 413,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const refusal = (status, message, extra = {}) => new Response(message + "\n", {
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
});

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return refusal(405, "method not allowed", { allow: "POST" });
    const url = new URL(request.url);
    const route = CLAIM.test(url.pathname) || url.pathname === COMPLETE;
    // A query string would be an unreviewed handle; the ticket is in the path.
    if (url.search || !route) return refusal(404, "not found");
    const control = env?.GHOSTFLEET_CONTROL_PLANE;
    if (!control || typeof control.fetch !== "function") return refusal(503, "enrollment bridge unavailable");

    const bounded = await boundedBody(request, url.pathname === COMPLETE ? BODY_LIMITS.complete : BODY_LIMITS.claim);
    if (bounded.tooLarge) return tooLarge();

    const headers = new Headers(request.headers);
    // The forwarded body is the bounded text, so a stale upstream length would
    // be wrong; the runtime sets the correct one.
    headers.delete("content-length");
    // The bridge is unauthenticated, so it must never forward or inject Console
    // credentials. The ticket path is the only identity that crosses.
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("x-forwarded-host");

    let upstream;
    try {
      upstream = await control.fetch("https://control-plane.invalid" + url.pathname, {
        method: "POST",
        headers,
        body: bounded.text,
        duplex: "half",
      });
    } catch {
      return refusal(503, "enrollment bridge unavailable");
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
