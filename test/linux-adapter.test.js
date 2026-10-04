import test from "node:test";
import assert from "node:assert/strict";
import { LinuxReceiptAdapter } from "../src/adapters/linux/index.js";
import { LINUX_BINDING_PROTOCOL, LINUX_RECEIPT_PROTOCOL, LINUX_EVIDENCE_TYPES, linuxReceiptDigest, validateLinuxReceipt } from "../src/adapters/linux/receipt.js";
import { GhostFleetController } from "../src/control-plane/controller.js";

// Every device/provider value below is synthetic. These tests cannot prove hardware acceptance.
const NOW = Date.parse("2026-10-05T00:00:00.000Z");
class Clock extends Date { constructor(value = NOW) { super(value); } static now() { return NOW; } }
const hash = (character) => "sha256:" + character.repeat(64);
const at = (delta = 0) => new Date(NOW + delta).toISOString();
function binding() {
  return {
    protocol: LINUX_BINDING_PROTOCOL, attempt_id: "attempt-synthetic-linux", node_uid: "node-synthetic-new",
    lifecycle: "PROVISIONAL", enrollment_id: "enroll-synthetic-new", adapter_id: "linux-synthetic-adapter",
    observer_id: "observer-synthetic-controller", credential_ref: "custody:synthetic-scoped-identity",
    source_revision: "a".repeat(40),
    subject: { machine_id_digest: hash("b"), provider_identity_digest: hash("c"), boot_id_digest: hash("d") },
    reboot_checkpoint: { checkpoint_ref: "checkpoint:synthetic-before-reboot", dispatch_ref: "dispatch:synthetic-one-reboot", before_boot_digest: hash("d") },
    expires_at: at(600000), max_age_seconds: 300,
  };
}
function receipt(type, configured = binding()) {
  const facts = {
    "transport.ready": { external_observation: true, authenticated: true, host_pin_matches: true, provider_running: true },
    "bootstrap.report": { completion_verified: true, report_digest: hash("e"), checkpoint_digest: hash("f") },
    "control.canary": { operation: "node_inspect", risk: "R0", receipt_verified: true },
    "convergence.zero_delta": { engine: "fleet-linux-converger/v1", outcome: "PRIMARY_CONVERGED", execution_verified: true, repeat: true, plan_digest: hash("e"), before_state_digest: hash("f"), after_state_digest: hash("f"), material_delta: [], lifecycle_promoted: false },
    "reboot.recovered": { scheduled_checkpoint_ref: configured.reboot_checkpoint?.checkpoint_ref ?? "checkpoint:synthetic-missing", dispatch_ref: configured.reboot_checkpoint?.dispatch_ref ?? "dispatch:synthetic-missing", before_boot_digest: configured.subject.boot_id_digest, after_boot_digest: hash("e"), recovered_transport: true, recovered_control: true, recovered_identity: true },
  }[type];
  return {
    protocol: LINUX_RECEIPT_PROTOCOL, type, operation_id: "operation-synthetic-" + type.replaceAll(".", "-"),
    ...Object.fromEntries(["attempt_id", "node_uid", "enrollment_id", "adapter_id", "observer_id", "credential_ref", "source_revision"].map((key) => [key, configured[key]])),
    subject: { ...configured.subject, boot_id_digest: type === "reboot.recovered" ? hash("e") : configured.subject.boot_id_digest },
    observed_at: at(), outcome: "SUCCEEDED", receipt_ref: "receipt:synthetic-observation", facts,
  };
}
async function verifyReceipt(request) {
  // Test-only observer. A live backend must authenticate and resolve its private receipt.
  return {
    verified: true, nonce: request.nonce, receipt_digest: request.receipt_digest,
    observer_id: request.binding.observer_id, credential_ref: request.binding.credential_ref,
    source_revision: request.binding.source_revision, current_subject: structuredClone(request.receipt.subject), observed_at: at(),
  };
}
const validate = (value, configured = binding(), verifier = verifyReceipt, clock = Clock) => validateLinuxReceipt(value, configured, { verifyReceipt: verifier, clock });
function backend(configured, overrides = {}) {
  return {
    readTransportReceipt: async () => receipt("transport.ready", configured),
    readBootstrapReceipt: async () => receipt("bootstrap.report", configured),
    readControlReceipt: async () => receipt("control.canary", configured),
    readConvergenceReceipt: async () => receipt("convergence.zero_delta", configured),
    readRebootReceipt: async () => receipt("reboot.recovered", configured),
    ...overrides,
  };
}

