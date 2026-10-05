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

function required(value, message) { if (!value) throw new Error(message); return value; }

export class GhostFleetController {
  constructor({ store = new InMemoryStore(), clock = Date } = {}) {
    this.store = store;
    this.clock = clock;
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

  createEnrollmentAttempt({ asset_hint = null, desired_state = NodeLifecycle.ACTIVE, ttl_seconds = 600 } = {}) {
    assertPublicSafe(asset_hint);
    if (desired_state !== NodeLifecycle.ACTIVE) throw new Error("DESIRED_STATE_INVALID");
    if (!Number.isInteger(ttl_seconds) || ttl_seconds < 30 || ttl_seconds > 3600) throw new Error("TTL_INVALID");
    const now = this.now();
    const attempt = {
      attempt_id: makeId("attempt"),
      asset_hint,
      desired_state,
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
  prepareEnrollmentAttempt(id) { return this.transitionAttempt(this.getEnrollmentAttempt(id), EnrollmentState.PREPARING, "prepare"); }
  claimEnrollmentAttempt(id) {
    const attempt = this.getEnrollmentAttempt(id);
    if (attempt.human_gate_ids.some((gateId) => this.store.getGate(gateId)?.state !== HumanGateState.APPROVED)) {
      throw new Error("HUMAN_GATE_APPROVAL_REQUIRED");
    }
    return this.transitionAttempt(attempt, EnrollmentState.CLAIMED, "claim");
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

  // Consumer acceptance is a separate contract: it references an existing
  // NodeIdentity and never mints one or mutates NodeLifecycle. Core ACTIVE is a
  // precondition here, never an acceptance signal.

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
    this.emit(EventType.CONSUMER_ACCEPTANCE_EVIDENCE_UPDATED, id, { signal });
    return next;
  }

  recordConsumerAcceptanceEvidence(id, element, data) {
    const record = this.getConsumerAcceptance(id);
    const next = recordConsumerEvidence(record, element, data, { at: this.now() });
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
      declared_bindings: record.introduced_bindings,
    });
    return next;
  }
}
