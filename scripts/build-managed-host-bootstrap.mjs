// Bundle a reviewable host-stage shell artifact without instance data.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [option, output, ...extra] = process.argv.slice(2);
if (option !== '--output' || !output || extra.length) {
  console.error('MANAGED_HOST_BUILD_EXPECTED_OUTPUT');
  process.exit(1);
}

const source = filename => Buffer.from(readFileSync(new URL(filename, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
const reporter = source('heartbeat.py').toString('base64');
const host = source('managed-bootstrap-host.py').toString('base64');
const script = Buffer.from(`#!/bin/sh
# GhostFleet managed host stage. This artifact installs the reporter.
exec /usr/bin/python3 -I -c '
import base64, sys, types
reporter = base64.b64decode("${reporter}")
module = types.ModuleType("heartbeat")
sys.modules["heartbeat"] = module
exec(compile(reporter, "heartbeat.py", "exec"), module.__dict__)
host = types.ModuleType("managed_bootstrap_host")
exec(compile(base64.b64decode("${host}"), "managed-bootstrap-host.py", "exec"), host.__dict__)
raise SystemExit(host.main(reporter))
' "$@"
`);
try {
  writeFileSync(output, script, { flag: 'wx', mode: 0o644 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (!readFileSync(output).equals(script)) {
    console.error('MANAGED_HOST_BUILD_OUTPUT_EXISTS');
    process.exit(1);
  }
}
const sha256 = createHash('sha256').update(script).digest('hex');
console.log(JSON.stringify({ stage: 'managed-host-reporter', sha256, bytes: script.length }));
