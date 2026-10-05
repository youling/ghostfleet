/** Optional authorization building blocks; importing them creates no ingress or token issuer. */
export * from "./auth.js";
export * from "./ownerConsent.js";
export * from "./oauthIngress.js";
export * from "./clientProfile.js";
/** Provider-specific Access JWT validation is explicit and deployment-configured. */
export * from "./access.js";