test("five strict synthetic receipts become sanitized adapter evidence, without core proof authority", async () => {
  const configured = binding();
  const adapter = new LinuxReceiptAdapter({ binding: configured, backend: backend(configured), verifyReceipt, clock: Clock });
  for (const type of LINUX_EVIDENCE_TYPES) {
    const result = await adapter.collect(type);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.type, type);
    assert.equal(result.evidence.data.status, "PASS");
    assert.equal(result.evidence.data.node_uid, configured.node_uid);
    assert.equal(result.evidence.source, "ghostfleet-linux-adapter");
  }
  await assert.rejects(adapter.collect("identity.materialized"), /LINUX_EVIDENCE_TYPE_INVALID/);
  assert.equal(adapter.exec, undefined);
  assert.equal(adapter.reboot, undefined);
});

test("retired/different UID, other enrollment, adapter or source revision cannot borrow a receipt", async () => {
  for (const [key, value] of [["node_uid", "node-synthetic-retired"], ["attempt_id", "attempt-synthetic-other"], ["enrollment_id", "enroll-synthetic-other"], ["adapter_id", "linux-synthetic-other"], ["credential_ref", "custody:synthetic-other"], ["source_revision", "b".repeat(40)]]) {
    const proof = receipt("transport.ready"); proof[key] = value;
    await assert.rejects(validate(proof), /LINUX_RECEIPT_BINDING_MISMATCH/);
  }
});

test("a different physical/provider subject or current boot fails before observer invocation", async () => {
  let calls = 0;
  for (const key of ["machine_id_digest", "provider_identity_digest", "boot_id_digest"]) {
    const proof = receipt("bootstrap.report"); proof.subject[key] = hash("a");
    await assert.rejects(validate(proof, binding(), async () => { calls++; }), /LINUX_RECEIPT_(SUBJECT_MISMATCH|BOOT_CONFLICT)/);
  }
  assert.equal(calls, 0);
});

test("stale or future receipts are rejected before private I/O", async () => {
  for (const delta of [-300001, 1]) {
    const proof = receipt("transport.ready"); proof.observed_at = at(delta);
    await assert.rejects(validate(proof), /LINUX_RECEIPT_STALE/);
  }
});

test("source labels alone cannot attest a receipt; observer must bind nonce and exact digest", async () => {
  await assert.rejects(validateLinuxReceipt(receipt("transport.ready"), binding(), { clock: Clock }), /LINUX_OBSERVER_REQUIRED/);
  for (const patch of [{ verified: false }, { nonce: "synthetic-replayed-nonce" }, { receipt_digest: hash("a") }, { observer_id: "observer-synthetic-wrong" }, { credential_ref: "custody:synthetic-wrong" }, { source_revision: "b".repeat(40) }]) {
    await assert.rejects(validate(receipt("transport.ready"), binding(), async (request) => ({ ...await verifyReceipt(request), ...patch })), /LINUX_OBSERVER_BINDING_MISMATCH/);
  }
});

test("fresh observer must independently agree with the complete current subject", async () => {
  for (const key of ["machine_id_digest", "provider_identity_digest", "boot_id_digest"]) {
    await assert.rejects(validate(receipt("control.canary"), binding(), async (request) => {
      const attestation = await verifyReceipt(request); attestation.current_subject[key] = hash("a"); return attestation;
    }), /LINUX_CURRENT_SUBJECT_CONFLICT/);
  }
  await assert.rejects(validate(receipt("transport.ready"), binding(), async (request) => ({ ...await verifyReceipt(request), observed_at: at(-300001) })), /LINUX_RECEIPT_STALE/);
});

