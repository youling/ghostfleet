import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";
import { InMemoryStore } from "../src/control-plane/store.js";
import { BOOTSTRAP_SH } from "../packages/bootstrap/src/index.js";

const template_selection = { template_id: "managed-linux-tailscale", overrides: { "providers.tailscale.ssh": true } };
const preflight = "sha256:" + "a".repeat(64);
// Three public surfaces: immutable content-addressed material, the narrow
// enrollment bridge that owns the one-time ticket URL, and the node plane the
// enrolled agent polls (never the Access-protected enrollment bridge).
const assets_origin = "https://assets.example.invalid";
const enroll_origin = "https://enroll.example.invalid";
const node_plane_origin = "https://node-plane.example.invalid";
const bootstrap_sha256 = "b".repeat(64);
const enrollmentDelivery = { assets_origin, enroll_origin, node_plane_origin, bootstrap_sha256 };

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
    enrollmentDelivery,
    ticketCodeFactory: () => "12345678",
    ...options,
  });
}

test("ticket issue persists only digests/public metadata and returns one-time delivery once", async () => {
  const store = new InMemoryStore();
  const c = controller({ store });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  const issued = await c.issueEnrollmentTicket(attempt.attempt_id);
  assert.equal(issued.ticket.state, "ISSUED");
  assert.equal(issued.delivery.short_code, "12345678");
  assert.equal(issued.delivery.one_time_url.split("/").at(-1), issued.ticket.ticket_id);
  assert.equal(issued.delivery.one_time_url.includes("12345678"), false);
  assert.ok(issued.delivery.command.includes("GHOSTFLEET_ENROLLMENT_URL"));
  const snapshot = JSON.stringify(store.snapshot());
  assert.equal(snapshot.includes("12345678"), false);
  assert.equal(snapshot.includes("synthetic-one-time-provider-material"), false);
});

test("ticket issue stops at provider/custody gate when no claim materializer is configured", async () => {
  const c = new GhostFleetController();
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await assert.rejects(() => c.issueEnrollmentTicket(attempt.attempt_id), /PROVIDER_CLAIM_MATERIAL_UNAVAILABLE/);
  assert.equal(c.getEnrollmentAttempt(attempt.attempt_id).state, "CREATED");
});

test("provider preparation completes before one-time delivery factors are created and caps ticket expiry", async () => {
  let codeCalls = 0;
  const seen = [];
  const providerExpiry = "2026-10-01T00:05:00.000Z";
  let now = Date.parse("2026-10-01T00:00:00Z");
  class Clock extends Date {
    constructor(value = now) { super(value); }
    static now() { return now; }
  }
  const c = controller({
    clock: Clock,
    enrollmentClaimPreparer: async ({ attempt, requested_ttl_seconds }) => {
      seen.push({ attempt_id: attempt.attempt_id, state: attempt.state, requested_ttl_seconds });
      return { outcome: "READY", expires_at: providerExpiry };
    },
    ticketCodeFactory: () => { codeCalls += 1; return "12345678"; },
  });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", ttl_seconds: 600, template_selection });
  const issued = await c.issueEnrollmentTicket(attempt.attempt_id, { enroll_origin, ttl_seconds: 600 });
  assert.deepEqual(seen, [{ attempt_id: attempt.attempt_id, state: "PREPARING", requested_ttl_seconds: 600 }]);
  assert.equal(codeCalls, 1);
  assert.equal(issued.ticket.expires_at, providerExpiry);
});

test("ambiguous provider preparation creates no GhostFleet ticket and retries on the same attempt", async () => {
  let prepareCalls = 0;
  let codeCalls = 0;
  const attempts = [];
  const c = controller({
    enrollmentClaimPreparer: async ({ attempt }) => {
      prepareCalls += 1;
      attempts.push(attempt.attempt_id);
      return prepareCalls === 1
        ? { outcome: "UNKNOWN", reason_code: "SYNTHETIC_UNKNOWN" }
        : { outcome: "READY", expires_at: new Date(Date.now() + 300_000).toISOString() };
    },
    ticketCodeFactory: () => { codeCalls += 1; return "12345678"; },
  });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await assert.rejects(
    () => c.issueEnrollmentTicket(attempt.attempt_id),
    /TICKET_PREPARATION_RECONCILE_REQUIRED/,
  );
  assert.equal(c.getEnrollmentAttempt(attempt.attempt_id).state, "PREPARING");
  assert.throws(() => c.getEnrollmentTicket(attempt.attempt_id), /TICKET_NOT_FOUND/);
  assert.equal(codeCalls, 0);

  const issued = await c.issueEnrollmentTicket(attempt.attempt_id);
  assert.equal(issued.ticket.state, "ISSUED");
  assert.equal(codeCalls, 1);
  assert.deepEqual(attempts, [attempt.attempt_id, attempt.attempt_id]);
});

