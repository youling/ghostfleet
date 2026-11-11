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

    const headers = new Headers(request.headers);
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
        body: request.body,
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
