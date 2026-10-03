import { EnrollmentState } from "./model.js";

const TRANSITIONS = Object.freeze({
  [EnrollmentState.CREATED]: new Set([EnrollmentState.PREPARING, EnrollmentState.CANCELLED, EnrollmentState.FAILED]),
  [EnrollmentState.PREPARING]: new Set([EnrollmentState.WAITING_HUMAN, EnrollmentState.CLAIMED, EnrollmentState.CANCELLED, EnrollmentState.FAILED]),
  [EnrollmentState.WAITING_HUMAN]: new Set([EnrollmentState.CLAIMED, EnrollmentState.CANCELLED, EnrollmentState.FAILED]),
  [EnrollmentState.CLAIMED]: new Set([EnrollmentState.MATERIALIZING, EnrollmentState.RECONCILE_REQUIRED, EnrollmentState.FAILED]),
  [EnrollmentState.MATERIALIZING]: new Set([EnrollmentState.ACCEPTED, EnrollmentState.RECONCILE_REQUIRED, EnrollmentState.FAILED]),
  [EnrollmentState.RECONCILE_REQUIRED]: new Set([EnrollmentState.CLAIMED, EnrollmentState.MATERIALIZING, EnrollmentState.CANCELLED, EnrollmentState.FAILED]),
  [EnrollmentState.ACCEPTED]: new Set(),
  [EnrollmentState.FAILED]: new Set(),
  [EnrollmentState.CANCELLED]: new Set(),
});

export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super("invalid enrollment transition: " + from + " -> " + to);
    this.name = "InvalidTransitionError";
    this.code = "INVALID_TRANSITION";
  }
}

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function transitionAttempt(attempt, to, { reason = null, at = new Date().toISOString() } = {}) {
  if (!canTransition(attempt.state, to)) throw new InvalidTransitionError(attempt.state, to);
  const from = attempt.state;
  const next = structuredClone(attempt);
  next.state = to;
  next.updated_at = at;
  next.revision = (next.revision ?? 0) + 1;
  next.history = [...(next.history ?? []), { from, to, at, reason }];
  next.reconcile_required = to === EnrollmentState.RECONCILE_REQUIRED;
  if (from === EnrollmentState.RECONCILE_REQUIRED && (to === EnrollmentState.CLAIMED || to === EnrollmentState.MATERIALIZING)) next.reconcile_required = false;
  return next;
}
