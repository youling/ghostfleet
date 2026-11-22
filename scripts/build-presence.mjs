// Deterministic static bundle; no package runtime or framework needed for the UI.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
const releaseAssets = path.join(out, 'release-assets');
const MAX_MANAGED_BOOTSTRAP_BYTES = 262144;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

function canonicalPath(file) {
  try {
    return realpathSync(file);
  } catch (error) {
    const parent = path.dirname(file);
    if (error.code !== 'ENOENT' || parent === file) throw error;
    return path.join(canonicalPath(parent), path.basename(file));
  }
}

function releaseConfig(args) {
  if (args.length === 0) return null;
  const hasManaged = args.length === 8 && args[4] === '--managed-bootstrap' && args[6] === '--managed-bootstrap-sha256';
  if ((args.length !== 4 && !hasManaged) || args[0] !== '--deployment-config' || args[2] !== '--output-config') {
    throw new Error('EXPECTED_DEPLOYMENT_AND_OUTPUT_CONFIG');
  }
  const source = path.resolve(args[1]);
  const target = path.resolve(args[3]);
  const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  let sourceDir, targetDir, locations, publicAssets, generatedPaths, generatedStats;
  try {
    sourceDir = canonicalPath(path.dirname(source));
    targetDir = canonicalPath(path.dirname(target));
    const configPaths = [
      path.join(sourceDir, path.basename(source)), path.join(targetDir, path.basename(target)),
      canonicalPath(source), canonicalPath(target),
    ];
    locations = configPaths.map(pathKey);
    const distDir = canonicalPath(out);
    publicAssets = [path.join(out, 'console'), releaseAssets].flatMap(file => [
      path.join(distDir, path.basename(file)), canonicalPath(file),
    ]).map(pathKey);
    generatedPaths = ['wrangler.json', 'installer.json'].map(name => path.join(distDir, name));
    generatedStats = generatedPaths.map(file => lstatSync(file, { throwIfNoEntry: false }));
  } catch {
    throw new Error('RELEASE_CONFIG_PATHS_UNVERIFIED');
  }
  if (pathKey(sourceDir) !== pathKey(targetDir)) {
    throw new Error('OUTPUT_MUST_SHARE_CONFIG_DIRECTORY');
  }
  if (locations[0] === locations[1] || locations[2] === locations[3] ||
      generatedPaths.map(pathKey).some(file => locations.includes(file))) {
    throw new Error('OUTPUT_CONFIG_MUST_BE_SEPARATE');
  }
  if (generatedStats.some(stat => stat && (!stat.isFile() || stat.nlink !== 1))) {
    throw new Error('GENERATED_CONFIG_PATH_UNSAFE');
  }
  if (locations.some(file => publicAssets.some(directory => file === directory || file.startsWith(directory + path.sep)))) {
    throw new Error('PRIVATE_CONFIG_INSIDE_ASSETS');
  }
  let deployment;
  try {
    deployment = JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('DEPLOYMENT_CONFIG_UNREADABLE');
  }
  const bindings = deployment?.durable_objects?.bindings;
  const state = Array.isArray(bindings) ? bindings.filter(bind => bind?.name === 'GHOSTFLEET_STATE') : [];
  if (typeof deployment?.name !== 'string' || !deployment.name.trim() || deployment.env !== undefined ||
      (deployment.compatibility_flags !== undefined && !Array.isArray(deployment.compatibility_flags)) ||
      state.length !== 1 || state[0].class_name !== 'GhostFleetState' ||
      (state[0].script_name !== undefined && state[0].script_name !== deployment.name)) {
    throw new Error('GHOSTFLEET_DEPLOYMENT_CONFIG_REQUIRED');
  }
  const vars = deployment.vars;
  if (!isHttpsOrigin(vars?.GHOSTFLEET_PANEL_ORIGIN) || !isHttpsOrigin(vars?.GHOSTFLEET_NODE_ORIGIN) ||
      vars.GHOSTFLEET_PANEL_ORIGIN === vars.GHOSTFLEET_NODE_ORIGIN) throw new Error('DEPLOYMENT_ORIGINS_INVALID');
  if (Object.hasOwn(vars, 'GHOSTFLEET_OPERATOR_TOKEN') || Object.hasOwn(vars, 'GHOSTFLEET_READ_TOKEN')) {
    throw new Error('DEPLOYMENT_TOKENS_MUST_USE_SECRETS');
  }
  if (!hasManaged && Object.hasOwn(vars, 'GHOSTFLEET_MANAGED_BOOTSTRAP_SHA256')) {
    throw new Error('MANAGED_BOOTSTRAP_INPUT_REQUIRED');
  }
  const managed = hasManaged ? readManagedBootstrap(args[5], args[7]) : null;
  return { deployment, target, managed };
}

