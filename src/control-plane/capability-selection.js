import {
  decodeCapabilitySelection, selectionCovers,
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
 * Deployment-owned pinned artifacts. The bundle is a complete selection,
 * including the template digest it was reviewed for: a bundle can never be
 * relabelled onto another template, so the controller's binding check is real.
 */
export function createCapabilitySelectionProvider({ bundle_base64 = "" } = {}) {
  const encoded = typeof bundle_base64 === "string" ? bundle_base64.trim() : "";
  if (!encoded) return null;
  const text = Buffer.from(encoded, "base64").toString("utf8");
  // Validated and digest-checked once at startup, never per request.
  const selection = decodeCapabilitySelection(text);
  return Object.freeze({
    version: selection.version,
    template_digest: selection.template_digest,
    selection,
    async select() {
      return Object.freeze({
        encoded,
        template_digest: selection.template_digest,
        selection,
      });
    },
  });
}

export function selectionMissingComponents(selection, installationPlan) {
  const required = (installationPlan?.components ?? []).map((component) => component.id);
  return selectionCovers(selection, required);
}
