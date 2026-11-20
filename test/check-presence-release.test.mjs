import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-presence-release.mjs', import.meta.url));
const shaA = 'a'.repeat(64), shaB = 'b'.repeat(64), shaC = 'c'.repeat(64);
const build = () => ({ sha256: shaA, bytes: 20000, bootstrap_sha256: shaB, bootstrap_bytes: 7000 });
const access = () => ({ ok: true, access: 'read_only', installer: {
  sha256: shaA, url: 'https://node.example.invalid/bootstrap/' + shaA + '.py',
  bootstrap: { sha256: shaB, url: 'https://node.example.invalid/bootstrap/' + shaB + '.sh' },
}, private_credential: 'do-not-echo' });

function run(buildDoc, accessDoc, args = null) {
  const root = mkdtempSync(path.join(tmpdir(), 'gf-release-pin-'));
  try {
    const buildPath = path.join(root, 'build.json');
    const accessPath = path.join(root, 'access.json');
    writeFileSync(buildPath, JSON.stringify(buildDoc));
    writeFileSync(accessPath, JSON.stringify(accessDoc));
    const result = spawnSync(process.execPath, [script, ...(args ?? [
      '--build-json', buildPath, '--access-json', accessPath,
    ])], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    return { exit: result.status, body: JSON.parse(result.stdout), stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('identical pins prove distribution match but never host-unit currentness', () => {
  const result = run(build(), access());
  assert.equal(result.exit, 0);
  assert.equal(result.body.status, 'MATCHED_BUILD_PINS');
  assert.equal(result.body.node_unit_currentness, 'NOT_PROVEN');
  assert.equal(result.body.node_privilege_authority, 'NONE');
  assert.equal(result.body.deployment_effect, 'NONE');
});

test('stale installer pin is not called an authenticated host failure', () => {
  const remote = access(); remote.installer.sha256 = shaC;
  remote.installer.url = 'https://node.example.invalid/bootstrap/' + shaC + '.py';
  const r = run(build(), remote);
  assert.equal(r.exit, 3);
  assert.equal(r.body.status, 'PIN_MISMATCH');
  assert.equal(r.body.installer_pin_match, false);
  assert.equal(r.body.bootstrap_pin_match, true);
});

test('stale bootstrap pin is distinct from installer pin', () => {
  const remote = access(); remote.installer.bootstrap.sha256 = shaC;
  remote.installer.bootstrap.url = 'https://node.example.invalid/bootstrap/' + shaC + '.sh';
  const r = run(build(), remote);
  assert.equal(r.exit, 3);
  assert.equal(r.body.installer_pin_match, true);
  assert.equal(r.body.bootstrap_pin_match, false);
});

test('unconfigured remote build pins are review-required not successful', () => {
  const r = run(build(), { ok: true, installer: null });
  assert.equal(r.exit, 3);
  assert.equal(r.body.status, 'REMOTE_PIN_NOT_CONFIGURED');
});

test('invalid manifest is fail closed', () => {
  for (const bad of [null, {}, { ...build(), sha256: 'a' }, { ...build(), bytes: -1 },
                     { ...build(), bootstrap_sha256: 'Z'.repeat(64) }]) {
    const r = run(bad, access());
    assert.equal(r.exit, 4);
    assert.equal(r.body.error, 'BUILD_MANIFEST_INVALID');
  }
});

test('mismatched route digest, redirects and non-HTTPS metadata are fail closed', () => {
  for (const url of [
    'http://node.example.invalid/bootstrap/' + shaA + '.py',
    'https://node.example.invalid/bootstrap/' + shaB + '.py',
    'https://node.example.invalid/bootstrap/' + shaA + '.py?token=secret',
    'https://' + 'user' + ':' + 'secret' + '@node.example.invalid/bootstrap/' + shaA + '.py',
    'https://node.example.invalid/elsewhere/' + shaA + '.py',
  ]) {
    const remote = access(); remote.installer.url = url;
    const r = run(build(), remote);
    assert.equal(r.exit, 4);
    assert.equal(r.body.error, 'ACCESS_INSTALLER_METADATA_INVALID');
  }
});

test('missing or unauthorized readback fails closed without printing values', () => {
  const remote = access(); remote.ok = false;
  const r = run(build(), remote);
  assert.equal(r.exit, 4);
  assert.equal(r.body.error, 'ACCESS_READBACK_INVALID');
  assert.ok(!JSON.stringify(r.body).includes('do-not-echo'));
  assert.equal(r.stderr, '');
});

test('private fields are never printed', () => {
  const r = run({ ...build(), token: 'do-not-echo' }, access());
  assert.equal(r.exit, 0);
  assert.ok(!JSON.stringify(r.body).includes('do-not-echo'));
  assert.ok(!JSON.stringify(r.body).includes('node.example.invalid'));
});

test('usage errors are bounded and do not expose input paths', () => {
  const r = run(build(), access(), ['--bad', '/private/secret.json']);
  assert.equal(r.exit, 4);
  assert.equal(r.body.error, 'USAGE_EXPECTED_BUILD_JSON_AND_ACCESS_JSON');
  assert.ok(!r.body.error.includes('/private/'));
});
