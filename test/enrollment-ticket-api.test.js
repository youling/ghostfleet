import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";
import { InMemoryStore } from "../src/control-plane/store.js";
import { BOOTSTRAP_SH } from "../packages/bootstrap/src/index.js";

const template_selection = { template_id: "managed-linux-tailscale", overrides: { "providers.tailscale.ssh": true } };
const preflight = "sha256:" + "a".repeat(64);

function syntheticMaterializer() {
  return async ({ attempt, ticket, preflight_digest }) => ({
    outcome: "READY",
    delivery: {
      resume_session: "resume_" + "r".repeat(48),
      auth_key: "synthetic-one-time-provider-material",
      identity_kind: "provisional",
      enrollment_id: "enroll-12345678-1234-1234-1234-123456789abc",
      node_id: "fleet-bootstrap-123456abcdef",
      node_uid: null,
    },
    attempt_id: attempt.attempt_id,
    ticket_id: ticket.ticket_id,
    preflight_digest,
  });
}

function controller(options = {}) {
  return new GhostFleetController({
    enrollmentClaimMaterializer: syntheticMaterializer(),
    ticketFactorFactory: () => "A".repeat(43),
    ticketCodeFactory: () => "12345678",
    ...options,
  });
}

test("ticket issue persists only digests/public metadata and returns one-time delivery once", () => {
  const store = new InMemoryStore();
  const c = controller({ store });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  const issued = c.issueEnrollmentTicket(attempt.attempt_id, { public_origin: "https://ghostfleet.invalid" });
  assert.equal(issued.ticket.state, "ISSUED");
  assert.equal(issued.delivery.short_code, "12345678");
  assert.match(issued.delivery.one_time_url, /\/v1\/enrollment-tickets\/A{43}$/);
  assert.ok(issued.delivery.command.includes("GHOSTFLEET_ENROLLMENT_URL"));
  const snapshot = JSON.stringify(store.snapshot());
  assert.equal(snapshot.includes("12345678"), false);
  assert.equal(snapshot.includes("A".repeat(43)), false);
  assert.equal(snapshot.includes("synthetic-one-time-provider-material"), false);
});

test("ticket issue stops at provider/custody gate when no claim materializer is configured", () => {
  const c = new GhostFleetController();
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  assert.throws(() => c.issueEnrollmentTicket(attempt.attempt_id, { public_origin: "https://ghostfleet.invalid" }), /PROVIDER_CLAIM_MATERIAL_UNAVAILABLE/);
  assert.equal(c.getEnrollmentAttempt(attempt.attempt_id).state, "CREATED");
});

test("wrong code is rate-limited without consuming a valid ticket", async () => {
  const c = controller();
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  c.issueEnrollmentTicket(attempt.attempt_id, { public_origin: "https://ghostfleet.invalid" });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => c.claimEnrollmentTicket({ claim_factor: "A".repeat(43), short_code: "00000000", preflight_digest: preflight }), /TICKET_SHORT_CODE_INVALID/);
  }
  await assert.rejects(() => c.claimEnrollmentTicket({ claim_factor: "A".repeat(43), short_code: "00000000", preflight_digest: preflight }), /TICKET_LOCKED/);
  assert.equal(c.getEnrollmentTicket(attempt.attempt_id).state, "REVOKED");
});

test("successful claim consumes ticket, returns raw material transiently, and denies replay", async () => {
  const store = new InMemoryStore();
  const c = controller({ store });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  c.issueEnrollmentTicket(attempt.attempt_id, { public_origin: "https://ghostfleet.invalid" });
  const result = await c.claimEnrollmentTicket({ claim_factor: "A".repeat(43), short_code: "12345678", preflight_digest: preflight });
  assert.equal(result.identity_kind, "provisional");
  assert.equal(result.auth_key, "synthetic-one-time-provider-material");
  assert.equal(c.getEnrollmentAttempt(attempt.attempt_id).state, "CLAIMED");
  assert.equal(c.getEnrollmentTicket(attempt.attempt_id).state, "CONSUMED");
  const snapshot = JSON.stringify(store.snapshot());
  assert.equal(snapshot.includes(result.auth_key), false);
  assert.equal(snapshot.includes(result.resume_session), false);
  await assert.rejects(() => c.claimEnrollmentTicket({ claim_factor: "A".repeat(43), short_code: "12345678", preflight_digest: preflight }), /TICKET_NOT_CLAIMABLE/);
});

test("completion is resume-bound, materializes exact provisional identity, and is idempotent for the same report", async () => {
  const c = controller();
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  c.issueEnrollmentTicket(attempt.attempt_id, { public_origin: "https://ghostfleet.invalid" });
  const claim = await c.claimEnrollmentTicket({ claim_factor: "A".repeat(43), short_code: "12345678", preflight_digest: preflight });
  const report = { identity_kind: "provisional", enrollment_id: claim.enrollment_id, node_id: claim.node_id, os_id: "debian", os_version_id: "13", bootstrap_version: "synthetic-v1" };
  const first = c.completeEnrollmentTicket({ resume_session: claim.resume_session, report });
  assert.equal(first.attempt.state, "MATERIALIZING");
  assert.equal(first.ticket.state, "COMPLETED");
  const second = c.completeEnrollmentTicket({ resume_session: claim.resume_session, report });
  assert.equal(second.ticket.state, "COMPLETED");
  assert.throws(() => c.completeEnrollmentTicket({ resume_session: claim.resume_session, report: { ...report, node_id: "other" } }), /BOOTSTRAP_COMPLETION_CONFLICT/);
});

test("public HTTP claim route is ticket-authenticated while operator ticket issuance stays under v0", async () => {
  const c = controller();
  const handle = createHttpHandler(c);
  const created = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset_hint: "node", template_selection }) }));
  const attempt = (await created.json()).attempt;
  const issued = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts/" + attempt.attempt_id + "/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(issued.status, 201);
  const delivery = (await issued.json()).delivery;
  const factor = delivery.one_time_url.split("/").at(-1);
  const claimed = await handle(new Request("https://ghostfleet.invalid/v1/enrollment-tickets/" + factor + "/claim", { method: "POST", headers: { "x-ghostfleet-preflight-digest": preflight }, body: "12345678" }));
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).identity_kind, "provisional");
});

test("bootstrap supports one-time enrollment URL while preserving legacy broker fallback", () => {
  assert.ok(BOOTSTRAP_SH.includes("GHOSTFLEET_ENROLLMENT_URL"));
  assert.ok(BOOTSTRAP_SH.includes('CLAIM_URL="$ENROLLMENT_URL/claim"'));
  assert.ok(BOOTSTRAP_SH.includes('CLAIM_URL="$BROKER_ORIGIN/v1/enroll/claim"'));
});
