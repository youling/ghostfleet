import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  BOOTSTRAP_SH, renderBootstrap, CAPABILITY_BLOCK_BEGIN, CAPABILITY_BLOCK_END,
  CAPABILITY_SECTION_BEGIN, CAPABILITY_SECTION_END,
  renderCapabilityBlock, selectedCapabilitiesFromPosture, normalizeSelectedCapability,
  encodeCapabilitySelection, decodeCapabilitySelection, capabilitySelectionDigest,
} from "../src/index.js";

const sha256 = (value) => "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");

function selection(overrides = {}) {
  return {
    source: "template",
    template_digest: sha256("reviewed-template"),
    version: "managed-linux-privileged-operations/2026.11",
    helper_required: true,
    linger_required: true,
    user_service_required: true,
    control_account: "ghostfleet-managed",
    privileged_account: "ghostfleet-ops",
    installer: "managed-linux-privileged-operations.sh",
    privileged_key: "privileged-ops.pub",
    user_unit: { name: "ghostfleet-managed.service", artifact: "ghostfleet-managed.service" },
    artifacts: [
      { name: "fleet-privctl.py", mode: "0755", content: "print('helper')\n" },
      { name: "privileged-ops.pub", mode: "0644", content: "ssh-ed25519 AAAAfixture synthetic\n" },
      { name: "ghostfleet-managed.service", mode: "0644", content: "[Service]\nExecStart=/bin/true\n" },
      { name: "managed-linux-privileged-operations.sh", mode: "0750", content: "#!/bin/sh\nexit 0\n" },
    ],
    ...overrides,
  };
}

function blockOf(script) {
  const begin = script.indexOf(CAPABILITY_BLOCK_BEGIN);
  const end = script.indexOf(CAPABILITY_BLOCK_END);
  assert.ok(begin >= 0 && end > begin);
  return script.slice(begin + CAPABILITY_BLOCK_BEGIN.length + 1, end).replace(/\n$/, "");
}

test("the published courier selects nothing unless the template requested it", () => {
  const block = blockOf(BOOTSTRAP_SH);
  assert.equal(block, renderCapabilityBlock(null));
  assert.match(block, /^CAPABILITY_HELPER_REQUIRED=0$/m);
  assert.match(block, /^CAPABILITY_ARTIFACT_COUNT=0$/m);
  assert.doesNotMatch(block, /CAPABILITY_ARTIFACT_1=/);
  const rendered = renderBootstrap({ brokerOrigin: "https://fixture.example.invalid" });
  assert.equal(blockOf(rendered), renderCapabilityBlock(null));
});

test("the reviewed template posture decides helper and Linger, never the courier", () => {
  const managed = { roles: ["managed"], privilege: { helper_required: true, broker_required: true } };
  assert.deepEqual({ ...selectedCapabilitiesFromPosture(managed) },
    { helper_required: true, linger_required: true, user_service_required: false });
  const limited = { roles: ["customer-managed"], privilege: { helper_required: false } };
  assert.equal(selectedCapabilitiesFromPosture(limited), null);
  const withUnit = { roles: ["managed"], privilege: { helper_required: false } };
  assert.deepEqual({ ...selectedCapabilitiesFromPosture(withUnit, { userUnit: "unit" }) },
    { helper_required: false, linger_required: true, user_service_required: true });
});

