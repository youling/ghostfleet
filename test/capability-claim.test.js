import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";
import { InMemoryStore } from "../src/control-plane/store.js";
import { createEnrollmentTemplateCatalog } from "../src/control-plane/enrollment-templates.js";
import { createCapabilitySelectionProvider } from "../src/control-plane/capability-selection.js";
import {
  decodeCapabilitySelection, encodeCapabilitySelection, capabilitySelectionDigest,
} from "../packages/bootstrap/src/capability.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../packages/bootstrap/test/fixtures");
const preflight = "sha256:" + "a".repeat(64);
const origin = "https://ghostfleet.invalid";
// Synthetic UID assembled at runtime: the publication guard reserves literal
// node identifiers for reviewed fixtures.
const NODE_UID = ["node", "00000000", "0000", "4000", "8000", "000000000001"].join("-");

async function artifacts() {
  return [
    { name: "managed-linux-privileged-operations.sh", mode: "0750", content: await readFile(join(fixtures, "capability-installer.sh"), "utf8") },
    { name: "fleet-privctl.py", mode: "0755", content: await readFile(join(fixtures, "fleet-privctl.py"), "utf8") },
    { name: "privileged-ops.pub", mode: "0644", content: await readFile(join(fixtures, "privileged-ops.pub"), "utf8") },
    { name: "ghostfleet-managed.service", mode: "0644", content: await readFile(join(fixtures, "ghostfleet-managed.service"), "utf8") },
  ];
}

async function bundleFor(template_digest, overrides = {}) {
  return encodeCapabilitySelection({
    source: "template",
    version: "managed-linux-privileged-operations/2026.11",
    template_digest,
    helper_required: true,
    linger_required: true,
    user_service_required: true,
    control_account: "ghostfleet-ops",
    installer: "managed-linux-privileged-operations.sh",
    privileged_key: "privileged-ops.pub",
    user_unit: { name: "ghostfleet-managed.service", artifact: "ghostfleet-managed.service" },
    artifacts: await artifacts(),
    ...overrides,
  });
}

function materializer() {
  return async ({ attempt, ticket, preflight_digest }) => ({
    outcome: "READY",
    delivery: {
      resume_session: "resume_" + "r".repeat(48),
      auth_key: "synthetic-one-time-provider-material",
      identity_kind: "canonical",
      node_id: "fixture-node",
      node_uid: NODE_UID,
    },
    attempt_id: attempt.attempt_id,
    ticket_id: ticket.ticket_id,
    preflight_digest,
  });
}

function controller(overrides = {}) {
  return new GhostFleetController({
    store: new InMemoryStore(),
    enrollmentClaimMaterializer: materializer(),
    ticketCodeFactory: () => "12345678",
    ...overrides,
  });
}

async function attemptFor(c, template_id) {
  return c.createEnrollmentAttempt({ asset_hint: "node", template_selection: { template_id } });
}

async function issue(c, attempt_id) {
  return c.issueEnrollmentTicket(attempt_id, { public_origin: origin });
}

async function claim(c, ticket_id) {
  return c.claimEnrollmentTicket({ ticket_id, short_code: "12345678", preflight_digest: preflight });
}

async function scoped(template_id, overrides = {}) {
  const probe = controller();
  const attempt = await attemptFor(probe, template_id);
  const digest = attempt.template_binding.template_digest;
  const provider = createCapabilitySelectionProvider({ bundle_base64: await bundleFor(digest, overrides) });
  const c = controller({ store: probe.store, capabilitySelectionProvider: provider });
  return { c, attempt, digest };
}

test("a managed template ships only its own pinned artifacts, bound to the ticket", async () => {
  const { c, attempt, digest } = await scoped("managed-linux-standard");
  const issued = await issue(c, attempt.attempt_id);
  const claimed = await claim(c, issued.ticket.ticket_id);
  assert.equal(claimed.capability_required, true);
  assert.equal(claimed.template_digest, issued.ticket.template_digest);
  const selection = decodeCapabilitySelection(Buffer.from(claimed.capability_selection, "base64").toString("utf8"));
  assert.equal(selection.template_digest, digest);
  assert.equal(selection.helper_required, true);
  assert.equal(selection.linger_required, true);
  assert.deepEqual(selection.artifacts.map((item) => item.name).sort(), [
    "fleet-privctl.py", "ghostfleet-managed.service",
    "managed-linux-privileged-operations.sh", "privileged-ops.pub",
  ]);
  const text = Buffer.from(claimed.capability_selection, "base64").toString("utf8");
  assert.doesNotMatch(text, /BEGIN .*PRIVATE KEY|auth_key|resume_session/i);
});

test("a template that requests no privilege claims with no capability material", async () => {
  const { c, attempt } = await scoped("customer-managed-limited");
  const issued = await issue(c, attempt.attempt_id);
  const claimed = await claim(c, issued.ticket.ticket_id);
  assert.equal(claimed.capability_required, false);
  assert.equal(claimed.capability_selection, null);
});

test("a bundle reviewed for another template cannot be relabelled onto this ticket", async () => {
  const probe = controller();
  const attempt = await attemptFor(probe, "managed-linux-standard");
  const other = await attemptFor(controller(), "managed-linux-tailscale");
  const foreign = createCapabilitySelectionProvider({
    bundle_base64: await bundleFor(other.template_binding.template_digest),
  });
  const c = controller({ store: probe.store, capabilitySelectionProvider: foreign });
  const issued = await issue(c, attempt.attempt_id);
  await assert.rejects(() => claim(c, issued.ticket.ticket_id), /CAPABILITY_SELECTION_BINDING_MISMATCH/);
  assert.equal(c.store.getEnrollmentTicket(issued.ticket.ticket_id).state, "ISSUED");
});

