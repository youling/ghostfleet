import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TEMPLATE = readFileSync(path.join(ROOT, 'scripts/join.sh'), 'utf8');
const PYTHON_PAYLOAD = '#!/usr/bin/python3\n# synthetic pinned installer fixture\n';
const INSTALLER_SHA = createHash('sha256').update(PYTHON_PAYLOAD).digest('hex');
const TICKET = 'ticket-11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://node.example.invalid';

function executable(file, source) {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function fixture({ distro = 'debian', version = '13', python = false, aptUpdate = 0,
  aptInstall = 0, dnfInstall = 0, corrupt = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gf-join-test-'));
  const bin = path.join(root, 'bin');
  const etc = path.join(root, 'etc');
  const usrBin = path.join(root, 'usr/bin');
  mkdirSync(bin); mkdirSync(etc, { recursive: true }); mkdirSync(usrBin, { recursive: true });
  const osRelease = path.join(etc, 'os-release');
  writeFileSync(osRelease, 'ID=' + distro + '\nVERSION_ID="' + version + '"\n');
  const pythonBin = path.join(usrBin, 'python3');
  const pythonStub = '#!/bin/sh\n' +
    'if [ "${1:-}" = "-c" ]; then\n' +
    '  if [ "${GF_PYTHON_TOO_OLD:-0}" = "1" ]; then exit 1; fi\n' +
    '  exit 0\n' +
    'fi\n' +
    'printf \'%s\\n\' "$@" > "$GF_PYTHON_ARGS_FILE"\n' +
    'exit 0\n';
  const createPython = () => executable(pythonBin, pythonStub);
  if (python) createPython();

  const pkgLog = path.join(root, 'packages.log');
  const argsLog = path.join(root, 'python-args.log');
  const payloadPath = path.join(root, 'installer.py');
  writeFileSync(payloadPath, PYTHON_PAYLOAD);
  executable(path.join(bin, 'curl'), '#!/bin/sh\n' +
    'out=\n' +
    'while [ "$#" -gt 0 ]; do\n' +
    '  case "$1" in\n' +
    '    --output) out=$2; shift 2 ;;\n' +
    '    *) shift ;;\n' +
    '  esac\n' +
    'done\n' +
    '[ -n "$out" ] || exit 90\n' +
    'if [ "${GF_CORRUPT_DOWNLOAD:-0}" = "1" ]; then\n' +
    '  printf corrupt > "$out"\n' +
    'else\n' +
    '  cp "$GF_PYTHON_PAYLOAD" "$out"\n' +
    'fi\n');
  executable(path.join(bin, 'apt-get'), '#!/bin/sh\n' +
    'printf \'%s\\n\' "$*" >> "$GF_PACKAGE_LOG"\n' +
    'case "$1" in\n' +
    '  update) exit "${GF_APT_UPDATE_EXIT:-0}" ;;\n' +
    '  install)\n' +
    '    if [ "${GF_APT_INSTALL_EXIT:-0}" -eq 0 ]; then cp "$GF_PYTHON_STUB" "$GF_PYTHON_BIN"; chmod 755 "$GF_PYTHON_BIN"; fi\n' +
    '    exit "${GF_APT_INSTALL_EXIT:-0}"\n' +
    '    ;;\n' +
    '  *) exit 91 ;;\n' +
    'esac\n');
  executable(path.join(bin, 'dnf'), '#!/bin/sh\n' +
    'printf \'%s\\n\' "$*" >> "$GF_PACKAGE_LOG"\n' +
    'case "$1" in\n' +
    '  install)\n' +
    '    if [ "${GF_DNF_INSTALL_EXIT:-0}" -eq 0 ]; then cp "$GF_PYTHON_STUB" "$GF_PYTHON_BIN"; chmod 755 "$GF_PYTHON_BIN"; fi\n' +
    '    exit "${GF_DNF_INSTALL_EXIT:-0}"\n' +
    '    ;;\n' +
    '  *) exit 92 ;;\n' +
    'esac\n');

  // Path substitutions keep the production script unchanged while isolating
  // package-manager and /usr/bin/python3 effects inside this disposable fixture.
  const script = TEMPLATE
    .replaceAll('__GHOSTFLEET_INSTALLER_SHA256__', INSTALLER_SHA)
    .replaceAll('/etc/os-release', osRelease)
    .replaceAll('/usr/bin/python3', pythonBin)
    .replaceAll('$(id -u)', '0');
  const scriptPath = path.join(root, 'join.sh');
  writeFileSync(scriptPath, script);
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    GF_PACKAGE_LOG: pkgLog,
    GF_PYTHON_ARGS_FILE: argsLog,
    GF_PYTHON_BIN: pythonBin,
    GF_PYTHON_STUB: path.join(root, 'python3.stub'),
    GF_PYTHON_PAYLOAD: payloadPath,
    GF_APT_UPDATE_EXIT: String(aptUpdate),
    GF_APT_INSTALL_EXIT: String(aptInstall),
    GF_DNF_INSTALL_EXIT: String(dnfInstall),
    GF_CORRUPT_DOWNLOAD: corrupt ? '1' : '0',
  };
  writeFileSync(env.GF_PYTHON_STUB, pythonStub);
  return {
    root, scriptPath, env, pkgLog, argsLog, pythonBin,
    run() {
      return spawnSync('/bin/sh', [scriptPath, '--origin', ORIGIN, '--ticket', TICKET], {
        encoding: 'utf8', env, timeout: 15000,
      });
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('POSIX bootstrap fast path reuses Python and never calls a package manager', () => {
  const f = fixture({ python: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.argsLog, 'utf8').includes(TICKET), true);
    assert.equal(readFileSync(f.pkgLog, 'utf8'), '');
  } finally { f.close(); }
});

test('Debian missing-Python path installs only python3 and never upgrades the system', () => {
  const f = fixture({ distro: 'debian', version: '13' });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(f.pkgLog, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['update -qq', 'install -y --no-install-recommends python3']);
    assert.ok(!calls.some(line => /\b(upgrade|full-upgrade|dist-upgrade|autoremove|remove)\b/.test(line)));
  } finally { f.close(); }
});

test('DNF path installs only python3 with weak dependencies disabled', () => {
  const f = fixture({ distro: 'fedora', version: '43' });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.pkgLog, 'utf8').trim(), 'install -y --setopt=install_weak_deps=False python3');
  } finally { f.close(); }
});

