import { assertPublicSafe } from "../core/security.js";

// PUBLIC_HANDOFF_PACKET v0 — youling/ghostfleet#11 bounded scope.
//
// A handoff packet is a durable public-side CLAIM CONTAINER for a parent
// Work: it binds the exact head, the merged baseline refs, the reported
// synthetic evidence, the public/private responsibility split, and the real
// first-use todos that are explicitly NOT claimed as done. It is labeled
// UNVERIFIED_CLAIMS_ONLY: validateHandoffPacket() checks shape, bounds, and
// best-effort secret hygiene, but never concludes "handoff-ready" or
// "synthetic PASS proved". Proof is the exact-head CI run plus Architect
// readback at acceptance time. The packet carries no secret material, no
// deployment authority, and no real-node evidence. Unknown fields fail
// closed so a packet can never silently smuggle extra authority or an
// unreviewed claim past Architect acceptance.

export const HANDOFF_PACKET_SCHEMA = "ghostfleet.public-handoff-packet.v1";

// RF-3: explicit claim classification. The library only ever issues this
// class; a packet that claims a stronger class is rejected.
export const HANDOFF_CLAIM_CLASS = "UNVERIFIED_CLAIMS_ONLY";

const HEAD_RE = /^[0-9a-f]{40}$/;
const WORK_RE = /^[\w.-]+\/[\w.-]+#\d+@[\w.-]+$/;

// RF-1: bounded free-text policy. Free-text surfaces (suite names,
// responsibility statements, todos) are prose, so they cannot be ref-only;
// they are length-capped and scanned for raw secret-shaped VALUES. These
// scans are best-effort hygiene, not proof of secret-freedom.
export const HANDOFF_MAX_TEXT = 2000;
export const HANDOFF_MAX_SUITE_NAME = 200;

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(gho_|github_pat_|ghp_|glpat-|xox[baprs]-|AKIA[0-9A-Z]{16})/,
  /\b(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*\S+/i,
  /:\/\/[^/\s]*:[^/\s]*@/,
];

const TOP_LEVEL_FIELDS = new Set([
  "schema",
  "claim_class",
  "work",
  "live_head",
  "baseline",
  "synthetic",
  "responsibility",
  "real_first_use_todos",
  "produced_at",
  "secret_value_included",
]);

const RESPONSIBILITY_FIELDS = new Set(["public", "private_owner", "human_first_use"]);

// Caller-supplied construction fields. `schema`, `claim_class` and
// `secret_value_included` are system-set inside createHandoffPacket and
// rejected here if supplied.
const INPUT_FIELDS = new Set([
  "work",
  "live_head",
  "baseline",
  "synthetic",
  "responsibility",
  "real_first_use_todos",
  "produced_at",
]);

export class HandoffPacketError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "HandoffPacketError";
    this.code = code;
    this.status = status;
  }
}

function assertNonEmptyString(value, code) {
  if (typeof value !== "string" || value.trim() === "") throw new HandoffPacketError(code);
  return value;
}

function assertNonNegativeInt(value, code) {
  if (!Number.isInteger(value) || value < 0) throw new HandoffPacketError(code);
  return value;
}

function assertBoundedText(value, max, code) {
  assertNonEmptyString(value, code);
  if (value.length > max) throw new HandoffPacketError(code);
  return value;
}

function assertNoRawSecretMaterial(value, code) {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) throw new HandoffPacketError(code);
  }
  return value;
}

function assertFreeText(value, max, code) {
  assertBoundedText(value, max, code);
  assertNoRawSecretMaterial(value, code);
  return value;
}

// RF-2: bounded recursive deep freeze. The validated packet tree is fully
// immutable: nested suite objects, arrays, and responsibility records can
// no longer be flipped in place after validation.
export function deepFreezePacket(value) {
  if (value && typeof value === "object") {
    if (!Object.isFrozen(value)) {
      for (const child of Object.values(value)) deepFreezePacket(child);
      Object.freeze(value);
    }
  }
  return value;
}

function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new HandoffPacketError("HANDOFF_BASELINE_REQUIRED");
  }
  for (const key of Object.keys(baseline)) {
    if (!["merged_refs", "open_prs", "no_production_change"].includes(key)) {
      throw new HandoffPacketError("HANDOFF_UNKNOWN_FIELD:baseline." + key);
    }
  }
  if (!Array.isArray(baseline.merged_refs) || baseline.merged_refs.length === 0) {
    throw new HandoffPacketError("HANDOFF_BASELINE_REFS_REQUIRED");
  }
  for (const ref of baseline.merged_refs) {
    if (typeof ref !== "string" || !HEAD_RE.test(ref)) throw new HandoffPacketError("HANDOFF_BASELINE_REF_INVALID");
  }
  assertNonNegativeInt(baseline.open_prs, "HANDOFF_BASELINE_OPEN_PRS_INVALID");
  if (baseline.no_production_change !== true) throw new HandoffPacketError("HANDOFF_PRODUCTION_CHANGE_UNDECLARED");
}

