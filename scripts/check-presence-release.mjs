#!/usr/bin/env node
/**
 * Offline release-pin comparison for GhostFleet lightweight presence.
 * Never fetches URLs, reads credentials, changes remote state, or upgrades a host.
 * A pin match proves deployed *distribution metadata* matches this build,
 * not that the systemd unit on any enrolled node was upgraded.
 */
import { readFileSync, statSync } from 'node:fs';

const HEX = /^[0-9a-f]{64}$/;
const MAX_BYTES = 65536;

function fail(code) {
  throw new Error(code);
}
function readJson(filename) {
  try {
    const st = statSync(filename);
    if (!st.isFile()) fail('INPUT_NOT_REGULAR_FILE');
    if (st.size > MAX_BYTES) fail('INPUT_TOO_LARGE');
    return JSON.parse(readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail('INVALID_JSON');
    if (error.message === 'INPUT_TOO_LARGE' || error.message === 'INPUT_NOT_REGULAR_FILE') throw error;
    fail('INPUT_UNREADABLE');
  }
}
function pin(value) {
  return typeof value === 'string' && HEX.test(value);
}
function bootstrapUrl(value, sha, extension) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/bootstrap/' + sha + extension;
  } catch {
    return false;
  }
}
function compare(build, access) {
  if (!build || typeof build !== 'object' || Array.isArray(build) ||
      !pin(build.sha256) || !pin(build.bootstrap_sha256) ||
      !Number.isSafeInteger(build.bytes) || build.bytes < 1 ||
      !Number.isSafeInteger(build.bootstrap_bytes) || build.bootstrap_bytes < 1) {
    fail('BUILD_MANIFEST_INVALID');
  }
  if (!access || access.ok !== true) fail('ACCESS_READBACK_INVALID');
  if (access.installer === null) return { status: 'REMOTE_PIN_NOT_CONFIGURED' };
  const i = access.installer;
  if (!i || !pin(i.sha256) || !i.bootstrap || !pin(i.bootstrap.sha256) ||
      !bootstrapUrl(i.url, i.sha256, '.py') ||
      !bootstrapUrl(i.bootstrap.url, i.bootstrap.sha256, '.sh')) {
    fail('ACCESS_INSTALLER_METADATA_INVALID');
  }
  const installer = build.sha256 === i.sha256;
  const bootstrap = build.bootstrap_sha256 === i.bootstrap.sha256;
  return { status: installer && bootstrap ? 'MATCHED_BUILD_PINS' : 'PIN_MISMATCH',
    installer_pin_match: installer, bootstrap_pin_match: bootstrap };
}
function main(args) {
  if (args.length !== 4 || args[0] !== '--build-json' || args[2] !== '--access-json') {
    fail('USAGE_EXPECTED_BUILD_JSON_AND_ACCESS_JSON');
  }
  return compare(readJson(args[1]), readJson(args[3]));
}
try {
  const result = main(process.argv.slice(2));
  console.log(JSON.stringify({
    schema: 'ghostfleet-presence-release-pin-check/v1',
    ...result,
    deployment_effect: 'NONE',
    node_unit_currentness: 'NOT_PROVEN',
    node_privilege_authority: 'NONE',
  }));
  process.exitCode = result.status === 'MATCHED_BUILD_PINS' ? 0 : 3;
} catch (error) {
  const allowed = new Set([
    'INPUT_NOT_REGULAR_FILE', 'INPUT_TOO_LARGE', 'INVALID_JSON', 'INPUT_UNREADABLE',
    'BUILD_MANIFEST_INVALID', 'ACCESS_READBACK_INVALID',
    'ACCESS_INSTALLER_METADATA_INVALID', 'USAGE_EXPECTED_BUILD_JSON_AND_ACCESS_JSON',
  ]);
  console.log(JSON.stringify({ ok: false, error: allowed.has(error.message) ? error.message : 'PIN_CHECK_UNKNOWN' }));
  process.exitCode = 4;
}
