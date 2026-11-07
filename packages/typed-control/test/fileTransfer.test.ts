import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "vitest";
import {
  canChangeFileTransferBackend, fileManifestSha256, fileTransferIntentSha256,
  snapshotFileTransferValue, validateFileManifest, validateFileTransferIntent,
  validateFileTransferRelativePath, verifyFileTransferManifest, verifyFileTransferReceipt,
} from "../src/fileTransferContract.js";
import {planRsyncFileTransfer} from "../src/fileTransferBackends.js";

// Inert node identities: no locator, credential, private topology or live evidence.
const sourceNode = "node-11111111-1111-4111-8111-111111111111";
const destinationNode = "node-22222222-2222-4222-8222-222222222222";
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const capabilities = ["from0", "files-from-no-recursion", "remote-arg-escaping", "partial-dir"];

function fixture(direction: "push" | "pull" = "push", windows = false, restricted = false) {
  const manifest = {
    schema_version: 1, profile: "portable-files-v1", source_version: "snapshot:synthetic-v1",
    entries: [
      {path: "empty", kind: "directory"},
      {path: "nested", kind: "directory"},
      {path: "nested/资料 with spaces.txt", kind: "file", size: 5, sha256: hash("hello")},
      {path: "zero.txt", kind: "file", size: 0, sha256: hash("")},
    ], file_count: 2, directory_count: 2, total_bytes: 5,
  };
  const intent = {
    schema_version: 1, capability: "fleet.file.transfer", operation_id: "operation:synthetic-1",
    actor_ref: "actor:synthetic", work_ref: "work:synthetic", policy_revision: "policy:synthetic-v1",
    source: {node_uid: sourceNode, root_ref: "root:source", relative_path: "dataset"},
    destination: {node_uid: destinationNode, root_ref: "root:destination", relative_path: "new-copy"},
    direction, backend: "rsync-ssh", profile: "portable-files-v1", source_version: manifest.source_version,
    manifest_sha256: fileManifestSha256(manifest), overwrite: "deny", delete_source: false, delete_extraneous: false,
  };
  const localNode = direction === "push" ? sourceNode : destinationNode;
  const remoteNode = direction === "push" ? destinationNode : sourceNode;
  const root = (node: string, rootRef: string) => ({
    node_uid: node, root_ref: rootRef,
    path: node === remoteNode && restricted ? "." : node === localNode && windows ? "/c/fleet files" : "/srv/fleet files",
    owner_ref: node === destinationNode ? "owner:destination" : "owner:source", no_links: true,
    evidence_ref: "evidence:root-synthetic",
  });
  const context = {
    now_ms: 100, dispatch_state: "NOT_DISPATCHED",
    approval: {
      intent_sha256: fileTransferIntentSha256(intent), operation_id: intent.operation_id, actor_ref: intent.actor_ref,
      work_ref: intent.work_ref, policy_revision: intent.policy_revision, expires_at_ms: 200,
      evidence_ref: "approval:synthetic",
    },
    executor: {node_uid: localNode, platform: windows ? "windows-msys2" : "linux"},
    source_root: root(sourceNode, "root:source"), destination_root: root(destinationNode, "root:destination"),
    peer: {
      node_uid: remoteNode, platform: "linux", ssh_alias: "synthetic-peer", ssh_config_path: "/run/fleet/ssh_config",
      ssh_config_sha256: hash("synthetic approved config"), target_proof: {method: "pinned_host_key", detail_digest: hash("synthetic pin")},
      auth_mode: restricted ? "rrsync" : "rsync-shell", rrsync_no_overwrite: false, config_ref: "ssh:synthetic-config",
    },
    programs: {rsync: "/usr/bin/rsync", ssh: "/usr/bin/ssh"},
    local_tools: {package_build: "distribution:reviewed-build-local", security_baseline_ref: "security:synthetic-local", capabilities: [...capabilities]},
    peer_tools: {package_build: "distribution:reviewed-build-peer", security_baseline_ref: "security:synthetic-peer", capabilities: [...capabilities]},
    staging: {
      intent_sha256: fileTransferIntentSha256(intent), operation_id: intent.operation_id, manifest_sha256: intent.manifest_sha256,
      source_version: intent.source_version, owner_ref: "owner:destination", state: "new", inventory_state: "empty", private: true,
      no_links: true, destination: "absent", evidence_ref: "staging:synthetic",
    },
  };
  return {intent, manifest, context};
}

