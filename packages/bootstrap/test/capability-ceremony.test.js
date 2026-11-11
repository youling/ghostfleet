import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  renderBootstrap, encodeCapabilitySelection, capabilitySelectionDigest, normalizeSelectedCapability,
} from "../src/index.js";
import {
  makeHost, freshCheckpoint, buildSelection, runCourier, calls, installerLog, exists, setClaim,
  linuxOnly, OPERATING_USER, sha256, readFixture, readJson, snapshot, resetProviderIdentity,
  CONTROL_ACCOUNT, PRIVILEGED_ACCOUNT, UNIT_PATH, WANT_PATH, LINGER, RUN_HOME,
  accountExists, seedAccount, startingWith, prettyRecord, laneState, assertLaneUnchanged, assertNoLane,
} from "./support/capability-fixture.js";

const HELPER_ONLY = { linger_required: false, user_service_required: false, user_unit: null };

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
    // Artifact re-verification is NOT an effect: it re-fetches every pinned
    // digest from the immutable origin. Claims, joins, service mutations and
    // installs are the effects that must not repeat.
    const effects = (journal) => journal.filter((line) => !line.startsWith("curl-"));
    const effectsBefore = effects(await calls(host));
    const appliesBefore = (await installerLog(host)).filter((line) => line.includes("--apply")).length;

    const second = await runCourier(host, selection);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /already converged/);
    assert.deepEqual(await snapshot(watched), before, "a converged host must not be rewritten");
    assert.deepEqual(effects(await calls(host)), effectsBefore, "no claim, join or Linger call on the zero-delta path");
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
    await rm(join(host.fixtureState, "linger"), { recursive: true, force: true });
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
      { name: "unpinned artifact row", selection: Buffer.from("schema=ghostfleet-selected-capability/v1\nversion=v1\ntemplate_digest=sha256:" + "0".repeat(64) + "\nhelper_required=1\nartifact=evil\n").toString("base64"), expected: /artifact row must be name\|sha256\|mode/ },
      { name: "inline artifact bytes", selection: Buffer.from("schema=ghostfleet-selected-capability/v1\nversion=v1\ntemplate_digest=sha256:" + "0".repeat(64) + "\nhelper_required=1\nlinger_required=1\nuser_service_required=1\ncontrol_account=ghostfleet-ops\ninstaller=a.sh\nprivileged_key=a.pub\nuser_unit=u.service\nuser_unit_artifact=u.service\nartifact=a.sh|" + "0".repeat(64) + "|0750|" + Buffer.from("#!/bin/sh").toString("base64") + "\n").toString("base64"), expected: /inline artifact content is refused/ },
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

