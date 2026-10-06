import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CODE_RE = /^[0-9]{8}$/;

export class EnrollmentTicketError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "EnrollmentTicketError";
    this.code = code;
    this.status = status;
  }
}

export function sha256Text(value) {
  return "sha256:" + createHash("sha256").update(String(value)).digest("hex");
}

function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createTicketFactors({
  codeFactory = () => String(randomBytes(4).readUInt32BE(0) % 100000000).padStart(8, "0"),
} = {}) {
  const short_code = String(codeFactory());
  if (!CODE_RE.test(short_code)) throw new EnrollmentTicketError("TICKET_SHORT_CODE_INVALID");
  return Object.freeze({ short_code });
}

export function createTicketRecord({ ticket_id, attempt, short_code, issued_at, expires_at }) {
  if (!ticket_id || !attempt?.attempt_id || !attempt?.template_binding?.template_digest) throw new EnrollmentTicketError("TICKET_BINDING_REQUIRED");
  return Object.freeze({
    ticket_id,
    attempt_id: attempt.attempt_id,
    template_id: attempt.template_binding.template_id,
    template_generation: attempt.template_binding.template_generation,
    template_digest: attempt.template_binding.template_digest,
    state: "ISSUED",
    short_code_digest: sha256Text(short_code),
    failed_claims: 0,
    issued_at,
    expires_at,
    preflight_digest: null,
    consumed_at: null,
    resume_capability_digest: null,
    identity_kind: null,
    enrollment_id: null,
    node_id: null,
    node_uid: null,
    completed_at: null,
    completion_digest: null,
    reason_code: null,
  });
}

export function publicTicketMetadata(record) {
  if (!record) throw new EnrollmentTicketError("TICKET_NOT_FOUND", 404);
  const claim_material_state = record.state === "ISSUED" ? "SHORT_CODE_PRESENT_ONCE_IN_DELIVERY" :
    ["CONSUMED", "COMPLETED"].includes(record.state) ? "CONSUMED" : "DESTROYED_OR_INVALID";
  return Object.freeze({
    ticket_id: record.ticket_id,
    attempt_id: record.attempt_id,
    template_id: record.template_id,
    template_generation: record.template_generation,
    template_digest: record.template_digest,
    state: record.state,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    failed_claims: record.failed_claims,
    preflight_digest: record.preflight_digest,
    claim_material_state,
    secret_value_included: false,
  });
}

export function validatePublicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new EnrollmentTicketError("PUBLIC_ORIGIN_INVALID"); }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!(url.protocol === "https:" || local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new EnrollmentTicketError("PUBLIC_ORIGIN_INVALID");
  }
  return url.origin;
}

export function createTicketDelivery({ record, short_code, public_origin }) {
  const origin = validatePublicOrigin(public_origin);
  const one_time_url = origin + "/v1/enrollment-tickets/" + encodeURIComponent(record.ticket_id);
  const bootstrap_script_url = origin + "/v1/bootstrap.sh";
  return Object.freeze({
    one_time_url,
    short_code,
    expires_at: record.expires_at,
    command: "curl -fsSL '" + bootstrap_script_url + "' | sudo env GHOSTFLEET_ENROLLMENT_URL='" + one_time_url + "' sh",
    warning: "ONE_TIME_ENROLLMENT_MATERIAL_EXECUTE_PROMPTLY",
  });
}

export function verifyTicketClaim(record, { short_code, preflight_digest, now_ms, max_failed_claims = 5 }) {
  if (!record) throw new EnrollmentTicketError("TICKET_NOT_FOUND", 404);
  if (record.state !== "ISSUED") throw new EnrollmentTicketError("TICKET_NOT_CLAIMABLE", 409);
  if (Number(now_ms) >= Date.parse(record.expires_at)) throw new EnrollmentTicketError("TICKET_EXPIRED", 410);
  if (!DIGEST_RE.test(String(preflight_digest ?? ""))) throw new EnrollmentTicketError("PREFLIGHT_DIGEST_REQUIRED", 409);
  if (!CODE_RE.test(String(short_code ?? "")) || !safeDigestEqual(record.short_code_digest, sha256Text(short_code))) {
    const failed_claims = Number(record.failed_claims ?? 0) + 1;
    const terminal = failed_claims >= max_failed_claims;
    return Object.freeze({
      ok: false,
      code: terminal ? "TICKET_LOCKED" : "TICKET_SHORT_CODE_INVALID",
      status: 403,
      record: Object.freeze({ ...record, failed_claims, state: terminal ? "REVOKED" : record.state, reason_code: terminal ? "TOO_MANY_FAILED_CLAIMS" : record.reason_code }),
    });
  }
  return Object.freeze({ ok: true });
}

export function validateClaimMaterial(material) {
  if (!material || material.outcome !== "READY") return material;
  const delivery = material.delivery;
  if (!delivery || typeof delivery !== "object") throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (typeof delivery.resume_session !== "string" || delivery.resume_session.length < 32 || delivery.resume_session.length > 256) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (typeof delivery.auth_key !== "string" || delivery.auth_key.length < 8 || delivery.auth_key.length > 512) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (!["provisional", "canonical"].includes(delivery.identity_kind)) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (typeof delivery.node_id !== "string" || !delivery.node_id || delivery.node_id.length > 128) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  if (delivery.identity_kind === "provisional") {
    if (typeof delivery.enrollment_id !== "string" || !/^enroll-[0-9a-f-]{36}$/.test(delivery.enrollment_id)) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
    if (delivery.node_uid) throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  } else if (typeof delivery.node_uid !== "string" || !delivery.node_uid) {
    throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
  }
  return material;
}

export function completionDigest(report) {
  return sha256Text(JSON.stringify(report));
}