function successReceipt() {
  const f = fixture();
  return {...f, receipt: {
    schema_version: 1, operation_id: f.intent.operation_id, intent_sha256: fileTransferIntentSha256(f.intent),
    actor_ref: f.intent.actor_ref, work_ref: f.intent.work_ref, policy_revision: f.intent.policy_revision,
    source_node_uid: sourceNode, destination_node_uid: destinationNode, backend: "rsync-ssh", outcome: "SUCCEEDED",
    dispatch_state: "MAY_HAVE_EXECUTED", exit_code: 0, source_version_after: f.manifest.source_version,
    observed_manifest: f.manifest, destination_owner_ref: "owner:destination", publication: "no-replace", evidence_ref: "receipt:synthetic",
  }};
}

describe("strict file transfer contract", () => {
  it("canonicalizes manifest ordering and snapshots caller data", () => {
    const {intent, manifest} = fixture();
    const parsed = validateFileTransferIntent(intent);
    intent.source.root_ref = "root:changed";
    assert.equal(parsed.source.root_ref, "root:source");
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.source));
    assert.equal(fileManifestSha256(manifest), fileManifestSha256({...manifest, entries: [...manifest.entries].reverse()}));
  });

  it("does not invoke accessor payloads", () => {
    let calls = 0;
    const data = Object.defineProperty({}, "command", {enumerable: true, get() { calls++; return "unsafe"; }});
    assert.throws(() => snapshotFileTransferValue(data), /NON_JSON_INPUT/);
    assert.equal(calls, 0);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    assert.throws(() => snapshotFileTransferValue(cyclic), /NON_JSON_INPUT/);
    assert.throws(() => snapshotFileTransferValue(new Date()), /NON_JSON_INPUT/);
  });

  it("rejects unknown fields, destructive policy and wrong node identities", () => {
    const {intent} = fixture();
    for (const change of [{command: "arbitrary"}, {options: ["--delete"]}, {overwrite: "allow"}, {delete_source: true}, {delete_extraneous: true}]) {
      assert.throws(() => validateFileTransferIntent({...intent, ...change}));
    }
    assert.throws(() => validateFileTransferIntent({...intent, source: {...intent.source, node_uid: "wrong-node"}}), /INVALID_NODE_UID/);
    assert.throws(() => validateFileTransferIntent({...intent, destination: {...intent.destination, node_uid: sourceNode}}), /DISTINCT_NODES/);
    assert.throws(() => validateFileTransferIntent({...intent, source: {...intent.source, host: "unapproved"}}), /UNKNOWN_OR_MISSING_FIELD/);
  });

  for (const path of ["/absolute", "../outside", "a/../b", "a//b", "a/./b", "C:/file", "\\\\share\\file", "a\0b", "a\nb", "name.", "name ", "NUL.txt", "COM1", "LPT².txt", ".ghostfleet-transfer/data", "e\u0301.txt", "\uD800.txt", "file\uDC00"]) {
    it(`rejects unsafe or nonportable path ${JSON.stringify(path)}`, () => assert.throws(() => validateFileTransferRelativePath(path)));
  }

  it("preserves a valid astral Unicode filename without UTF-8 replacement", () => {
    const path = "目录/😀.txt";
    assert.equal(validateFileTransferRelativePath(path), path);
    assert.equal(Buffer.from(path, "utf8").toString("utf8"), path);
  });

  it("rejects name collisions, missing parents, links, unknown metadata and totals", () => {
    const {manifest} = fixture();
    assert.throws(() => validateFileManifest({...manifest, entries: [...manifest.entries, {path: "ZERO.TXT", kind: "file", size: 0, sha256: hash("") }], file_count: 3}), /PATH_COLLISION/);
    assert.throws(() => validateFileManifest({...manifest, entries: manifest.entries.filter(e => e.path !== "nested"), directory_count: 1}), /MISSING_OR_CONFLICTING_PARENT/);
    const conflict = [{path: "parent", kind: "file", size: 0, sha256: hash("")}, {path: "parent/child", kind: "file", size: 0, sha256: hash("")}];
    assert.throws(() => validateFileManifest({...manifest, entries: conflict, file_count: 2, directory_count: 0, total_bytes: 0}), /MISSING_OR_CONFLICTING_PARENT/);
    for (const kind of ["symlink", "reparse-point", "device", "socket"]) {
      assert.throws(() => validateFileManifest({...manifest, entries: [{path: "link", kind}]}), /UNSUPPORTED_FILE_KIND/);
    }
    assert.throws(() => validateFileManifest({...manifest, entries: [{path: "empty", kind: "directory", acl: "unverified"}]}), /UNKNOWN_OR_MISSING_FIELD/);
    assert.throws(() => validateFileManifest({...manifest, total_bytes: 6}), /MANIFEST_TOTAL_MISMATCH/);
    assert.throws(() => validateFileManifest({...manifest, file_count: 1}), /MANIFEST_TOTAL_MISMATCH/);
  });

  it("verifies every hash, missing/extra entries and source version, not only size", () => {
    const {manifest} = fixture();
    assert.equal(verifyFileTransferManifest(manifest, manifest).file_count, 2);
    const tampered = {...manifest, entries: manifest.entries.map(e => e.path.startsWith("nested/") ? {...e, sha256: hash("HELLO")} : e)};
    assert.throws(() => verifyFileTransferManifest(manifest, tampered), /MANIFEST_MISMATCH/);
    assert.throws(() => verifyFileTransferManifest(manifest, {...manifest, entries: manifest.entries.filter(e => e.path !== "zero.txt"), file_count: 1}), /MANIFEST_MISMATCH/);
    assert.throws(() => verifyFileTransferManifest(manifest, {...manifest, entries: [...manifest.entries, {path: "extra", kind: "directory"}], directory_count: 3}), /MANIFEST_MISMATCH/);
    assert.throws(() => verifyFileTransferManifest(manifest, {...manifest, source_version: "snapshot:changed"}), /MANIFEST_MISMATCH/);
  });
});