test("rendered capability carries version, template provenance and SHA-256 pinned artifacts", () => {
  const supplied = selection();
  const rendered = renderBootstrap({
    brokerOrigin: "https://fixture.example.invalid",
    checkpointDir: "/tmp/synthetic-fixture",
    capabilitySelection: supplied,
  });
  const block = blockOf(rendered);
  assert.match(block, /^CAPABILITY_HELPER_REQUIRED=1$/m);
  assert.match(block, /^CAPABILITY_LINGER_REQUIRED=1$/m);
  assert.match(block, /^CAPABILITY_USER_SERVICE_REQUIRED=1$/m);
  assert.ok(block.includes("CAPABILITY_VERSION='" + supplied.version + "'"));
  assert.ok(block.includes("CAPABILITY_TEMPLATE_DIGEST='" + supplied.template_digest + "'"));
  assert.match(block, /^CAPABILITY_SELECTION_DIGEST='sha256:[0-9a-f]{64}'$/m);
  assert.ok(block.includes("CAPABILITY_CONTROL_ACCOUNT='" + supplied.control_account + "'"));
  assert.ok(block.includes("CAPABILITY_PRIVILEGED_ACCOUNT='" + supplied.privileged_account + "'"));
  assert.ok(rendered.includes("BROKER_ORIGIN='https://fixture.example.invalid'"));
  assert.ok(rendered.includes("CHECKPOINT_DIR='/tmp/synthetic-fixture'"));
  for (const artifact of supplied.artifacts) {
    const row = block.split("\n").find((line) => line.startsWith("CAPABILITY_ARTIFACT_") && line.includes("'" + artifact.name + "|"));
    assert.ok(row, "artifact row for " + artifact.name);
    // A1: an address row, never the bytes. name|sha256|mode is the whole row.
    const [, name, digest, mode] = row.match(/^CAPABILITY_ARTIFACT_\d+='([^|]*)\|([0-9a-f]{64})\|([0-7]{4})'$/);
    assert.equal(name, artifact.name);
    assert.equal("sha256:" + digest, sha256(artifact.content));
    assert.equal(mode, "0" + (artifact.mode.replace(/^0/, "")));
    assert.doesNotMatch(row, /[A-Za-z0-9+/]{16,}={0,2}'$/, "no inline artifact bytes may reach the command");
  }
  // The default block is replaced, never appended to.
  assert.equal(rendered.split(CAPABILITY_BLOCK_BEGIN).length, 2);
  assert.doesNotMatch(rendered, /^CAPABILITY_ARTIFACT_COUNT=0$/m);
});

test("unrequested, unpinned or inconsistent privilege selections are refused at render time", () => {
  const render = (overrides) => () => renderBootstrap({
    brokerOrigin: "https://fixture.example.invalid",
    capabilitySelection: selection(overrides),
  });
  assert.throws(render({ artifacts: [] }), /CAPABILITY_ARTIFACTS_REQUIRED/);
  assert.throws(render({
    helper_required: false, linger_required: false, user_service_required: false, user_unit: null,
  }), /CAPABILITY_NOT_REQUESTED_BY_TEMPLATE/);
  assert.throws(render({ installer: "other.sh" }), /CAPABILITY_INSTALLER_NOT_PINNED/);
  assert.throws(render({ privileged_key: "other.pub" }), /CAPABILITY_PRIVILEGED_KEY_NOT_PINNED/);
  assert.throws(render({ user_unit: null, user_service_required: true }), /CAPABILITY_USER_UNIT_REQUIRED/);
  assert.throws(render({ template_digest: "sha256:short" }), /CAPABILITY_TEMPLATE_DIGEST_INVALID/);
  assert.throws(render({ version: "bad version" }), /CAPABILITY_VERSION_INVALID/);
  assert.throws(render({ control_account: "root" }), /CAPABILITY_CONTROL_ACCOUNT_INVALID/);
  // The privileged account is a deployment fact, never a courier default.
  assert.throws(render({ privileged_account: undefined }), /CAPABILITY_PRIVILEGED_ACCOUNT_REQUIRED/);
  assert.throws(render({ privileged_account: "" }), /CAPABILITY_PRIVILEGED_ACCOUNT_REQUIRED/);
  assert.throws(render({ privileged_account: "root" }), /CAPABILITY_PRIVILEGED_ACCOUNT_INVALID/);
  assert.throws(render({ privileged_account: "ghostfleet-managed" }), /CAPABILITY_ACCOUNT_COLLISION/);
  assert.throws(render({ unexpected: true }), /CAPABILITY_SELECTION_INVALID/);
  assert.throws(() => renderBootstrap({
    brokerOrigin: "https://fixture.example.invalid",
    capabilitySelection: selection({ artifacts: [
      { name: "../escape", mode: "0644", content: "x" },
    ] }),
  }), /CAPABILITY_ARTIFACT_NAME_INVALID/);
  const drifted = selection();
  drifted.artifacts = [{ ...drifted.artifacts[0], sha256: sha256("other bytes") }, ...drifted.artifacts.slice(1)];
  assert.throws(() => renderBootstrap({
    brokerOrigin: "https://fixture.example.invalid", capabilitySelection: drifted,
  }), /CAPABILITY_ARTIFACT_DIGEST_MISMATCH/);
});

test("the shell text decoder accepts address rows and refuses inline bytes", () => {
  const valid = encodeCapabilitySelection(selection());
  const text = Buffer.from(valid, "base64").toString("utf8");
  assert.ok(decodeCapabilitySelection(text));
  assert.match(text, /^artifact=[^|]+\|[0-9a-f]{64}\|[0-7]{4}$/m);
  const unknown = text + "unexpected_field=1\n";
  assert.throws(() => decodeCapabilitySelection(unknown), /CAPABILITY_SELECTION_INVALID/);
  const truncated = text.replace(/^artifact=(.+)$/m, (match, row) => "artifact=" + row.split("|").slice(0, 2).join("|"));
  assert.throws(() => decodeCapabilitySelection(truncated), /CAPABILITY_ARTIFACT_ROW_INVALID/);
  // A legacy v1 row inlined the bytes; the new decoder must refuse it instead of
  // preferring the claim over the immutable asset origin.
  const inline = text.replace(/^artifact=(.+)$/m, (match, row) => "artifact=" + row + "|Zm9yYmlkZGVu");
  assert.throws(() => decodeCapabilitySelection(inline), /CAPABILITY_ARTIFACT_ROW_INVALID/);
});

test("the published courier carries no literal control bytes or split printf formats", async () => {
  const { BOOTSTRAP_SH } = await import("../src/bootstrap.js");
  // A literal tab or CR inside the template would change what the node executes.
  assert.doesNotMatch(BOOTSTRAP_SH, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\t\r]/);
  const lines = BOOTSTRAP_SH.split("\n");
  const split = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/printf '[^']*%s$/.test(lines[index]) && (lines[index + 1] ?? "").startsWith("'")) {
      split.push(index + 1);
    }
  }
  assert.deepEqual(split, [], "printf formats must keep explicit \\n escapes");
});