test("the managed run account may never be the privileged operations account", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    // The deployment-rendered channel: a colliding selection must stop before
    // any effect at all, so the journal is empty.
    const tampered = await runCourier(host, selection, {
      tamper: (script) => script.replace(
        "CAPABILITY_PRIVILEGED_ACCOUNT='" + PRIVILEGED_ACCOUNT + "'",
        () => "CAPABILITY_PRIVILEGED_ACCOUNT='" + CONTROL_ACCOUNT + "'",
      ),
    });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /\[CAPABILITY_ACCOUNT_COLLISION\]/);
    assert.match(tampered.stderr, /must not be the privileged operations account/);
    assert.match(tampered.stderr, /NOPASSWD fleet-privctl/);
    assert.deepEqual(await calls(host), [], "no claim, package, account or service effect");
    assert.deepEqual(await installerLog(host), [], "the installer never ran");
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal(await accountExists(host, CONTROL_ACCOUNT), false);

    // The claim channel arrives later, so the claim happens; the installer, the
    // account and the unit still never do.
    const text = Buffer.from(encodeCapabilitySelection(selection), "base64").toString("utf8");
    const colliding = text.replace(
      "control_account=" + CONTROL_ACCOUNT,
      "control_account=" + PRIVILEGED_ACCOUNT,
    );
    assert.notEqual(colliding, text);
    await freshCheckpoint(host);
    await setClaim(host, { capability_required: true, capability_selection: Buffer.from(colliding).toString("base64") });
    const claimed = await runCourier(host, null);
    assert.notEqual(claimed.status, 0);
    assert.match(claimed.stderr, /\[CAPABILITY_ACCOUNT_COLLISION\]/);
    assert.deepEqual(await installerLog(host), [], "the installer never ran for the colliding claim");
    assert.equal(await accountExists(host, CONTROL_ACCOUNT), false);
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal((await calls(host)).some((line) => line === "tailscale-up"), false, "no identity effect");
    assert.equal(await exists(join(host.checkpoint, "capability-state.json")), false);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("the courier creates the dedicated run account once, inside the same ceremony", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await buildSelection();
    const result = await runCourier(host, selection);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /created the dedicated managed run account ghostfleet-managed/);

    const journal = await calls(host);
    const useradds = startingWith(journal, "useradd ");
    assert.equal(useradds.length, 1, "the account is created exactly once");
    assert.match(useradds[0], /--create-home/);
    assert.match(useradds[0], /--user-group/);
    assert.match(useradds[0], /--shell \/usr\/sbin\/nologin/);
    assert.match(useradds[0], /ghostfleet-managed$/);
    assert.equal(startingWith(journal, "usermod ").length, 0, "no group is added to the run account");
    assert.equal(journal.some((line) => line === "sudo -l -U " + CONTROL_ACCOUNT), false, "the check is read-only");
    assert.ok(await accountExists(host, CONTROL_ACCOUNT));
    assert.equal(await readFile(UNIT_PATH(host), "utf8"), await readFixture("ghostfleet-managed.service"));
    assert.ok(await exists(LINGER(host)));
    assert.ok(journal.includes("loginctl-enable-linger " + CONTROL_ACCOUNT));
    assert.equal(journal.some((line) => line.includes(PRIVILEGED_ACCOUNT) && line.startsWith("loginctl")), false);

    const state = await readJson(join(host.checkpoint, "capability-state.json"));
    assert.equal(state.control_account, CONTROL_ACCOUNT);
    assert.equal(state.control_account_state, "CREATED");
    assert.equal(state.control_account_created_by_courier, true);
    assert.equal(state.privileged_account, PRIVILEGED_ACCOUNT);

    // Idempotency: the same ceremony again creates nothing and rewrites nothing.
    const watched = [UNIT_PATH(host), join(host.checkpoint, "capability-state.json")];
    const before = await snapshot(watched);
    const second = await runCourier(host, selection);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /already converged/);
    assert.equal(startingWith(await calls(host), "useradd ").length, 1, "no second account creation");
    assert.deepEqual(await snapshot(watched), before, "a converged node is not rewritten");
    assert.deepEqual(await readJson(join(host.checkpoint, "capability-state.json")), state,
      "the converged node keeps the provenance it recorded");

    // A repair run adopts the account instead of creating it, and must keep the
    // "created by this product" provenance so the account stays attributable.
    await rm(UNIT_PATH(host), { force: true });
    const repair = await runCourier(host, selection);
    assert.equal(repair.status, 0, repair.stderr);
    assert.equal(startingWith(await calls(host), "useradd ").length, 1, "a repair never recreates the account");
    const repaired = await readJson(join(host.checkpoint, "capability-state.json"));
    assert.equal(repaired.mode, "REPAIR");
    assert.equal(repaired.control_account_state, "EXISTING");
    assert.equal(repaired.control_account_created_by_courier, true,
      "provenance survives the adopting run");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a pre-existing run account with any sudo grant is refused with the concrete risk", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    await seedAccount(host, CONTROL_ACCOUNT, { sudo: true });
    const result = await runCourier(host, await buildSelection());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has a sudo grant/);
    assert.match(result.stderr, /bounded fleet-privctl entry exists to prevent/);
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 0, "the installer never applied");
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal(await exists(LINGER(host)), false);
    assert.ok(await accountExists(host, CONTROL_ACCOUNT), "a pre-existing account is never removed");
    assert.equal(startingWith(await calls(host), "userdel ").length, 0);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a pre-existing run account in a root-equivalent group is refused", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    await seedAccount(host, CONTROL_ACCOUNT, { groups: [CONTROL_ACCOUNT, "docker"] });
    const result = await runCourier(host, await buildSelection());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root-equivalent group docker/);
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 0);
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.ok(await accountExists(host, CONTROL_ACCOUNT));
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("rollback removes only the run account this ceremony created", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    // The run account is created, then the privileged helper fails.
    const failed = await runCourier(host, await buildSelection(), { env: { FAKE_INSTALLER_FAIL: "1" } });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /selected privileged helper apply failed/);
    assert.equal(await accountExists(host, CONTROL_ACCOUNT), false, "the account this run created is gone");
    assert.equal(await exists(RUN_HOME(host)), false, "its home is gone");
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal(await exists(LINGER(host)), false);
    assert.equal(startingWith(await calls(host), "userdel ").length, 1);

    // A different host with the same account already present: a failure must
    // leave that pre-existing account and its home untouched.
    const preexisting = await makeHost();
    try {
      await freshCheckpoint(preexisting);
      const home = await seedAccount(preexisting, CONTROL_ACCOUNT);
      await writeFile(join(home, "pre-existing-marker"), "deployment owned\n");
      const second = await runCourier(preexisting, await buildSelection(), { env: { FAKE_INSTALLER_FAIL: "1" } });
      assert.notEqual(second.status, 0);
      assert.ok(await accountExists(preexisting, CONTROL_ACCOUNT), "a pre-existing account survives");
      assert.equal(await readFile(join(home, "pre-existing-marker"), "utf8"), "deployment owned\n");
      assert.equal(startingWith(await calls(preexisting), "userdel ").length, 0);
    } finally { await rm(preexisting.root, { recursive: true, force: true }); }
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a selection that does not declare the privileged account is refused with an actionable error", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    const selection = await buildSelection();
    const text = Buffer.from(encodeCapabilitySelection(selection), "base64").toString("utf8");
    const withoutField = (value) => Buffer.from(
      value.split("\n").filter((line) => !line.startsWith("privileged_account=")).join("\n"),
    ).toString("base64");
    const cases = [
      {
        name: "v1 selection",
        selection: withoutField(text.replace("schema=ghostfleet-selected-capability/v2", "schema=ghostfleet-selected-capability/v1")),
        expected: /\[CAPABILITY_SCHEMA_V1_UNPROVEN\] selected-capability schema v1 does not declare privileged_account/,
      },
      {
        name: "v2 selection with the field dropped",
        selection: withoutField(text),
        expected: /\[CAPABILITY_PRIVILEGED_ACCOUNT_REQUIRED\] selected-capability declares no privileged_account/,
      },
    ];
    for (const item of cases) {
      await resetProviderIdentity(host);
      await freshCheckpoint(host);
      await setClaim(host, { capability_required: true, capability_selection: item.selection });
      const result = await runCourier(host, null);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.expected, item.name);
      assert.match(result.stderr, /re-render the reviewed/, item.name + ": the error must say what to do");
      assert.deepEqual(await installerLog(host), [], item.name + ": the installer never ran");
      assert.equal(await accountExists(host, CONTROL_ACCOUNT), false, item.name);
      assert.equal(await exists(UNIT_PATH(host)), false, item.name);
    }
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a run account that gains privilege while the installer runs is refused after it", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    // The reviewed installer runs as root and hands the run account a
    // root-equivalent group. The proof taken before the installer must not be
    // the last one.
    const result = await runCourier(host, await buildSelection(), {
      env: { FAKE_INSTALLER_GRANT_ACCOUNT: CONTROL_ACCOUNT },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_RUN_ACCOUNT_PRIVILEGED/);
    assert.match(result.stderr, /root-equivalent group docker/);
    assert.equal(startingWith(await calls(host), "useradd ").length, 1, "the account was created before the installer ran");
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 1, "the installer really ran");
    // Nothing was installed into an account that lost its proof, and the
    // account this run created was rolled back.
    assert.equal(await exists(UNIT_PATH(host)), false, "no unit is installed after the re-proof fails");
    assert.equal(await exists(LINGER(host)), false, "Linger is not enabled after the re-proof fails");
    assert.equal(await accountExists(host, CONTROL_ACCOUNT), false, "the created account is rolled back");
    assert.equal(await exists(join(host.fixtureState, "complete-body.json")), false, "no completion is reported");
    assert.equal(await exists(join(host.checkpoint, "capability-state.json")), false);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a managed lane left inside the privileged account is refused before any effect", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    // A v1 node: the unit, its enablement link and Linger all live in the
    // privileged operations account.
    const privilegedHome = await seedAccount(host, PRIVILEGED_ACCOUNT);
    const staleUnit = join(privilegedHome, ".config/systemd/user/ghostfleet-managed.service");
    const staleWant = join(privilegedHome, ".config/systemd/user/default.target.wants/ghostfleet-managed.service");
    await mkdir(join(privilegedHome, ".config/systemd/user/default.target.wants"), { recursive: true });
    await writeFile(staleUnit, await readFixture("ghostfleet-managed.service"));
    await symlink("../ghostfleet-managed.service", staleWant);
    await mkdir(join(host.fixtureState, "linger"), { recursive: true });
    await writeFile(join(host.fixtureState, "linger", PRIVILEGED_ACCOUNT), "yes\n");

    const result = await runCourier(host, await buildSelection());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_STALE_PRIVILEGED_LANE/);
    assert.match(result.stderr, /Decommission it first/);
    assert.match(result.stderr, new RegExp("disable-linger " + PRIVILEGED_ACCOUNT));
    // Nothing happened: no claim, no installer, no account, no second unit.
    assert.deepEqual(await calls(host), [], "the refusal precedes every effect");
    assert.deepEqual(await installerLog(host), [], "the installer never ran");
    assert.equal(await accountExists(host, CONTROL_ACCOUNT), false);
    assert.equal(await exists(UNIT_PATH(host)), false, "no second unit is installed");
    // The residue is not this run's to delete, so it is reported and left.
    assert.ok(await exists(staleUnit), "a pre-existing lane is never deleted automatically");
    assert.ok(await exists(staleWant));
    assert.ok(await exists(join(host.fixtureState, "linger", PRIVILEGED_ACCOUNT)));
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a privileged declaration the installer does not admit is refused after it runs", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    // Well-formed and distinct from the run account, but not the account the
    // installer actually admits: only the cross-check can catch this.
    const result = await runCourier(host, await buildSelection({ privileged_account: "ghostfleet-ops-alt" }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_PRIVILEGED_ACCOUNT_MISMATCH/);
    assert.match(result.stderr, /admits ghostfleet-ops/);
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 1, "the installer really ran");
    assert.equal(await exists(UNIT_PATH(host)), false, "no unit is installed on a mismatched declaration");
    assert.equal(await exists(LINGER(host)), false);
    assert.equal(await accountExists(host, CONTROL_ACCOUNT), false, "the account this run created is rolled back");
    assert.equal(await exists(join(host.fixtureState, "complete-body.json")), false);
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("an adopted run account must satisfy the same criteria as a created one", { skip: linuxOnly }, async () => {
  const cases = [
    { name: "login shell", seed: { shell: "/bin/bash" }, expected: /has a login shell/ },
    { name: "unlocked password", seed: { unlocked: true }, expected: /password of the managed run account .* is not locked/ },
    { name: "system uid", seed: { uid: 990 }, expected: /has a system uid/ },
    { name: "no same-name group", seed: { noGroup: true }, expected: /has no group of the same name/ },
  ];
  for (const item of cases) {
    const host = await makeHost();
    try {
      await freshCheckpoint(host);
      await seedAccount(host, CONTROL_ACCOUNT, item.seed);
      const result = await runCourier(host, await buildSelection());
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.expected, item.name);
      assert.equal(startingWith(await installerLog(host), "installer --apply").length, 0, item.name + ": no apply");
      assert.equal(await exists(UNIT_PATH(host)), false, item.name + ": no unit");
      assert.ok(await accountExists(host, CONTROL_ACCOUNT), item.name + ": the adopted account is untouched");
    } finally { await rm(host.root, { recursive: true, force: true }); }
  }
});

