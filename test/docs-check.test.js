import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocuments } from '../scripts/docs-check.mjs';
async function fixture(run) { const root = await mkdtemp(join(tmpdir(), 'ghostfleet-docs-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('docs require both language sections and each required topic', async () => fixture(async root => {
  await writeFile(join(root, 'README.md'), '## 中文\n<!-- topic:install -->\n## English\n');
  const result = await checkDocuments(root, { documents: [{ path: 'README.md', topics: ['install'] }] }, ['README.md']);
  assert.equal(result.findings[0].rule, 'missing-topic'); assert.equal(result.findings[0].language, 'en');
}));
test('docs resolve local anchors and reject broken or escaping links', async () => fixture(async root => {
  await writeFile(join(root, 'README.md'), '## 中文\n## English\n[ok](#english) [bad](missing.md) [escape](../outside.md)');
  const result = await checkDocuments(root, { documents: [{ path: 'README.md' }] }, ['README.md']);
  assert.deepEqual(result.findings.map(x => x.rule), ['missing-link-target', 'link-escape']);
}));
test('docs ignore code examples as link instructions and retain unicode anchors', async () => fixture(async root => {
  await writeFile(join(root, 'README.md'), '## 中文\n[ok](#中文)\n## English\n```md\n[example](missing.md)\n```\n');
  assert.equal((await checkDocuments(root, { documents: [{ path: 'README.md' }] }, ['README.md'])).ok, true);
}));