test("binding expiry during observer verification cannot produce PASS", async () => {
  let now = NOW;
  class AdvancingClock extends Date { static now() { return now; } }
  const configured = binding(); configured.expires_at = at(1000);
  await assert.rejects(validate(receipt("transport.ready", configured), configured, async (request) => {
    now += 1001; return { ...await verifyReceipt(request), observed_at: new Date(now).toISOString() };
  }, AdvancingClock), /LINUX_BINDING_EXPIRED/);
});

test("transport needs authenticated external observations and verified host pin", async () => {
  for (const key of ["external_observation", "authenticated", "host_pin_matches", "provider_running"]) {
    const proof = receipt("transport.ready"); proof.facts[key] = false;
    await assert.rejects(validate(proof), /LINUX_POSTCONDITION_FAILED/);
  }
});

test("bootstrap report needs verified protected completion, not installed packages", async () => {
  const proof = receipt("bootstrap.report"); proof.facts.completion_verified = false;
  await assert.rejects(validate(proof), /LINUX_POSTCONDITION_FAILED/);
});

test("control receipt only represents the fixed typed R0 canary", async () => {
  for (const patch of [{ operation: "exec" }, { risk: "R2" }, { receipt_verified: false }]) {
    const proof = receipt("control.canary"); Object.assign(proof.facts, patch);
    await assert.rejects(validate(proof), /LINUX_CONTROL_SCOPE_INVALID|LINUX_POSTCONDITION_FAILED/);
  }
});

test("zero-delta requires an executed accepted-engine repeat with no effects or hidden state changes", async () => {
  for (const patch of [{ repeat: false }, { execution_verified: false }, { material_delta: ["restart-tailscaled"] }, { after_state_digest: hash("a") }, { lifecycle_promoted: true }]) {
    const proof = receipt("convergence.zero_delta"); Object.assign(proof.facts, patch);
    await assert.rejects(validate(proof), /LINUX_MATERIAL_DELTA_PRESENT/);
  }
  const proof = receipt("convergence.zero_delta"); proof.facts.engine = "synthetic-snapshot-only";
  await assert.rejects(validate(proof), /LINUX_CONVERGENCE_INVALID/);
});

test("reboot needs the exact pre-dispatch checkpoint, changed boot and independently recovered identity", async () => {
  for (const patch of [{ after_boot_digest: hash("d") }, { before_boot_digest: hash("a") }, { scheduled_checkpoint_ref: "checkpoint:synthetic-other" }, { dispatch_ref: "dispatch:synthetic-other" }, { recovered_control: false }]) {
    const proof = receipt("reboot.recovered"); Object.assign(proof.facts, patch);
    await assert.rejects(validate(proof), /LINUX_REBOOT_NOT_OBSERVED|LINUX_REBOOT_CHECKPOINT_CONFLICT|LINUX_POSTCONDITION_FAILED/);
  }
  const configured = binding(); configured.reboot_checkpoint = null;
  await assert.rejects(validate(receipt("reboot.recovered", configured), configured), /LINUX_REBOOT_CHECKPOINT_CONFLICT/);
});

test("receipt fields reject raw credentials, private locators and unknown payload surfaces", async () => {
  const proof = receipt("transport.ready"); proof.facts.private_key = "synthetic-forbidden-field";
  await assert.rejects(validate(proof), /raw secret-bearing field/);
  const located = receipt("transport.ready"); located.credential_ref = "https://example.invalid/private-custody";
  const configured = binding(); configured.credential_ref = located.credential_ref;
  await assert.rejects(validate(located, configured), /LINUX_BINDING_INVALID/);
  const additional = receipt("bootstrap.report"); additional.facts.raw_inventory = "synthetic-extra";
  await assert.rejects(validate(additional), /LINUX_FACTS_INVALID/);
});

