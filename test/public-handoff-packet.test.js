import test from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_PACKET_SCHEMA,
  HANDOFF_CLAIM_CLASS,
  createHandoffPacket,
  validateHandoffPacket,
  publicHandoffSummary,
  deepFreezePacket,
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
  assert.equal(packet.claim_class, HANDOFF_CLAIM_CLASS);
  assert.equal(packet.secret_value_included, false);
  assert.equal(validateHandoffPacket(packet), true);
  assert.ok(Object.isFrozen(packet));
  const summary = publicHandoffSummary(packet);
  assert.deepEqual(summary, {
    schema: HANDOFF_PACKET_SCHEMA,
    claim_class: HANDOFF_CLAIM_CLASS,
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

test("packet is labeled UNVERIFIED_CLAIMS_ONLY, never verified evidence", () => {
  const packet = createHandoffPacket(validInput());
  assert.equal(packet.claim_class, "UNVERIFIED_CLAIMS_ONLY");
  assert.equal(publicHandoffSummary(packet).claim_class, "UNVERIFIED_CLAIMS_ONLY");
  assert.throws(
    () => createHandoffPacket({ ...validInput(), claim_class: "VERIFIED" }),
    /HANDOFF_UNKNOWN_FIELD:claim_class/,
  );
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

test("secret-shaped KEYS are rejected", () => {
  const input = validInput();
  input.baseline = { ...input.baseline, access_token: "tsec_example" };
  assert.throws(() => createHandoffPacket(input), (error) => error instanceof UnsafePublicPayloadError);
});

test("secret-shaped free-text VALUES are rejected (pattern-shaped fakes, no real secrets)", () => {
  // Fakes are short/fragmented on purpose: they trip the module's value
  // patterns while staying inert to publication-guard (see existing
  // "do-not-store"/"tskey-fixture" style negatives elsewhere in test/).
  const userinfoUrl = ["open ", "http", "s://", "operator", ":", "fake", "@", "console", ".local/setup"].join("");
  const cases = [
    ["todo with token prefix", { real_first_use_todos: ["rotate gho_fake000 then re-run"] }],
    ["responsibility with key block", { responsibility: { ...validInput().responsibility, public: "note -----BEGIN FAKE PRIVATE KEY----- placeholder" } }],
    ["todo with credential assignment", { real_first_use_todos: ["set password: fake-none then continue"] }],
    ["todo with userinfo URL", { real_first_use_todos: [userinfoUrl] }],
    ["suite name with token prefix", { synthetic: { suites: [{ name: "xoxb-fake-suite", pass: 1, fail: 0, skip: 0 }] } }],
  ];
  for (const [label, patch] of cases) {
    assert.throws(() => createHandoffPacket({ ...validInput(), ...patch }), /HANDOFF_(TODOS_REQUIRED|RESPONSIBILITY_REQUIRED|SYNTHETIC_SUITE_INVALID)/, label);
  }
});

test("oversized free text is rejected", () => {
  const input = validInput();
  input.real_first_use_todos = ["x".repeat(2001)];
  assert.throws(() => createHandoffPacket(input), /HANDOFF_TODOS_REQUIRED/);
});

test("validated packet tree is deeply immutable (RF-2 regression)", () => {
  const packet = createHandoffPacket(validInput());
  assert.ok(Object.isFrozen(packet.synthetic.suites[0]));
  assert.ok(Object.isFrozen(packet.responsibility));
  assert.ok(Object.isFrozen(packet.real_first_use_todos));
  assert.throws(() => { packet.synthetic.suites[0].fail = 1; }, TypeError);
  assert.throws(() => { packet.responsibility.public = "rewritten"; }, TypeError);
  assert.throws(() => { packet.real_first_use_todos.push("extra"); }, TypeError);
  assert.throws(() => { packet.baseline.merged_refs.pop(); }, TypeError);
  // The validated content is unchanged after the attempts.
  assert.equal(packet.synthetic.suites[0].fail, 0);
});

test("deepFreezePacket freezes reachable nesting", () => {
  const tree = deepFreezePacket({ a: [{ b: 1 }], c: { d: [2] } });
  assert.ok(Object.isFrozen(tree) && Object.isFrozen(tree.a[0]) && Object.isFrozen(tree.c.d));
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
