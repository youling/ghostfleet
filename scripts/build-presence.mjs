// Deterministic static bundle; no package runtime or framework needed for the UI.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
mkdirSync(path.join(out, 'console/bootstrap'), { recursive: true });
for (const file of ['index.html', 'app.js', 'presence.css', 'shared/console.css', 'shared/appearance.js', 'shared/first-use.js']) {
  mkdirSync(path.dirname(path.join(out, 'console', file)), { recursive: true });
  cpSync(path.join(root, 'console', file), path.join(out, 'console', file));
}
const script = readFileSync(path.join(root, 'scripts/heartbeat.py'));
const sha256 = createHash('sha256').update(script).digest('hex');
writeFileSync(path.join(out, 'console/bootstrap', sha256 + '.py'), script);

const joinTemplate = readFileSync(path.join(root, 'scripts/join.sh'), 'utf8');
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
console.log('PRESENCE_BUILD_OK installer_sha256=' + sha256 + ' bytes=' + script.length +
  ' bootstrap_sha256=' + bootstrapSha256 + ' bootstrap_bytes=' + join.length);
