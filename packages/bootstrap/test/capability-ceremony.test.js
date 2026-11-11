import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  renderBootstrap, encodeCapabilitySelection, capabilitySelectionDigest, normalizeSelectedCapability,
} from "../src/index.js";

const linuxOnly = process.platform !== "linux";
// A real ordinary account: the courier resolves and validates this identity.
// A root test runner (the disposable jobs) supplies an ordinary account.
const OPERATING_USER = process.getuid?.() === 0
  ? (process.env.GHOSTFLEET_TEST_ORDINARY_USER || "ghostfleet-test")
  : userInfo().username;
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const NODE_ID = "fleet-node-fixture";
const NODE_UID = "node-00000000-0000-4000-8000-000000000001";
const STUB_COMMANDS = [
  "id", "uname", "dpkg-query", "systemctl", "apt-get", "curl", "ssh-keygen",
  "install", "chown", "getent", "loginctl", "useradd", "usermod", "passwd",
  "visudo", "sudo", "python3",
];

function sha256(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

async function readFixture(name) {
  return readFile(join(fixtureDir, name), "utf8");
}

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), "ghostfleet-capability-"));
  const host = {
    root,
    bin: join(root, "bin"),
    fixtureState: join(root, "fixture-state"),
    checkpoint: join(root, "checkpoint"),
    run: join(root, "run"),
    accountHome: join(root, "home-ghostfleet-managed"),
    tty: join(root, "dev-tty"),
    ttyOut: join(root, "dev-tty-out"),
    osRelease: join(root, "os-release"),
    systemdDir: join(root, "systemd"),
    keyrings: join(root, "usr-share-keyrings"),
    aptSources: join(root, "etc-apt-sources"),
    sshDir: join(root, "etc-ssh"),
    tailscaleStateMarker: join(root, "tailscale.state.marker"),
    lock: join(root, "fresh-checkpoint"),
  };
  await mkdir(host.bin);
  await mkdir(host.fixtureState);
  await mkdir(host.accountHome);
  await mkdir(host.systemdDir);
  await mkdir(host.sshDir);
  await mkdir(host.keyrings);
  await mkdir(host.aptSources);
  await writeFile(join(host.sshDir, "ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAAfixturehostkey synthetic\n");
  await writeFile(host.osRelease, 'ID=debian\nID_LIKE=debian\nVERSION_ID="13"\nVERSION_CODENAME=bookworm\n');
  await writeFile(host.tty, "12345678\n");
  await writeFile(join(host.fixtureState, "claim.json"), JSON.stringify({
    resume_session: "fixture-resume-session-0123456789abcdef",
    auth_key: "fixture-one-off-auth-key",
    identity_kind: "canonical",
    node_id: NODE_ID,
    node_uid: NODE_UID,
  }));
  const dispatcher = await readFixture("fixture-tools.sh");
  for (const command of STUB_COMMANDS) {
    await writeFile(join(host.bin, command), dispatcher, { mode: 0o755 });
  }
  host.env = {
    FIXTURE_STATE: host.fixtureState,
    FIXTURE_BIN: host.bin,
    FIXTURE_NODE_ID: NODE_ID,
    FIXTURE_ACCOUNT_HOME: host.accountHome,
    FIXTURE_AUTHKEY: join(host.run, "ts-authkey"),
    GHOSTFLEET_OPERATING_USER: OPERATING_USER,
  };
  return host;
}

// A new enrollment attempt starts from a machine with no provider identity but
// the same, possibly already-installed, selected capability lane.
async function resetProviderIdentity(host) {
  await rm(join(host.fixtureState, "tailscale.joined"), { force: true });
  await rm(join(host.bin, "tailscale"), { force: true });
}

// The claim is the server-authoritative channel for the selection.
async function setClaim(host, overrides = {}) {
  await writeFile(join(host.fixtureState, "claim.json"), JSON.stringify({
    resume_session: "fixture-resume-session-0123456789abcdef",
    auth_key: "fixture-one-off-auth-key",
    identity_kind: "canonical",
    node_id: NODE_ID,
    node_uid: NODE_UID,
    ...overrides,
  }));
}

async function freshCheckpoint(host) {
  await rm(host.checkpoint, { recursive: true, force: true });
  await mkdir(host.checkpoint, { mode: 0o700 });
}