test("an invalid enrollment origin cannot persist an unrecoverable ticket", async () => {
  const store = new InMemoryStore();
  const c = controller({ store, enrollmentDelivery: { assets_origin, enroll_origin: "http://example.invalid", node_plane_origin, bootstrap_sha256 } });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await assert.rejects(
    () => c.issueEnrollmentTicket(attempt.attempt_id),
    /ENROLL_ORIGIN_INVALID/,
  );
  assert.equal(store.findEnrollmentTicketByAttempt(attempt.attempt_id), null);
});

test("a deployment that forgot the enrollment origin refuses to issue and mints nothing", async () => {
  // Reproducer for the fallback finding: assets + digest are configured, the
  // enrollment bridge origin is not. The request origin must never stand in for
  // it (behind the service binding that value is "https://control-plane.invalid").
  const store = new InMemoryStore();
  let prepared = 0;
  let codes = 0;
  const c = new GhostFleetController({
    store,
    enrollmentClaimMaterializer: syntheticMaterializer(),
    enrollmentClaimPreparer: async () => { prepared += 1; return { outcome: "READY", expires_at: new Date(Date.now() + 300_000).toISOString() }; },
    enrollmentDelivery: { assets_origin, bootstrap_sha256 },
    ticketCodeFactory: () => { codes += 1; return "12345678"; },
  });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await assert.rejects(() => c.issueEnrollmentTicket(attempt.attempt_id), /ENROLLMENT_DELIVERY_INCOMPLETE/);
  assert.equal(prepared, 0, "no provider authority may be prepared");
  assert.equal(codes, 0, "no short code may be minted");
  assert.equal(store.findEnrollmentTicketByAttempt(attempt.attempt_id), null);
});

test("a deployment without the immutable asset coordinates mints nothing and prepares no provider authority", async () => {
  const store = new InMemoryStore();
  let prepared = 0;
  const c = new GhostFleetController({
    store,
    enrollmentClaimMaterializer: syntheticMaterializer(),
    enrollmentClaimPreparer: async () => { prepared += 1; return { outcome: "READY", expires_at: new Date(Date.now() + 300_000).toISOString() }; },
    ticketCodeFactory: () => "12345678",
  });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await assert.rejects(
    () => c.issueEnrollmentTicket(attempt.attempt_id),
    /ENROLLMENT_DELIVERY_NOT_CONFIGURED/,
  );
  assert.equal(prepared, 0, "no provider authority may be minted for a delivery that cannot name its material");
  assert.equal(store.findEnrollmentTicketByAttempt(attempt.attempt_id), null);
});

test("collapsing the asset and enrollment origins onto one host is refused", async () => {
  const store = new InMemoryStore();
  const c = controller({ store, enrollmentDelivery: { assets_origin, enroll_origin: assets_origin, node_plane_origin, bootstrap_sha256 } });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await assert.rejects(
    () => c.issueEnrollmentTicket(attempt.attempt_id),
    /DELIVERY_ORIGINS_NOT_SEPARATED/,
  );
  assert.equal(store.findEnrollmentTicketByAttempt(attempt.attempt_id), null);
});

