#!/usr/bin/env node
// Checks the acceptance specification's structure, NOT GhostFleet runtime behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(await readFile(resolve(root, 'test/fixtures/versioned-enrollment-v1.acceptance.json'), 'utf8'));
const doc = await readFile(resolve(root, 'docs/architecture/VERSIONED_ENROLLMENT_RECONCILE_V1.md'), 'utf8');
assert.equal(cases.schema, 'ghostfleet-versioned-enrollment-acceptance/v1');
assert.equal(cases.evidence_class, 'SPECIFICATION_ONLY_NOT_EXECUTED');
assert.equal(cases.runtime_implementation_claimed, false);
assert.equal(cases.node_effects_executed, 0);
assert.equal(cases.cases.length, 24);

const tierOrder = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'];
const validTiers = new Set(tierOrder);
// These 24 cases require behavior/state evidence; T0 validates the specification alone.
const minTier = new Map([['VE-06', 'T3'], ['VE-19', 'T3'], ['VE-24', 'T2']]);
const ids = new Set();
const groups = new Set();
const tiersSeen = new Set();

for (const c of cases.cases) {
  assert.match(c.id, /^VE-\d{2}$/);
  assert(!ids.has(c.id), `duplicate case: ${c.id}`);
  ids.add(c.id);
  groups.add(c.group);

  assert(validTiers.has(c.evidence_tier), `${c.id}: invalid evidence_tier '${c.evidence_tier}'`);
  tiersSeen.add(c.evidence_tier);
  assert.notEqual(c.evidence_tier, 'T0', `${c.id}: T0 spec checks cannot prove a VE scenario`);
  if (minTier.has(c.id)) assert(
    tierOrder.indexOf(c.evidence_tier) >= tierOrder.indexOf(minTier.get(c.id)),
    `${c.id}: tier below executable minimum ${minTier.get(c.id)}`
  );
  if (c.id === 'VE-24') {
    assert.notEqual(c.implementation_phase, 'EXISTING', 'VE-24: task-state integration not implemented');
    assert(!c.target_seam.includes('check-versioned-enrollment-spec'), 'VE-24: Markdown checker cannot prove task state');
  }
  if (c.id === 'VE-14') assert(c.target_seam.includes('youling/ai-hub#297'), 'VE-14: private provider effect owner required');
  if (c.id === 'VE-15') assert(!c.target_seam.startsWith('packages/bootstrap/src/session.js'), 'VE-15: in-memory session is not a durable lock');
  if (c.id === 'VE-21') assert(!c.target_seam.startsWith('packages/typed-control/src/authorization.ts'), 'VE-21: nonexistent module');

  assert(typeof c.test_layer === 'string' && c.test_layer.trim().length > 0, `${c.id}: missing test_layer`);
  assert(typeof c.target_seam === 'string' && c.target_seam.trim().length > 0, `${c.id}: missing target_seam`);
  assert(typeof c.implementation_phase === 'string' && c.implementation_phase.trim().length > 0, `${c.id}: missing implementation_phase`);

  for (const k of ['given', 'when', 'expected', 'evidence_required']) {
    assert(Array.isArray(c[k]) && c[k].length > 0, `${c.id}: missing ${k}`);
    assert(c[k].every(v => typeof v === 'string' && v.trim().length > 0), `${c.id}: empty ${k}`);
  }
  assert.equal(c.result, 'NOT_RUN', `${c.id}: specification must not claim execution`);
}

for (let i = 1; i <= 24; i++) assert(ids.has(`VE-${String(i).padStart(2, '0')}`));
for (const g of ['version', 'identity', 'convergence', 'recovery', 'authority', 'acceptance']) assert(groups.has(g), `missing group: ${g}`);
for (const t of ['T1', 'T2', 'T3', 'T4', 'T5']) assert(tiersSeen.has(t), `missing required scenario tier: ${t}`);

for (const topic of ['goal', 'versions', 'compatibility', 'convergence', 'recovery', 'acceptance', 'delivery', 'prior-art']) {
  assert.equal(doc.split(`<!-- topic:${topic} -->`).length - 1, 2, `bilingual topic: ${topic}`);
}
assert.equal((doc.match(/^```/gm) || []).length % 2, 0, 'unbalanced Markdown fences');
assert(doc.includes('PROPOSED / CONTRACT_AND_ACCEPTANCE_ONLY'));
assert(!/\b(?:tskey-(?:auth|client|api)-[A-Za-z0-9]+|sk-proj-[A-Za-z0-9]+)|BEGIN [A-Z ]*PRIVATE KEY/.test(doc + JSON.stringify(cases)), 'secret-shaped value');

console.log(JSON.stringify({
  result: 'SPEC_STRUCTURE_OK',
  cases: cases.cases.length,
  bilingual_topics: 8,
  tiers: [...tiersSeen].sort(),
  runtime_cases_executed: 0,
  real_node_effects: 0
}));