test("FAILED and UNKNOWN authenticated receipts cannot yield PASS", async () => {
  for (const outcome of ["FAILED", "UNKNOWN"]) {
    const proof = receipt("control.canary"); proof.outcome = outcome; proof.facts.receipt_verified = false;
    const evidence = await validate(proof, binding(), async (request) => ({ ...await verifyReceipt(request), current_subject: null }));
    assert.equal(evidence.data.status, outcome === "FAILED" ? "FAIL" : "UNKNOWN");
  }
});

test("unknown reboot is read once, requires reconcile, and never dispatches recovery effects", async () => {
  const configured = binding(); let observations = 0; let mutations = 0;
  const adapter = new LinuxReceiptAdapter({ binding: configured, clock: Clock, verifyReceipt, backend: backend(configured, {
    readRebootReceipt: async () => { observations++; const proof = receipt("reboot.recovered", configured); proof.outcome = "UNKNOWN"; return proof; },
    reboot: () => { mutations++; }, converge: () => { mutations++; }, mint: () => { mutations++; },
  }) });
  const result = await adapter.collect("reboot.recovered");
  assert.equal(result.state, "RECONCILE_REQUIRED"); assert.equal(result.evidence.data.status, "UNKNOWN");
  assert.equal(observations, 1); assert.equal(mutations, 0);
});

test("private I/O errors are sanitized; mismatched returned evidence type is not accepted", async () => {
  const configured = binding(); let calls = 0;
  const adapter = new LinuxReceiptAdapter({ binding: configured, clock: Clock, verifyReceipt, backend: backend(configured, {
    readTransportReceipt: async () => { calls++; throw new Error("synthetic-private-detail-must-not-escape"); },
    readBootstrapReceipt: async () => receipt("transport.ready", configured),
  }) });
  const failed = await adapter.collect("transport.ready");
  assert.equal(calls, 1); assert.equal(failed.reason, "LINUX_OBSERVATION_UNKNOWN");
  assert.equal(JSON.stringify(failed).includes("synthetic-private-detail"), false);
  const mismatch = await adapter.collect("bootstrap.report");
  assert.equal(mismatch.reason, "LINUX_EVIDENCE_TYPE_MISMATCH"); assert.equal(mismatch.evidence.type, "bootstrap.report");
});

test("latest adapter UNKNOWN invalidates an earlier PASS through the existing core seam", async () => {
  const controller = new GhostFleetController({ clock: Clock });
  const attempt = controller.createEnrollmentAttempt(); controller.prepareEnrollmentAttempt(attempt.attempt_id); controller.claimEnrollmentAttempt(attempt.attempt_id);
  const materializing = controller.startMaterialization(attempt.attempt_id, { platform: "linux" });
  const configured = binding(); configured.attempt_id = attempt.attempt_id; configured.node_uid = materializing.node_uid;
  let available = true;
  const adapter = new LinuxReceiptAdapter({ binding: configured, clock: Clock, verifyReceipt, backend: backend(configured, {
    readControlReceipt: async () => { if (!available) throw new Error("synthetic-offline"); return receipt("control.canary", configured); },
  }) });
  for (const type of LINUX_EVIDENCE_TYPES) controller.recordEvidence(attempt.attempt_id, (await adapter.collect(type)).evidence);
  available = false;
  controller.recordEvidence(attempt.attempt_id, (await adapter.collect("control.canary")).evidence);
  assert.throws(() => controller.acceptEnrollment(attempt.attempt_id), (error) => error.missing.includes("control.canary"));
  assert.equal(controller.getNode(materializing.node_uid).lifecycle, "PROVISIONAL");
});

test("binding clone prevents later caller mutation from redirecting a private observation", async () => {
  const configured = binding(); const expected = structuredClone(configured);
  const adapter = new LinuxReceiptAdapter({ binding: configured, clock: Clock, verifyReceipt, backend: backend(expected) });
  configured.node_uid = "node-synthetic-retired"; configured.subject.machine_id_digest = hash("a");
  assert.equal((await adapter.collect("transport.ready")).evidence.data.node_uid, expected.node_uid);
});