async function buildSelection(overrides = {}) {
  const [installer, key, helper, unit] = await Promise.all([
    readFixture("capability-installer.sh"),
    readFixture("privileged-ops.pub"),
    readFixture("fleet-privctl.py"),
    readFixture("ghostfleet-managed.service"),
  ]);
  const selection = {
    source: "template",
    template_digest: sha256("fixture-template"),
    version: "managed-linux-privileged-operations/2026.11",
    helper_required: true,
    linger_required: true,
    user_service_required: true,
    control_account: "ghostfleet-managed",
    installer: "managed-linux-privileged-operations.sh",
    privileged_key: "privileged-ops.pub",
    user_unit: { name: "ghostfleet-managed.service", artifact: "ghostfleet-managed.service" },
    artifacts: [
      { name: "fleet-privctl.py", mode: "0755", content: helper },
      { name: "privileged-ops.pub", mode: "0644", content: key },
      { name: "ghostfleet-managed.service", mode: "0644", content: unit },
      { name: "managed-linux-privileged-operations.sh", mode: "0750", content: installer },
    ],
    ...overrides,
  };
  return selection;
}

async function runCourier(host, selection, options = {}) {
  let script = renderBootstrap({
    brokerOrigin: "https://broker.fixture.invalid",
    checkpointDir: host.checkpoint,
    capabilitySelection: selection,
  });
  const replace = (needle, value) => { script = script.replace(needle, () => value); };
  replace('PATH="/usr/sbin:/usr/bin:/sbin:/bin"', 'PATH="' + host.bin + ':/usr/sbin:/usr/bin:/sbin:/bin"');
  script = script.replaceAll(". /etc/os-release", () => ". " + host.osRelease);
  script = script.replaceAll("[ -d /run/systemd/system ]", () => "[ -d " + host.systemdDir + " ]");
  script = script.replaceAll("[ -c /dev/tty ]", () => "[ -f " + host.tty + " ]");
  script = script.replaceAll("</dev/tty", () => "<" + host.tty);
  script = script.replaceAll("< /dev/tty", () => "< " + host.tty);
  script = script.replaceAll("> /dev/tty", () => "> " + host.ttyOut);
  script = script.replaceAll("/run/fleet", () => host.run);
  script = script.replaceAll("/etc/ssh/", () => host.sshDir + "/");
  script = script.replaceAll("/usr/share/keyrings", () => host.keyrings);
  script = script.replaceAll("/etc/apt/sources.list.d", () => host.aptSources);
  script = script.replaceAll("/var/lib/tailscale/tailscaled.state", () => host.tailscaleStateMarker);
  if (options.tamper) script = options.tamper(script);
  const file = join(host.root, "courier.sh");
  await writeFile(file, script);
  return spawnSync("/bin/sh", [file], {
    env: { ...process.env, ...host.env, ...(options.env ?? {}) },
    encoding: "utf8",
    timeout: 120000,
    input: "",
  });
}

