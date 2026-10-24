import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BOOTSTRAP_SH } from "../src/bootstrap.js";

const linuxOnly = process.platform !== "linux";
function functionSource(name, nextName) {
  const start = BOOTSTRAP_SH.indexOf(name + "() {");
  const end = BOOTSTRAP_SH.indexOf("\n" + nextName + "() {", start);
  assert.ok(start >= 0 && end > start, "published shell function must be present: " + name);
  return BOOTSTRAP_SH.slice(start, end);
}
function safePath(value) {
  assert.doesNotMatch(value, /['\r\n]/, "fixture path must be shell-safe");
  return "'" + value + "'";
}
async function runShell(root, filename, source, env = {}) {
  const file = join(root, filename);
  await writeFile(file, "#!/bin/sh\nset -eu\n" + source + "\n");
  return spawnSync("/bin/sh", [file], {
    cwd: root, env: { ...process.env, ...env },
    encoding: "utf8", timeout: 10000, input: "",
  });
}

test("preclaim and original attempt guard execute BEFORE any package/provider effects", () => {
  const preflight = BOOTSTRAP_SH.indexOf("\nbootstrap_phase0_preflight\n");
  const compliant = BOOTSTRAP_SH.indexOf("\nif checkpoint_is_compliant; then");
  const guard = BOOTSTRAP_SH.indexOf("\nrefuse_unresolved_previous_enrollment\n");
  const preclaim = BOOTSTRAP_SH.indexOf('\ncase "$(tailscale_preclaim_state)" in');
  const baseline = BOOTSTRAP_SH.indexOf("\nbootstrap_transport_baseline\n");
  const claim = BOOTSTRAP_SH.indexOf("\nCLAIM_URL=");
  const fence = BOOTSTRAP_SH.indexOf("\n  checkpoint_write CONVERGE RECONCILE_REQUIRED\n");
  const keyfile = BOOTSTRAP_SH.indexOf("\n  printf '%s' \"$TS_AUTHKEY\" > /run/fleet/ts-authkey");
  const up = BOOTSTRAP_SH.indexOf("\n  if ! tailscale up --authkey=file:/run/fleet/ts-authkey");
  const verify = BOOTSTRAP_SH.indexOf("\n  checkpoint_write VERIFY IN_PROGRESS\n");
  assert.ok(0 < preflight && preflight < compliant && compliant < guard && guard < preclaim &&
    preclaim < baseline && baseline < claim && claim < fence && fence < keyfile &&
    keyfile < up && up < verify);
  assert.match(BOOTSTRAP_SH.slice(up, verify), /<\/dev\/null >\/dev\/null 2>&1/);
  assert.doesNotMatch(BOOTSTRAP_SH.slice(up, verify), /force-reauth|tailscale login/);
});

test("pre-installed Tailscale with ambiguous/auth-lost status cannot claim new key", { skip: linuxOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ghostfleet-preclaim-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const statusFile = join(root, "status.json");
    const effectFile = join(root, "unexpected-effect");
    await writeFile(join(bin, "tailscale"),
      '#!/bin/sh\nif [ "$*" = "status --self --peers=false --json" ]; then cat "$FAKE_STATUS"; else printf x >> "$FAKE_EFFECT"; exit 31; fi\n',
      { mode: 0o755 });
    const source = functionSource("tailscale_preclaim_state", "live_tailscale_ready") +
      "\ntailscale_preclaim_state";
    const env = { PATH: bin + ":/usr/bin:/bin", FAKE_STATUS: statusFile, FAKE_EFFECT: effectFile };
    for (const [backend, self, expected] of [
      ["NeedsLogin", null, "UNKNOWN"],
      ["NoState", null, "UNKNOWN"],
      ["Running", null, "UNKNOWN"],
      ["Running", { HostName: "previous-node" }, "EXISTING"],
      ["Stopped", { HostName: "previous-node" }, "EXISTING"],
      ["Unexpected", { HostName: "previous-node" }, "UNKNOWN"],
    ]) {
      await writeFile(statusFile, JSON.stringify({ BackendState: backend, Self: self }));
      const result = await runShell(root, "preclaim.sh", source, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected, backend);
    }
    await assert.rejects(stat(effectFile), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete or symlinked checkpoint refuses a new one-off claim", { skip: linuxOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ghostfleet-oneoff-guard-"));
  try {
    const checkpoint = join(root, "enrollment-checkpoint.json");
    const report = join(root, "enrollment-report.json");
    const guard = functionSource("refuse_unresolved_previous_enrollment", "fail");
    const source =
      "CHECKPOINT_DIR=" + safePath(root) + '\nCHECKPOINT_FILE="$CHECKPOINT_DIR/enrollment-checkpoint.json"\n' +
      'fail() { printf "%s\n" "$*" >&2; exit 71; }\n' +
      guard + '\nrefuse_unresolved_previous_enrollment\nprintf "fresh"\n';
    let result = await runShell(root, "guard.sh", source);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "fresh");
    for (const marker of [checkpoint, report]) {
      await writeFile(marker, '{"status":"RECONCILE_REQUIRED","identity_kind":"provisional"}\n');
      result = await runShell(root, "guard.sh", source);
      assert.equal(result.status, 71, result.stderr);
      assert.match(result.stderr, /prior enrollment state unresolved/);
      await rm(marker);
    }
    await symlink(join(root, "absent-original"), checkpoint);
    result = await runShell(root, "guard.sh", source);
    assert.equal(result.status, 71);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed one-off auth persists key-free attempt fence; no retry on next run", { skip: linuxOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ghostfleet-oneoff-effect-"));
  try {
    const checkpoint = join(root, "enrollment-checkpoint.json");
    const keyPath = join(root, "ephemeral-one-off-key");
    const counter = join(root, "tailscale-up-calls");
    const authStart = BOOTSTRAP_SH.indexOf('if [ "$TAILSCALE_STATE" != COMPLIANT ]; then\n  # The one-time claim');
    const authEndMarker = "\nelse\n  unset TS_AUTHKEY\nfi";
    const authEnd = BOOTSTRAP_SH.indexOf(authEndMarker, authStart);
    assert.ok(authStart >= 0 && authEnd > authStart, "real effectful block present");
    const realBlock = BOOTSTRAP_SH.slice(authStart, authEnd + authEndMarker.length);
    assert.ok(realBlock.includes("/run/fleet/ts-authkey"));
    const fixtureBlock = realBlock.replaceAll("/run/fleet/ts-authkey", keyPath);
    const source = [
      "CHECKPOINT_DIR=" + safePath(root),
      'CHECKPOINT_FILE="$CHECKPOINT_DIR/enrollment-checkpoint.json"',
      "NODE_ID=fleet-bootstrap-000000000001",
      "NODE_UID=",
      "IDENTITY_KIND=provisional",
      "ENROLLMENT_ID=enroll-00000000-0000-4000-8000-000000000001",
      "OS_FAMILY=debian-family", "OS_ID=debian", "OS_VERSION_ID=13",
      "SSH_HOST_KEY_SHA=SHA256:synthetic-host",
      "PACKAGES_STATE=COMPLIANT", "TAILSCALE_STATE=ABSENT",
      "TS_AUTHKEY=synthetic-key-DO-NOT-REUSE",
      "FAKE_COUNTER=" + safePath(counter),
      "FAKE_EXIT=43",
      'install() { :; }',
      'chown() { :; }',
      'tailscale() { printf x >> "$FAKE_COUNTER"; return "$FAKE_EXIT"; }',
      'live_tailscale_ready() { :; }',
      'fail() { printf "%s\n" "$*" >&2; exit 43; }',
      functionSource("checkpoint_write", "refuse_unresolved_previous_enrollment"),
      fixtureBlock,
    ].join("\n");
    const failed = await runShell(root, "join.sh", source);
    assert.equal(failed.status, 43, failed.stderr);
    assert.match(failed.stderr, /one-off Tailscale auth rejected or uncertain/);
    assert.equal(await readFile(counter, "utf8"), "x", "one auth attempt only");
    await assert.rejects(stat(keyPath), { code: "ENOENT" });
    const checkpointValue = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.equal(checkpointValue.phase, "CONVERGE");
    assert.equal(checkpointValue.status, "RECONCILE_REQUIRED");
    assert.equal(checkpointValue.node_id, "fleet-bootstrap-000000000001");
    assert.equal(checkpointValue.enrollment_id, "enroll-00000000-0000-4000-8000-000000000001");
    assert.ok(!(await readFile(checkpoint, "utf8")).includes("synthetic-key-DO-NOT-REUSE"));

    const guard = functionSource("refuse_unresolved_previous_enrollment", "fail");
    const subsequent =
      "CHECKPOINT_DIR=" + safePath(root) + '\nCHECKPOINT_FILE="$CHECKPOINT_DIR/enrollment-checkpoint.json"\n' +
      'fail() { printf "%s\n" "$*" >&2; exit 71; }\n' +
      guard + '\nrefuse_unresolved_previous_enrollment\nprintf BAD_SECOND_JOIN\n';
    const retry = await runShell(root, "guard-after-join.sh", subsequent);
    assert.equal(retry.status, 71);
    assert.equal(await readFile(counter, "utf8"), "x", "retry must not reauthenticate");
  } finally { await rm(root, { recursive: true, force: true }); }
});
