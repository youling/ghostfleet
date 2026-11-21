import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ghostfleet-build-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['console', 'scripts/heartbeat.py', 'scripts/join.sh', 'scripts/build-presence.mjs', 'wrangler.jsonc']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(source, file), path.join(root, file), { recursive: true });
  }
  const configDir = path.join(root, 'deployment');
  mkdirSync(configDir);
  const input = path.join(configDir, 'private.json');
  const output = path.join(configDir, 'release.json');
  const config = {
    name: 'fixture-ghostfleet',
    workers_dev: false,
    preview_urls: false,
    compatibility_flags: ['nodejs_compat'],
    routes: [{ pattern: 'node.example.invalid', custom_domain: true }],
    durable_objects: { bindings: [{ name: 'GHOSTFLEET_STATE', class_name: 'GhostFleetState' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['GhostFleetState'] }],
    vars: {
      GHOSTFLEET_PANEL_ORIGIN: 'https://panel.example.invalid',
      GHOSTFLEET_NODE_ORIGIN: 'https://node.example.invalid',
      GHOSTFLEET_INSTALLER_SHA256: 'a'.repeat(64),
    },
  };
  const build = () => spawnSync(process.execPath, [
    path.join(root, 'scripts/build-presence.mjs'), '--deployment-config', input, '--output-config', output,
  ], { encoding: 'utf8' });
  return { root, input, output, config, build };
}

test('release embeds both Linux asset pins while keeping the existing Worker and storage identity', t => {
  const f = fixture(t);
  const original = JSON.stringify(f.config);
  writeFileSync(f.input, original);
  for (const file of ['heartbeat.py', 'join.sh']) {
    const filename = path.join(f.root, 'scripts', file);
    writeFileSync(filename, readFileSync(filename, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  const built = f.build();
  assert.equal(built.status, 0, built.stderr);
  const packaged = JSON.parse(readFileSync(f.output, 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(f.root, 'dist/installer.json'), 'utf8'));
  assert.equal(packaged.name, f.config.name);
  assert.deepEqual(packaged.routes, f.config.routes);
  assert.deepEqual(packaged.durable_objects, f.config.durable_objects);
  assert.deepEqual(packaged.migrations, f.config.migrations);
  assert.equal(packaged.vars.GHOSTFLEET_NODE_ORIGIN, f.config.vars.GHOSTFLEET_NODE_ORIGIN);
  assert.equal(packaged.vars.GHOSTFLEET_INSTALLER_SHA256, manifest.sha256);
  assert.equal(packaged.vars.GHOSTFLEET_BOOTSTRAP_SHA256, manifest.bootstrap_sha256);
  assert.equal(packaged.assets.binding, 'ASSETS');
  assert.equal(packaged.assets.run_worker_first, true);
  assert.equal(path.resolve(path.dirname(f.output), packaged.main), path.join(f.root, 'src/adapters/cloudflare/worker.js'));
  const assets = path.resolve(path.dirname(f.output), packaged.assets.directory);
  for (const [pin, bytes, ext] of [
    [manifest.sha256, manifest.bytes, 'py'], [manifest.bootstrap_sha256, manifest.bootstrap_bytes, 'sh'],
  ]) {
    const body = readFileSync(path.join(assets, 'bootstrap', pin + '.' + ext));
    assert.equal(body.length, bytes);
    assert.equal(hash(body), pin);
    assert.ok(!body.toString('utf8').includes('\r\n'));
  }
  assert.equal(readFileSync(f.input, 'utf8'), original);
  assert.equal(f.build().status, 0);
  writeFileSync(f.output, 'existing private file');
  const conflict = f.build();
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /OUTPUT_CONFIG_EXISTS/);
  assert.equal(readFileSync(f.output, 'utf8'), 'existing private file');
});

test('a courier or an overlay carrying access credentials is rejected without printing its contents', t => {
  const f = fixture(t);
  const sample = 'synthetic-in-memory-value';
  writeFileSync(f.input, JSON.stringify({
    ...f.config, durable_objects: { bindings: [{ name: 'ENROLLMENTS', class_name: 'EnrollmentTicket' }] },
  }));
  assert.match(f.build().stderr, /GHOSTFLEET_DEPLOYMENT_CONFIG_REQUIRED/);
  writeFileSync(f.input, JSON.stringify({
    ...f.config, vars: { ...f.config.vars, GHOSTFLEET_OPERATOR_TOKEN: sample },
  }));
  const secret = f.build();
  assert.equal(secret.status, 1);
  assert.match(secret.stderr, /DEPLOYMENT_TOKENS_MUST_USE_SECRETS/);
  assert.ok(!(secret.stdout + secret.stderr).includes(sample));
});
