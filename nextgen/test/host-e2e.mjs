import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const run = promisify(execFile);
const socket = createServer();
const port = await new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const value = socket.address().port;
    socket.close((error) => error ? reject(error) : resolve(value));
  });
});
const bundle = await build({ entryPoints: ['nextgen/worker.mjs'], bundle: true, format: 'esm', platform: 'node', write: false });
const origin = 'http://127.0.0.1:' + port;
const operator = randomBytes(36).toString('hex');
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'ghostfleet-e2e', modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { GHOSTFLEET_STATE: { className: 'GhostFleetState', useSQLite: true } },
  host: '127.0.0.1', port,
  bindings: { NEXTGEN_LOCAL_TEST: '1', GHOSTFLEET_PANEL_ORIGIN: origin, GHOSTFLEET_NODE_ORIGIN: origin,
    GHOSTFLEET_OPERATOR_TOKEN: operator },
}));
try {
  await runtime.ready;
  const { stdout } = await run('python3', ['nextgen/test/host_e2e.py', origin], {
    env: { PATH: process.env.PATH, LC_ALL: 'C', GHOSTFLEET_FIXTURE_OPERATOR: operator },
    timeout: 120_000,
  });
  assert.match(stdout, /HOST_E2E_PASS/);
  process.stdout.write(stdout);
} finally {
  await runtime.dispose();
}
