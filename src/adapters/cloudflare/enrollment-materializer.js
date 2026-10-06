import { assertPublicSafe } from "../../core/security.js";

export function createEnrollmentClaimMaterializer(env) {
  const service = env?.GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER;
  const ready = env?.GHOSTFLEET_ENROLLMENT_CLAIM_READY === "1";
  if (!ready || !service || typeof service.fetch !== "function") return null;
  // Contract: this service resolves already-authorized/pre-materialized one-time
  // enrollment material from private deployment custody. It MUST NOT rely on
  // callback retries to mint irreversible provider state.
  return async ({ attempt, ticket, preflight_digest }) => {
    const payload = {
      protocol: "ghostfleet-enrollment-claim-material/v1",
      attempt_id: attempt.attempt_id,
      template_binding: attempt.template_binding,
      ticket_id: ticket.ticket_id,
      preflight_digest,
    };
    assertPublicSafe(payload);
    let response;
    try {
      response = await service.fetch("https://service.invalid/v1/materialize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      return { outcome: "UNKNOWN", reason_code: "CLAIM_MATERIALIZER_OUTCOME_UNKNOWN" };
    }
    let data = {};
    try { data = await response.json(); } catch {}
    if (response.status === 409 || response.status === 503) {
      return { outcome: "BLOCKED", code: data?.error || "PROVIDER_CLAIM_MATERIAL_UNAVAILABLE" };
    }
    if (!response.ok) return { outcome: "UNKNOWN", reason_code: "CLAIM_MATERIALIZER_OUTCOME_UNKNOWN" };
    return data;
  };
}
