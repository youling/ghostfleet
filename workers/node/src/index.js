/**
 * GhostFleet node agent ingress bridge.
 *
 * The resident node agent holds a node credential, never an operator bearer and
 * never an Access session. This bridge is the only public surface that credential
 * may cross:
 *
 *   POST /v0/nodes/<node_uid>/heartbeat
 *   POST /v0/nodes/<node_uid>/tasks/poll
 *   POST /v0/nodes/<node_uid>/tasks/<task_id>/result
 *
 * Everything else - any path, any method, any query string - is a flat 404, so
 * the bridge does not confirm which routes exist. It never authenticates: the
 * control plane verifies the token digest, the node scope, the clock, the replay
 * window and the token bucket inside its single durable object. This bridge only
 * caps the body, fixes the media type, allowlists four headers and drops the rest.
 *
 * This file is the single implementation of that boundary (workers/README.md).
 */
const NODE_UID = "[a-z0-9][a-z0-9_-]{0,63}";
const TASK_ID = "[a-z0-9][a-z0-9_-]{0,63}";

// One route table, in the ADR's order. The strict character classes are the
// contract: a percent-encoded or uppercase uid is not a node handle.
export const ROUTES = Object.freeze([
  { kind: "heartbeat", path: new RegExp("^/v0/nodes/(" + NODE_UID + ")/heartbeat$"), limit: "heartbeat" },
  { kind: "poll", path: new RegExp("^/v0/nodes/(" + NODE_UID + ")/tasks/poll$"), limit: "poll" },
  { kind: "result", path: new RegExp("^/v0/nodes/(" + NODE_UID + ")/tasks/(" + TASK_ID + ")/result$"), limit: "result" },
]);

// §5.1 body caps. Duplicated here on purpose: the public edge must refuse an
// anonymous oversized body before the service binding is touched, and the
// control plane enforces the same numbers again on its side.
export const BODY_LIMITS = Object.freeze({ heartbeat: 16 * 1024, poll: 4 * 1024, result: 64 * 1024 });

export const CONTENT_TYPES = Object.freeze({ node: "application/json" });

// Advisory only; a limiter is never an authorization decision.
export const RATE_LIMIT_RETRY_SECONDS = 10;

// Forward only what the control plane consumes. A forged x-forwarded-for, a
// cookie, an Access JWT or an arbitrary header never crosses the binding.
export const FORWARDED_HEADERS = Object.freeze([
  "authorization",
  "content-type",
  "x-ghostfleet-node-uid",
  "x-ghostfleet-agent-version",
]);

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});

const problem = (status, error, extra = {}) => new Response(
  JSON.stringify({ ok: false, error, ...extra }) + "\n",
  { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS } },
);

const notFound = () => problem(404, "NOT_FOUND");
const tooLarge = () => problem(413, "NODE_BODY_TOO_LARGE");
const unsupportedType = () => problem(415, "UNSUPPORTED_CONTENT_TYPE");
const unconfigured = () => problem(503, "NODE_PLANE_NOT_CONFIGURED");
const unavailable = () => problem(503, "NODE_PLANE_UNAVAILABLE");
const rateLimited = () => problem(429, "NODE_RATE_LIMITED", { retry_after_seconds: RATE_LIMIT_RETRY_SECONDS });

/** Media type only: parameters (charset, ...) are allowed. */
function mediaType(value) {
  if (typeof value !== "string") return null;
  return value.split(";")[0].trim().toLowerCase();
}

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

// Keys are derived, never raw: the limiter receives a digest, so a node uid is
// never written to a log or a limiter store by this Worker.
async function derivedKey(prefix, value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return prefix + hex.slice(0, 32);
}

/**
 * Advisory per-node limit. Denies only on an explicit success:false; a missing
 * binding, a throwing getter, no WebCrypto, a throwing limit() or a malformed
 * answer all fail open. Success here is never authorization.
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
    const url = new URL(request.url);
    // No 405: a non-POST is indistinguishable from an unknown path, and no
    // query string is part of this contract. The raw URL is checked because a
    // bare "?" parses to an empty url.search while still being a query string.
    if (request.method !== "POST") return notFound();
    if (request.url.includes("?")) return notFound();
    const route = ROUTES.find((entry) => entry.path.test(url.pathname));
    if (!route) return notFound();
    const match = route.path.exec(url.pathname);
    const nodeUid = match[1];

    // Shape before authority: wrong media type is refused before the body read
    // and before the service binding.
    if (mediaType(request.headers.get("content-type")) !== CONTENT_TYPES.node) return unsupportedType();

    // Cap the body before the binding: an anonymous caller must never make the
    // single serialized control-plane object buffer unbounded bytes.
    const bounded = await boundedBody(request, BODY_LIMITS[route.limit]);
    if (bounded.tooLarge) return tooLarge();

    const control = env?.GHOSTFLEET_CONTROL_PLANE;
    if (!control || typeof control.fetch !== "function") return unconfigured();

    if (await advisoryDenied(() => env?.NODE_PLANE_RATE_LIMITER, "node:", nodeUid)) return rateLimited();

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
      return unavailable();
    }
    const responseHeaders = {
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
    };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter !== null) responseHeaders["retry-after"] = retryAfter;
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};
