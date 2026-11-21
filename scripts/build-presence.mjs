// Deterministic static bundle; no package runtime or framework needed for the UI.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

function releaseConfig(args) {
  if (args.length === 0) return null;
  if (args.length !== 4 || args[0] !== '--deployment-config' || args[2] !== '--output-config') {
    throw new Error('EXPECTED_DEPLOYMENT_AND_OUTPUT_CONFIG');
  }
  const source = path.resolve(args[1]);
  const target = path.resolve(args[3]);
  const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (pathKey(path.dirname(source)) !== pathKey(path.dirname(target))) {
    throw new Error('OUTPUT_MUST_SHARE_CONFIG_DIRECTORY');
  }
  const stockConfig = pathKey(path.join(out, 'wrangler.json'));
  if (pathKey(source) === pathKey(target) || pathKey(target) === stockConfig) {
    throw new Error('OUTPUT_CONFIG_MUST_BE_SEPARATE');
  }
  let deployment, realSource;
  try {
    realSource = realpathSync(source);
    deployment = JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('DEPLOYMENT_CONFIG_UNREADABLE');
  }
  if (pathKey(realSource) === stockConfig) throw new Error('OUTPUT_CONFIG_MUST_BE_SEPARATE');
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
  return { deployment, target };
}

function writeReleaseConfig(release, built) {
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
      directory: relative(path.resolve(out, built.assets.directory)),
    },
    vars: {
      ...deployment.vars,
      GHOSTFLEET_INSTALLER_SHA256: built.vars.GHOSTFLEET_INSTALLER_SHA256,
      GHOSTFLEET_BOOTSTRAP_SHA256: built.vars.GHOSTFLEET_BOOTSTRAP_SHA256,
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

mkdirSync(path.join(out, 'console/bootstrap'), { recursive: true });
for (const file of ['index.html', 'app.js', 'presence.css', 'shared/console.css', 'shared/appearance.js', 'shared/first-use.js']) {
  mkdirSync(path.dirname(path.join(out, 'console', file)), { recursive: true });
  cpSync(path.join(root, 'console', file), path.join(out, 'console', file));
}
// Both assets run on Linux. Use their canonical LF bytes on every host.
const linuxSource = file => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const script = Buffer.from(linuxSource('scripts/heartbeat.py'), 'utf8');
const sha256 = createHash('sha256').update(script).digest('hex');
writeFileSync(path.join(out, 'console/bootstrap', sha256 + '.py'), script);

const joinTemplate = linuxSource('scripts/join.sh');
if (joinTemplate.split('@INSTALLER_SHA256@').length !== 2 ||
    joinTemplate.split('@INSTALLER_BYTES@').length !== 2) {
  throw new Error('JOIN_BOOTSTRAP_TEMPLATE_INVALID');
}
const joinText = joinTemplate
  .replace('@INSTALLER_SHA256@', sha256)
  .replace('@INSTALLER_BYTES@', String(script.length));
const join = Buffer.from(joinText, 'utf8');
const bootstrapSha256 = createHash('sha256').update(join).digest('hex');
writeFileSync(path.join(out, 'console/bootstrap', bootstrapSha256 + '.sh'), join);

const config = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
config.main = '../src/adapters/cloudflare/worker.js';
config.assets.directory = './console';
config.vars.GHOSTFLEET_INSTALLER_SHA256 = sha256;
config.vars.GHOSTFLEET_BOOTSTRAP_SHA256 = bootstrapSha256;
writeFileSync(path.join(out, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
writeFileSync(path.join(out, 'installer.json'), JSON.stringify({
  sha256, bytes: script.length, bootstrap_sha256: bootstrapSha256, bootstrap_bytes: join.length,
}, null, 2) + '\n');
if (release) {
  try {
    writeReleaseConfig(release, config);
  } catch (error) {
    console.error('PRESENCE_RELEASE_CONFIG_ERROR ' + error.message);
    process.exit(1);
  }
}
console.log('PRESENCE_BUILD_OK installer_sha256=' + sha256 + ' bytes=' + script.length +
  ' bootstrap_sha256=' + bootstrapSha256 + ' bootstrap_bytes=' + join.length);
