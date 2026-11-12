import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile, mkdir, symlink, readlink } from "node:fs/promises";
import { join } from "node:path";
import { encodeCapabilitySelection } from "../src/index.js";
import {
  makeHost, freshCheckpoint, buildSelection, runCourier, calls, installerLog, exists, setClaim,
  linuxOnly, OPERATING_USER, sha256, readFixture, readJson, snapshot, resetProviderIdentity, NODE_UID, NODE_ID,
  CONTROL_ACCOUNT, PRIVILEGED_ACCOUNT, UNIT_PATH, WANT_PATH, LINGER, RUN_HOME,
  accountExists, seedAccount, startingWith, prettyRecord, seedRecordedV1Lane, laneState,
  assertLaneUnchanged, assertNoLane,
} from "./support/capability-fixture.js";

const HELPER_ONLY = { linger_required: false, user_service_required: false, user_unit: null };

async function systemPathWithout(host, command) {
  const farm = join(host.root, "farm");
  await mkdir(farm, { recursive: true });
  const script = [
    "for d in /usr/bin /bin /usr/sbin /sbin; do",
    '  for entry in "$d"/*; do ln -sf "$entry" ' + farm + "/ 2>/dev/null || true; done",
    "done",
    'rm -f "' + farm + "/" + command + '"',
  ].join("\n");
  const built = spawnSync("bash", ["-c", script]);
  if (built.status !== 0) throw new Error("could not build the PATH fixture: " + String(built.stderr));
  // The fixture bin comes first on PATH, so its stub has to go too.
  await rm(join(host.bin, command), { force: true });
  return farm;
}
import { spawnSync } from "node:child_process";

// The durable half of the lane: a reviewed record, zero delta, legacy
// checkpoints and reconcile-only convergence. Kept separate from the first-run
// ceremony so each file stays well inside the package's per-test timeout.
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
    await rm(join(host.fixtureState, "linger"), { recursive: true, force: true });

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

test("a converged node stops reporting zero delta when the run account gains sudo", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);

    // The account gains a sudo grant after the ceremony. That is drift against
    // the boundary, so the node must not answer "already converged".
    await mkdir(join(host.fixtureState, "sudo-grant"), { recursive: true });
    await writeFile(join(host.fixtureState, "sudo-grant", CONTROL_ACCOUNT), "granted\n");
    const second = await runCourier(host, selection);
    assert.notEqual(second.status, 0);
    assert.doesNotMatch(second.stderr, /already converged/);
    assert.match(second.stderr, /has a sudo grant/);
    assert.ok(await accountExists(host, CONTROL_ACCOUNT), "the adopted account is left in place");
    assert.equal(startingWith(await calls(host), "userdel ").length, 0);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a v1 lane this node recorded is decommissioned before the v2 selection is applied", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);

    // Rewrite the recorded selection exactly as a v1 node would have written it:
    // the unit owner was the privileged account.
    const text = Buffer.from(encodeCapabilitySelection(selection), "base64").toString("utf8");
    const v1 = text
      .replace("schema=ghostfleet-selected-capability/v2", "schema=ghostfleet-selected-capability/v1")
      .split("\n")
      .filter((line) => !line.startsWith("privileged_account="))
      .map((line) => (line.startsWith("control_account=") ? "control_account=" + PRIVILEGED_ACCOUNT : line))
      .join("\n");
    await writeFile(join(host.checkpoint, "capability-selection.txt"), Buffer.from(v1).toString("base64") + "\n");

    const privilegedHome = await seedAccount(host, PRIVILEGED_ACCOUNT);
    const staleUnit = join(privilegedHome, ".config/systemd/user/ghostfleet-managed.service");
    const staleWant = join(privilegedHome, ".config/systemd/user/default.target.wants/ghostfleet-managed.service");
    await mkdir(join(privilegedHome, ".config/systemd/user/default.target.wants"), { recursive: true });
    await writeFile(staleUnit, await readFixture("ghostfleet-managed.service"));
    await symlink("../ghostfleet-managed.service", staleWant);
    await mkdir(join(host.fixtureState, "linger"), { recursive: true });
    await writeFile(join(host.fixtureState, "linger", PRIVILEGED_ACCOUNT), "yes\n");

    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /CAPABILITY_STALE_PRIVILEGED_LANE/);
    assert.match(second.stderr, /decommissioned the v1 managed lane/);
    assert.ok((await calls(host)).includes("loginctl-disable-linger " + PRIVILEGED_ACCOUNT));
    assert.equal(await exists(staleUnit), false, "the recorded v1 unit is removed");
    assert.equal(await exists(staleWant), false, "the recorded v1 enablement link is removed");
    assert.equal(await exists(join(host.fixtureState, "linger", PRIVILEGED_ACCOUNT)), false, "the recorded v1 Linger is removed");
    // The v2 lane was not reapplied on top of the residue.
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 1);
    // The record goes with the lane: leaving a v1 record behind would block the
    // next authorized claim before it could deliver the v2 selection.
    assert.equal(await exists(join(host.checkpoint, "capability-selection.txt")), false,
      "the recorded v1 selection is removed with the lane it describes");

    // Drift the lane, then prove a claim-only run still reaches the claim.
    await rm(UNIT_PATH(host), { force: true });
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const claimsBefore = (await calls(host)).filter((line) => line === "curl claim").length;
    const third = await runCourier(host, null);
    assert.equal(third.status, 0, third.stderr);
    assert.doesNotMatch(third.stderr, /CAPABILITY_SCHEMA_V1_UNPROVEN|CAPABILITY_STALE_PRIVILEGED_LANE/);
    assert.equal((await calls(host)).filter((line) => line === "curl claim").length, claimsBefore + 1,
      "the removed v1 record no longer blocks the claim");
    assert.ok(await exists(UNIT_PATH(host)), "the claim-installed v2 lane is present again");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a recorded lane whose unit bytes are not the reviewed artifact is not deleted", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);

    // A v1 record claims the lane, but the file at that path is something else.
    const text = Buffer.from(encodeCapabilitySelection(selection), "base64").toString("utf8");
    const v1 = text
      .replace("schema=ghostfleet-selected-capability/v2", "schema=ghostfleet-selected-capability/v1")
      .split("\n")
      .filter((line) => !line.startsWith("privileged_account="))
      .map((line) => (line.startsWith("control_account=") ? "control_account=" + PRIVILEGED_ACCOUNT : line))
      .join("\n");
    await writeFile(join(host.checkpoint, "capability-selection.txt"), Buffer.from(v1).toString("base64") + "\n");

    const privilegedHome = await seedAccount(host, PRIVILEGED_ACCOUNT);
    const staleUnit = join(privilegedHome, ".config/systemd/user/ghostfleet-managed.service");
    await mkdir(join(privilegedHome, ".config/systemd/user"), { recursive: true });
    await writeFile(staleUnit, "[Service]\nExecStart=/bin/false\n");

    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /does not hash to the reviewed unit artifact/);
    assert.match(second.stderr, /left in place/);
    assert.ok(await exists(staleUnit), "unreviewed bytes are never deleted");
    assert.equal(await exists(join(host.checkpoint, "capability-selection.txt")), true,
      "the record is kept when the lane could not be decommissioned");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The declared/recorded cross-check must not depend on the account lane, and a
