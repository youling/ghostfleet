/** Pure projections of server facts. No transitions, requests or authority. */
const STEPS = Object.freeze([
  Object.freeze({ state: "CREATED", labelKey: "step.created" }),
  Object.freeze({ state: "PREPARING", labelKey: "step.preparing" }),
  Object.freeze({ state: "WAITING_HUMAN", labelKey: "state.WAITING_HUMAN" }),
  Object.freeze({ state: "CLAIMED", labelKey: "step.claimed" }),
  Object.freeze({ state: "MATERIALIZING", labelKey: "step.evidence" }),
  Object.freeze({ state: "ACCEPTED", labelKey: "step.accepted" }),
]);

/** Unknown/paused/failed/expired states must not masquerade as forward progress. */
export function enrollmentProgress(attempt, now = Date.now()) {
  const stage = STEPS.findIndex((step) => step.state === attempt?.state);
  if (stage < 0) return [];
  const accepted = attempt.state === "ACCEPTED";
  const expiresAt = Date.parse(attempt.expires_at);
  if (!accepted && Number.isFinite(expiresAt) && expiresAt <= now) return [];
  const gates = Array.isArray(attempt.human_gate_ids) ? attempt.human_gate_ids : [];
  const history = Array.isArray(attempt.history) ? attempt.history : [];
  const sawApproval = attempt.state === "WAITING_HUMAN" || gates.length > 0
    || history.some((change) => change?.from === "WAITING_HUMAN" || change?.to === "WAITING_HUMAN");
  return STEPS.flatMap((step, index) => {
    // A policy that did not require a Human Gate must not look Human-approved.
    if (step.state === "WAITING_HUMAN" && stage > 2 && !sawApproval) return [];
    return [{ ...step, complete: accepted || index < stage, current: index === stage }];
  });
}

/** Display unknown and malformed evidence as unknown, never as an execution failure. */
export function evidencePresentation(item) {
  if (item == null) return { status: "MISSING", tone: "secondary", labelKey: "evidenceMissing" };
  if (item.data?.status === "PASS") return { status: "PASS", tone: "pass", labelKey: "evidencePass" };
  if (item.data?.status === "FAIL") return { status: "FAIL", tone: "fail", labelKey: "evidenceFail" };
  return { status: "UNKNOWN", tone: "secondary", labelKey: "unknown" };
}
