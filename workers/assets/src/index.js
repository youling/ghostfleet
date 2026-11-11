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

/** ETag is the content digest itself: the path names the bytes. */
const etagFor = (digest) => '"' + digest + '"';

/**
 * If-None-Match accepts a list, weak validators and "*". The stored object is
 * immutable, so a matching validator is always a true 304 for that address.
 */
function etagMatches(header, digest) {
  if (!header) return false;
  for (const token of header.split(",")) {
    const value = token.trim();
    if (value === "*") return true;
    const opaque = value.replace(/^W\//i, "").replace(/^"|"$/g, "");
    if (opaque === digest) return true;
  }
  return false;
}

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
    const match = DIGEST_PATH.exec(url.pathname);
    if (url.search || !match) return refusal(404, "not found");
    const digest = match[1];
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== "function") {
      // Misconfigured deployment: fail closed rather than serving from a
      // different origin or falling back to the Worker's own URL space.
      return refusal(503, "asset binding unavailable");
    }
    const fetched = await env.ASSETS.fetch(new Request(url.origin + url.pathname, { method: request.method }));
    if (fetched.status !== 200) return refusal(404, "not found");
    // Never copy the upstream header bag: an asset layer can add its own
    // metadata, and this origin publishes bytes, not headers.
    const etag = etagFor(digest);
    const headers = new Headers({
      // Stable for every object: the address carries no extension, and the
      // manifest that maps names to digests is never served here.
      "content-type": "application/octet-stream",
      // Immutable: the bytes behind a digest can never change, and a mismatch is
      // the client's verification failure, never a silent update.
      "cache-control": "public, max-age=31536000, immutable",
      etag,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    // A revalidator must be a true 304 for THAT address. A missing object was
    // already answered 404 above, so this never confirms a cached phantom.
    if (etagMatches(request.headers.get("if-none-match"), digest)) {
      await fetched.body?.cancel().catch(() => {});
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
      });
    }
    const length = fetched.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(request.method === "HEAD" ? null : fetched.body, { status: 200, headers });
  },
};