// compliant helper must never "converge" without a readable record.
// ---------------------------------------------------------------------------


test("a helper-only node that reports compliant but records another account is not zero delta", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection(HELPER_ONLY);
    const first = await runCourier(host, selection);
    assert.equal(first.status, 0, first.stderr);
    // The installer now records a different ops account than the one declared.
    await writeFile(host.installerState, prettyRecord("ghostfleet-ops-alt"));
    const second = await runCourier(host, selection);
    assert.notEqual(second.status, 0);
    assert.doesNotMatch(second.stderr, /already converged/);
    assert.match(second.stderr, /CAPABILITY_PRIVILEGED_ACCOUNT_MISMATCH/);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a compliant helper with no readable record is refused on the zero-delta path", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    const first = await runCourier(host, selection);
    assert.equal(first.status, 0, first.stderr);
    // The helper still reports COMPLIANT (its --check never reads control.json),
    // but the record the declaration is compared against is gone.
    await rm(host.installerState, { force: true });
    const second = await runCourier(host, selection);
    assert.notEqual(second.status, 0);
    assert.doesNotMatch(second.stderr, /already converged/);
    assert.match(second.stderr, /CAPABILITY_PRIVILEGED_ACCOUNT_UNVERIFIED/);
    assert.match(second.stderr, /is missing/);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("the installer record is parsed, not pattern-matched", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);
    // A reformatted record that names another account is still a mismatch.
    await writeFile(host.installerState, prettyRecord("ghostfleet-ops-alt"));
    const mismatched = await runCourier(host, selection);
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /CAPABILITY_PRIVILEGED_ACCOUNT_MISMATCH/);
    // A reformatted record with the right account is accepted.
    await writeFile(host.installerState, prettyRecord(PRIVILEGED_ACCOUNT));
    const accepted = await runCourier(host, selection);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stderr, /already converged/);
    // A record that exists but carries no ops_user is unverified, not accepted.
    await writeFile(host.installerState, JSON.stringify({ schema: "x", ordinary_user: OPERATING_USER }) + "\n");
    const unreadable = await runCourier(host, selection);
    assert.notEqual(unreadable.status, 0);
    assert.match(unreadable.stderr, /CAPABILITY_PRIVILEGED_ACCOUNT_UNVERIFIED/);
    assert.match(unreadable.stderr, /records no readable ops_user/);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a stale v1 record with no lane left is removed so the next claim is not blocked", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);

    // A v1 record whose lane was already cleaned up by hand: nothing left to
    // delete, but the record alone would stop the next claim at the schema gate.
    const text = Buffer.from(encodeCapabilitySelection(selection), "base64").toString("utf8");
    const v1 = text
      .replace("schema=ghostfleet-selected-capability/v2", "schema=ghostfleet-selected-capability/v1")
      .split("\n")
      .filter((line) => !line.startsWith("privileged_account="))
      .map((line) => (line.startsWith("control_account=") ? "control_account=" + PRIVILEGED_ACCOUNT : line))
      .join("\n");
    await writeFile(join(host.checkpoint, "capability-selection.txt"), Buffer.from(v1).toString("base64") + "\n");

    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /CAPABILITY_STALE_PRIVILEGED_LANE/);
    assert.match(second.stderr, /removed the recorded v1 selection/);
    assert.equal(await exists(join(host.checkpoint, "capability-selection.txt")), false,
      "the stale record is removed with the lane it described");

    // The next authorized claim is no longer blocked by the record.
    await rm(UNIT_PATH(host), { force: true });
    await setClaim(host, { capability_required: true, capability_selection: encodeCapabilitySelection(selection) });
    const third = await runCourier(host, null);
    assert.equal(third.status, 0, third.stderr);
    assert.doesNotMatch(third.stderr, /CAPABILITY_SCHEMA_V1_UNPROVEN/);
    assert.ok(await exists(UNIT_PATH(host)), "the claim-installed lane is present");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// NSS answers are never guessed, and a v1 lane is only deleted once its service