describe("rsync plans are bounded and never execute", () => {
  for (const direction of ["push", "pull"] as const) for (const windows of [false, true]) for (const restricted of [false, true]) {
    it(`plans ${windows ? "MSYS2" : "Linux"} ${direction} with ${restricted ? "rrsync" : "rsync shell"}`, () => {
      const {intent, manifest, context} = fixture(direction, windows, restricted);
      const plan = planRsyncFileTransfer(intent, manifest, context);
      assert.equal(plan.status, "SOURCE_PLAN_ONLY");
      assert.equal(plan.shell, false);
      assert.equal(plan.windows_server_status, "NOT_VERIFIED");
      assert.equal(plan.publication, "runtime-no-replace-required");
      assert.equal(plan.argv.slice(-2).filter(a => a.startsWith("synthetic-peer:")).length, 1);
      assert.equal(plan.stdin_utf8.split("\0").length - 1, 4);
      assert.ok(plan.stdin_utf8.includes("资料 with spaces.txt\0"));
      assert.equal(plan.stdin_sha256, hash(plan.stdin_utf8));
      assert.ok(plan.argv.includes("--no-recursive") && plan.argv.includes("--dirs"));
      assert.ok(!plan.argv.some(a => /^--(?:delete|remove-source|inplace|recursive|secluded-args|protect-args)/.test(a) || a === "-s" || a === "-a"));
      assert.equal(plan.environment.RSYNC_PROTECT_ARGS, "0");
      assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.argv));
      const argv = [...plan.argv]; context.source_root.path = "/changed";
      assert.deepEqual(plan.argv, argv);
    });
  }

  it("keeps filename shell syntax in NUL stdin, never in SSH command operands", () => {
    const {intent, manifest, context} = fixture();
    manifest.entries.push({path: "name;$(printf marker).txt", kind: "file", size: 0, sha256: hash("")});
    manifest.file_count++;
    intent.manifest_sha256 = fileManifestSha256(manifest);
    context.approval.intent_sha256 = fileTransferIntentSha256(intent);
    context.staging.intent_sha256 = context.approval.intent_sha256;
    context.staging.manifest_sha256 = intent.manifest_sha256;
    const plan = planRsyncFileTransfer(intent, manifest, context);
    assert.ok(plan.stdin_utf8.includes("name;$(printf marker).txt\0"));
    assert.ok(plan.argv.every(a => !a.includes("printf")));
  });

  it("rejects approval/identity/policy drift and expired approval", () => {
    const {intent, manifest, context} = fixture();
    for (const change of [{actor_ref: "actor:other"}, {policy_revision: "policy:new"}, {work_ref: "work:other"}, {operation_id: "operation:other"}, {intent_sha256: hash("other")}, {expires_at_ms: 100}]) {
      assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, approval: {...context.approval, ...change}}));
    }
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, executor: {...context.executor, node_uid: destinationNode}}), /ENDPOINT_IDENTITY_MISMATCH/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, source_root: {...context.source_root, root_ref: "root:other"}}), /ROOT_BINDING_MISMATCH/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, peer: {...context.peer, node_uid: sourceNode}}), /ENDPOINT_IDENTITY_MISMATCH/);
    assert.throws(() => planRsyncFileTransfer(intent, {...manifest, source_version: "snapshot:changed"}, context), /MANIFEST_BINDING_MISMATCH/);
  });

  it("requires observed host proof, safe configuration and tested tool capabilities", () => {
    const {intent, manifest, context} = fixture();
    for (const change of [{ssh_alias: "-oProxyCommand=unsafe"}, {ssh_alias: "host:other"}, {ssh_config_path: "/run/config;unsafe"}, {target_proof: {method: "provider_binding_tag", detail_digest: hash("other")}}, {command: "unsafe"}]) {
      assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, peer: {...context.peer, ...change}}));
    }
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, programs: {rsync: "/bin/rsync;unsafe", ssh: "/bin/ssh"}}), /UNSUPPORTED_EXECUTABLE_PATH/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, local_tools: {...context.local_tools, capabilities: ["unknown"]}}), /UNVERIFIED_TOOL_CAPABILITIES/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, peer_tools: {...context.peer_tools, security_baseline_ref: ""}}), /INVALID_CONTEXT_REFERENCE/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, source_root: {...context.source_root, path: "/srv/$(unsafe)"}}), /UNSUPPORTED_OPERAND_PATH/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, options: ["--inplace"]}), /UNKNOWN_OR_MISSING_CONTEXT_FIELD/);
  });

  it("separates MSYS2 local paths from native Windows server acceptance", () => {
    const {intent, manifest, context} = fixture("push", true);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, peer: {...context.peer, platform: "windows-native"}}), /WINDOWS_SSH_SERVER_NOT_VERIFIED/);
    for (const path of ["C:/fleet", "//server/share", "/srv/fleet"]) {
      assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, source_root: {...context.source_root, path}}));
    }
    for (const programs of [
      {rsync: "/usr/bin/rsync", ssh: "/c/Windows/System32/OpenSSH/ssh.exe"},
      {rsync: "/c/msys64/usr/bin/rsync.exe", ssh: "/d/msys64/usr/bin/ssh.exe"},
      {rsync: "/c/Windows/System32/OpenSSH/rsync.exe", ssh: "/c/Windows/System32/OpenSSH/ssh.exe"},
      {rsync: "/usr/bin/rsync", ssh: "/usr/bin/native-ssh"},
    ]) {
      assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, programs}), /MSYS_RUNTIME_PAIR_REQUIRED/);
    }
    const paired = planRsyncFileTransfer(intent, manifest, {...context, programs: {
      rsync: "/c/msys64/usr/bin/rsync.exe", ssh: "/c/msys64/usr/bin/ssh.exe",
    }});
    assert.equal(paired.program, "/c/msys64/usr/bin/rsync.exe");
  });

  it("does not substitute SFTP-only or incompatible rrsync flags", () => {
    const {intent, manifest, context} = fixture();
    assert.throws(() => planRsyncFileTransfer({...intent, backend: "sftp"}, manifest, context), /BACKEND_NOT_IMPLEMENTED/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, peer: {...context.peer, auth_mode: "sftp-only"}}), /RSYNC_REMOTE_EXEC_REQUIRED/);
    assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, peer: {...context.peer, auth_mode: "rrsync", rrsync_no_overwrite: true}}), /RRSYNC_NO_OVERWRITE_PARTIAL_CONFLICT/);
  });

  it("requires private, confined, same-intent staging and an absent final target", () => {
    const {intent, manifest, context} = fixture();
    for (const change of [{private: false}, {no_links: false}, {destination: "exists"}, {operation_id: "operation:other"}, {intent_sha256: hash("other")}, {owner_ref: "owner:other"}, {state: "resume-matching", inventory_state: "unknown"}]) {
      assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, staging: {...context.staging, ...change}}));
    }
    const resumed = planRsyncFileTransfer(intent, manifest, {...context, staging: {...context.staging, state: "resume-matching", inventory_state: "verified-subset"}});
    assert.ok(resumed.argv.includes("--partial-dir=.ghostfleet-partial"));
    assert.throws(() => planRsyncFileTransfer({...intent, destination: {...intent.destination, relative_path: "."}}, manifest, context), /NEW_DESTINATION_CHILD_REQUIRED/);
  });

  it("never replans after unknown dispatch and only permits proven pre-dispatch fallback", () => {
    const {intent, manifest, context} = fixture();
    for (const dispatch_state of ["UNKNOWN", "MAY_HAVE_EXECUTED", null]) {
      assert.equal(canChangeFileTransferBackend(dispatch_state as "UNKNOWN" | "MAY_HAVE_EXECUTED" | null), false);
      assert.throws(() => planRsyncFileTransfer(intent, manifest, {...context, dispatch_state}), /RECONCILE_BEFORE_PLANNING/);
    }
    assert.equal(canChangeFileTransferBackend("NOT_DISPATCHED"), true);
  });
});