test("expired binding fails before any backend I/O", async () => {
  let now = NOW; class ExpiringClock extends Date { static now() { return now; } }
  const configured = binding(); let calls = 0;
  const adapter = new LinuxReceiptAdapter({ binding: configured, clock: ExpiringClock, verifyReceipt, backend: backend(configured, { readTransportReceipt: async () => { calls++; } }) });
  now += 600000;
  await assert.rejects(adapter.collect("transport.ready"), /LINUX_BINDING_EXPIRED/);
  assert.equal(calls, 0);
});

test("receipt digest ignores object key order while binding every value", async () => {
  const original = receipt("transport.ready");
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(await linuxReceiptDigest(original), await linuxReceiptDigest(reordered));
  reordered.operation_id = "operation-synthetic-other";
  assert.notEqual(await linuxReceiptDigest(original), await linuxReceiptDigest(reordered));
});

test("operation identifiers cannot pass through regular-expression coercion", async () => {
  for (const value of [null, true, undefined, 123]) {
    const proof = receipt("transport.ready"); proof.operation_id = value;
    await assert.rejects(validate(proof), /LINUX_RECEIPT_INVALID/);
  }
});

test("published bootstrap convergence needs the same executed-repeat proof as the opt-in engine", async () => {
  const proof = receipt("convergence.zero_delta"); proof.facts.engine = "fleet-enroll-bootstrap/v2-r1";
  assert.equal((await validate(proof)).data.status, "PASS");
  proof.facts.execution_verified = false;
  await assert.rejects(validate(proof), /LINUX_MATERIAL_DELTA_PRESENT/);
});

test("a hanging backend or verifier returns UNKNOWN within the whole observation deadline", async () => {
  for (const lane of ["backend", "verifier"]) {
    let signal; let calls = 0;
    const configured = binding();
    const hanging = (_, options) => { calls++; signal = options.signal; return new Promise(() => {}); };
    const adapter = new LinuxReceiptAdapter({ binding: configured, clock: { now: () => NOW }, observation_timeout_ms: 20,
      backend: backend(configured, lane === "backend" ? { readTransportReceipt: hanging } : {}),
      verifyReceipt: lane === "verifier" ? (request) => { calls++; signal = request.signal; return new Promise(() => {}); } : verifyReceipt });
    const result = await adapter.collect("transport.ready");
    assert.equal(result.reason, "LINUX_OBSERVATION_TIMEOUT");
    assert.equal(result.evidence.data.status, "UNKNOWN");
    assert.equal(result.evidence.at, at());
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  }
});

test("a late observation cannot replace a returned UNKNOWN or start observer verification", async () => {
  let release; let verificationCalls = 0;
  const configured = binding();
  const adapter = new LinuxReceiptAdapter({ binding: configured, clock: Clock, observation_timeout_ms: 10,
    backend: backend(configured, { readTransportReceipt: () => new Promise((resolve) => { release = resolve; }) }),
    verifyReceipt: async (request) => { verificationCalls++; return verifyReceipt(request); } });
  const result = await adapter.collect("transport.ready");
  release(receipt("transport.ready", configured));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(result.evidence.data.status, "UNKNOWN");
  assert.equal(verificationCalls, 0);
});

test("observation deadlines are bounded and injectable clocks only need now()", async () => {
  const configured = binding();
  for (const value of [0, 30001, Infinity, "20"]) {
    assert.throws(() => new LinuxReceiptAdapter({ binding: configured, backend: backend(configured), verifyReceipt, clock: Clock, observation_timeout_ms: value }), /LINUX_DEADLINE_INVALID/);
  }
  const adapter = new LinuxReceiptAdapter({ binding: configured, backend: backend(configured, { readControlReceipt: async () => { throw new Error("private-error"); } }), verifyReceipt, clock: { now: () => NOW } });
  assert.equal((await adapter.collect("control.canary")).evidence.at, at());
});
