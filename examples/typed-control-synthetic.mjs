// A local synthetic contract example: no SSH, provider, subprocess or device I/O.
import assert from 'node:assert/strict';
import { createNativeBackend, runControlOperation } from '../packages/typed-control/dist/index.js';

const uid = `node-${'0'.repeat(8)}-${'0'.repeat(4)}-4000-8000-${'0'.repeat(11)}1`;
const revision = 'a'.repeat(40);
const source = { repository: 'example/fixture-product', revision };
const policy = {
  schema_version: 1, source,
  nodes: { [uid]: { display_name: 'Synthetic device', aliases: [], platform: 'linux', execution_privilege: 'normal', asset_ref: null, observations: ['identity'], services: {} } },
};
// These values are installed by a trusted deployment in production, never tool input.
const env = {
  CONTROL_POLICY_SOURCE_REPOSITORY: source.repository,
  CONTROL_POLICY_SOURCE_REVISION: revision,
  CONTROL_POLICY_JSON: JSON.stringify(policy),
  CONTROL_TARGETS_JSON: JSON.stringify({ [uid]: { username: 'fixture', transport_mode: 'local_ssh', ssh_host_key_algorithm: 'ssh-ed25519', ssh_host_key_sha256: 'SHA256:AAAA' } }),
  CONTROL_SSH_PRIVATE_KEY: 'synthetic-adapter-label-no-key-material',
};
let contacts = 0;
const fake = createNativeBackend({
  async connect() { contacts++; return { close: async () => {}, closed: Promise.resolve() }; },
  async execute() { return { exit_code: 0, stdout: 'synthetic observation', stderr: '', truncated: false }; },
});
const input = { operation: 'node.inspect', node_uid: uid, observation: 'identity', timeout_seconds: 1 };
// authKind is a synthetic trusted-actor label here, not evidence of an OAuth login.
for (const userId of ['synthetic-client-alpha', 'synthetic-client-beta']) {
  const result = await runControlOperation(env, { userId, scopes: ['fleet.read'], authKind: 'oauth' }, input, fake);
  assert.equal(result.outcome, 'SUCCEEDED');
}
const denied = await runControlOperation(env, undefined, input, fake);
assert.equal(denied.outcome, 'NOT_DISPATCHED');
assert.equal(contacts, 2);
const unconfigured = await runControlOperation(env, { userId: 'fixture', scopes: ['fleet.read'], authKind: 'oauth' }, input);
assert.equal(unconfigured.outcome, 'NOT_DISPATCHED');
console.log('Synthetic typed-control contract passed; no device contacted.');