async function calls(host) {
  try { return (await readFile(join(host.fixtureState, "calls.log"), "utf8")).trim().split("\n"); }
  catch { return []; }
}
async function installerLog(host) {
  try { return (await readFile(join(host.fixtureState, "installer.log"), "utf8")).trim().split("\n"); }
  catch { return []; }
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function snapshot(paths) {
  const result = [];
  for (const path of paths) {
    const info = await stat(path);
    result.push({ path, body: await readFile(path, "utf8"), mtime: info.mtimeMs, mode: info.mode });
  }
  return result;
}

const UNIT_PATH = (host) => join(host.accountHome, ".config/systemd/user/ghostfleet-managed.service");
const WANT_PATH = (host) => join(host.accountHome, ".config/systemd/user/default.target.wants/ghostfleet-managed.service");

test("the template-selected privileged capability installs inside the same root ceremony", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    const result = await runCourier(host, selection);
    assert.equal(result.status, 0, result.stderr);

    const journal = await calls(host);
    const installJournal = await installerLog(host);
    // Real full-bootstrap call chain: the broker claim happened, the identity
    // join happened, and the completion report was posted after the capability.
    assert.deepEqual(journal.filter((line) => line === "curl claim" || line === "curl complete"), ["curl claim", "curl complete"]);
    assert.equal(journal.filter((line) => line === "tailscale-up").length, 1);
    assert.ok(installJournal.some((line) => line.startsWith("installer --apply")));
    assert.ok(installJournal.some((line) => line.startsWith("installer --check")));
    assert.ok(journal.indexOf("curl claim") < journal.indexOf("tailscale-up"));
    assert.ok(await readJson(join(host.fixtureState, "complete-body.json")));

    // The selected effect is real: the pinned key and ordinary user reached the
    // installer, the unit was materialized, and Linger was enabled.
    const pinnedKey = await readFixture("privileged-ops.pub");
    const applyLine = installJournal.find((line) => line.startsWith("installer --apply"));
    assert.ok(applyLine.includes("user=" + OPERATING_USER + " "), applyLine);
    assert.ok(applyLine.includes("key=" + createHash("sha256").update(pinnedKey, "utf8").digest("hex")));
    assert.equal(await readFile(UNIT_PATH(host), "utf8"), await readFixture("ghostfleet-managed.service"));
    assert.equal((await stat(UNIT_PATH(host))).mode & 0o777, 0o644);
    assert.equal(await readFile(WANT_PATH(host), "utf8"), await readFixture("ghostfleet-managed.service"));
    assert.ok(await exists(join(host.fixtureState, "linger")));
    assert.ok(journal.includes("loginctl-enable-linger ghostfleet-managed"));

    const checkpoint = await readJson(join(host.checkpoint, "enrollment-checkpoint.json"));
    assert.deepEqual(checkpoint.components, {
      packages: "COMPLIANT", tailscale: "COMPLIANT",
      privileged_helper: "COMPLIANT", user_service: "COMPLIANT", linger: "COMPLIANT",
    });
    assert.equal(checkpoint.status, "COMPLIANT");
    const capabilityState = await readJson(join(host.checkpoint, "capability-state.json"));
    assert.equal(capabilityState.mode, "NEW");
    assert.equal(capabilityState.version, selection.version);
    assert.equal(capabilityState.template_digest, selection.template_digest);
    assert.deepEqual(capabilityState.components, {
      privileged_helper: "COMPLIANT", user_service: "COMPLIANT", linger: "COMPLIANT",
    });
    const report = await readJson(join(host.checkpoint, "enrollment-report.json"));
    assert.equal(report.capability_mode, "NEW");
    assert.equal(report.capability_version, selection.version);
    assert.equal(report.ssh_host_key_sha256, "SHA256:fixturehostfingerprint");
    // The staged artifacts never survive the ceremony.
    assert.deepEqual((await readdir(host.root)).filter((name) => name.startsWith("tmp.")), []);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a template that requests no privileged capability installs nothing", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const result = await runCourier(host, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /requests no privileged capability/);
    assert.deepEqual(await installerLog(host), []);
    assert.equal((await calls(host)).filter((line) => line.startsWith("loginctl")).length, 0);
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal(await exists(join(host.fixtureState, "linger")), false);
    assert.equal(await exists(join(host.checkpoint, "capability-state.json")), false);
    const checkpoint = await readJson(join(host.checkpoint, "enrollment-checkpoint.json"));
    assert.deepEqual(checkpoint.components, { packages: "COMPLIANT", tailscale: "COMPLIANT" });
    assert.equal(checkpoint.status, "COMPLIANT");
    assert.ok(await readJson(join(host.fixtureState, "complete-body.json")));
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("repeated execution is zero delta and never reinstalls the selected capability", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    const first = await runCourier(host, selection);
    assert.equal(first.status, 0, first.stderr);
    const watched = [
      join(host.checkpoint, "enrollment-checkpoint.json"),
      join(host.checkpoint, "enrollment-report.json"),
      join(host.checkpoint, "capability-state.json"),
      UNIT_PATH(host),
    ];
    const before = await snapshot(watched);
    const callsBefore = (await calls(host)).length;
    const appliesBefore = (await installerLog(host)).filter((line) => line.includes("--apply")).length;

    const second = await runCourier(host, selection);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /already converged/);
    assert.deepEqual(await snapshot(watched), before, "a converged host must not be rewritten");
    const journalAfter = await calls(host);
    assert.equal(journalAfter.length, callsBefore, "no claim, join or Linger call on the zero-delta path");
    assert.equal(
      (await installerLog(host)).filter((line) => line.includes("--apply")).length,
      appliesBefore,
      "no second privileged helper apply",
    );
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("NEW, ADOPT and REPAIR are distinguishable and only repair real drift", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    const selection = await buildSelection();
    await freshCheckpoint(host);
    const fresh = await runCourier(host, selection);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal((await readJson(join(host.checkpoint, "capability-state.json"))).mode, "NEW");

    // ADOPT: a new enrollment attempt (fresh provider identity, fresh attempt
    // record) on a host whose selected capability is already converged must not
    // reinstall it.
    await resetProviderIdentity(host);
    await freshCheckpoint(host);
    const appliesBefore = (await installerLog(host)).filter((line) => line.includes("--apply")).length;
    const adopt = await runCourier(host, selection);
    assert.equal(adopt.status, 0, adopt.stderr);
    assert.equal((await readJson(join(host.checkpoint, "capability-state.json"))).mode, "ADOPT");
    assert.equal((await installerLog(host)).filter((line) => line.includes("--apply")).length, appliesBefore);

    // REPAIR: drift the helper and the Linger lane, then converge only that.
    await writeFile(join(host.fixtureState, "drift"), "drifted\n");
    await rm(join(host.fixtureState, "linger"), { force: true });
    await resetProviderIdentity(host);
    await freshCheckpoint(host);
    const repair = await runCourier(host, selection);
    assert.equal(repair.status, 0, repair.stderr);
    assert.equal((await readJson(join(host.checkpoint, "capability-state.json"))).mode, "REPAIR");
    assert.equal((await installerLog(host)).filter((line) => line.includes("--apply")).length, appliesBefore + 1);
    assert.equal(await exists(join(host.fixtureState, "drift")), false);
    assert.ok(await exists(join(host.fixtureState, "linger")));
    const checkpoint = await readJson(join(host.checkpoint, "enrollment-checkpoint.json"));
    assert.equal(checkpoint.components.privileged_helper, "COMPLIANT");
    assert.equal(checkpoint.components.linger, "COMPLIANT");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a partially applied capability is never reported as completion and repairs on the reviewed retry", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    const interrupted = await runCourier(host, selection, { env: { FAKE_INSTALLER_FAIL: "1" } });
    assert.notEqual(interrupted.status, 0);
    assert.match(interrupted.stderr, /selected privileged helper apply failed/);
    assert.equal(await exists(join(host.fixtureState, "complete-body.json")), false, "no completion may be reported");
    const failedState = await readJson(join(host.checkpoint, "enrollment-checkpoint.json"));
    assert.equal(failedState.status, "IN_PROGRESS", "interruption is a pending state, not compliance");
    assert.notEqual(failedState.status, "COMPLIANT");
    assert.equal(await exists(join(host.checkpoint, "capability-state.json")), false);
    assert.equal(await exists(UNIT_PATH(host)), false, "the user service is not reached after a helper failure");

    // The published courier refuses a second one-off key while that state is
    // unresolved; the reviewed operator step clears the fence first.
    const fenced = await runCourier(host, selection);
    assert.notEqual(fenced.status, 0);
    assert.match(fenced.stderr, /prior enrollment state unresolved/);
    // The reviewed reconciliation clears the attempt fence and re-establishes a
    // provider identity; the half-applied capability itself is left in place.
    await resetProviderIdentity(host);
    await freshCheckpoint(host);

    const retry = await runCourier(host, selection);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal((await readJson(join(host.checkpoint, "capability-state.json"))).mode, "REPAIR");
    const installed = await readJson(join(host.fixtureState, "installed.json"));
    assert.equal(installed.complete, true);
    assert.equal(installed.ordinary_user, OPERATING_USER);
    assert.equal(installed.applies, 2, "the retry repairs, it does not duplicate the account or key");
    assert.equal(await readFile(UNIT_PATH(host), "utf8"), await readFixture("ghostfleet-managed.service"));
    assert.ok(await exists(join(host.fixtureState, "linger")));
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a missing or unverifiable capability dependency fails closed before any effect", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    const selection = await buildSelection();
    const cases = [
      {
        name: "artifact missing from the payload",
        tamper: (script) => script.replace("CAPABILITY_ARTIFACT_COUNT=4", () => "CAPABILITY_ARTIFACT_COUNT=5"),
        expected: /selected-capability artifact 5 is missing/,
      },
      {
        name: "privileged key not pinned",
        tamper: (script) => script.replace("CAPABILITY_PRIVILEGED_KEY='privileged-ops.pub'", () => "CAPABILITY_PRIVILEGED_KEY='absent.pub'"),
        expected: /does not pin the admitted privileged SSH public key/,
      },
      {
        name: "artifact digest mismatch",
        tamper: (script) => script.replace(/(CAPABILITY_ARTIFACT_1='[^|]*\|)[0-9a-f]{64}/, (match, prefix) => prefix + "0".repeat(64)),
        expected: /failed digest verification/,
      },
      {
        name: "unrequested artifacts injected into a template-less payload",
        capabilitySelection: null,
        tamper: (script) => script
          .replace("CAPABILITY_ARTIFACT_COUNT=0", () => "CAPABILITY_ARTIFACT_COUNT=1")
          .replace("capability_artifact_row() {", () => "CAPABILITY_ARTIFACT_1='a|b|c|d'\ncapability_artifact_row() {"),
        expected: /refusing privileged capability artifacts/,
      },
    ];
    for (const item of cases) {
      await freshCheckpoint(host);
      const result = await runCourier(host, item.capabilitySelection === undefined ? selection : item.capabilitySelection, { tamper: item.tamper });
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.expected, item.name);
      assert.deepEqual(await calls(host), [], item.name + ": no claim, package or service effect");
      assert.deepEqual(await installerLog(host), [], item.name + ": the installer never ran");
      assert.equal(await exists(join(host.checkpoint, "enrollment-checkpoint.json")), false, item.name);
      assert.equal(await exists(UNIT_PATH(host)), false, item.name);
    }
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a claim-delivered selection installs the capability without a rendered payload", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, {
      capability_required: true,
      capability_selection: encodeCapabilitySelection(selection),
    });
    const result = await runCourier(host, null);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await installerLog(host)).some((line) => line.startsWith("installer --apply")));
    const checkpoint = await readJson(join(host.checkpoint, "enrollment-checkpoint.json"));
    assert.equal(checkpoint.components.privileged_helper, "COMPLIANT");
    assert.equal(checkpoint.components.linger, "COMPLIANT");
    assert.equal((await readJson(join(host.checkpoint, "capability-state.json"))).mode, "NEW");
    assert.equal(await readFile(UNIT_PATH(host), "utf8"), await readFixture("ghostfleet-managed.service"));
    assert.ok(await exists(join(host.fixtureState, "linger")));
    // The recorded digest binds the installed bytes to the reviewed selection.
    const expected = capabilitySelectionDigest(normalizeSelectedCapability(selection));
    const state = await readJson(join(host.checkpoint, "capability-state.json"));
    const report = await readJson(join(host.checkpoint, "enrollment-report.json"));
    assert.equal(state.selection_digest, expected);
    assert.equal(report.capability_selection_digest, expected);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a required capability with no delivered artifacts stops before the identity join", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    await setClaim(host, { capability_required: true });
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires the privileged capability but the claim delivered no pinned artifacts/);
    const journal = await calls(host);
    assert.equal(journal.includes("tailscale-up"), false, "no identity effect before the selection is known");
    assert.equal(journal.includes("curl complete"), false);
    assert.deepEqual(await installerLog(host), []);
    assert.equal(await exists(join(host.checkpoint, "capability-state.json")), false);
    assert.equal(await exists(UNIT_PATH(host)), false);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a claim selection that is not decodable or not pinned is refused before the join", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    const cases = [
      { name: "undecodable", selection: Buffer.from("not-a-selection\n").toString("base64"), expected: /unknown field|requires the privileged capability/ },
      { name: "unpinned artifact row", selection: Buffer.from("schema=ghostfleet-selected-capability/v1\nversion=v1\ntemplate_digest=sha256:" + "0".repeat(64) + "\nhelper_required=1\nartifact=evil\n").toString("base64"), expected: /artifact row is invalid/ },
    ];
    for (const item of cases) {
      await resetProviderIdentity(host);
      await freshCheckpoint(host);
      await setClaim(host, { capability_required: true, capability_selection: item.selection });
      const result = await runCourier(host, null);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.expected, item.name);
      assert.equal((await calls(host)).includes("tailscale-up"), false, item.name);
      assert.deepEqual(await installerLog(host), [], item.name);
    }
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a claim-delivered capability repeats as zero delta without a new claim", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const first = await runCourier(host, null);
    assert.equal(first.status, 0, first.stderr);
    const applies = (await installerLog(host)).filter((line) => line.includes("--apply")).length;
    const watched = [
      join(host.checkpoint, "enrollment-checkpoint.json"),
      join(host.checkpoint, "capability-state.json"),
      join(host.checkpoint, "capability-selection.txt"),
      UNIT_PATH(host),
    ];
    const before = await snapshot(watched);

    const second = await runCourier(host, null);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /already converged/);
    assert.deepEqual(await snapshot(watched), before, "a converged node is not rewritten");
    assert.equal((await calls(host)).filter((line) => line === "curl claim").length, 1, "no second claim");
    assert.equal((await installerLog(host)).filter((line) => line.includes("--apply")).length, applies);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a drifted user service or Linger lane is repaired from the recorded selection without a claim", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const first = await runCourier(host, null);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(await exists(UNIT_PATH(host)));
    assert.ok(await exists(join(host.fixtureState, "linger")));
    const applies = (await installerLog(host)).filter((line) => line.includes("--apply")).length;

    // Break only the user-level lane: the helper stays compliant.
    await rm(UNIT_PATH(host), { force: true });
    await rm(join(host.accountHome, ".config/systemd/user/default.target.wants/ghostfleet-managed.service"), { force: true });
    await rm(join(host.fixtureState, "linger"), { force: true });

    const second = await runCourier(host, null);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /repaired from the recorded reviewed selection/);
    assert.equal((await calls(host)).filter((line) => line === "curl claim").length, 1, "repair needs no new claim");
    assert.equal((await installerLog(host)).filter((line) => line.includes("--apply")).length, applies, "no helper reinstall");
    assert.equal(await readFile(UNIT_PATH(host), "utf8"), await readFixture("ghostfleet-managed.service"));
    assert.ok(await exists(join(host.fixtureState, "linger")));
    const state = await readJson(join(host.checkpoint, "capability-state.json"));
    assert.equal(state.mode, "REPAIR");
    const checkpoint = await readJson(join(host.checkpoint, "enrollment-checkpoint.json"));
    assert.equal(checkpoint.status, "COMPLIANT");
    assert.equal(checkpoint.components.user_service, "COMPLIANT");
    assert.equal(checkpoint.components.linger, "COMPLIANT");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a recorded capability that cannot be re-proved is never reported as zero delta", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    // Losing the reviewed selection removes the only way to re-prove the lane,
    // and the lane has drifted: zero delta must not be reported.
    await rm(join(host.checkpoint, "capability-selection.txt"), { force: true });
    await rm(UNIT_PATH(host), { force: true });
    await setClaim(host, {});
    const second = await runCourier(host, null);
    // The fixture broker accepts any code, so the code alone cannot prove the
    // refusal; what must never happen is a zero-delta claim for a lane that
    // cannot be re-proved.
    assert.doesNotMatch(second.stderr, /already converged/);
    assert.match(second.stderr, /legacy checkpoint/);
    assert.equal((await calls(host)).filter((line) => line === "tailscale-up").length, 1);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a selection delivered for a template that requires none is refused", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: false, capability_selection: encodeCapabilitySelection(selection) });
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires none; no privileged component was installed/);
    assert.equal((await calls(host)).includes("tailscale-up"), false);
    assert.deepEqual(await installerLog(host), []);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("the claim selection is verified after the claim and before the identity join", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const result = await runCourier(host, null);
    assert.equal(result.status, 0, result.stderr);
    const journal = await calls(host);
    const claimAt = journal.indexOf("curl claim");
    const joinAt = journal.indexOf("tailscale-up");
    const lingerAt = journal.indexOf("loginctl-enable-linger ghostfleet-managed");
    const completeAt = journal.indexOf("curl complete");
    // Honest ordering: transport prerequisites precede the claim; the capability
    // never installs before the claim, and never after the completion report.
    assert.ok(claimAt > 0 && joinAt > claimAt, "claim precedes the identity join");
    assert.ok(lingerAt > joinAt, "capability effect follows the join fence");
    assert.ok(completeAt > lingerAt, "completion follows the capability");
    assert.deepEqual(await installerLog(host).then((lines) => lines.filter((line) => line.startsWith("installer --apply"))).then((lines) => lines.length), 1);
    const aptLines = journal.map((line, index) => [line, index]).filter(([line]) => line.startsWith("apt-get"));
    assert.ok(aptLines.length > 0 && aptLines.every(([, index]) => index < claimAt), "package prerequisites precede the claim");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("the one-time ticket URL never enters curl argv, and the auth key stays 0600", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const oneTimeUrl = "https://broker.fixture.invalid/v1/enrollment-tickets/ticket-fixture";
    const result = await runCourier(host, null, { env: { GHOSTFLEET_ENROLLMENT_URL: oneTimeUrl } });
    assert.equal(result.status, 0, result.stderr);
    const journal = await calls(host);
    assert.ok(journal.includes("curl claim"));
    assert.equal(journal.some((line) => line.includes("enrollment-tickets")), false, "ticket URL is not in argv");
    assert.ok(journal.includes("curl-config mode=600"), "claim config is root-private");
    // Root-owned and 0600 while it exists; the fixture chown is recorded, so an
    // ordinary-user CI run can still prove the intended ownership.
    assert.ok(journal.some((line) => /^authkey 600 /.test(line)), "one-off auth key is mode 0600 while written");
    assert.ok(journal.some((line) => line === "chown root:root " + join(host.run, "ts-authkey")), "one-off auth key is chowned to root");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a legacy checkpoint without a reviewed record converges through the next claim", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    // A checkpoint written by an older courier: components recorded, no record.
    // The lane drifted, so the record cannot be re-proved and only a fresh
    // authorized claim can converge it — without manual state surgery.
    await rm(join(host.checkpoint, "capability-selection.txt"), { force: true });
    await rm(UNIT_PATH(host), { force: true });
    await rm(join(host.accountHome, ".config/systemd/user/default.target.wants/ghostfleet-managed.service"), { force: true });
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const legacy = await runCourier(host, null);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(legacy.stderr, /legacy checkpoint/);
    assert.match(legacy.stderr, /reconciling a legacy capability record/);
    assert.equal((await calls(host)).filter((line) => line === "tailscale-up").length, 1, "no second identity join");
    assert.ok(await exists(join(host.checkpoint, "capability-selection.txt")), "the record is rebuilt");
    assert.equal((await readJson(join(host.checkpoint, "enrollment-checkpoint.json"))).status, "COMPLIANT");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a capability record from another node is refused when this checkpoint recorded none", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    // Simulate a record that belongs to another node: the checkpoint is rewritten
    // so it never recorded a privileged component, while the record survives.
    const checkpointPath = join(host.checkpoint, "enrollment-checkpoint.json");
    const checkpoint = await readJson(checkpointPath);
    await writeFile(checkpointPath, JSON.stringify({
      ...checkpoint,
      components: { packages: "COMPLIANT", tailscale: "COMPLIANT" },
    }));
    await setClaim(host, {});
    const applied = (await installerLog(host)).filter((line) => line.includes("--apply")).length;
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to install from an unrelated record/);
    assert.equal((await installerLog(host)).filter((line) => line.includes("--apply")).length, applied);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a claim selection with a non-normalised mode or a root control account is refused", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    const selection = await buildSelection();
    const text = Buffer.from(encodeCapabilitySelection(selection), "base64").toString("utf8");
    const cases = [
      {
        name: "user-service only with root account",
        body: text
          .replace("helper_required=1", "helper_required=0")
          .replace("linger_required=1", "linger_required=0")
          .replace("control_account=ghostfleet-managed", "control_account=root"),
        expected: /control account must not be root/,
      },
    ];
    for (const item of cases) {
      await freshCheckpoint(host);
      await setClaim(host, { capability_required: true, capability_selection: Buffer.from(item.body).toString("base64") });
      const result = await runCourier(host, null);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.expected, item.name);
      assert.equal((await calls(host)).includes("tailscale-up"), false, item.name);
      assert.deepEqual(await installerLog(host), [], item.name);
    }
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a legacy node cannot be downgraded by a claim that delivers no capability", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    const stateBefore = await readJson(join(host.checkpoint, "capability-state.json"));
    const checkpointBefore = await readJson(join(host.checkpoint, "enrollment-checkpoint.json"));
    const reportBefore = await readJson(join(host.checkpoint, "enrollment-report.json"));
    await rm(join(host.checkpoint, "capability-selection.txt"), { force: true });

    // The next claim comes from a template that requests no capability at all.
    await setClaim(host, { capability_required: false, capability_selection: null });
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0, "a claim without a selection must not complete");
    assert.match(result.stderr, /recorded a privileged capability but the claim delivered no reviewed selection/);
    assert.equal((await calls(host)).filter((line) => line === "curl complete").length, 1, "only the first run reported completion");
    // Every piece of evidence still describes the installed lane.
    assert.deepEqual(await readJson(join(host.checkpoint, "capability-state.json")), stateBefore);
    assert.deepEqual(await readJson(join(host.checkpoint, "enrollment-checkpoint.json")), checkpointBefore);
    assert.deepEqual(await readJson(join(host.checkpoint, "enrollment-report.json")), reportBefore);
    assert.equal(await exists(join(host.checkpoint, "capability-selection.txt")), false);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a legacy reconcile refuses a claim for a different node identity", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    assert.equal((await runCourier(host, null)).status, 0);
    await rm(join(host.checkpoint, "capability-selection.txt"), { force: true });
    await rm(UNIT_PATH(host), { force: true });

    // Same node id, different node uid: not the node this checkpoint belongs to.
    await setClaim(host, {
      capability_required: true,
      capability_selection: encodeCapabilitySelection(selection),
      node_uid: NODE_UID.slice(0, -1) + "2",
    });
    const result = await runCourier(host, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /different node identity/);
    assert.equal((await calls(host)).filter((line) => line === "tailscale-up").length, 1);
    assert.deepEqual(await installerLog(host).then((lines) => lines.filter((line) => line.includes("--apply"))).then((lines) => lines.length), 1);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("the courier refuses an operating Human identity it cannot trust", { skip: linuxOnly }, async () => {
  const cases = [
    { name: "absent", env: { GHOSTFLEET_OPERATING_USER: "", SUDO_USER: "" } },
    { name: "root", env: { GHOSTFLEET_OPERATING_USER: "root", SUDO_USER: "" } },
    { name: "unknown account", env: { GHOSTFLEET_OPERATING_USER: "ghostfleet-no-such-human", SUDO_USER: "" } },
    { name: "injection", env: { GHOSTFLEET_OPERATING_USER: "ops;touch /tmp/owned", SUDO_USER: "" } },
    { name: "system account", env: { GHOSTFLEET_OPERATING_USER: "daemon", SUDO_USER: "" } },
  ];
  for (const item of cases) {
    const host = await makeHost();
    try {
      await freshCheckpoint(host);
      const selection = await buildSelection();
      await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
      const result = await runCourier(host, null, { env: item.env });
      assert.notEqual(result.status, 0, item.name + " must fail closed");
      assert.match(result.stderr, /operating Human account/, item.name);
      assert.deepEqual(await installerLog(host), [], item.name + " installed nothing");
    } finally { await rm(host.root, { recursive: true, force: true }); }
  }
});