test('unsupported distributions fail closed before download or package mutation', () => {
  const f = fixture({ distro: 'arch', version: '2026.11' });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UNSUPPORTED_DISTRIBUTION/);
    assert.equal(readFileSync(f.pkgLog, 'utf8'), '');
    assert.equal(requireNoFile(f.argsLog), true);
  } finally { f.close(); }
});

test('apt metadata failure stops before package install and artifact download', () => {
  const f = fixture({ distro: 'debian', version: '13', aptUpdate: 17 });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APT_UPDATE_FAILED/);
    assert.equal(readFileSync(f.pkgLog, 'utf8').trim(), 'update -qq');
    assert.equal(requireNoFile(f.argsLog), true);
  } finally { f.close(); }
});

test('apt package install failure stops before running the reporter installer', () => {
  const f = fixture({ distro: 'debian', version: '13', aptInstall: 23 });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APT_PYTHON3_INSTALL_FAILED/);
    assert.deepEqual(readFileSync(f.pkgLog, 'utf8').trim().split('\n'), [
      'update -qq', 'install -y --no-install-recommends python3',
    ]);
    assert.equal(requireNoFile(f.argsLog), true);
  } finally { f.close(); }
});

test('Python below the supported minimum is not silently upgraded', () => {
  const f = fixture({ python: true });
  f.env.GF_PYTHON_TOO_OLD = '1';
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PYTHON3_TOO_OLD_OR_BROKEN/);
    assert.equal(readFileSync(f.pkgLog, 'utf8'), '');
    assert.equal(requireNoFile(f.argsLog), true);
  } finally { f.close(); }
});

test('downloaded Python artifact must match the embedded SHA-256 before execution', () => {
  const f = fixture({ python: true, corrupt: true });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /INSTALLER_HASH_MISMATCH/);
    assert.equal(requireNoFile(f.argsLog), true);
  } finally { f.close(); }
});

test('bootstrap never accepts the short code as a command-line argument', () => {
  const source = TEMPLATE;
  assert.doesNotMatch(source, /--code|SHORT_CODE|short_code/);
  assert.match(source, /install --origin "\$ORIGIN" --ticket "\$TICKET"/);
});

function requireNoFile(file) {
  try { readFileSync(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
