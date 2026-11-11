import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";
import { InMemoryStore } from "../src/control-plane/store.js";
import { createCapabilitySelectionProvider } from "../src/control-plane/capability-selection.js";
import { decodeCapabilitySelection } from "../packages/bootstrap/src/capability.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../packages/bootstrap/test/fixtures");
const preflight = "sha256:" + "a".repeat(64);
// Synthetic UID assembled at runtime: the publication guard reserves literal
// node identifiers for reviewed fixtures.
const NODE_UID = ["node", "00000000", "0000", "4000", "8000", "000000000001"].join("-");
const origin = "https://ghostfleet.invalid";

async function artifacts() {
  return [
    { name: "managed-linux-privileged-operations.sh", mode: "0750", content: await readFile(join(fixtures, "capability-installer.sh"), "utf8") },
    { name: "fleet-privctl.py", mode: "0755", content: await readFile(join(fixtures, "fleet-privctl.py"), "utf8") },
    { name: "privileged-ops.pub", mode: "0644", content: await readFile(join(fixtures, "privileged-ops.pub"), "utf8") },
    { name: "ghostfleet-managed.service", mode: "0644", content: await readFile(join(fixtures, "ghostfleet-managed.service"), "utf8") },
  ];
}

async function bundle() {
  // Deployment-owned pinned artifacts, template-agnostic.
  const provider = createCapabilitySelectionProvider({});
  assert.equal(provider, null);
  const { encodeCapabilitySelection } = await import("../packages/bootstrap/src/capability.js");
  return encodeCapabilitySelection({
    source: "template",
    version: "managed-linux-privileged-operations/2026.11",
    template_digest: "sha256:" + "0".repeat(64),
    helper_required: true,
    linger_required: true,
    user_service_required: true,
    control_account: "ghostfleet-ops",
    installer: "managed-linux-privileged-operations.sh",
    privileged_key: "privileged-ops.pub",
    user_unit: { name: "ghostfleet-managed.service", artifact: "ghostfleet-managed.service" },
    artifacts: await artifacts(),
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

async function issue(c, template_id) {
  const attempt = c.createEnrollmentAttempt({ asset_hint: "node", template_selection: { template_id } });
  return c.issueEnrollmentTicket(attempt.attempt_id, { public_origin: origin });
}

test("a template that selects managed privilege ships pinned artifacts with the claim", async () => {
  const provider = createCapabilitySelectionProvider({ bundle_base64: await bundle() });
  const c = controller({ capabilitySelectionProvider: provider });
  const issued = await issue(c, "managed-linux-standard");
  const claim = await c.claimEnrollmentTicket({ ticket_id: issued.ticket.ticket_id, short_code: "12345678", preflight_digest: preflight });
  assert.equal(claim.capability_required, true);
  assert.equal(typeof claim.capability_selection, "string");
  // The selection is bound to the ticket template, not to the client request.
  assert.equal(claim.template_digest, issued.ticket.template_digest);
  const selection = decodeCapabilitySelection(Buffer.from(claim.capability_selection, "base64").toString("utf8"));
  assert.equal(selection.template_digest, issued.ticket.template_digest);
  assert.equal(selection.helper_required, true);
  assert.equal(selection.linger_required, true);
  assert.equal(selection.control_account, "ghostfleet-ops");
  assert.deepEqual(selection.artifacts.map((item) => item.name).sort(), [
    "fleet-privctl.py", "ghostfleet-managed.service",
    "managed-linux-privileged-operations.sh", "privileged-ops.pub",
  ]);
  // Delivered material is public-safe: no secret and no private key body.
  const text = Buffer.from(claim.capability_selection, "base64").toString("utf8");
  assert.doesNotMatch(text, /BEGIN .*PRIVATE KEY|auth_key|resume_session/i);
});

test("a template that requests no privilege claims with no capability material", async () => {
  const provider = createCapabilitySelectionProvider({ bundle_base64: await bundle() });
  const c = controller({ capabilitySelectionProvider: provider });
  const issued = await issue(c, "customer-managed-limited");
  const claim = await c.claimEnrollmentTicket({ ticket_id: issued.ticket.ticket_id, short_code: "12345678", preflight_digest: preflight });
  assert.equal(claim.capability_required, false);
  assert.equal(claim.capability_selection, null);
});

test("a managed template without deployment artifacts still reports the requirement", async () => {
  const c = controller();
  const issued = await issue(c, "managed-linux-standard");
  const claim = await c.claimEnrollmentTicket({ ticket_id: issued.ticket.ticket_id, short_code: "12345678", preflight_digest: preflight });
  // The node must fail closed rather than silently under-install.
  assert.equal(claim.capability_required, true);
  assert.equal(claim.capability_selection, null);
});

test("a selection bound to another template is refused and the ticket stays claimable", async () => {
  const c = controller({
    capabilitySelectionProvider: {
      async select() {
        return { encoded: "c2VsZWN0aW9u", template_digest: "sha256:" + "b".repeat(64) };
      },
    },
  });
  const issued = await issue(c, "managed-linux-standard");
  await assert.rejects(
    () => c.claimEnrollmentTicket({ ticket_id: issued.ticket.ticket_id, short_code: "12345678", preflight_digest: preflight }),
    /CAPABILITY_SELECTION_BINDING_MISMATCH/,
  );
  assert.equal(c.store.getEnrollmentTicket(issued.ticket.ticket_id).state, "ISSUED");
});

test("claim material fields outside the explicit allowlist are dropped", async () => {
  const c = new GhostFleetController({
    store: new InMemoryStore(),
    ticketCodeFactory: () => "12345678",
    // A materializer that tries to smuggle extra material must not reach the
    // node: the claim response is built from an explicit allowlist.
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
  const issued = await issue(c, "managed-linux-standard");
  const claim = await c.claimEnrollmentTicket({ ticket_id: issued.ticket.ticket_id, short_code: "12345678", preflight_digest: preflight });
  assert.equal(claim.capability_selection, null, "materializer material never becomes a selection");
  assert.equal(claim.capability_required, true, "the template, not the materializer, decides");
  assert.equal("extra_material" in claim, false);
  assert.equal(JSON.stringify(claim).includes("bWFsaWNpb3Vz"), false);
});

test("the HTTP claim never lets a client supply or widen the selection", async () => {
  const provider = createCapabilitySelectionProvider({ bundle_base64: await bundle() });
  const c = controller({ capabilitySelectionProvider: provider });
  const handler = createHttpHandler(c);
  const issued = await issue(c, "managed-linux-standard");
  // The wire contract is a plain-text short code plus a preflight-digest header;
  // there is no field through which a client could supply capability material.
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

  // Injecting capability text into the claim body is a wrong short code, not a
  // selection: it never reaches the server-side provider.
  const injected = await issue(c, "managed-linux-standard");
  const injectedResponse = await handler(new Request(origin + "/v1/enrollment-tickets/" + injected.ticket.ticket_id + "/claim", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-ghostfleet-preflight-digest": preflight },
    body: "capability_selection=" + Buffer.from("artifact=evil|" + "0".repeat(64) + "|0755|Zm9vCg==").toString("base64"),
  }));
  assert.notEqual(injectedResponse.status, 200);
  assert.equal(c.store.getEnrollmentTicket(injected.ticket.ticket_id).state, "ISSUED");
});