test("delivery names the asset origin, the pinned bootstrap digest, the enrollment origin and the node plane", async () => {
  const c = controller();
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  const issued = await c.issueEnrollmentTicket(attempt.attempt_id);
  assert.equal(issued.delivery.protocol, "ghostfleet-enrollment-delivery/v2");
  assert.equal(issued.delivery.assets_origin, assets_origin);
  assert.equal(issued.delivery.node_plane_origin, node_plane_origin);
  assert.equal(issued.delivery.bootstrap_sha256, bootstrap_sha256);
  // The node plane is env-only: it is never a URL, an argv token or a log line.
  assert.match(issued.delivery.command, /GHOSTFLEET_NODE_PLANE_ORIGIN=/);
  assert.match(issued.delivery.command, /export GHOSTFLEET_NODE_PLANE_ORIGIN/);
  const nodePlaneAssignments = issued.delivery.command.split("GHOSTFLEET_NODE_PLANE_ORIGIN=").length - 1;
  assert.ok(nodePlaneAssignments > 0);
  assert.equal(issued.delivery.command.split(node_plane_origin).length - 1, nodePlaneAssignments, "the node plane only appears inside its env assignment");
  assert.equal(issued.delivery.one_time_url, enroll_origin + "/v1/enrollment-tickets/" + issued.ticket.ticket_id);
  assert.match(issued.delivery.command, new RegExp("/sha256/" + bootstrap_sha256));
  assert.equal(issued.delivery.command.includes(issued.ticket.ticket_id), false, "the handle never reaches argv");
  assert.equal(issued.delivery.command.includes("12345678"), false, "the short code never reaches argv");
});

test("wrong code is rate-limited without consuming a valid ticket", async () => {
  const c = controller();
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await c.issueEnrollmentTicket(attempt.attempt_id);
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => c.claimEnrollmentTicket({ ticket_id: c.getEnrollmentTicket(attempt.attempt_id).ticket_id, short_code: "00000000", preflight_digest: preflight }), /TICKET_SHORT_CODE_INVALID/);
  }
  await assert.rejects(() => c.claimEnrollmentTicket({ ticket_id: c.getEnrollmentTicket(attempt.attempt_id).ticket_id, short_code: "00000000", preflight_digest: preflight }), /TICKET_LOCKED/);
  assert.equal(c.getEnrollmentTicket(attempt.attempt_id).state, "REVOKED");
});

test("successful claim consumes ticket, returns raw material transiently, and denies replay", async () => {
  const store = new InMemoryStore();
  const c = controller({ store });
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await c.issueEnrollmentTicket(attempt.attempt_id);
  const result = await c.claimEnrollmentTicket({ ticket_id: c.getEnrollmentTicket(attempt.attempt_id).ticket_id, short_code: "12345678", preflight_digest: preflight });
  assert.equal(result.identity_kind, "provisional");
  assert.equal(result.auth_key, "synthetic-one-time-provider-material");
  assert.equal(c.getEnrollmentAttempt(attempt.attempt_id).state, "CLAIMED");
  assert.equal(c.getEnrollmentTicket(attempt.attempt_id).state, "CONSUMED");
  const snapshot = JSON.stringify(store.snapshot());
  assert.equal(snapshot.includes(result.auth_key), false);
  assert.equal(snapshot.includes(result.resume_session), false);
  await assert.rejects(() => c.claimEnrollmentTicket({ ticket_id: c.getEnrollmentTicket(attempt.attempt_id).ticket_id, short_code: "12345678", preflight_digest: preflight }), /TICKET_NOT_CLAIMABLE/);
});

test("completion is resume-bound, materializes exact provisional identity, and is idempotent for the same report", async () => {
  const c = controller();
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection });
  await c.issueEnrollmentTicket(attempt.attempt_id);
  const claim = await c.claimEnrollmentTicket({ ticket_id: c.getEnrollmentTicket(attempt.attempt_id).ticket_id, short_code: "12345678", preflight_digest: preflight });
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
  const handle = createHttpHandler(c, { authorizeOperator: () => true });
  const created = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset_hint: "node", template_selection }) }));
  const attempt = (await created.json()).attempt;
  const issued = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts/" + attempt.attempt_id + "/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(issued.status, 201);
  const delivery = (await issued.json()).delivery;
  const ticketId = delivery.one_time_url.split("/").at(-1);
  assert.equal(ticketId, (await c.getEnrollmentTicket(attempt.attempt_id)).ticket_id);
  const claimed = await handle(new Request("https://ghostfleet.invalid/v1/enrollment-tickets/" + ticketId + "/claim", { method: "POST", headers: { "x-ghostfleet-preflight-digest": preflight }, body: "12345678" }));
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).identity_kind, "provisional");
});