function validateSynthetic(synthetic) {
  if (!synthetic || typeof synthetic !== "object" || Array.isArray(synthetic)) {
    throw new HandoffPacketError("HANDOFF_SYNTHETIC_REQUIRED");
  }
  for (const key of Object.keys(synthetic)) {
    if (key !== "suites") throw new HandoffPacketError("HANDOFF_UNKNOWN_FIELD:synthetic." + key);
  }
  if (!Array.isArray(synthetic.suites) || synthetic.suites.length === 0) {
    throw new HandoffPacketError("HANDOFF_SYNTHETIC_SUITES_REQUIRED");
  }
  let totalPass = 0;
  for (const suite of synthetic.suites) {
    if (!suite || typeof suite !== "object" || Array.isArray(suite)) throw new HandoffPacketError("HANDOFF_SYNTHETIC_SUITE_INVALID");
    for (const key of Object.keys(suite)) {
      if (!["name", "pass", "fail", "skip"].includes(key)) {
        throw new HandoffPacketError("HANDOFF_UNKNOWN_FIELD:synthetic.suites." + key);
      }
    }
    assertFreeText(suite.name, HANDOFF_MAX_SUITE_NAME, "HANDOFF_SYNTHETIC_SUITE_INVALID");
    assertNonNegativeInt(suite.pass, "HANDOFF_SYNTHETIC_SUITE_INVALID");
    assertNonNegativeInt(suite.skip ?? 0, "HANDOFF_SYNTHETIC_SUITE_INVALID");
    if (suite.fail !== 0) throw new HandoffPacketError("HANDOFF_SYNTHETIC_NOT_GREEN");
    totalPass += suite.pass;
  }
  if (totalPass === 0) throw new HandoffPacketError("HANDOFF_SYNTHETIC_EMPTY_PASS");
}

function validateResponsibility(responsibility) {
  if (!responsibility || typeof responsibility !== "object" || Array.isArray(responsibility)) {
    throw new HandoffPacketError("HANDOFF_RESPONSIBILITY_REQUIRED");
  }
  for (const key of Object.keys(responsibility)) {
    if (!RESPONSIBILITY_FIELDS.has(key)) throw new HandoffPacketError("HANDOFF_UNKNOWN_FIELD:responsibility." + key);
  }
  for (const key of RESPONSIBILITY_FIELDS) {
    assertFreeText(responsibility[key], HANDOFF_MAX_TEXT, "HANDOFF_RESPONSIBILITY_REQUIRED");
  }
}

export function validateHandoffPacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new HandoffPacketError("HANDOFF_PACKET_REQUIRED");
  }
  // Secret-shaped KEYS fail closed first, regardless of placement. The
  // top-level marker is proven `false` before the scan and stripped from
  // it: like tickets, the marker name itself is allow-listed, its value
  // can never carry material.
  const { secret_value_included, ...scannable } = packet;
  if (secret_value_included !== false) throw new HandoffPacketError("HANDOFF_SECRET_FLAG_INVALID");
  assertPublicSafe(scannable);
  for (const key of Object.keys(packet)) {
    if (!TOP_LEVEL_FIELDS.has(key)) throw new HandoffPacketError("HANDOFF_UNKNOWN_FIELD:" + key);
  }
  if (packet.schema !== HANDOFF_PACKET_SCHEMA) throw new HandoffPacketError("HANDOFF_SCHEMA_MISMATCH");
  if (packet.claim_class !== HANDOFF_CLAIM_CLASS) throw new HandoffPacketError("HANDOFF_CLAIM_CLASS_INVALID");
  if (typeof packet.work !== "string" || !WORK_RE.test(packet.work)) throw new HandoffPacketError("HANDOFF_WORK_INVALID");
  if (typeof packet.live_head !== "string" || !HEAD_RE.test(packet.live_head)) {
    throw new HandoffPacketError("HANDOFF_HEAD_INVALID");
  }
  validateBaseline(packet.baseline);
  validateSynthetic(packet.synthetic);
  validateResponsibility(packet.responsibility);
  if (!Array.isArray(packet.real_first_use_todos) || packet.real_first_use_todos.length === 0) {
    throw new HandoffPacketError("HANDOFF_TODOS_REQUIRED");
  }
  for (const todo of packet.real_first_use_todos) {
    assertFreeText(todo, HANDOFF_MAX_TEXT, "HANDOFF_TODOS_REQUIRED");
  }
  if (typeof packet.produced_at !== "string" || Number.isNaN(Date.parse(packet.produced_at))) {
    throw new HandoffPacketError("HANDOFF_PRODUCED_AT_INVALID");
  }
  return true;
}

export function createHandoffPacket(input) {
  if (!input || typeof input !== "object") throw new HandoffPacketError("HANDOFF_PACKET_REQUIRED");
  // Fail closed at the construction boundary too: unknown input never
  // silently drops; schema/claim-class/marker are system-set, never
  // caller-supplied.
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.has(key)) throw new HandoffPacketError("HANDOFF_UNKNOWN_FIELD:" + key);
  }
  const packet = {
    schema: HANDOFF_PACKET_SCHEMA,
    claim_class: HANDOFF_CLAIM_CLASS,
    work: input.work,
    live_head: input.live_head,
    baseline: structuredClone(input.baseline),
    synthetic: structuredClone(input.synthetic),
    responsibility: structuredClone(input.responsibility),
    real_first_use_todos: structuredClone(input.real_first_use_todos),
    produced_at: input.produced_at ?? new Date().toISOString(),
    secret_value_included: false,
  };
  validateHandoffPacket(packet);
  return deepFreezePacket(packet);
}

// Minimal readback for review routing: counts only, no claim text, no todos.
// Carries the claim class so no reader mistakes it for verified evidence.
export function publicHandoffSummary(packet) {
  validateHandoffPacket(packet);
  let totalPass = 0;
  let totalSkip = 0;
  for (const suite of packet.synthetic.suites) {
    totalPass += suite.pass;
    totalSkip += suite.skip ?? 0;
  }
  return Object.freeze({
    schema: packet.schema,
    claim_class: packet.claim_class,
    work: packet.work,
    live_head: packet.live_head,
    suites: packet.synthetic.suites.length,
    total_pass: totalPass,
    total_skip: totalSkip,
    todos_count: packet.real_first_use_todos.length,
    produced_at: packet.produced_at,
    secret_value_included: false,
  });
}
