import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink, readlink } from "node:fs/promises";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  renderBootstrap, encodeCapabilitySelection, capabilitySelectionDigest, normalizeSelectedCapability,
} from "../../src/index.js";

export const linuxOnly = process.platform !== "linux";
// A real ordinary account: the courier resolves and validates this identity.
// A root test runner (the disposable jobs) supplies an ordinary account.
export const OPERATING_USER = process.getuid?.() === 0
  ? (process.env.GHOSTFLEET_TEST_ORDINARY_USER || "ghostfleet-test")
  : userInfo().username;
export const here = dirname(fileURLToPath(import.meta.url));
export const fixtureDir = join(here, "..", "fixtures");
// The fixture hands pinned-artifact downloads to the real curl binary against a
// real loopback content-addressed server. Everything else stays stubbed.
export const REAL_CURL = ["/usr/bin/curl", "/bin/curl", "/usr/local/bin/curl"].find((path) => existsSync(path));
export const NODE_ID = "fleet-node-fixture";
export const NODE_UID = "node-00000000-0000-4000-8000-000000000001";
export const STUB_COMMANDS = [
  "id", "uname", "dpkg-query", "systemctl", "apt-get", "curl", "ssh-keygen",
  "install", "chown", "getent", "loginctl", "useradd", "userdel", "usermod", "passwd",
  "visudo", "sudo", "python3", "pgrep", "stat", "mv",
];

// The release asset and the synthetic fixture copy both carry the production
// payload path. The harness relocates that prefix into the host root so a
// non-root runner can exercise the same install lane byte for byte.
export const AGENT_PAYLOAD_LITERAL = "/usr/local/libexec/ghostfleet/node-agent.pyz";
export const AGENT_PAYLOAD_ARTIFACT = "node-agent.pyz";
export const AGENT_UNIT_NAME = "ghostfleet-managed.service";
export const AGENT_CONFIG_LITERAL = "/etc/ghostfleet";