test("oversized public bodies are refused with 413 before any claim or completion effect", async () => {
  const c = controller();
  const handle = createHttpHandler(c, { authorizeOperator: () => true });
  const created = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ asset_hint: "node", template_selection }),
  }));
  const attempt = (await created.json()).attempt;
  const issued = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts/" + attempt.attempt_id + "/ticket", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  const ticketId = (await issued.json()).delivery.one_time_url.split("/").at(-1);

  // A short code is a few bytes; anything larger never reaches the controller.
  const hugeClaim = await handle(new Request("https://ghostfleet.invalid/v1/enrollment-tickets/" + ticketId + "/claim", {
    method: "POST",
    headers: { "x-ghostfleet-preflight-digest": preflight },
    body: "9".repeat(2048),
  }));
  assert.equal(hugeClaim.status, 413);
  assert.equal((await hugeClaim.json()).error, "REQUEST_BODY_TOO_LARGE");
  assert.equal(c.getEnrollmentTicket(attempt.attempt_id).state, "ISSUED", "the oversized body consumed nothing");

  // The claim still works with the real short code afterwards.
  const claimed = await handle(new Request("https://ghostfleet.invalid/v1/enrollment-tickets/" + ticketId + "/claim", {
    method: "POST", headers: { "x-ghostfleet-preflight-digest": preflight }, body: "12345678",
  }));
  assert.equal(claimed.status, 200);

  const hugeComplete = await handle(new Request("https://ghostfleet.invalid/v1/enroll/complete", {
    method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(300_000),
  }));
  assert.equal(hugeComplete.status, 413);
  assert.equal((await hugeComplete.json()).error, "REQUEST_BODY_TOO_LARGE");
});

test("bootstrap consumes the actual formatted HTTP claim response", { skip: process.platform === "win32" }, async () => {
  const c = controller();
  const handle = createHttpHandler(c, { authorizeOperator: () => true });
  const created = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ asset_hint: "node", template_selection }),
  }));
  const attempt = (await created.json()).attempt;
  const issued = await handle(new Request("https://ghostfleet.invalid/v0/enrollment-attempts/" + attempt.attempt_id + "/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  const delivery = (await issued.json()).delivery;
  const ticketId = delivery.one_time_url.split("/").at(-1);
  const claimed = await handle(new Request("https://ghostfleet.invalid/v1/enrollment-tickets/" + ticketId + "/claim", {
    method: "POST",
    headers: { "x-ghostfleet-preflight-digest": preflight },
    body: "12345678",
  }));
  assert.equal(claimed.status, 200);
  const claimJson = await claimed.text();
  assert.match(claimJson, /"resume_session":\s+"/);

  const jsonGet = BOOTSTRAP_SH.match(/json_get\(\) \{\n[\s\S]*?\n\}/)?.[0];
  assert.ok(jsonGet);
  const parsed = spawnSync("/bin/sh", ["-c", jsonGet + '\njson_get "$CLAIM_JSON" resume_session\n'], {
    env: { ...process.env, CLAIM_JSON: claimJson },
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout.trim(), "resume_" + "r".repeat(48));
});

test("one-time ticket prompt matches the eight-digit ticket contract and keeps legacy fallback", () => {
  assert.ok(BOOTSTRAP_SH.includes('if [ -n "$ENROLLMENT_URL" ]; then'));
  assert.ok(BOOTSTRAP_SH.includes("Enrollment code (visible; 8 digits):"));
  assert.ok(BOOTSTRAP_SH.includes("Enrollment code (visible; FE1-XXXX-XXXX or XXXX-XXXX):"));
});

test("bootstrap supports one-time enrollment URL while preserving legacy broker fallback", () => {
  assert.ok(BOOTSTRAP_SH.includes("GHOSTFLEET_ENROLLMENT_URL"));
  assert.ok(BOOTSTRAP_SH.includes('CLAIM_URL="$ENROLLMENT_URL/claim"'));
  assert.ok(BOOTSTRAP_SH.includes('CLAIM_URL="$BROKER_ORIGIN/v1/enroll/claim"'));
});
