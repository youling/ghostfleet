# Bootstrap courier fixtures (synthetic)

Every file in this directory is a **synthetic test double** for the bootstrap
courier's selected-capability lane. None of them is a product artifact and none
may be presented as one:

- `node-agent.pyz` — a tiny plain-text stand-in for the pinned agent payload.
  It is **not the product agent**; the product payload is a Python zipapp built
  from `packages/node-agent` in the agent repository. When this checkout does
  contain `packages/node-agent/dist/node-agent.pyz`, the test support pins
  **those** bytes automatically (`REAL_AGENT_PAYLOAD_PATH` in
  `test/support/capability-fixture.js`), so integration switches over without a
  test change and without ever mistaking the fixture for the real payload.
- `ghostfleet-node-agent.service` — a synthetic copy of
  `packages/bootstrap/assets/ghostfleet-managed.service`, kept byte-comparable
  so the release unit directive set is exercised by fixture tests. The release
  asset, not this file, is the shipped unit.
- `ghostfleet-managed.service` — the legacy nine-line `Type=oneshot` canary
  retained only for the historical v1 refusal cases.
- `privileged-ops.pub` — a synthetic public key. It is nobody's real credential.
- `capability-installer.sh`, `fleet-privctl.py`, `fixture-tools.sh` — synthetic
  helper/installer test doubles and the command dispatcher used by the harness.

Digests pinned by these fixtures are fixture digests. A real deployment computes
its digests from the reviewed release bytes.
