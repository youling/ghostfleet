import test from "node:test";
import assert from "node:assert/strict";
import { createDeploymentEnrollmentTemplateCatalog } from "../src/adapters/cloudflare/deployment-templates.js";
import { createEnrollmentClaimMaterializer, createEnrollmentClaimPreparer } from "../src/adapters/cloudflare/enrollment-materializer.js";

function extension(overrides = {}) {
  return {
    templates: [{
      template_id: "fully-managed",
      version: "1.0.0",
      generation: "fleet-fully-managed-v1",
      extends: "managed-linux-tailscale",
      posture: {
        providers: { tailscale: { ssh: true } },
        privilege: { broker_required: true, helper_required: true },
        recovery: { break_glass_required: true },
        consumer_acceptance: "STRICT",
        bootstrap: { root_ceremony: "ONE_TIME", requirements: ["systemd"] },
      },
    }],
    display: {
      "fully-managed": {
        "zh-CN": { name: "完全纳管", description: "Synthetic private deployment profile." },
        en: { name: "Fully managed", description: "Synthetic private deployment profile." },
      },
    },
    ...overrides,
  };
}

test("no deployment catalog extension preserves the public template surface", () => {
  const catalog = createDeploymentEnrollmentTemplateCatalog({});
  const ids = catalog.list().map((item) => item.template_id);
  assert.deepEqual(ids, ["managed-linux-standard", "managed-linux-tailscale", "customer-managed-limited"]);
});

test("a private non-secret extension can expose a deployment-only fully-managed mode", () => {
  const catalog = createDeploymentEnrollmentTemplateCatalog({
    GHOSTFLEET_ENROLLMENT_CATALOG_JSON: JSON.stringify(extension()),
  });
  const item = catalog.list().find((entry) => entry.template_id === "fully-managed");
  assert.ok(item);
  assert.equal(item.display["zh-CN"].name, "完全纳管");
  assert.equal(item.effective_posture.providers.tailscale.enabled, true);
  assert.equal(item.effective_posture.providers.tailscale.ssh, true);
  assert.equal(item.effective_posture.privilege.broker_required, true);
  assert.equal(item.effective_posture.recovery.break_glass_required, true);
  assert.equal(item.effective_posture.consumer_acceptance, "STRICT");
  assert.equal(item.effective_posture.bootstrap.root_ceremony, "ONE_TIME");
  assert.ok(item.allowed_override_paths.includes("providers.tailscale.ssh"));
  assert.match(item.binding.template_digest, /^sha256:[0-9a-f]{64}$/);
});

test("deployment catalog rejects public-id collisions, orphan display, and secret-shaped plaintext", () => {
  const collision = extension();
  collision.templates[0].template_id = "managed-linux-tailscale";
  assert.throws(() => createDeploymentEnrollmentTemplateCatalog({
    GHOSTFLEET_ENROLLMENT_CATALOG_JSON: JSON.stringify(collision),
  }), /DEPLOYMENT_TEMPLATE_ID_COLLISION/);

  const orphan = extension();
  orphan.display["unknown-private-template"] = { en: { name: "Unknown", description: "" } };
  assert.throws(() => createDeploymentEnrollmentTemplateCatalog({
    GHOSTFLEET_ENROLLMENT_CATALOG_JSON: JSON.stringify(orphan),
  }), /DEPLOYMENT_TEMPLATE_DISPLAY_ORPHAN/);

  const secret = extension();
  secret.templates[0].posture.provider_secret = "synthetic-plaintext-must-be-rejected";
  assert.throws(() => createDeploymentEnrollmentTemplateCatalog({
    GHOSTFLEET_ENROLLMENT_CATALOG_JSON: JSON.stringify(secret),
  }), /SECRET_PLAINTEXT_FORBIDDEN/);
});

test("prepare and materialize share one private binding but use distinct protocols and endpoints", async () => {
  const calls = [];
  const service = {
    async fetch(url, init) {
      const payload = JSON.parse(init.body);
      calls.push({ url, payload });
      if (url.endsWith("/v1/prepare")) {
        return Response.json({ outcome: "READY", expires_at: "2026-10-01T00:10:00.000Z" });
      }
      return Response.json({
        outcome: "READY",
        delivery: {
          resume_session: "resume_" + "r".repeat(48),
          auth_key: "synthetic-one-time-material",
          identity_kind: "provisional",
          enrollment_id: "enroll-12345678-1234-1234-1234-123456789abc",
          node_id: "fleet-bootstrap-123456abcdef",
          node_uid: null,
        },
      });
    },
  };
  const env = {
    GHOSTFLEET_ENROLLMENT_CLAIM_READY: "1",
    GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: service,
  };
  const attempt = {
    attempt_id: "attempt-12345678-1234-1234-1234-123456789abc",
    template_binding: {
      template_id: "fully-managed",
      template_generation: "fleet-fully-managed-v1",
      template_digest: "sha256:" + "a".repeat(64),
    },
  };
  const preparer = createEnrollmentClaimPreparer(env);
  const materializer = createEnrollmentClaimMaterializer(env);
  assert.ok(preparer);
  assert.ok(materializer);
  assert.equal((await preparer({ attempt, requested_ttl_seconds: 600 })).outcome, "READY");
  assert.equal((await materializer({
    attempt,
    ticket: { ticket_id: "ticket-12345678-1234-1234-1234-123456789abc" },
    preflight_digest: "sha256:" + "b".repeat(64),
  })).outcome, "READY");

  assert.equal(calls[0].url, "https://service.invalid/v1/prepare");
  assert.equal(calls[0].payload.protocol, "ghostfleet-enrollment-claim-prepare/v1");
  assert.equal(calls[0].payload.attempt_id, attempt.attempt_id);
  assert.equal(calls[1].url, "https://service.invalid/v1/materialize");
  assert.equal(calls[1].payload.protocol, "ghostfleet-enrollment-claim-material/v1");
  assert.equal(calls[1].payload.attempt_id, attempt.attempt_id);
});

test("private enrollment service remains disabled without explicit readiness and binding", () => {
  assert.equal(createEnrollmentClaimPreparer({}), null);
  assert.equal(createEnrollmentClaimMaterializer({}), null);
  const service = { fetch() { throw new Error("not called"); } };
  assert.equal(createEnrollmentClaimPreparer({ GHOSTFLEET_ENROLLMENT_CLAIM_MATERIALIZER: service }), null);
});