function readManagedBootstrap(file, expected) {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('MANAGED_BOOTSTRAP_DIGEST_INVALID');
  let body;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size < 10 || info.size > MAX_MANAGED_BOOTSTRAP_BYTES) throw new Error();
    body = readFileSync(file);
  } catch {
    throw new Error('MANAGED_BOOTSTRAP_SOURCE_INVALID');
  }
  if (body.length > MAX_MANAGED_BOOTSTRAP_BYTES || !body.subarray(0, 10).equals(Buffer.from('#!/bin/sh\n')) ||
      body.includes(0) || body.includes(13)) throw new Error('MANAGED_BOOTSTRAP_SOURCE_INVALID');
  if (sha(body) !== expected) throw new Error('MANAGED_BOOTSTRAP_DIGEST_MISMATCH');
  return { body, sha256: expected };
}

function prepareReleaseAssets(files) {
  const identity = sha(JSON.stringify([...files].map(([name, bytes]) => [name, sha(bytes)])));
  const directory = path.join(releaseAssets, identity);
  mkdirSync(out, { recursive: true });
  if (!lstatSync(out).isDirectory()) throw new Error('RELEASE_ASSET_TREE_INVALID');
  mkdirSync(releaseAssets, { recursive: true });
  if (!lstatSync(releaseAssets).isDirectory()) throw new Error('RELEASE_ASSET_TREE_INVALID');
  mkdirSync(directory, { recursive: true });
  const folders = new Set([...files.keys()].map(file => path.posix.dirname(file)));
  function check(folder, relative = '') {
    if (!lstatSync(folder).isDirectory()) throw new Error('RELEASE_ASSET_TREE_INVALID');
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      const local = path.join(folder, entry.name);
      if (entry.isDirectory() && folders.has(name)) {
        check(local, name);
      } else if (!entry.isFile() || !files.has(name) || !readFileSync(local).equals(files.get(name))) {
        throw new Error('RELEASE_ASSET_TREE_INVALID');
      }
    }
  }
  check(directory);
  for (const [name, bytes] of files) {
    const filename = path.join(directory, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    try {
      writeFileSync(filename, bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST' || !lstatSync(filename).isFile() || !readFileSync(filename).equals(bytes)) {
        throw new Error('RELEASE_ASSET_TREE_INVALID');
      }
    }
  }
  return directory;
}

function writeReleaseConfig(release, built, assets) {
  const relative = file => path.relative(path.dirname(release.target), file).split(path.sep).join('/');
  const { deployment, target } = release;
  const merged = {
    ...deployment,
    main: relative(path.resolve(out, built.main)),
    compatibility_date: deployment.compatibility_date ?? built.compatibility_date,
    compatibility_flags: [...new Set([...(deployment.compatibility_flags ?? []), ...built.compatibility_flags])],
    assets: {
      ...deployment.assets,
      ...built.assets,
      directory: relative(assets),
    },
    vars: {
      ...deployment.vars,
      GHOSTFLEET_INSTALLER_SHA256: built.vars.GHOSTFLEET_INSTALLER_SHA256,
      GHOSTFLEET_BOOTSTRAP_SHA256: built.vars.GHOSTFLEET_BOOTSTRAP_SHA256,
      ...(release.managed ? { GHOSTFLEET_MANAGED_BOOTSTRAP_SHA256: release.managed.sha256 } : {}),
    },
  };
  const content = JSON.stringify(merged, null, 2) + '\n';
  try {
    writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('OUTPUT_CONFIG_WRITE_FAILED');
    try {
      if (readFileSync(target, 'utf8') === content) return;
    } catch { /* Never replace an existing config. */ }
    throw new Error('OUTPUT_CONFIG_EXISTS');
  }
}

