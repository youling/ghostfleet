/**
 * GhostFleet immutable material origin.
 *
 * Contract:
 *   GET/HEAD /sha256/<64 lowercase hex>  -> the exact bytes reviewed for that digest
 *   anything else                        -> 404
 *
 * There is no listing, no upload, no auth, no redirect and no dynamic content.
 * "Content addressed" is not "encrypted": everything here is public by design,
 * and scripts/build-assets.mjs refuses to publish secret-shaped material.
 */
const DIGEST_PATH = /^\/sha256\/([0-9a-f]{64})$/;

const refusal = (status, message, extra = {}) => new Response(message + "\n", {
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return refusal(405, "method not allowed", { allow: "GET, HEAD" });
    }
    // The digest is the whole address. A query string or a second path segment
    // would create a second, uncontrolled cache key for the same object.
    if (url.search || !DIGEST_PATH.test(url.pathname)) return refusal(404, "not found");
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== "function") {
      // Misconfigured deployment: fail closed rather than serving from a
      // different origin or falling back to the Worker's own URL space.
      return refusal(503, "asset binding unavailable");
    }
    const fetched = await env.ASSETS.fetch(new Request(url.origin + url.pathname, { method: request.method }));
    if (fetched.status !== 200) return refusal(404, "not found");
    // Never copy the upstream header bag: an asset layer can add its own
    // metadata, and this origin publishes bytes, not headers.
    const headers = new Headers({
      "content-type": "application/octet-stream",
      // Immutable: the bytes behind a digest can never change, and a mismatch is
      // the client's verification failure, never a silent update.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    const length = fetched.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(request.method === "HEAD" ? null : fetched.body, { status: 200, headers });
  },
};
