import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-presence-release.mjs', import.meta.url));
const shaA = 'a'.repeat(64), shaB = 'b'.repeat(64), shaC = 'c'.repeat(64);
const nodeOrigin = 'https://node.example.invalid';
const build = () => ({ sha256: shaA, bytes: 20000, bootstrap_sha256: shaB, bootstrap_bytes: 7000 });
const access = ({ sha256 = shaA, bootstrap_sha256 = shaB } = {}) => ({ ok: true, access: 'read_only', installer: {
  sha256, url: nodeOrigin + '/bootstrap/' + sha256 + '.py',
  bootstrap: { sha256: bootstrap_sha256, url: nodeOrigin + '/bootstrap/' + bootstrap_sha256 + '.sh' },
}, private_credential: 'do-not-echo' });

const bodies = {
  installer: Buffer.from('# private installer · detail\r\n'),
  bootstrap: Buffer.from('#!/bin/sh\n# private bootstrap detail\n'),
};
const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const capturedBuild = () => ({
  sha256: sha256(bodies.installer), bytes: bodies.installer.length,
  bootstrap_sha256: sha256(bodies.bootstrap), bootstrap_bytes: bodies.bootstrap.length,
});

function run(buildDoc, accessDoc, { args, capture } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gf-release-pin-'));
  try {
    const buildPath = path.join(root, 'build.json');
    const accessPath = path.join(root, 'access.json');
    writeFileSync(buildPath, JSON.stringify(buildDoc));
    writeFileSync(accessPath, JSON.stringify(accessDoc));
    const input = ['--build-json', buildPath, '--access-json', accessPath];
    if (capture) {
      const installerPath = path.join(root, 'private-installer.py');
      const bootstrapPath = path.join(root, 'private-bootstrap.sh');
      if (capture.installer) writeFileSync(installerPath, capture.installer);
      if (capture.bootstrap) writeFileSync(bootstrapPath, capture.bootstrap);
      input.push('--installer-body', installerPath, '--bootstrap-body', bootstrapPath);
    }
    const result = spawnSync(process.execPath, [script, ...(args ?? input)], { encoding: 'utf8', timeout: 5000 });
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
  assert.equal(result.body.installer_body_match, undefined);
  assert.equal(result.body.bootstrap_body_match, undefined);
  assert.equal(result.body.node_unit_currentness, 'NOT_PROVEN');
  assert.equal(result.body.node_privilege_authority, 'NONE');
  assert.equal(result.body.deployment_effect, 'NONE');
});

test('matching captured bytes have a separate success status and do not prove installed-node currentness', () => {
  const manifest = capturedBuild();
  const r = run(manifest, { ...access(manifest), node_origin: nodeOrigin }, { capture: bodies });
  assert.equal(r.exit, 0);
  assert.equal(r.body.status, 'MATCHED_BUILD_PINS_AND_CAPTURED_BODIES');
  assert.equal(r.body.installer_body_match, true);
  assert.equal(r.body.bootstrap_body_match, true);
  assert.equal(r.body.node_unit_currentness, 'NOT_PROVEN');
  assert.equal(r.body.node_privilege_authority, 'NONE');
  assert.equal(r.body.deployment_effect, 'NONE');
  assert.doesNotMatch(JSON.stringify(r.body), /private|node\.example\.invalid|[0-9a-f]{64}/);
  assert.equal(r.stderr, '');
});

test('matching pins cannot hide a same-length digest mismatch or an incorrect byte count', () => {
  const manifest = capturedBuild();
  const changedInstaller = Buffer.from(bodies.installer);
  changedInstaller[0] = 0;
  const r = run({ ...manifest, bootstrap_bytes: manifest.bootstrap_bytes + 1 }, access(manifest), {
    capture: { ...bodies, installer: changedInstaller },
  });
  assert.equal(r.exit, 3);
  assert.equal(r.body.status, 'CAPTURED_BODY_MISMATCH');
  assert.equal(r.body.installer_pin_match, true);
  assert.equal(r.body.bootstrap_pin_match, true);
  assert.equal(r.body.installer_body_match, false);
  assert.equal(r.body.bootstrap_body_match, false);
});

test('a missing capture yields a bounded input error without exposing its filename', () => {
  const manifest = capturedBuild();
  const r = run(manifest, access(manifest), { capture: { installer: bodies.installer } });
  assert.equal(r.exit, 4);
  assert.deepEqual(r.body, { ok: false, error: 'INPUT_UNREADABLE' });
  assert.equal(r.stderr, '');
});

test('matching local files do not override stale advertised pins', () => {
  const manifest = capturedBuild();
  const remote = access({ ...manifest, bootstrap_sha256: shaC });
  const r = run(manifest, remote, { capture: bodies });
  assert.equal(r.exit, 3);
  assert.equal(r.body.status, 'PIN_MISMATCH');
  assert.equal(r.body.installer_body_match, undefined);
  assert.equal(r.body.bootstrap_body_match, undefined);
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

test('each advertised digest URL must match the declared node origin', () => {
  for (const source of ['installer', 'bootstrap']) {
    const remote = { ...access(), node_origin: nodeOrigin };
    const metadata = source === 'installer' ? remote.installer : remote.installer.bootstrap;
    metadata.url = metadata.url.replace('node.example.invalid', 'other.example.invalid');
    const r = run(build(), remote);
    assert.equal(r.exit, 4);
    assert.deepEqual(r.body, { ok: false, error: 'ACCESS_INSTALLER_METADATA_INVALID' });
    delete remote.node_origin;
    assert.equal(run(build(), remote).body.status, 'MATCHED_BUILD_PINS');
  }
});

test('a declared node origin must be the canonical HTTPS origin of the advertised URLs', () => {
  for (const origin of [null, 'http://node.example.invalid', nodeOrigin + '/route']) {
    const r = run(build(), { ...access(), node_origin: origin });
    assert.equal(r.exit, 4);
    assert.deepEqual(r.body, { ok: false, error: 'ACCESS_INSTALLER_METADATA_INVALID' });
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
  for (const args of [
    ['--bad', '/private/secret.json'],
    ['--build-json', 'build.json', '--access-json', 'access.json', '--installer-body', '/private/capture.py'],
  ]) {
    const r = run(build(), access(), { args });
    assert.equal(r.exit, 4);
    assert.deepEqual(r.body, { ok: false, error: 'USAGE_EXPECTED_BUILD_JSON_AND_ACCESS_JSON' });
  }
});
