export const EnrollmentState = Object.freeze({
  CREATED: "CREATED",
  PREPARING: "PREPARING",
  WAITING_HUMAN: "WAITING_HUMAN",
  CLAIMED: "CLAIMED",
  MATERIALIZING: "MATERIALIZING",
  RECONCILE_REQUIRED: "RECONCILE_REQUIRED",
  ACCEPTED: "ACCEPTED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

export const HumanGateState = Object.freeze({
  WAITING: "WAITING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
});

export const NodeLifecycle = Object.freeze({
  PROVISIONAL: "PROVISIONAL",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  RETIRED: "RETIRED",
});

export const RiskClass = Object.freeze({ R0: "R0", R1: "R1", R2: "R2" });

export const EventType = Object.freeze({
  ENROLLMENT_ATTEMPT_CHANGED: "EnrollmentAttemptChanged",
  HUMAN_GATE_REQUIRED: "HumanGateRequired",
  HUMAN_GATE_RESOLVED: "HumanGateResolved",
  EVIDENCE_UPDATED: "EvidenceUpdated",
  CAPABILITY_AVAILABLE: "CapabilityAvailable",
  CAPABILITY_REQUESTED: "CapabilityRequested",
  CAPABILITY_GRANTED: "CapabilityGranted",
  NODE_ADMITTED: "NodeAdmitted",
  PROJECTION_STALE: "ProjectionStale",
  RECONCILE_REQUIRED: "ReconcileRequired",
});

export const CapabilityRequestState = Object.freeze({
  WAITING_HUMAN: "WAITING_HUMAN",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  EXPIRED: "EXPIRED",
});

export const DEFAULT_ACCEPTANCE_EVIDENCE = Object.freeze([
  "transport.ready",
  "bootstrap.report",
  "identity.materialized",
  "catalog.admitted",
  "control.canary",
  "convergence.zero_delta",
  "reboot.recovered",
]);
