import { validateCapabilityDefinition } from "../core/capabilities.js";
import {
  completeConsumerRollback,
  createConsumerAcceptance,
  evaluateConsumerAcceptance,
  recordConsumerEvidence,
  recordConsumerSignal,
} from "../core/consumer-acceptance.js";
import { createEvidence, missingAcceptanceEvidence } from "../core/evidence.js";
import { makeId, isoAfter, isoNow } from "../core/ids.js";
import { CORE_OWNED_EVIDENCE, EnrollmentState, EventType, HumanGateState, NodeLifecycle } from "../core/model.js";
import { assertPublicSafe, publicClone } from "../core/security.js";
import { InvalidTransitionError, transitionAttempt } from "../core/state-machine.js";
import { InMemoryStore } from "./store.js";
import { createEnrollmentTemplateCatalog } from "./enrollment-templates.js";
import {
  EnrollmentTicketError, completionDigest, createTicketDelivery, createTicketFactors,
  createTicketRecord, publicTicketMetadata, sha256Text, validateClaimMaterial, verifyTicketClaim,
} from "./tickets.js";

function required(value, message) { if (!value) throw new Error(message); return value; }

export class GhostFleetController {
  constructor({
    store = new InMemoryStore(),
    clock = Date,
    enrollmentTemplates = createEnrollmentTemplateCatalog(),
    enrollmentClaimMaterializer = null,
    ticketCodeFactory = undefined,
  } = {}) {
    this.store = store;
    this.clock = clock;
    this.enrollmentTemplates = enrollmentTemplates;
    this.enrollmentClaimMaterializer = enrollmentClaimMaterializer;
    this.ticketCodeFactory = ticketCodeFactory;
  }

  now() { return isoNow(this.clock); }
  after(seconds) { return isoAfter(seconds, this.clock); }

  requireLiveAttempt(attempt) {
    if (Date.parse(attempt.expires_at) <= this.clock.now()) throw new Error("ATTEMPT_EXPIRED");
    return attempt;
  }

  emit(type, subject, data = {}) {
    assertPublicSafe(data);
    return this.store.appendEvent({ event_id: makeId("event"), type, subject, data: publicClone(data), at: this.now() });
  }

  transitionAttempt(attempt, to, reason = null) {
    this.requireLiveAttempt(attempt);
    const next = transitionAttempt(attempt, to, { reason, at: this.now() });
    this.store.putAttempt(next);
    this.emit(EventType.ENROLLMENT_ATTEMPT_CHANGED, next.attempt_id, { from: attempt.state, to, revision: next.revision });
    if (to === EnrollmentState.RECONCILE_REQUIRED) this.emit(EventType.RECONCILE_REQUIRED, next.attempt_id, { revision: next.revision });
    return next;
  }

  createEnrollmentAttempt(input = {}) {
    assertPublicSafe(input);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("CREATE_INPUT_INVALID");
    if (Object.keys(input).some((key) => !["asset_hint", "desired_state", "ttl_seconds", "template_selection"].includes(key))) throw new Error("CREATE_INPUT_INVALID");
    const { asset_hint = null, desired_state = NodeLifecycle.ACTIVE, ttl_seconds = 600, template_selection = null } = input;
    if (desired_state !== NodeLifecycle.ACTIVE) throw new Error("DESIRED_STATE_INVALID");
    if (!Number.isInteger(ttl_seconds) || ttl_seconds < 30 || ttl_seconds > 3600) throw new Error("TTL_INVALID");
    const template = template_selection ? this.enrollmentTemplates.resolveSelection(template_selection) : null;
    const now = this.now();
    const attempt = {
      attempt_id: makeId("attempt"),
      asset_hint,
      desired_state,
      template_binding: template?.binding ?? null,
      state: EnrollmentState.CREATED,
      revision: 0,
      reconcile_required: false,
      human_gate_ids: [],
      evidence: [],
      created_at: now,
      updated_at: now,
      expires_at: this.after(ttl_seconds),
      history: [],
      node_uid: null,
    };
    this.store.putAttempt(attempt);
    this.emit(EventType.ENROLLMENT_ATTEMPT_CHANGED, attempt.attempt_id, { from: null, to: attempt.state, revision: 0 });
    return publicClone(attempt);
  }

