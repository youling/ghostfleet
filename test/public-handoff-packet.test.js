import test from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_PACKET_SCHEMA,
  createHandoffPacket,
  validateHandoffPacket,
  publicHandoffSummary,
} from "../src/control-plane/handoff-packet.js";
import { UnsafePublicPayloadError } from "../src/core/security.js";

const HEAD = "1d529299425c85bc31cc332af271ba814f7d8ce5";
const PR43 = "cc8b30dca2671cd19dc8fa9fbcaa758783b11891";
const PR44 = "8557417d5ca1bd859163f761ced82b753ef92c88";

function validInput() {
  return {
    work: "youling/ghostfleet#11@build",
    live_head: HEAD,
    baseline: { merged_refs: [PR43, PR44, HEAD], open_prs: 0, no_production_change: true },
    synthetic: {
      suites: [
        { name: "npm test", pass: 193, fail: 0, skip: 1 },
        { name: "typed-control", pass: 59, fail: 0, skip: 0 },
        { name: "bootstrap", pass: 10, fail: 0, skip: 1 },
        { name: "runtime-python", pass: 81, fail: 0, skip: 5 },
      ],
    },
    responsibility: {
      public: "generic schema/adapter contract/ticket-claim-bootstrap/synthetic evidence/docs",
      private_owner: "private overlay/binding/credential custody/deployment/real receipts",
      human_first_use: "durable custody/real evidence/independent replay/rollback drill/OMV8 sign-off",
    },
    real_first_use_todos: [
      "freeze consumer_ref/source/config/control_path/origin_executor",
      "deployment owner signs durable custody",
      "collect 9-element real evidence under node_uid(ACTIVE)",
    ],
    produced_at: "2026-10-12T19:51:20.000Z",
  };
}

test("handoff packet round-trips and validates at frozen shape", () => {
  const packet = createHandoffPacket(validInput());
  assert.equal(packet.schema, HANDOFF_PACKET_SCHEMA);
  assert.equal(packet.secret_value_included, false);
  assert.equal(validateHandoffPacket(packet), true);
  assert.ok(Object.isFrozen(packet));
  const summary = publicHandoffSummary(packet);
  assert.deepEqual(summary, {
    schema: HANDOFF_PACKET_SCHEMA,
    work: "youling/ghostfleet#11@build",
    live_head: HEAD,
    suites: 4,
    total_pass: 343,
    total_skip: 7,
    todos_count: 3,
    produced_at: "2026-10-12T19:51:20.000Z",
    secret_value_included: false,
  });
});

test("unknown top-level field fails closed", () => {
  const input = { ...validInput(), reviewer_override: true };
  assert.throws(() => createHandoffPacket(input), /HANDOFF_UNKNOWN_FIELD:reviewer_override/);
});

test("unknown nested field fails closed", () => {
  const input = validInput();
  input.responsibility = { ...input.responsibility, deploy_approval: "granted" };
  assert.throws(() => createHandoffPacket(input), /HANDOFF_UNKNOWN_FIELD:responsibility.deploy_approval/);
});

test("secret-shaped material is rejected", () => {
  const input = validInput();
  input.baseline = { ...input.baseline, access_token: "tsec_example" };
  assert.throws(() => createHandoffPacket(input), (error) => error instanceof UnsafePublicPayloadError);
});

test("non-green synthetic evidence cannot hand off", () => {
  const input = validInput();
  input.synthetic.suites[0] = { name: "npm test", pass: 192, fail: 1, skip: 1 };
  assert.throws(() => createHandoffPacket(input), /HANDOFF_SYNTHETIC_NOT_GREEN/);
});

test("short or non-hex head is rejected", () => {
  for (const head of ["1d52929", "", "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", 12345]) {
    assert.throws(() => createHandoffPacket({ ...validInput(), live_head: head }), /HANDOFF_HEAD_INVALID/);
  }
});

test("empty real first-use todos are rejected: synthetic PASS != real acceptance", () => {
  assert.throws(() => createHandoffPacket({ ...validInput(), real_first_use_todos: [] }), /HANDOFF_TODOS_REQUIRED/);
});

test("production change without declaration is rejected", () => {
  const input = validInput();
  input.baseline = { ...input.baseline, no_production_change: false };
  assert.throws(() => createHandoffPacket(input), /HANDOFF_PRODUCTION_CHANGE_UNDECLARED/);
});