// is proved stopped.
// ---------------------------------------------------------------------------

test("a v1 lane whose service will not stop is not removed", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);
    const lane = await seedRecordedV1Lane(host, selection, {
      unitState: "active", stopIneffective: true,
    });
    const before = await laneState(host, lane);
    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /CAPABILITY_STALE_PRIVILEGED_LANE/);
    assert.match(second.stderr, /still running and could not be proved stopped/);
    assert.match(second.stderr, /still reports 'active'/);
    // Nothing was removed and the record survives, so the operator can retry.
    assertLaneUnchanged(await laneState(host, lane), before, "stop not proved");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a v1 lane whose stop command fails is not removed", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);
    const lane = await seedRecordedV1Lane(host, selection, { unitState: "active", stopFails: true });
    const before = await laneState(host, lane);
    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /could not be proved stopped/);
    assert.match(second.stderr, /stop it yourself: sudo -iu ghostfleet-ops systemctl --user stop/i);
    assertLaneUnchanged(await laneState(host, lane), before, "refused");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a v1 lane that is proved stopped is removed with its record", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);
    const lane = await seedRecordedV1Lane(host, selection, { unitState: "active" });
    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /decommissioned the v1 managed lane/);
    assert.ok((await calls(host)).some((line) => line.startsWith("sudo -iu " + PRIVILEGED_ACCOUNT + " systemctl --user stop")),
      "the unit was stopped in the privileged account's session");
    assert.equal(await exists(lane.unitPath), false, "the stopped unit is removed");
    assert.equal(await exists(lane.wantPath), false);
    assert.equal(await exists(join(host.fixtureState, "linger", PRIVILEGED_ACCOUNT)), false);
    assert.equal(await exists(join(host.checkpoint, "capability-selection.txt")), false);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});


test("a pgrep query failure blocks deletion", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);
    const lane = await seedRecordedV1Lane(host, selection, { pgrepFails: true });
    const before = await laneState(host, lane);
    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0, "pgrep exit 3 is a failed query, not an empty process set");
    assert.match(second.stderr, /could not be proved stopped/);
    assert.match(second.stderr, /pgrep could not answer/);
    assertLaneUnchanged(await laneState(host, lane), before, "refused");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a missing pgrep blocks deletion", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    assert.equal((await runCourier(host, selection)).status, 0);
    const lane = await seedRecordedV1Lane(host, selection);
    const before = await laneState(host, lane);
    const systemPath = await systemPathWithout(host, "pgrep");
    const second = await runCourier(host, null, { systemPath });
    assert.notEqual(second.status, 0, "without pgrep the absence of a process cannot be proved");
    assert.match(second.stderr, /could not be proved stopped/);
    assert.match(second.stderr, /pgrep is not installed, so the absence of the unit's processes cannot be proved/);
    assert.match(second.stderr, /nothing is removed and the unit is left running as it was/);
    assertLaneUnchanged(await laneState(host, lane), before, "refused");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a unit whose ExecStart is not an absolute binary blocks deletion", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const relativeUnit = "[Service]\nExecStart=sleep 300\n";
    const selection = await buildSelection({ unitContent: relativeUnit });
    assert.equal((await runCourier(host, selection)).status, 0);
    const lane = await seedRecordedV1Lane(host, selection, { unitContent: relativeUnit });
    const before = await laneState(host, lane);
    const second = await runCourier(host, null);
    assert.notEqual(second.status, 0, "a relative ExecStart cannot be attributed to a process set");
    assert.match(second.stderr, /could not be proved stopped/);
    assert.match(second.stderr, /does not name an absolute executable/);
    assert.match(second.stderr, /nothing is removed and the unit is left running as it was/);
    assert.equal((await calls(host)).some((line) => line.includes("systemctl --user stop")), false,
      "the refusal happens before the only side effect");
    assertLaneUnchanged(await laneState(host, lane), before, "refused");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});
