import {
  decodeCapabilitySelection, encodeCapabilitySelection,
} from "../../packages/bootstrap/src/capability.js";

// The template posture decides whether a node needs the bounded privileged
// helper or the dedicated user-service/Linger lane. Those components are the
// ones that must ship pinned artifacts with the claim.
export const CAPABILITY_COMPONENTS = Object.freeze(["privileged_helper", "user_manager", "linger"]);

export function templateRequiresCapability(installationPlan) {
  const ids = (installationPlan?.components ?? []).map((component) => component.id);
  return CAPABILITY_COMPONENTS.some((id) => ids.includes(id));
}

/**
 * Deployment-owned pinned artifacts. The bundle is the compact selection text
 * without a ticket binding; the ticket's own template digest is injected per
 * claim so a selection can never be replayed onto another template.
 */
export function createCapabilitySelectionProvider({ bundle_base64 = "" } = {}) {
  const encoded = typeof bundle_base64 === "string" ? bundle_base64.trim() : "";
  if (!encoded) return null;
  const text = Buffer.from(encoded, "base64").toString("utf8");
  // Validated and digest-checked once at startup, never per request.
  const template = decodeCapabilitySelection(text, { templateDigest: "sha256:" + "0".repeat(64) });
  return Object.freeze({
    version: template.version,
    async select({ template_digest }) {
      if (typeof template_digest !== "string") throw new Error("CAPABILITY_TEMPLATE_DIGEST_REQUIRED");
      return Object.freeze({
        encoded: encodeCapabilitySelection(template, { templateDigest: template_digest }),
        template_digest,
      });
    },
  });
}