test("a helper-only template still cross-checks the declared privileged account", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    // No unit and no Linger lane at all: only the bounded helper is requested.
    const result = await runCourier(host, await buildSelection({
      ...HELPER_ONLY, privileged_account: "ghostfleet-ops-alt",
    }));
    assert.notEqual(result.status, 0, "a helper-only template must not accept a wrong declaration");
    assert.match(result.stderr, /CAPABILITY_PRIVILEGED_ACCOUNT_MISMATCH/);
    assert.match(result.stderr, /admits ghostfleet-ops/);
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 1, "the installer really ran");
    assert.equal(await exists(join(host.fixtureState, "complete-body.json")), false, "no completion is reported");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a failing group lookup is never read as 'no privileged group'", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    await seedAccount(host, CONTROL_ACCOUNT);
    await mkdir(join(host.fixtureState, "nss-fail", "id-groups"), { recursive: true });
    await writeFile(join(host.fixtureState, "nss-fail", "id-groups", CONTROL_ACCOUNT), "unavailable\n");
    const result = await runCourier(host, await buildSelection());
    assert.notEqual(result.status, 0, "a broken group lookup must not decide the boundary");
    assert.match(result.stderr, /CAPABILITY_RUN_ACCOUNT_UNPROVEN/);
    assert.match(result.stderr, /account database could not be queried/);
    assert.equal(await exists(UNIT_PATH(host)), false);
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 0);
    assert.ok(await accountExists(host, CONTROL_ACCOUNT), "the account is left untouched");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("an account whose only group is its primary group is accepted", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    // A real account always lists its primary group; that is the shape accepted.
    await seedAccount(host, CONTROL_ACCOUNT);
    const groups = spawnSync(join(host.bin, "id"), ["-nG", CONTROL_ACCOUNT], {
      env: { ...process.env, ...host.env },
      encoding: "utf8",
    });
    assert.equal(groups.stdout.trim(), CONTROL_ACCOUNT, "the fixture answers with the real primary group");
    const result = await runCourier(host, await buildSelection());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(UNIT_PATH(host), "utf8"), await readFixture("ghostfleet-managed.service"));
    const state = await readJson(join(host.checkpoint, "capability-state.json"));
    assert.equal(state.control_account_state, "EXISTING");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a group list that comes back empty is not accepted", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    await seedAccount(host, CONTROL_ACCOUNT);
    await mkdir(join(host.fixtureState, "empty-groups"), { recursive: true });
    await writeFile(join(host.fixtureState, "empty-groups", CONTROL_ACCOUNT), "none\n");
    const result = await runCourier(host, await buildSelection());
    assert.notEqual(result.status, 0, "id -nG always lists the primary group; empty output is not an answer");
    assert.match(result.stderr, /CAPABILITY_RUN_ACCOUNT_UNPROVEN/);
    assert.equal(startingWith(await installerLog(host), "installer --apply").length, 0);
    await assertNoLane(host, "empty group list");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("a group list that does not contain the primary group is not accepted", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    // Parses cleanly but names some other group: the primary group is missing, so
    // the answer was replaced or truncated and nothing about membership is proved.
    await seedAccount(host, CONTROL_ACCOUNT, { groups: ["users"] });
    const result = await runCourier(host, await buildSelection());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_RUN_ACCOUNT_UNPROVEN/);
    await assertNoLane(host, "missing primary group");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});

test("an unparseable group token is not accepted", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    await seedAccount(host, CONTROL_ACCOUNT, { groups: [CONTROL_ACCOUNT, "bad!token"] });
    const result = await runCourier(host, await buildSelection());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPABILITY_RUN_ACCOUNT_UNPROVEN/);
    await assertNoLane(host, "unparseable group token");
  } finally { await rm(host.root, { recursive: true, force: true }); }
});
