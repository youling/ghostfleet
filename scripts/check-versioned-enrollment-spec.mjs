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
const ids = new Set();
const groups = new Set();
for (const c of cases.cases) {
  assert.match(c.id, /^VE-\d{2}$/);
  assert(!ids.has(c.id), `duplicate case: ${c.id}`);
  ids.add(c.id); groups.add(c.group);
  for (const k of ['given', 'when', 'expected', 'evidence_required']) {
    assert(Array.isArray(c[k]) && c[k].length > 0, `${c.id}: missing ${k}`);
    assert(c[k].every(v => typeof v === 'string' && v.trim().length > 0), `${c.id}: empty ${k}`);
  }
  assert.equal(c.result, 'NOT_RUN', `${c.id}: specification must not claim execution`);
}
for (let i = 1; i <= 24; i++) assert(ids.has(`VE-${String(i).padStart(2, '0')}`));
for (const g of ['version', 'identity', 'convergence', 'recovery', 'authority', 'acceptance']) assert(groups.has(g), `missing group: ${g}`);
for (const topic of ['goal','versions','compatibility','convergence','recovery','acceptance','delivery','prior-art']) {
  assert.equal(doc.split(`<!-- topic:${topic} -->`).length - 1, 2, `bilingual topic: ${topic}`);
}
assert.equal((doc.match(/^```/gm) || []).length % 2, 0, 'unbalanced Markdown fences');
assert(doc.includes('PROPOSED / CONTRACT_AND_ACCEPTANCE_ONLY'));
assert(!/\b(?:tskey-(?:auth|client|api)-[A-Za-z0-9]+|sk-proj-[A-Za-z0-9]+)|BEGIN [A-Z ]*PRIVATE KEY/.test(doc + JSON.stringify(cases)), 'secret-shaped value');
console.log(JSON.stringify({result:'SPEC_STRUCTURE_OK', cases:cases.cases.length, bilingual_topics:8, runtime_cases_executed:0, real_node_effects:0}));