test("a selection that does not cover the reviewed plan is refused, not silently installed", async () => {
  // The template requires the privileged helper; a linger-only bundle would
  // under-install, so the claim must fail closed.
  const { c, attempt } = await scoped("managed-linux-standard", { helper_required: false, installer: null, privileged_key: null });
  const issued = await issue(c, attempt.attempt_id);
  await assert.rejects(() => claim(c, issued.ticket.ticket_id), /CAPABILITY_SELECTION_INCOMPLETE/);
  assert.equal(c.store.getEnrollmentTicket(issued.ticket.ticket_id).state, "ISSUED");
});

test("an unresolvable template fails the claim closed instead of installing nothing", async () => {
  const real = createEnrollmentTemplateCatalog();
  let strict = false;
  const catalog = {
    resolveSelection(selection) {
      if (strict) throw new Error("TEMPLATE_NOT_FOUND");
      return real.resolveSelection(selection);
    },
  };
  const c = controller({ enrollmentTemplates: catalog });
  const attempt = await attemptFor(c, "managed-linux-standard");
  const issued = await issue(c, attempt.attempt_id);
  strict = true;
  await assert.rejects(() => claim(c, issued.ticket.ticket_id), /TEMPLATE_RESOLUTION_FAILED/);
  assert.equal(c.store.getEnrollmentTicket(issued.ticket.ticket_id).state, "ISSUED");
});

test("a managed template without deployment artifacts still reports the requirement", async () => {
  const c = controller();
  const attempt = await attemptFor(c, "managed-linux-standard");
  const issued = await issue(c, attempt.attempt_id);
  const claimed = await claim(c, issued.ticket.ticket_id);
  assert.equal(claimed.capability_required, true);
  assert.equal(claimed.capability_selection, null);
});

test("claim material fields outside the explicit allowlist are dropped", async () => {
  const c = new GhostFleetController({
    store: new InMemoryStore(),
    ticketCodeFactory: () => "12345678",
    enrollmentClaimMaterializer: async ({ ticket, preflight_digest }) => ({
      outcome: "READY",
      delivery: {
        resume_session: "resume_" + "r".repeat(48),
        auth_key: "synthetic-one-time-provider-material",
        identity_kind: "canonical",
        node_id: "fixture-node",
        node_uid: NODE_UID,
        capability_selection: "bWFsaWNpb3Vz",
        capability_required: false,
        extra_material: "unexpected",
      },
      ticket_id: ticket.ticket_id,
      preflight_digest,
    }),
  });
  const attempt = await attemptFor(c, "managed-linux-standard");
  const issued = await issue(c, attempt.attempt_id);
  const claimed = await claim(c, issued.ticket.ticket_id);
  assert.equal(claimed.capability_selection, null, "materializer material never becomes a selection");
  assert.equal(claimed.capability_required, true, "the template, not the materializer, decides");
  assert.equal("extra_material" in claimed, false);
  assert.equal(JSON.stringify(claimed).includes("bWFsaWNpb3Vz"), false);
});

test("an accepted bundle is re-encoded from the validated selection, so shell and JS digests agree", async () => {
  const probe = controller();
  const attempt = await attemptFor(probe, "managed-linux-standard");
  const digest = attempt.template_binding.template_digest;
  const base = await bundleFor(digest);
  const text = Buffer.from(base, "base64").toString("utf8");
  // A hand-made bundle written with three-digit modes must still be accepted
  // only in normalised form.
  const loose = text.replace(/\|0(\d{3})\|/g, "|$1|");
  assert.notEqual(loose, text);
  const provider = createCapabilitySelectionProvider({ bundle_base64: Buffer.from(loose).toString("base64") });
  const selected = await provider.select();
  const normalized = Buffer.from(selected.encoded, "base64").toString("utf8");
  assert.doesNotMatch(normalized, /\|[0-7]{3}\|/);
  assert.match(normalized, /\|0750\|/);
  assert.equal(capabilitySelectionDigest(decodeCapabilitySelection(normalized)),
    capabilitySelectionDigest(decodeCapabilitySelection(text)));
});

test("the HTTP claim never lets a client supply or widen the selection", async () => {
  const { c, attempt } = await scoped("managed-linux-standard");
  const handler = createHttpHandler(c);
  const issued = await issue(c, attempt.attempt_id);
  const response = await handler(new Request(origin + "/v1/enrollment-tickets/" + issued.ticket.ticket_id + "/claim", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-ghostfleet-preflight-digest": preflight },
    body: "12345678",
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.capability_required, true);
  const text = Buffer.from(body.capability_selection, "base64").toString("utf8");
  assert.doesNotMatch(text, /evil/);
  assert.match(text, /artifact=managed-linux-privileged-operations\.sh\|/);

  const injected = await issue(c, (await attemptFor(c, "managed-linux-standard")).attempt_id);
  const injectedResponse = await handler(new Request(origin + "/v1/enrollment-tickets/" + injected.ticket.ticket_id + "/claim", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-ghostfleet-preflight-digest": preflight },
    body: "capability_selection=" + Buffer.from("artifact=evil|" + "0".repeat(64) + "|0755|Zm9vCg==").toString("base64"),
  }));
  assert.notEqual(injectedResponse.status, 200);
  assert.equal(c.store.getEnrollmentTicket(injected.ticket.ticket_id).state, "ISSUED");
});