test("the recorded selection digest is stable and covers every pinned artifact", () => {
  const first = normalizeSelectedCapability(selection());
  assert.equal(capabilitySelectionDigest(first), capabilitySelectionDigest(normalizeSelectedCapability(selection())));
  const changed = normalizeSelectedCapability(selection({
    artifacts: [...selection().artifacts, { name: "extra.txt", mode: "0644", content: "extra\n" }],
  }));
  assert.notEqual(capabilitySelectionDigest(changed), capabilitySelectionDigest(first));
  const reordered = normalizeSelectedCapability(selection({ artifacts: [...selection().artifacts].reverse() }));
  assert.equal(capabilitySelectionDigest(reordered), capabilitySelectionDigest(first));
});

test("the capability lane is delimited once so a root job can run the published bytes", () => {
  for (const marker of [CAPABILITY_SECTION_BEGIN, CAPABILITY_SECTION_END]) {
    assert.equal(BOOTSTRAP_SH.split(marker).length, 2, "exactly one " + marker);
  }
  const begin = BOOTSTRAP_SH.indexOf(CAPABILITY_SECTION_BEGIN);
  const end = BOOTSTRAP_SH.indexOf(CAPABILITY_SECTION_END);
  assert.ok(begin >= 0 && end > begin);
  const slice = BOOTSTRAP_SH.slice(begin, end);
  assert.ok(slice.includes(CAPABILITY_BLOCK_BEGIN), "the data block is inside the section");
  assert.ok(slice.includes(CAPABILITY_BLOCK_END));
  assert.match(slice, /capability_validate_selection\(\) \{/);
  assert.match(slice, /capability_apply\(\) \{/);
  assert.match(slice, /capability_stage_cleanup\(\) \{/);
});

test("an unchanged artifact set keeps a stable selection digest", () => {
  const first = normalizeSelectedCapability(selection());
  const second = normalizeSelectedCapability(selection());
  assert.equal(first.selection_digest, second.selection_digest);
  const changed = normalizeSelectedCapability(selection({ version: "managed-linux-privileged-operations/2026.12" }));
  assert.notEqual(changed.selection_digest, first.selection_digest);
  // The account boundary is part of the reviewed selection, so the digest binds
  // it: swapping the privileged account cannot keep the recorded digest.
  const otherPrivileged = normalizeSelectedCapability(selection({ privileged_account: "ghostfleet-ops-alt" }));
  assert.notEqual(otherPrivileged.selection_digest, first.selection_digest);
});

test("both the default and the selected courier stay valid POSIX shell", { skip: process.platform !== "linux" }, () => {
  const selected = renderBootstrap({
    brokerOrigin: "https://fixture.example.invalid",
    capabilitySelection: selection(),
  });
  for (const script of [BOOTSTRAP_SH, selected]) {
    const check = spawnSync("/bin/sh", ["-n"], { input: script, encoding: "utf8", timeout: 10000 });
    assert.equal(check.status, 0, check.stderr);
  }
});