export function sha256(value) {
  // Accept both reviewed text fixtures and raw bytes (the pinned payload is a
  // zipapp, so an integration checkout carries binary content).
  if (typeof value === "string") return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

export async function readFixture(name) {
  return readFile(join(fixtureDir, name), "utf8");
}

// Anti-impersonation: the fixture payload under test/fixtures is synthetic and
// must never be presented as the product agent. When a real rebuilt artifact is
// present in this checkout the selection automatically pins those bytes instead,
// so the same tests exercise the frozen payload without a code change.
export const REAL_AGENT_PAYLOAD_PATH = join(here, "..", "..", "..", "node-agent", "dist", "node-agent.pyz");
export async function agentPayload() {
  try {
    return await readFile(REAL_AGENT_PAYLOAD_PATH);
  } catch {
    return await readFixture(AGENT_PAYLOAD_ARTIFACT);
  }
}

// The dedicated run identity the courier owns and the privileged operations
// identity the reviewed installer owns. Different accounts, different rights.
export const CONTROL_ACCOUNT = "ghostfleet-managed";
export const PRIVILEGED_ACCOUNT = "ghostfleet-ops";
export const RUN_HOME = (host) => join(host.homeRoot, CONTROL_ACCOUNT);
export const UNIT_PATH = (host) => join(RUN_HOME(host), ".config/systemd/user/ghostfleet-managed.service");
export const WANT_PATH = (host) => join(RUN_HOME(host), ".config/systemd/user/default.target.wants/ghostfleet-managed.service");
export const LINGER = (host, name = CONTROL_ACCOUNT) => join(host.fixtureState, "linger", name);
export const PAYLOAD_DIR = (host) => join(host.root, "libexec", "ghostfleet");
export const PAYLOAD_PATH = (host) => join(PAYLOAD_DIR(host), AGENT_PAYLOAD_ARTIFACT);
export const ETC_GHOSTFLEET = (host) => join(host.root, "etc-ghostfleet");
export const AGENT_CONFIG_PATH = (host) => join(ETC_GHOSTFLEET(host), "node-agent.json");
export const AGENT_CONFIG_HOME = (host) => join(RUN_HOME(host), ".config", "ghostfleet");
export const NODE_TOKEN_PATH = (host) => join(AGENT_CONFIG_HOME(host), "node-token");
export const NODE_JSON_PATH = (host) => join(AGENT_CONFIG_HOME(host), "node.json");
export const AGENT_STATE_HOME = (host) => join(RUN_HOME(host), ".local", "state", "ghostfleet-agent");
export const OWNER_MARKERS = (host) => join(host.fixtureState, "stat-owner.tsv");

/** Model the root:root ownership of a path the fixture never really chowns. */
export async function seedOwner(host, path, owner = "root:root") {
  await writeFile(OWNER_MARKERS(host), path + "|" + owner + "\n", { flag: "a" });
}

/** Model an account the host already had: no real account is ever created. */
export async function seedAccount(host, name, {
  groups = [name], sudo = false, home = null, shell = "/usr/sbin/nologin", uid = 1234, unlocked = false,
  noGroup = false,
} = {}) {
  const accountHome = home ?? join(host.homeRoot, name);
  await mkdir(accountHome, { recursive: true });
  for (const directory of ["accounts", "groups", "sudo-grant", "uids", "unlocked", "no-group"]) {
    await mkdir(join(host.fixtureState, directory), { recursive: true });
  }
  await writeFile(join(host.fixtureState, "accounts", name), accountHome + "|" + shell + "\n");
  await writeFile(join(host.fixtureState, "groups", name), groups.join(" ") + "\n");
  await writeFile(join(host.fixtureState, "uids", name), String(uid) + "\n");
  if (sudo) await writeFile(join(host.fixtureState, "sudo-grant", name), "granted\n");
  if (unlocked) await writeFile(join(host.fixtureState, "unlocked", name), "yes\n");
  if (noGroup) await writeFile(join(host.fixtureState, "no-group", name), "yes\n");
  return accountHome;
}

export async function accountExists(host, name) {
  return exists(join(host.fixtureState, "accounts", name));
}

export function startingWith(journal, prefix) {
  return journal.filter((line) => line.startsWith(prefix));
}

export async function seedRecordedV1Lane(host, selection, {
  unitState = "inactive", stopIneffective = false, stopFails = false, processes = null,
  pgrepFails = false, unitContent = null,
} = {}) {
  const text = Buffer.from(encodeCapabilitySelection(selection), "base64").toString("utf8");
  const unitRow = selection.artifacts.find((artifact) => artifact.name === selection.user_unit.artifact);
  // The v1 lane must hold the bytes the v1 record reviewed, otherwise the
  // decommission path refuses on a digest mismatch instead of exercising the
  // stop/prove evidence. `unitContent` is for the cases whose reviewed unit is
  // itself unsafe: the record is then rewritten to pin those bytes.
  const laneUnit = unitContent ?? unitRow.content ?? (await readFixture("ghostfleet-managed.service"));
  const laneDigest = sha256(laneUnit).slice("sha256:".length);
  const v1 = text
    .replace("schema=ghostfleet-selected-capability/v2", "schema=ghostfleet-selected-capability/v1")
    .split("\n")
    .filter((line) => !line.startsWith("privileged_account="))
    .map((line) => (line.startsWith("control_account=") ? "control_account=" + PRIVILEGED_ACCOUNT : line))
    .map((line) => {
      if (!line.startsWith("artifact=")) return line;
      const parts = line.slice("artifact=".length).split("|");
      return parts[0] === selection.user_unit.artifact ? "artifact=" + parts[0] + "|" + laneDigest + "|" + parts[2] : line;
    })
    .join("\n");
  await writeFile(join(host.checkpoint, "capability-selection.txt"), Buffer.from(v1).toString("base64") + "\n");
  const privilegedHome = await seedAccount(host, PRIVILEGED_ACCOUNT);
  const unitPath = join(privilegedHome, ".config/systemd/user/ghostfleet-managed.service");
  const wantPath = join(privilegedHome, ".config/systemd/user/default.target.wants/ghostfleet-managed.service");
  await mkdir(join(privilegedHome, ".config/systemd/user/default.target.wants"), { recursive: true });
  await writeFile(unitPath, laneUnit);
  await symlink("../ghostfleet-managed.service", wantPath);
  await mkdir(join(host.fixtureState, "linger"), { recursive: true });
  await writeFile(join(host.fixtureState, "linger", PRIVILEGED_ACCOUNT), "yes\n");
  await mkdir(join(host.fixtureState, "unit-state"), { recursive: true });
  await writeFile(join(host.fixtureState, "unit-state", "ghostfleet-managed.service"), unitState + "\n");
  if (stopIneffective) await writeFile(join(host.fixtureState, "stop-ineffective"), "yes\n");
  if (stopFails) await writeFile(join(host.fixtureState, "stop-fails"), "yes\n");
  if (processes) await writeFile(join(host.fixtureState, "unit-procs"), processes);
  if (pgrepFails) await writeFile(join(host.fixtureState, "pgrep-fails"), "yes\n");
  return { unitPath, wantPath };
}

export function prettyRecord(opsUser) {
  return JSON.stringify({ schema: "youling-fleet-privileged-operations-local/v2", ordinary_user: OPERATING_USER, ops_user: opsUser }, null, 2) + "\n";
}

export async function laneState(host, lane) {
  const unit = await readFile(lane.unitPath);
  const wantTarget = await readlink(lane.wantPath);
  const linger = await exists(join(host.fixtureState, "linger", PRIVILEGED_ACCOUNT));
  const record = await readFile(join(host.checkpoint, "capability-selection.txt"));
  return { unit, wantTarget, linger, record };
}

export function assertLaneUnchanged(actual, expected, label) {
  assert.deepEqual(actual.unit, expected.unit, label + ": the unit file is unchanged");
  assert.equal(actual.wantTarget, expected.wantTarget, label + ": the enablement link target is unchanged");
  assert.equal(actual.linger, true, label + ": Linger is still enabled");
  assert.equal(expected.linger, true, label + ": Linger was enabled before the run");
  assert.deepEqual(actual.record, expected.record, label + ": the provenance record is unchanged");
}

export async function assertNoLane(host, label) {
  assert.equal(await exists(UNIT_PATH(host)), false, label + ": no unit");
  assert.equal(await exists(WANT_PATH(host)), false, label + ": no enablement link");
  assert.equal(await exists(LINGER(host)), false, label + ": no Linger");
  assert.equal(await exists(join(host.checkpoint, "capability-selection.txt")), false, label + ": no record");
}

// A refusal deletes nothing: the unit, its enablement link, Linger and the
// provenance record must be byte-for-byte what they were before the run.
export async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), "ghostfleet-capability-"));
  const host = {
    root,
    bin: join(root, "bin"),
    fixtureState: join(root, "fixture-state"),
    checkpoint: join(root, "checkpoint"),
    run: join(root, "run"),
    installerState: join(root, "fixture-state", "control.json"),
    homeRoot: join(root, "homes"),
    accountHome: join(root, "homes", CONTROL_ACCOUNT),
    tty: join(root, "dev-tty"),
    ttyOut: join(root, "dev-tty-out"),
    osRelease: join(root, "os-release"),
    systemdDir: join(root, "systemd"),
    keyrings: join(root, "usr-share-keyrings"),
    aptSources: join(root, "etc-apt-sources"),
    sshDir: join(root, "etc-ssh"),
    tailscaleStateMarker: join(root, "tailscale.state.marker"),
    lock: join(root, "fresh-checkpoint"),
    payloadDir: join(root, "libexec", "ghostfleet"),
    payloadPath: join(root, "libexec", "ghostfleet", AGENT_PAYLOAD_ARTIFACT),
    etcGhostfleet: join(root, "etc-ghostfleet"),
  };
  await mkdir(host.bin);
  await mkdir(host.fixtureState);
  await mkdir(host.homeRoot);
  await mkdir(host.accountHome, { recursive: true });
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
  // The operating Human is modelled like every other account, so no test ever
  // depends on the host's name service.
  await seedAccount(host, OPERATING_USER, { uid: 2500, shell: "/bin/bash" });
  const dispatcher = await readFixture("fixture-tools.sh");
  for (const command of STUB_COMMANDS) {
    await writeFile(join(host.bin, command), dispatcher, { mode: 0o755 });
  }
  // A real loopback content-addressed origin. Only the pinned artifacts are
  // reachable, by digest, and a test can make it redirect or answer 404.
  const assets = new Map();
  const requests = [];
  let assetMode = "ok";
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://loopback.invalid").pathname;
    requests.push(path);
    const match = /^\/sha256\/([0-9a-f]{64})$/.exec(path);
    if (!match || !assets.has(match[1])) { response.writeHead(404); response.end(); return; }
    if (assetMode === "redirect") { response.writeHead(302, { location: "/sha256/" + match[1] }); response.end(); return; }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(assets.get(match[1]));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  // A test may create several hosts; an unref'd listener never blocks exit.
  server.unref();
  host.assetsUrl = "http://127.0.0.1:" + server.address().port;
  host.serveAsset = (digest, content) => { assets.set(digest, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")); };
  host.removeAsset = (digest) => { assets.delete(digest); };
  // The install lane proves ownership of the payload directory and of the
  // installed payload, so the fixture models root:root for exactly those paths.
  await seedOwner(host, host.payloadDir);
  await seedOwner(host, host.payloadPath);
  // A host-scoped selection pins this host's payload prefix: the unit bytes and
  // the payload path agree, and the relayed script rewrites the same prefix.
  host.buildSelection = (overrides = {}) => buildSelection({ payloadPath: host.payloadPath, ...overrides });
  // The installed unit must be byte-identical to the pinned unit artifact of
  // this host's selection (the payload prefix is host-scoped).
  host.unitText = async (overrides = {}) => {
    const selection = await host.buildSelection(overrides);
    return selection.artifacts.find((artifact) => artifact.name === selection.user_unit.artifact).content;
  };
  // The reviewed fixture selection is published up front: a claim delivers its
  // digests, and the deployment publishes those exact bytes. Tests that tamper
  // with the selection re-publish through runCourier.
  for (const artifact of normalizeSelectedCapability(await host.buildSelection()).artifacts) {
    host.serveAsset(artifact.sha256, artifact.content);
  }
  host.assetRequests = () => [...requests];
  host.setAssetMode = (mode) => { assetMode = mode; };
  host.env = {
    FIXTURE_STATE: host.fixtureState,
    FIXTURE_BIN: host.bin,
    FIXTURE_NODE_ID: NODE_ID,
    FIXTURE_HOME_ROOT: host.homeRoot,
    FIXTURE_AUTHKEY: join(host.run, "ts-authkey"),
    FIXTURE_PAYLOAD_PATH: host.payloadPath,
    FIXTURE_REAL_CURL: REAL_CURL,
    GHOSTFLEET_OPERATING_USER: OPERATING_USER,
    GHOSTFLEET_ASSETS_ORIGIN: host.assetsUrl,
  };
  return host;
}

// A new enrollment attempt starts from a machine with no provider identity but
// the same, possibly already-installed, selected capability lane.
export async function resetProviderIdentity(host) {
  await rm(join(host.fixtureState, "tailscale.joined"), { force: true });
  await rm(join(host.bin, "tailscale"), { force: true });
}

// The claim is the server-authoritative channel for the selection.
export async function setClaim(host, overrides = {}) {
  await writeFile(join(host.fixtureState, "claim.json"), JSON.stringify({
    resume_session: "fixture-resume-session-0123456789abcdef",
    auth_key: "fixture-one-off-auth-key",
    identity_kind: "canonical",
    node_id: NODE_ID,
    node_uid: NODE_UID,
    ...overrides,
  }));
}

export async function freshCheckpoint(host) {
  await rm(host.checkpoint, { recursive: true, force: true });
  await mkdir(host.checkpoint, { mode: 0o700 });
}

export async function buildSelection(overrides = {}) {
  const {
    unitContent = null,
    unitName = AGENT_UNIT_NAME,
    payloadPath = AGENT_PAYLOAD_LITERAL,
    payloadMode = "0755",
    ...rest
  } = overrides;
  const [installer, key, helper, defaultUnit, payload] = await Promise.all([
    readFixture("capability-installer.sh"),
    readFixture("privileged-ops.pub"),
    readFixture("fleet-privctl.py"),
    readFixture("ghostfleet-node-agent.service"),
    agentPayload(),
  ]);
  // The unit pins the payload path, so a host that relocates the prefix must
  // pin a unit whose bytes carry the very same path.
  const unit = unitContent ?? defaultUnit.split(AGENT_PAYLOAD_LITERAL).join(payloadPath);
  const selection = {
    source: "template",
    template_digest: sha256("fixture-template"),
    version: "managed-linux-privileged-operations/2026.11",
    helper_required: true,
    linger_required: true,
    user_service_required: true,
    control_account: CONTROL_ACCOUNT,
    privileged_account: PRIVILEGED_ACCOUNT,
    installer: "managed-linux-privileged-operations.sh",
    privileged_key: "privileged-ops.pub",
    user_unit: {
      name: unitName,
      artifact: unitName,
      payload_artifact: AGENT_PAYLOAD_ARTIFACT,
      payload_path: payloadPath,
      payload_mode: payloadMode,
    },
    artifacts: [
      { name: "fleet-privctl.py", mode: "0755", content: helper },
      { name: "privileged-ops.pub", mode: "0644", content: key },
      { name: unitName, mode: "0644", content: unit },
      { name: "managed-linux-privileged-operations.sh", mode: "0750", content: installer },
      { name: AGENT_PAYLOAD_ARTIFACT, mode: payloadMode, content: payload },
    ],
    ...rest,
  };
  return selection;
}

export async function runCourier(host, selection, options = {}) {
  // The content-addressed origin serves exactly the reviewed bytes. A test can
  // replace one object after it was published to prove the digest gate.
  if (host.setAssetMode) host.setAssetMode("ok");
  if (selection) {
    const normalized = normalizeSelectedCapability(selection);
    for (const artifact of normalized.artifacts) host.serveAsset(artifact.sha256, artifact.content);
    if (options.assetTamper) options.assetTamper(host, normalized);
  }
  let script = renderBootstrap({
    brokerOrigin: "https://broker.fixture.invalid",
    checkpointDir: host.checkpoint,
    capabilitySelection: selection,
  });
  const replace = (needle, value) => { script = script.replace(needle, () => value); };
  const systemPath = options.systemPath ?? "/usr/sbin:/usr/bin:/sbin:/bin";
  replace('PATH="/usr/sbin:/usr/bin:/sbin:/bin"', 'PATH="' + host.bin + ":" + systemPath + '"');
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
  script = script.replaceAll("/etc/youling-fleet/privileged-operations/control.json", () => host.installerState);
  script = script.replaceAll(AGENT_PAYLOAD_LITERAL, () => host.payloadPath);
  script = script.replaceAll(AGENT_CONFIG_LITERAL, () => host.etcGhostfleet);
  script = script.split("/usr/local/libexec/ghostfleet").join(host.payloadDir);
  if (options.tamper) script = options.tamper(script);
  const file = join(host.root, "courier.sh");
  await writeFile(file, script);
  // The content-addressed origin is served by THIS process, so the courier must
  // run asynchronously: a synchronous child would block the server that is
  // supposed to answer its artifact fetches.
  const child = spawn("/bin/sh", [file], {
    env: { ...process.env, ...host.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  timer.unref?.();
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(timer);
  return { status, stdout, stderr };
}

export async function calls(host) {
  try { return (await readFile(join(host.fixtureState, "calls.log"), "utf8")).trim().split("\n"); }
  catch { return []; }
}
export async function installerLog(host) {
  try { return (await readFile(join(host.fixtureState, "installer.log"), "utf8")).trim().split("\n"); }
  catch { return []; }
}
export async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
export async function exists(path) { try { await stat(path); return true; } catch { return false; } }
export async function snapshot(paths) {
  const result = [];
  for (const path of paths) {
    const info = await stat(path);
    result.push({ path, body: await readFile(path, "utf8"), mtime: info.mtimeMs, mode: info.mode });
  }
  return result;
}