let release;
try {
  release = releaseConfig(process.argv.slice(2));
} catch (error) {
  console.error('PRESENCE_RELEASE_CONFIG_ERROR ' + error.message);
  process.exit(1);
}

const ui = ['index.html', 'app.js', 'presence.css', 'shared/console.css', 'shared/appearance.js', 'shared/first-use.js'];
const files = new Map(ui.map(file => [file, readFileSync(path.join(root, 'console', file))]));
// Both assets run on Linux. Use their canonical LF bytes on every host.
const linuxSource = file => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const script = Buffer.from(linuxSource('scripts/heartbeat.py'), 'utf8');
const sha256 = sha(script);
files.set('bootstrap/' + sha256 + '.py', script);

const joinTemplate = linuxSource('scripts/join.sh');
if (joinTemplate.split('@INSTALLER_SHA256@').length !== 2 ||
    joinTemplate.split('@INSTALLER_BYTES@').length !== 2) {
  throw new Error('JOIN_BOOTSTRAP_TEMPLATE_INVALID');
}
const joinText = joinTemplate
  .replace('@INSTALLER_SHA256@', sha256)
  .replace('@INSTALLER_BYTES@', String(script.length));
const join = Buffer.from(joinText, 'utf8');
const bootstrapSha256 = sha(join);
files.set('bootstrap/' + bootstrapSha256 + '.sh', join);
const managed = release?.managed;
if (managed) {
  if (managed.sha256 === sha256 || managed.sha256 === bootstrapSha256) {
    console.error('PRESENCE_RELEASE_CONFIG_ERROR MANAGED_BOOTSTRAP_REUSES_REPORTER');
    process.exit(1);
  }
  files.set('bootstrap/' + managed.sha256 + '.managed.sh', managed.body);
}

const defaultAssets = path.join(out, 'console');
let assets = defaultAssets;
if (release) {
  try {
    assets = prepareReleaseAssets(files);
  } catch (error) {
    const code = error.message === 'RELEASE_ASSET_TREE_INVALID' ? error.message : 'RELEASE_ASSETS_WRITE_FAILED';
    console.error('PRESENCE_RELEASE_CONFIG_ERROR ' + code);
    process.exit(1);
  }
} else {
  for (const [name, bytes] of files) {
    const filename = path.join(defaultAssets, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, bytes);
  }
}

const config = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
config.main = '../src/adapters/cloudflare/index.js';
config.assets.directory = './' + path.relative(out, assets).split(path.sep).join('/');
config.vars.GHOSTFLEET_INSTALLER_SHA256 = sha256;
config.vars.GHOSTFLEET_BOOTSTRAP_SHA256 = bootstrapSha256;
if (managed) config.vars.GHOSTFLEET_MANAGED_BOOTSTRAP_SHA256 = managed.sha256;
writeFileSync(path.join(out, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
writeFileSync(path.join(out, 'installer.json'), JSON.stringify({
  sha256, bytes: script.length, bootstrap_sha256: bootstrapSha256, bootstrap_bytes: join.length,
  ...(managed ? { managed_bootstrap_sha256: managed.sha256, managed_bootstrap_bytes: managed.body.length } : {}),
}, null, 2) + '\n');
if (release) {
  try {
    writeReleaseConfig(release, config, assets);
  } catch (error) {
    console.error('PRESENCE_RELEASE_CONFIG_ERROR ' + error.message);
    process.exit(1);
  }
}
console.log('PRESENCE_BUILD_OK installer_sha256=' + sha256 + ' bytes=' + script.length +
  ' bootstrap_sha256=' + bootstrapSha256 + ' bootstrap_bytes=' + join.length);