describe("independent receipt reconciliation", () => {
  it("accepts complete matching inventory and ownership after no-replace publication", () => {
    const {intent, manifest, receipt} = successReceipt();
    assert.deepEqual(verifyFileTransferReceipt(intent, manifest, receipt, "owner:destination"), {
      verified: true, outcome: "SUCCEEDED", retry_safe: false, reconcile_required: false, manifest_sha256: intent.manifest_sha256,
    });
  });

  it("rejects exit zero without complete hash, source stability, owner and publication proof", () => {
    const {intent, manifest, receipt} = successReceipt();
    for (const change of [{observed_manifest: null}, {destination_owner_ref: "owner:other"}, {publication: "not-published"}, {source_version_after: "snapshot:changed"}, {dispatch_state: "UNKNOWN"}, {operation_id: "operation:other"}, {policy_revision: "policy:other"}, {stdout: "done"}]) {
      assert.throws(() => verifyFileTransferReceipt(intent, manifest, {...receipt, ...change}, "owner:destination"));
    }
    const observed = {...manifest, entries: manifest.entries.map(e => e.kind === "file" && e.size === 5 ? {...e, sha256: hash("HELLO")} : e)};
    assert.throws(() => verifyFileTransferReceipt(intent, manifest, {...receipt, observed_manifest: observed}, "owner:destination"), /MANIFEST_MISMATCH/);
  });

  it("UNKNOWN and FAILED require reconciliation, not automatic SFTP fallback", () => {
    const {intent, manifest, receipt} = successReceipt();
    for (const outcome of ["UNKNOWN", "FAILED"]) {
      const result = verifyFileTransferReceipt(intent, manifest, {...receipt, outcome, exit_code: null, dispatch_state: "UNKNOWN", publication: "not-published", observed_manifest: null}, "owner:destination");
      assert.equal(result.verified, false); assert.equal(result.retry_safe, false); assert.equal(result.reconcile_required, true);
    }
  });

  it("requires a coherent NOT_DISPATCHED receipt before a retry is safe", () => {
    const {intent, manifest, receipt} = successReceipt();
    const notDispatched = {...receipt, outcome: "NOT_DISPATCHED", dispatch_state: "NOT_DISPATCHED", exit_code: null,
      observed_manifest: null, source_version_after: null, destination_owner_ref: null, publication: "not-published"};
    assert.equal(verifyFileTransferReceipt(intent, manifest, notDispatched, "owner:destination").retry_safe, true);
    assert.throws(() => verifyFileTransferReceipt(intent, manifest, {...notDispatched, exit_code: 0}, "owner:destination"), /INVALID_NOT_DISPATCHED_PROOF/);
  });
});
