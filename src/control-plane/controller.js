import { validateCapabilityDefinition } from "../core/capabilities.js";\nimport { createEvidence, missingAcceptanceEvidence } from "../core/evidence.js";
import { makeId, isoAfter, isoNow } from "../core/ids.js";
import { EnrollmentState, EventType, HumanGateState, NodeLifecycle } from "../core/model.js";
import { assertPublicSafe, publicClone } from "../core/security.js";
import { transitionAttempt } from "../core/state-machine.js";
import { InMemoryStore } from "./store.js";

function required(value, message) { if (!value) throw new Error(message); return value; }

export class GhostFleetController {
  constructor({ store = new InMemoryStore(), clock = Date } = {}) {
    this.store = store;
    this.clock = clock;
  }

  now() { return isoNow(this.clock); }
  after(seconds) { return isoAfter(seconds, this.clock); }

  emit(type, subject, data = {}) {
    assertPublicSafe(data);
    return this.store.appendEvent({ event_id: makeId("event"), type, subject, data: publicClone(data), at: this.now() });
  }

  transitionAttempt(attempt, to, reason = null) {
    const next = transitionAttempt(attempt, to, { reason, at: this.now() });
    this.store.putAttempt(next);
    this.emit(EventType.ENROLLMENT_ATTEMPT_CHANGED, next.attempt_id, { from: attempt.state, to, revision: next.revision });
    if (to === EnrollmentState.RECONCILE_REQUIRED) this.emit(EventType.RECONCILE_REQUIRED, next.attempt_id, { revision: next.revision });
    return next;
  }

  createEnrollmentAttempt({ asset_hint = null, desired_state = NodeLifecycle.ACTIVE, ttl_seconds = 600 } = {}) {
    assertPublicSafe(asset_hint);
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
  claimEnrollmentAttempt(id) { return this.transitionAttempt(this.getEnrollmentAttempt(id), EnrollmentState.CLAIMED, "claim"); }
  startMaterialization(id) { return this.transitionAttempt(this.getEnrollmentAttempt(id), EnrollmentState.MATERIALIZING, "materialize"); }

  requireEnrollmentHumanGate(id, { gate_type = "ENROLLMENT_CONFIRMATION", prompt = "Confirm enrollment", code_format = "FE1-XXXX-XXXX", ttl_seconds = 600 } = {}) {
    const attempt = this.getEnrollmentAttempt(id);
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
    if (Date.parse(gate.expires_at) <= this.clock.now()) {
      gate.state = HumanGateState.EXPIRED;
      gate.resolved_at = this.now();
      this.store.putGate(gate);
      throw new Error("HUMAN_GATE_EXPIRED");
    }
    gate.state = decision === "APPROVE" ? HumanGateState.APPROVED : HumanGateState.REJECTED;
    gate.resolved_at = this.now();
    this.store.putGate(gate);
    const attempt = this.getEnrollmentAttempt(gate.subject_id);
    const result = decision === "APPROVE"
      ? this.transitionAttempt(attempt, EnrollmentState.CLAIMED, "human-gate-approved")
      : this.transitionAttempt(attempt, EnrollmentState.CANCELLED, "human-gate-rejected");
    this.emit(EventType.HUMAN_GATE_RESOLVED, gate_id, { decision, subject_type: gate.subject_type, subject_id: gate.subject_id });
    return { gate: publicClone(gate), result };
  }

  recordEvidence(id, input) {
    const attempt = this.getEnrollmentAttempt(id);
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
    return this.transitionAttempt(this.getEnrollmentAttempt(id), resume_state, "reconciled");
  }

  acceptEnrollment(id, { node_id = null, platform = "unknown" } = {}) {
    const attempt = this.getEnrollmentAttempt(id);
    if (attempt.state !== EnrollmentState.MATERIALIZING) throw new Error("ACCEPT_STATE_INVALID");
    const missing = missingAcceptanceEvidence(attempt.evidence);
    if (missing.length) {
      const error = new Error("ACCEPTANCE_EVIDENCE_MISSING");
      error.missing = missing;
      throw error;
    }
    const node_uid = makeId("node");
    const node = {
      node_uid,
      node_id: node_id || node_uid,
      platform,
      lifecycle: NodeLifecycle.ACTIVE,
      enrollment_attempt_id: id,
      capabilities: [],
      admitted_at: this.now(),
      updated_at: this.now(),
    };
    this.store.putNode(node);
    let accepted = this.transitionAttempt(attempt, EnrollmentState.ACCEPTED, "acceptance-evidence-complete");
    accepted.node_uid = node_uid;
    this.store.putAttempt(accepted);
    this.emit(EventType.NODE_ADMITTED, node_uid, { enrollment_attempt_id: id, platform });
    return publicClone(node);
  }

  getNode(id) { return required(this.store.getNode(id), "NODE_NOT_FOUND"); }
  listNodes() { return this.store.listNodes(); }
  listHumanGates() { return this.store.listGates(); }
  listEvents() { return this.store.listEvents(); }

  registerCapabilityDefinition(definition) {
    assertPublicSafe(definition);
    if (!definition?.id || !definition?.risk) throw new Error("CAPABILITY_DEFINITION_INVALID");
    return this.store.putCapabilityDefinition(definition);
  }

  listCapabilityDefinitions() { return this.store.listCapabilityDefinitions(); }
}
