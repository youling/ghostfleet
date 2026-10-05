import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { scanFiles, classifyUrl } from '../scripts/publication-guard.mjs';

async function fixture(run) { const root = await mkdtemp(join(tmpdir(), 'ghostfleet-publication-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('publication blocks credential shapes and emits no matched value', async () => fixture(async root => {
  const value = 'gh' + 'p_' + 'A'.repeat(24);
  await writeFile(join(root, 'candidate.txt'), value);
  const result = await scanFiles(root, ['candidate.txt']);
  assert.equal(result.ok, false); assert.equal(result.findings[0].rule, 'credential-shape');
  assert.ok(!JSON.stringify(result).includes(value));
}));
test('an inert exception binds path, rule and exact value, and expires on change', async () => fixture(async root => {
  const value = 'gh' + 'p_' + 'F'.repeat(24);
  const policy = { fixture_exceptions: [{ path: 'fixture.txt', rule: 'credential-shape', sha256: createHash('sha256').update(value).digest('hex'), reason: 'Synthetic rejection fixture; not a credential.', kind: 'inert-fixture-or-detector' }] };
  await writeFile(join(root, 'fixture.txt'), value);
  assert.equal((await scanFiles(root, ['fixture.txt'], policy)).ok, true);
  await writeFile(join(root, 'fixture.txt'), value + 'X');
  assert.equal((await scanFiles(root, ['fixture.txt'], policy)).ok, false);
}));
test('publication rejects private artifacts, escaped paths and unknown binaries', async () => fixture(async root => {
  await writeFile(join(root, 'new.png'), Buffer.from([0, 1, 2]));
  const result = await scanFiles(root, ['../outside', '.dev.vars', 'new.png']);
  assert.deepEqual(result.findings.map(x => x.rule), ['path-escape', 'private-artifact', 'unreviewed-binary']);
}));
test('documentation addresses pass and incomplete scans fail', async () => fixture(async root => {
  await writeFile(join(root, 'example.txt'), '127.0.0.1 192.0.2.10 198.51.100.8 203.0.113.8');
  assert.equal((await scanFiles(root, ['example.txt'])).ok, true);
  assert.equal((await scanFiles(root, ['example.txt'], { max_file_bytes: 4 })).findings[0].rule, 'scan-budget');
}));
test('compressed private IPv6 and undeclared contacts are blocked, documentation IPv6 passes', async () => fixture(async root => {
  await writeFile(join(root, 'example.txt'), '::1 2001:db8::1 fc00::1 fe80::1');
  const result = await scanFiles(root, ['example.txt']);
  assert.equal(result.findings.filter(x => x.rule === 'instance-ipv6').length, 2);
  const address = ['operator', '@', 'unlisted.test'].join('');
  await writeFile(join(root, 'contact.txt'), address);
  assert.equal((await scanFiles(root, ['contact.txt'], { public_contacts: ['unlisted.test'] })).ok, false);
  assert.equal((await scanFiles(root, ['contact.txt'], { public_contacts: [{ path: 'contact.txt', address, reason: 'Explicit synthetic public contact review.' }] })).ok, true);
}));
test('optional packages cannot silently introduce default AI-provider dependencies', async () => fixture(async root => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'packages', 'sample'), { recursive: true });
  await writeFile(join(root, 'packages/sample/package.json'), JSON.stringify({ dependencies: { ['open' + 'ai']: '1' } }));
  assert.equal((await scanFiles(root, ['packages/sample/package.json'])).findings[0].rule, 'default-ai-provider-coupling');
}));
test('Python and PowerShell packaged runtime cannot hide client-specific default helpers', async () => fixture(async root => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'packages', 'sample'), { recursive: true });
  await writeFile(join(root, 'packages/sample/adapter.py'), 'host = "chat' + 'gpt.site"');
  await writeFile(join(root, 'packages/sample/runtime.ps1'), 'helper = "managed-windows-' + 'chatgpt-control.ps1"');
  const result = await scanFiles(root, ['packages/sample/adapter.py', 'packages/sample/runtime.ps1']);
  assert.equal(result.findings.filter(x => x.rule === 'ai-client-specific-runtime').length, 2);
}));
test('multi-line or base64 key bodies cannot use a detector-marker exemption', async () => fixture(async root => {
  const header = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
  const end = ['-----END RSA', 'PRIVATE KEY-----'].join(' ');
  const material = header + '\n' + 'A'.repeat(80) + '\n' + end;
  await writeFile(join(root, 'candidate.txt'), material);
  const policy = { fixture_exceptions: [{ path: 'candidate.txt', rule: 'secret-material', sha256: createHash('sha256').update(header).digest('hex'), reason: 'Synthetic detector-shaped negative fixture.', kind: 'inert-fixture-or-detector' }] };
  assert.ok((await scanFiles(root, ['candidate.txt'], policy)).findings.some(x => x.rule === 'private-key-body'));
  await writeFile(join(root, 'encoded.txt'), Buffer.from(material).toString('base64'));
  assert.ok((await scanFiles(root, ['encoded.txt'])).findings.some(x => x.rule === 'encoded-private-key'));
}));
test('URL classification rejects credentials and unknown deployments without broad provider exemptions', () => {
  assert.equal(classifyUrl('http://127.0.0.1:8791/mcp'), null);
  assert.equal(classifyUrl('https://controller.example.invalid/mcp'), null);
  assert.equal(classifyUrl('https://developers.cloudflare.com/workers/'), null);
  assert.equal(classifyUrl('https://user:inert@example.invalid/'), 'credential-url');
  assert.equal(classifyUrl('https://arbitrary.workers.dev/mcp'), 'unreviewed-endpoint');
  assert.equal(classifyUrl('https://arbitrary.' + 'chatgpt.site/mcp'), 'unreviewed-endpoint');
  assert.equal(classifyUrl('https://github.com/example/repo?token=inert'), 'credential-url');
});