test("the selected capability is validated before the preclaim fence and installed before completion", () => {
  return import("../src/bootstrap.js").then(({ BOOTSTRAP_SH }) => {
    const preflight = BOOTSTRAP_SH.indexOf("\nbootstrap_phase0_preflight\n");
    const validate = BOOTSTRAP_SH.indexOf("\ncapability_validate_selection\n");
    const guard = BOOTSTRAP_SH.indexOf("refuse_unresolved_previous_enrollment", BOOTSTRAP_SH.indexOf("checkpoint_identity_converged; then"));
    const baseline = BOOTSTRAP_SH.indexOf("\nbootstrap_transport_baseline\n");
    const claim = BOOTSTRAP_SH.indexOf("\nCLAIM_URL=");
    const join = BOOTSTRAP_SH.indexOf('if [ "$TAILSCALE_STATE" != COMPLIANT ]; then');
    const apply = BOOTSTRAP_SH.indexOf("\ncapability_apply\n");
    const complete = BOOTSTRAP_SH.indexOf("/v1/enroll/complete");
    assert.ok(preflight > 0 && validate > preflight, "selection validation follows read-only Phase 0");
    assert.ok(validate < guard && validate < baseline, "a malformed selection stops before any effect");
    assert.ok(apply > join && apply > claim, "the capability installs after the identity/join fence");
    assert.ok(apply < complete, "the capability installs before completion is reported");
    assert.match(BOOTSTRAP_SH, /capability_selected; then\n  printf/);
    assert.match(BOOTSTRAP_SH, /no completion is reported/);
  });
});
