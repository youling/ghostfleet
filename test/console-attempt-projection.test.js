import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { enrollmentProgress, evidencePresentation } from "../console/enrollment/attempts/presentation.js";

const now = Date.parse("2030-01-01T00:00:00.000Z");
const live = (state, extra = {}) => ({ state, expires_at: "2030-01-01T00:10:00.000Z", ...extra });
const app = readFileSync(new URL("../console/app.js", import.meta.url), "utf8");
function renderer(name, overrides = {}) {
  const start = app.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "actual app function must exist");
  const end = app.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, "actual app function boundary must exist");
  const requiredEvidence = ["bootstrap.report", "transport.ready", "reboot.recovered"];
  const context = {
    enrollmentProgress: (value) => enrollmentProgress(value, now), evidencePresentation,
    finalStates: new Set(["ACCEPTED", "FAILED", "CANCELLED"]),
    expired: (value) => Date.parse(value?.expires_at) <= now,
    attemptState: (value) => value.state,
    text: (key) => key, h: (value) => String(value ?? ""), t: (key) => key,
    snapshot: {}, busy: false, writable: () => false, disabled: () => " disabled",
    attemptName: () => "synthetic-test-node", syntheticEvidence: () => false,
    requiredEvidence,
    section: (title, body) => '<section data-title="' + title + '">' + body + "</section>",
    evidenceResults: (attempt) => {
      const latest = new Map((attempt.evidence || []).map((item) => [item.type, item]));
      return { latest, passed: requiredEvidence.filter((type) => latest.get(type)?.data?.status === "PASS").length };
    },
    ...overrides,
  };
  // Execute the shipped app renderer, rather than only matching its source text.
  return vm.runInNewContext(app.slice(start, end) + "\n" + name, context, { timeout: 1000 });
}

for (const state of ["CREATED", "PREPARING", "WAITING_HUMAN", "CLAIMED", "MATERIALIZING", "ACCEPTED"]) {
  test("one current step matches server state: " + state, () => {
    const steps = enrollmentProgress(live(state, { human_gate_ids: ["gate-synthetic"] }), now);
    assert.equal(steps.filter((step) => step.current).length, 1);
    assert.equal(steps.find((step) => step.current).state, state);
    assert.equal(steps.filter((step) => step.complete).length, state === "ACCEPTED" ? 6 : steps.findIndex((step) => step.current));
  });
}
test("skipped optional Human Gate is not presented as approved", () => {
  assert.equal(enrollmentProgress(live("CLAIMED"), now).some((step) => step.state === "WAITING_HUMAN"), false);
  assert.equal(enrollmentProgress(live("MATERIALIZING", { history: [{ to: "WAITING_HUMAN" }] }), now)
    .some((step) => step.state === "WAITING_HUMAN"), true);
});
test("accepted attempt remains complete after its issuance TTL", () => {
  const steps = enrollmentProgress({ state: "ACCEPTED", expires_at: "2000-01-01T00:00:00.000Z" }, now);
  assert.ok(steps.every((step) => step.complete));
  assert.equal(steps.at(-1).state, "ACCEPTED");
  assert.equal(steps.at(-1).current, true);
});
test("failed, cancelled, reconcile, invalid and expired states never show forward success", () => {
  for (const state of ["FAILED", "CANCELLED", "RECONCILE_REQUIRED", "EXPIRED", "constructor", "__proto__", "future-state", undefined]) {
    assert.deepEqual(enrollmentProgress(live(state), now), []);
  }
  assert.deepEqual(enrollmentProgress(live("MATERIALIZING", { expires_at: "2030-01-01T00:00:00.000Z" }), now), []);
  assert.deepEqual(enrollmentProgress(null, now), []);
});
test("projection does not change server state, history or evidence", () => {
  const value = live("WAITING_HUMAN", { history: [{ from: "PREPARING", to: "WAITING_HUMAN" }], evidence: [] });
  const before = JSON.stringify(value);
  enrollmentProgress(value, now);
  assert.equal(JSON.stringify(value), before);
});
test("evidence pass, failure, missing and unknown are distinct", () => {
  assert.equal(evidencePresentation(null).status, "MISSING");
  assert.equal(evidencePresentation({ data: { status: "PASS" } }).status, "PASS");
  assert.equal(evidencePresentation({ data: { status: "FAIL" } }).status, "FAIL");
  for (const value of ["UNKNOWN", "NOT_RUN", "pass", true, 1, undefined]) {
    const display = evidencePresentation({ data: { status: value } });
    assert.equal(display.status, "UNKNOWN");
    assert.equal(display.tone, "secondary");
  }
});
test("actual app highlights WAITING_HUMAN, not claimed", () => {
  const html = renderer("progress")(live("WAITING_HUMAN"));
  assert.match(html, /aria-current="step">state\.WAITING_HUMAN<\/li>/);
  assert.doesNotMatch(html, /aria-current="step">step\.claimed/);
});
test("actual app distinguishes claimed from evidence verification", () => {
  const progress = renderer("progress");
  assert.match(progress(live("CLAIMED")), /aria-current="step">step\.claimed<\/li>/);
  assert.match(progress(live("MATERIALIZING")), /aria-current="step">step\.evidence<\/li>/);
  assert.match(progress(live("ACCEPTED")), /class="done current" aria-current="step">step\.accepted<\/li>/);
});
test("actual app renders UNKNOWN and absent evidence without inventing a failure", () => {
  const html = renderer("evidence")({ evidence: [{ type: "transport.ready", data: { status: "UNKNOWN" } }] });
  assert.match(html, /data-evidence-status="UNKNOWN">unknown/);
  assert.match(html, /data-evidence-status="MISSING">evidenceMissing/);
  assert.doesNotMatch(html, /class="fail"/);
});
test("actual app uses latest receipt, not an older PASS", () => {
  const html = renderer("evidence")({ evidence: [
    { type: "transport.ready", data: { status: "PASS" } },
    { type: "transport.ready", data: { status: "UNKNOWN" } },
    { type: "bootstrap.report", data: { status: "FAIL" } },
  ] });
  assert.doesNotMatch(html, /data-evidence-status="PASS"/);
  assert.match(html, /data-evidence-status="FAIL">evidenceFail/);
});
test("actual app offers read-only refresh while waiting for evidence or reconciliation", () => {
  for (const state of ["MATERIALIZING", "RECONCILE_REQUIRED"]) {
    const html = renderer("attemptActions")(live(state));
    assert.match(html, /data-refresh-state>readServerState/);
    assert.doesNotMatch(html, /data-action=|data-attempt=|disabled/);
  }
});
test("actual refresh obeys busy, disconnected, expired and terminal UI conditions", () => {
  assert.match(renderer("attemptActions", { busy: true })(live("MATERIALIZING")), /disabled/);
  assert.match(renderer("attemptActions", { snapshot: null })(live("MATERIALIZING")), /disabled/);
  for (const state of ["ACCEPTED", "CANCELLED", "FAILED"]) assert.equal(renderer("attemptActions")(live(state)), "");
  assert.equal(renderer("attemptActions")(live("MATERIALIZING", { expires_at: "2000-01-01T00:00:00Z" })), "");
});
