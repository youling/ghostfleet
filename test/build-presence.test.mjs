import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const build = (deployment = input, release = output) => spawnSync(process.execPath, [
    path.join(root, 'scripts/build-presence.mjs'), '--deployment-config', deployment, '--output-config', release,
  ], { encoding: 'utf8' });
  return { root, input, output, config, build };
}

test('release embeds both Linux asset pins while keeping the existing Worker and storage identity', t => {
  const f = fixture(t);
  const original = JSON.stringify(f.config);
  writeFileSync(f.input, original);
  const previousAssets = path.join(f.root, 'dist/console');
  mkdirSync(previousAssets, { recursive: true });
  writeFileSync(path.join(previousAssets, 'unrelated.json'), 'legacy file');
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
  assert.notEqual(assets, previousAssets);
  assert.ok(!existsSync(path.join(assets, 'unrelated.json')));
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

test('rejects extra files in an existing release asset tree without removing them', t => {
  const f = fixture(t);
  writeFileSync(f.input, JSON.stringify(f.config));
  assert.equal(f.build().status, 0);
  const config = JSON.parse(readFileSync(f.output, 'utf8'));
  const assetPath = path.resolve(path.dirname(f.output), config.assets.directory, 'unrelated.json');
  writeFileSync(assetPath, 'fixture that must not ship');
  const secondOutput = path.join(path.dirname(f.output), 'second-release.json');
  const result = f.build(f.input, secondOutput);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE_ASSET_TREE_INVALID/);
  assert.equal(readFileSync(assetPath, 'utf8'), 'fixture that must not ship');
  assert.ok(!existsSync(secondOutput));
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

test('refuses reserved build outputs as either config before writing anything', t => {
  const f = fixture(t);
  const dist = path.join(f.root, 'dist');
  mkdirSync(dist);
  const manifest = path.join(dist, 'installer.json');
  const draft = path.join(dist, 'private.json');
  const manifestAlias = path.join(dist, 'private-alias.json');
  const original = JSON.stringify(f.config);
  writeFileSync(manifest, original);
  writeFileSync(draft, original);
  linkSync(manifest, manifestAlias);
  const release = path.join(dist, 'release.json');
  for (const [input, output] of [[manifest, release], [draft, manifest], [manifestAlias, release], [draft, manifestAlias]]) {
    const result = f.build(input, output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OUTPUT_CONFIG_MUST_BE_SEPARATE/);
    assert.equal(readFileSync(manifest, 'utf8'), original);
    assert.ok(!existsSync(path.join(dist, 'console')));
  }
});

test('refuses private configs inside the published asset tree even through a directory alias', t => {
  const f = fixture(t);
  const assets = path.join(f.root, 'dist/console');
  const alias = path.join(f.root, 'local-alias');
  mkdirSync(assets, { recursive: true });
  symlinkSync(assets, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const original = JSON.stringify(f.config);
  writeFileSync(path.join(assets, 'private.json'), original);
  for (const dir of [assets, alias]) {
    const result = f.build(path.join(dir, 'private.json'), path.join(dir, 'release.json'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PRIVATE_CONFIG_INSIDE_ASSETS/);
  }
  assert.equal(readFileSync(path.join(assets, 'private.json'), 'utf8'), original);
  assert.ok(!existsSync(path.join(assets, 'release.json')));
  assert.ok(!existsSync(path.join(assets, 'bootstrap')));
});