  getEnrollmentAttempt(id) { return required(this.store.getAttempt(id), "ATTEMPT_NOT_FOUND"); }
  listEnrollmentAttempts() { return this.store.listAttempts(); }
  listEnrollmentTemplates() { return this.enrollmentTemplates.list(); }
  prepareEnrollmentAttempt(id) { return this.transitionAttempt(this.getEnrollmentAttempt(id), EnrollmentState.PREPARING, "prepare"); }
  claimEnrollmentAttempt(id) {
    const attempt = this.getEnrollmentAttempt(id);
    if (attempt.human_gate_ids.some((gateId) => this.store.getGate(gateId)?.state !== HumanGateState.APPROVED)) {
      throw new Error("HUMAN_GATE_APPROVAL_REQUIRED");
    }
    return this.transitionAttempt(attempt, EnrollmentState.CLAIMED, "claim");
  }
  #assertEnrollmentClaimAuthorized(attempt) {
    if (attempt.human_gate_ids.some((gateId) => this.store.getGate(gateId)?.state !== HumanGateState.APPROVED)) {
      throw new EnrollmentTicketError("HUMAN_GATE_APPROVAL_REQUIRED", 409);
    }
  }

  issueEnrollmentTicket(id, { public_origin, ttl_seconds = 600, replace = false } = {}) {
    if (!this.enrollmentClaimMaterializer) throw new EnrollmentTicketError("PROVIDER_CLAIM_MATERIAL_UNAVAILABLE", 503);
    let attempt = this.requireLiveAttempt(this.getEnrollmentAttempt(id));
    if (!attempt.template_binding?.template_digest) throw new EnrollmentTicketError("TEMPLATE_BINDING_REQUIRED", 409);
    if (![EnrollmentState.CREATED, EnrollmentState.PREPARING].includes(attempt.state)) throw new EnrollmentTicketError("TICKET_ATTEMPT_STATE_INVALID", 409);
    if (!Number.isInteger(ttl_seconds) || ttl_seconds < 60 || ttl_seconds > 900) throw new EnrollmentTicketError("TICKET_TTL_INVALID", 409);
    const existing = this.store.findEnrollmentTicketByAttempt(id);
    if (existing && existing.state === "ISSUED") {
      if (!replace) throw new EnrollmentTicketError("TICKET_ALREADY_ISSUED", 409);
      this.store.putEnrollmentTicket({ ...existing, state: "REVOKED", reason_code: "REISSUED" });
    }
    if (attempt.state === EnrollmentState.CREATED) attempt = this.prepareEnrollmentAttempt(id);
    const factors = createTicketFactors({ codeFactory: this.ticketCodeFactory });
    const ticket_id = makeId("ticket");
    const ticketExpiry = Math.min(this.clock.now() + ttl_seconds * 1000, Date.parse(attempt.expires_at));
    if (ticketExpiry <= this.clock.now()) throw new EnrollmentTicketError("TICKET_EXPIRED", 410);
    const record = createTicketRecord({
      ticket_id, attempt, short_code: factors.short_code,
      issued_at: this.now(), expires_at: new Date(ticketExpiry).toISOString(),
    });
    this.store.putEnrollmentTicket(record);
    return {
      ticket: publicTicketMetadata(record),
      delivery: createTicketDelivery({ record, short_code: factors.short_code, public_origin }),
    };
  }

  getEnrollmentTicket(id) {
    return publicTicketMetadata(required(this.store.findEnrollmentTicketByAttempt(id), "TICKET_NOT_FOUND"));
  }

  revokeEnrollmentTicket(id) {
    const record = required(this.store.findEnrollmentTicketByAttempt(id), "TICKET_NOT_FOUND");
    if (!["ISSUED", "RECONCILE_REQUIRED"].includes(record.state)) throw new EnrollmentTicketError("TICKET_NOT_REVOCABLE", 409);
    const next = { ...record, state: "REVOKED", reason_code: "OPERATOR_REVOKED" };
    this.store.putEnrollmentTicket(next);
    return publicTicketMetadata(next);
  }

  async claimEnrollmentTicket({ ticket_id, short_code, preflight_digest }) {
    if (!this.enrollmentClaimMaterializer) throw new EnrollmentTicketError("PROVIDER_CLAIM_MATERIAL_UNAVAILABLE", 503);
    if (typeof ticket_id !== "string" || !/^ticket-[0-9a-f-]{36}$/.test(ticket_id)) throw new EnrollmentTicketError("TICKET_ID_INVALID", 403);
    const record = this.store.getEnrollmentTicket(ticket_id);
    const verification = verifyTicketClaim(record, { short_code, preflight_digest, now_ms: this.clock.now() });
    if (!verification.ok) {
      this.store.putEnrollmentTicket(verification.record);
      throw new EnrollmentTicketError(verification.code, verification.status);
    }
    let attempt = this.requireLiveAttempt(this.getEnrollmentAttempt(record.attempt_id));
    if (attempt.template_binding?.template_digest !== record.template_digest ||
        String(attempt.template_binding?.template_generation) !== String(record.template_generation)) {
      this.store.putEnrollmentTicket({ ...record, state: "REVOKED", reason_code: "TEMPLATE_BINDING_STALE" });
      throw new EnrollmentTicketError("TICKET_TEMPLATE_STALE", 409);
    }
    if (attempt.state !== EnrollmentState.PREPARING) throw new EnrollmentTicketError("TICKET_ATTEMPT_STATE_INVALID", 409);
    this.#assertEnrollmentClaimAuthorized(attempt);
    const material = validateClaimMaterial(await this.enrollmentClaimMaterializer({
      attempt, ticket: publicTicketMetadata(record), preflight_digest,
    }));
    if (!material || material.outcome === "BLOCKED") {
      throw new EnrollmentTicketError(material?.code || "PROVIDER_CLAIM_MATERIAL_UNAVAILABLE", 503);
    }
    if (material.outcome === "UNKNOWN") {
      this.store.putEnrollmentTicket({ ...record, state: "RECONCILE_REQUIRED", preflight_digest, reason_code: material.reason_code || "CLAIM_MATERIALIZER_OUTCOME_UNKNOWN" });
      throw new EnrollmentTicketError("TICKET_CLAIM_RECONCILE_REQUIRED", 409);
    }
    if (material.outcome !== "READY") throw new EnrollmentTicketError("CLAIM_MATERIAL_INVALID", 502);
    attempt = this.claimEnrollmentAttempt(attempt.attempt_id);
    const delivery = material.delivery;
    this.store.putEnrollmentTicket({
      ...record, state: "CONSUMED", preflight_digest, consumed_at: this.now(),
      resume_capability_digest: sha256Text(delivery.resume_session),
      identity_kind: delivery.identity_kind, enrollment_id: delivery.enrollment_id ?? null,
      node_id: delivery.node_id, node_uid: delivery.node_uid ?? null, reason_code: null,
    });
    return {
      protocol: "ghostfleet-enrollment-claim/v1", ticket_id: record.ticket_id, template_digest: record.template_digest,
      resume_session: delivery.resume_session, auth_key: delivery.auth_key, identity_kind: delivery.identity_kind,
      enrollment_id: delivery.enrollment_id ?? null, node_id: delivery.node_id, node_uid: delivery.node_uid ?? null,
    };
  }

  completeEnrollmentTicket({ resume_session, report }) {
    if (typeof resume_session !== "string" || resume_session.length < 32 || resume_session.length > 256) throw new EnrollmentTicketError("TICKET_RESUME_INVALID", 403);
    assertPublicSafe(report);
    if (!report || typeof report !== "object" || Array.isArray(report) || JSON.stringify(report).length > 131072) throw new EnrollmentTicketError("BOOTSTRAP_REPORT_INVALID", 409);
    const record = this.store.findEnrollmentTicketByResumeDigest(sha256Text(resume_session));
    if (!record) throw new EnrollmentTicketError("TICKET_RESUME_NOT_FOUND", 404);
    const digest = completionDigest(report);
    if (record.state === "COMPLETED") {
      if (record.completion_digest !== digest) throw new EnrollmentTicketError("BOOTSTRAP_COMPLETION_CONFLICT", 409);
      return { ticket: publicTicketMetadata(record), attempt: this.getEnrollmentAttempt(record.attempt_id) };
    }
    if (record.state !== "CONSUMED") throw new EnrollmentTicketError("TICKET_NOT_COMPLETABLE", 409);
    if (report.node_id !== record.node_id || (report.identity_kind && report.identity_kind !== record.identity_kind) ||
        (record.enrollment_id && report.enrollment_id !== record.enrollment_id)) {
      throw new EnrollmentTicketError("BOOTSTRAP_IDENTITY_MISMATCH", 409);
    }
    let attempt = this.getEnrollmentAttempt(record.attempt_id);
    if (attempt.state === EnrollmentState.CLAIMED) {
      attempt = this.startMaterialization(attempt.attempt_id, { node_id: record.node_id, platform: "linux" });
    } else if (attempt.state !== EnrollmentState.MATERIALIZING) {
      throw new EnrollmentTicketError("BOOTSTRAP_ATTEMPT_STATE_INVALID", 409);
    }
    const completed = { ...record, state: "COMPLETED", completed_at: this.now(), completion_digest: digest, reason_code: null };
    this.store.putEnrollmentTicket(completed);
    this.recordEvidence(record.attempt_id, {
      type: "BOOTSTRAP_COMPLETION", source: "ghostfleet-bootstrap",
      data: { status: "PASS", preflight_digest: record.preflight_digest, completion_digest: digest },
    });
    return { ticket: publicTicketMetadata(completed), attempt: this.getEnrollmentAttempt(record.attempt_id) };
  }
  #provisionalNode(attempt) {
    const node = attempt.node_uid && this.store.getNode(attempt.node_uid);
    if (!node) throw new Error("PROVISIONAL_IDENTITY_MISSING");
    if (node.node_uid !== attempt.node_uid || node.enrollment_attempt_id !== attempt.attempt_id || node.lifecycle !== NodeLifecycle.PROVISIONAL) {
      throw new Error("PROVISIONAL_IDENTITY_MISMATCH");
    }
    return node;
  }

  #assertIdentityInput(node, { node_id, platform }) {
    if ((node_id !== undefined && node_id !== null && node_id !== node.node_id) ||
        (platform !== undefined && platform !== node.platform)) throw new Error("NODE_IDENTITY_MISMATCH");
  }

  startMaterialization(id, input = {}) {
    const attempt = this.requireLiveAttempt(this.getEnrollmentAttempt(id));
    if (![EnrollmentState.CLAIMED, EnrollmentState.MATERIALIZING].includes(attempt.state)) {
      throw new InvalidTransitionError(attempt.state, EnrollmentState.MATERIALIZING);
    }
    const { node_id = null, platform = "unknown" } = input;
    assertPublicSafe(input);
    if (Object.keys(input).some((key) => !["node_id", "platform"].includes(key))) throw new Error("MATERIALIZATION_INPUT_INVALID");
    if (node_id !== null && (typeof node_id !== "string" || !node_id.trim() || node_id.length > 128)) throw new Error("NODE_ID_INVALID");
    if (typeof platform !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(platform)) throw new Error("PLATFORM_INVALID");
    let node;
    if (attempt.node_uid) {
      node = this.#provisionalNode(attempt);
      this.#assertIdentityInput(node, input);
      // A lost response must not remint an identity or append duplicate evidence/events.
      if (attempt.state === EnrollmentState.MATERIALIZING) return publicClone(attempt);
    } else {
      if (attempt.state === EnrollmentState.MATERIALIZING) throw new Error("PROVISIONAL_IDENTITY_MISSING");
      const node_uid = makeId("node");
      node = {
        node_uid, node_id: node_id || node_uid, platform,
        lifecycle: NodeLifecycle.PROVISIONAL,
        enrollment_attempt_id: id, capabilities: [],
        materialized_at: this.now(), admitted_at: null, updated_at: this.now(),
      };
    }
    this.store.putNode(node);
    const next = this.transitionAttempt({ ...attempt, node_uid: node.node_uid }, EnrollmentState.MATERIALIZING, "materialize");
    this.#recordCatalogEvidence(next.attempt_id, node);
    this.emit(EventType.NODE_MATERIALIZED, node.node_uid, { enrollment_attempt_id: id, platform: node.platform });
    return this.getEnrollmentAttempt(id);
  }

  requireEnrollmentHumanGate(id, { gate_type = "ENROLLMENT_CONFIRMATION", prompt = "Confirm enrollment", code_format = "FE1-XXXX-XXXX", ttl_seconds = 600 } = {}) {
    const attempt = this.getEnrollmentAttempt(id);
    this.requireLiveAttempt(attempt);
    if (!Number.isInteger(ttl_seconds) || ttl_seconds < 30 || ttl_seconds > 3600) throw new Error("TTL_INVALID");
    if (attempt.state !== EnrollmentState.PREPARING) throw new Error("HUMAN_GATE_STATE_INVALID");
    const gate = {
      gate_id: makeId("gate"),
      gate_type,
      subject_type: "enrollment_attempt",
      subject_id: id,
      state: HumanGateState.WAITING,
      prompt,
      code_format,
      input_echo: "visible",
      resumable: true,
      created_at: this.now(),
      expires_at: this.after(ttl_seconds),
      resolved_at: null,
    };
    this.store.putGate(gate);
    let next = this.transitionAttempt(attempt, EnrollmentState.WAITING_HUMAN, "human-gate-required");
    next.human_gate_ids = [...next.human_gate_ids, gate.gate_id];
    this.store.putAttempt(next);
    this.emit(EventType.HUMAN_GATE_REQUIRED, gate.gate_id, { subject_type: gate.subject_type, subject_id: id, gate_type });
    return publicClone(gate);
  }

  resolveHumanGate(gate_id, decision) {
    const gate = required(this.store.getGate(gate_id), "HUMAN_GATE_NOT_FOUND");
    if (gate.state !== HumanGateState.WAITING) throw new Error("HUMAN_GATE_ALREADY_RESOLVED");
    if (!["APPROVE", "REJECT"].includes(decision)) throw new Error("HUMAN_GATE_DECISION_INVALID");
    const attempt = this.getEnrollmentAttempt(gate.subject_id);
    this.requireLiveAttempt(attempt);
    if (attempt.state !== EnrollmentState.WAITING_HUMAN) throw new Error("HUMAN_GATE_STATE_INVALID");
    if (Date.parse(gate.expires_at) <= this.clock.now()) {
      gate.state = HumanGateState.EXPIRED;
      gate.resolved_at = this.now();
      this.store.putGate(gate);
      throw new Error("HUMAN_GATE_EXPIRED");
    }
    gate.state = decision === "APPROVE" ? HumanGateState.APPROVED : HumanGateState.REJECTED;
    gate.resolved_at = this.now();
    this.store.putGate(gate);
    const result = decision === "APPROVE"
      ? this.transitionAttempt(attempt, EnrollmentState.CLAIMED, "human-gate-approved")
      : this.transitionAttempt(attempt, EnrollmentState.CANCELLED, "human-gate-rejected");
    this.emit(EventType.HUMAN_GATE_RESOLVED, gate_id, { decision, subject_type: gate.subject_type, subject_id: gate.subject_id });
    return { gate: publicClone(gate), result };
  }

  recordEvidence(id, input) {
    if (CORE_OWNED_EVIDENCE.includes(input.type) || input.source === "ghostfleet-core") throw new Error("CORE_EVIDENCE_RESERVED");
    return this.#recordEvidence(id, input);
  }

  #recordCatalogEvidence(id, node) {
    for (const type of CORE_OWNED_EVIDENCE) {
      this.#recordEvidence(id, { type, source: "ghostfleet-core", data: {
        status: "PASS", node_uid: node.node_uid, lifecycle: node.lifecycle,
        projection: "enrollment_catalog",
      } });
    }
  }

  #recordEvidence(id, input) {
    const attempt = this.getEnrollmentAttempt(id);
    this.requireLiveAttempt(attempt);
    if ([EnrollmentState.ACCEPTED, EnrollmentState.CANCELLED, EnrollmentState.FAILED].includes(attempt.state)) throw new Error("EVIDENCE_STATE_INVALID");
    const evidence = createEvidence({ ...input, at: this.now() });
    const next = publicClone(attempt);
    next.evidence = [...next.evidence, evidence];
    next.updated_at = this.now();
    next.revision += 1;
    this.store.putAttempt(next);
    this.emit(EventType.EVIDENCE_UPDATED, id, { type: evidence.type, source: evidence.source, revision: next.revision });
    return evidence;
  }

  markReconcileRequired(id, reason = "ambiguous external outcome") {
    const attempt = this.getEnrollmentAttempt(id);
    if (![EnrollmentState.CLAIMED, EnrollmentState.MATERIALIZING].includes(attempt.state)) throw new Error("RECONCILE_STATE_INVALID");
    return this.transitionAttempt(attempt, EnrollmentState.RECONCILE_REQUIRED, reason);
  }

  resumeFromReconcile(id, resume_state) {
    if (![EnrollmentState.CLAIMED, EnrollmentState.MATERIALIZING].includes(resume_state)) throw new Error("RECONCILE_RESUME_STATE_INVALID");
    const attempt = this.getEnrollmentAttempt(id);
    if (resume_state === EnrollmentState.MATERIALIZING) this.#provisionalNode(attempt);
    return this.transitionAttempt(attempt, resume_state, "reconciled");
  }

  acceptEnrollment(id, input = {}) {
    const attempt = this.requireLiveAttempt(this.getEnrollmentAttempt(id));
    if (attempt.state !== EnrollmentState.MATERIALIZING) throw new Error("ACCEPT_STATE_INVALID");
    if (Object.keys(input).some((key) => !["node_id", "platform"].includes(key))) throw new Error("ACCEPT_INPUT_INVALID");
    const provisional = this.#provisionalNode(attempt);
    this.#assertIdentityInput(provisional, input);
    for (const type of CORE_OWNED_EVIDENCE) {
      const proof = attempt.evidence.findLast((item) => item.type === type);
      if (proof?.source !== "ghostfleet-core" || proof?.data.node_uid !== provisional.node_uid) throw new Error("CORE_EVIDENCE_INVALID");
    }
    const missing = missingAcceptanceEvidence(attempt.evidence);
    if (missing.length) {
      const error = new Error("ACCEPTANCE_EVIDENCE_MISSING");
      error.missing = missing;
      throw error;
    }
    const node = {
      ...provisional,
      lifecycle: NodeLifecycle.ACTIVE,
      admitted_at: this.now(),
      updated_at: this.now(),
    };
    this.store.putNode(node);
    this.#recordCatalogEvidence(id, node);
    this.transitionAttempt(this.getEnrollmentAttempt(id), EnrollmentState.ACCEPTED, "acceptance-evidence-complete");
    this.emit(EventType.NODE_ADMITTED, node.node_uid, { enrollment_attempt_id: id, platform: node.platform });
    return publicClone(node);
  }

  getNode(id) { return required(this.store.getNode(id), "NODE_NOT_FOUND"); }
  listNodes() { return this.store.listNodes(); }
  listHumanGates() { return this.store.listGates(); }
  listEvents() { return this.store.listEvents(); }

  registerCapabilityDefinition(definition) {
    return this.store.putCapabilityDefinition(validateCapabilityDefinition(definition));
  }

  listCapabilityDefinitions() { return this.store.listCapabilityDefinitions(); }

  // Consumer acceptance references an existing NodeIdentity. Core ACTIVE is a
  // precondition, never acceptance evidence, and these methods never mint or
  // mutate node identity/lifecycle.
  openConsumerAcceptance(input) {
    const record = createConsumerAcceptance(input);
    this.store.putConsumerAcceptance(record);
    this.emit(EventType.CONSUMER_ACCEPTANCE_OPENED, record.acceptance_id, {
      node_uid: record.node_uid, consumer_ref: record.consumer_ref,
      source_revision: record.source_revision, config_revision: record.config_revision,
      custody_class: record.custody.custody_class, durability: record.custody.durability,
    });
    return record;
  }

  getConsumerAcceptance(id) { return required(this.store.getConsumerAcceptance(id), "CONSUMER_ACCEPTANCE_NOT_FOUND"); }
  listConsumerAcceptances() { return this.store.listConsumerAcceptances(); }

  recordConsumerSignal(id, signal, detail = {}) {
    const next = recordConsumerSignal(this.getConsumerAcceptance(id), signal, detail);
    this.store.putConsumerAcceptance(next);
    this.emit(EventType.CONSUMER_ACCEPTANCE_SIGNAL_RECORDED, id, { signal });
    return next;
  }

  recordConsumerAcceptanceEvidence(id, element, data) {
    const next = recordConsumerEvidence(this.getConsumerAcceptance(id), element, data, { at: this.now() });
    this.store.putConsumerAcceptance(next);
    this.emit(EventType.CONSUMER_ACCEPTANCE_EVIDENCE_UPDATED, id, { element });
    return next;
  }

  evaluateConsumerAcceptance(id) {
    const record = this.getConsumerAcceptance(id);
    const node = required(this.store.getNode(record.node_uid), "NODE_NOT_FOUND");
    const decided = evaluateConsumerAcceptance(record, { node });
    this.store.putConsumerAcceptance(decided);
    this.emit(EventType.CONSUMER_ACCEPTANCE_DECIDED, id, {
      accepted: decided.decision.accepted,
      missing: decided.decision.missing,
      blocking: decided.decision.blocking,
      non_admitting_signals_ignored: decided.decision.non_admitting_signals_ignored,
    });
    return decided;
  }

  completeConsumerRollback(id, input) {
    const record = this.getConsumerAcceptance(id);
    const next = completeConsumerRollback(record, { ...input, at: this.now() });
    this.store.putConsumerAcceptance(next);
    this.emit(EventType.CONSUMER_ROLLBACK_COMPLETED, id, {
      removed_bindings: next.decision.removed_bindings,
      declared_bindings: record.declared_bindings,
      rollback_receipt_ref: next.decision.rollback_receipt_ref,
      prior_path_readback_ref: next.decision.prior_path_readback_ref,
    });
    return next;
  }
}
