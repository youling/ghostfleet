import { assertPublicSafe } from "../../core/security.js";

function privateEnrollmentService(env) {
  const service = env?.GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER;
  const ready = env?.GHOSTFLEET_ENROLLMENT_CLAIM_READY === "1";
  if (!ready || !service || typeof service.fetch !== "function") return null;
  return service;
}

async function invoke(service, path, payload, {
  blockedCode = "PROVIDER_CLAIM_MATERIAL_UNAVAILABLE",
  unknownReason = "CLAIM_MATERIALIZER_OUTCOME_UNKNOWN",
} = {}) {
  assertPublicSafe(payload);
  let response;
  try {
    response = await service.fetch("https://service.invalid" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { outcome: "UNKNOWN", reason_code: unknownReason };
  }
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 409 || response.status === 503) {
    return { outcome: "BLOCKED", code: data?.error || blockedCode };
  }
  if (!response.ok) return { outcome: "UNKNOWN", reason_code: unknownReason };
  return data;
}

export function createEnrollmentClaimPreparer(env) {
  const service = privateEnrollmentService(env);
  if (!service) return null;
  // Preparation is keyed by the durable EnrollmentAttempt. The private service
  // may mint/pre-materialize one-time authority here, but it MUST reconcile an
  // ambiguous retry by attempt_id instead of minting a second credential.
  return async ({ attempt, requested_ttl_seconds }) => invoke(service, "/v1/prepare", {
    protocol: "ghostfleet-enrollment-claim-prepare/v1",
    attempt_id: attempt.attempt_id,
    template_binding: attempt.template_binding,
    requested_ttl_seconds,
  }, {
    blockedCode: "PROVIDER_CLAIM_PREPARATION_UNAVAILABLE",
    unknownReason: "CLAIM_PREPARATION_OUTCOME_UNKNOWN",
  });
}

export function createEnrollmentClaimMaterializer(env) {
  const service = privateEnrollmentService(env);
  if (!service) return null;
  // Claim only consumes already-authorized/pre-materialized one-time material.
  // It MUST NOT rely on callback retries to mint irreversible provider state.
  return async ({ attempt, ticket, preflight_digest }) => invoke(service, "/v1/materialize", {
    protocol: "ghostfleet-enrollment-claim-material/v1",
    attempt_id: attempt.attempt_id,
    template_binding: attempt.template_binding,
    ticket_id: ticket.ticket_id,
    preflight_digest,
  });
}
