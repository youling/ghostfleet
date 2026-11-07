import {createHash} from "node:crypto";
import {NODE_UID_RE} from "./routing.js";
import type {TargetProof} from "./transportContract.js";
import {
  FileTransferError, fileManifestSha256, fileTransferIntentSha256, fileTransferValueSha256,
  snapshotFileTransferValue, validateFileManifest, validateFileTransferIntent,
} from "./fileTransferContract.js";

export interface FileTransferRootBinding {
  readonly node_uid: string;
  readonly root_ref: string;
  /** Trusted resolver output; never an Agent-supplied host path. */
  readonly path: string;
  readonly owner_ref: string;
  readonly no_links: true;
  readonly evidence_ref: string;
}

export interface FileTransferToolInventory {
  /** Exact distribution package/build, including vendor backports when applicable. */
  readonly package_build: string;
  readonly security_baseline_ref: string;
  readonly capabilities: readonly string[];
}

/** Installed by the trusted runtime after authorization and fresh OS observations. */
export interface FileTransferPlanningContext {
  readonly now_ms: number;
  readonly dispatch_state: "NOT_DISPATCHED";
  readonly approval: {
    readonly intent_sha256: string;
    readonly operation_id: string;
    readonly actor_ref: string;
    readonly work_ref: string;
    readonly policy_revision: string;
    readonly expires_at_ms: number;
    readonly evidence_ref: string;
  };
  readonly executor: {readonly node_uid: string; readonly platform: "linux" | "windows-msys2"};
  readonly source_root: FileTransferRootBinding;
  readonly destination_root: FileTransferRootBinding;
  readonly peer: {
    readonly node_uid: string;
    readonly platform: "linux" | "windows-native";
    readonly ssh_alias: string;
    readonly ssh_config_path: string;
    readonly ssh_config_sha256: string;
    readonly target_proof: TargetProof;
    readonly auth_mode: "rsync-shell" | "rrsync" | "sftp-only";
    readonly rrsync_no_overwrite: boolean;
    readonly config_ref: string;
  };
  readonly programs: {readonly rsync: string; readonly ssh: string};
  readonly local_tools: FileTransferToolInventory;
  readonly peer_tools: FileTransferToolInventory;
  readonly staging: {
    readonly intent_sha256: string;
    readonly operation_id: string;
    readonly manifest_sha256: string;
    readonly source_version: string;
    readonly owner_ref: string;
    readonly state: "new" | "resume-matching";
    readonly inventory_state: "empty" | "verified-subset";
    readonly private: true;
    readonly no_links: true;
    readonly destination: "absent";
    readonly evidence_ref: string;
  };
}

export interface RsyncFileTransferPlan {
  readonly status: "SOURCE_PLAN_ONLY";
  readonly backend: "rsync-ssh";
  readonly intent_sha256: string;
  readonly manifest_sha256: string;
  readonly plan_sha256: string;
  readonly context_sha256: string;
  readonly executor_node_uid: string;
  readonly program: string;
  readonly argv: readonly string[];
  readonly stdin_utf8: string;
  readonly stdin_sha256: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly requires_clean_environment: true;
  readonly shell: false;
  readonly staging_path: string;
  readonly destination_path: string;
  readonly publication: "runtime-no-replace-required";
  readonly ssh_config_sha256: string;
  readonly approval_evidence_ref: string;
  readonly staging_evidence_ref: string;
  readonly local_package_build: string;
  readonly peer_package_build: string;
  readonly local_security_baseline_ref: string;
  readonly peer_security_baseline_ref: string;
  readonly windows_server_status: "NOT_VERIFIED";
}

function check(value: unknown, code: string): asserts value {
  if (!value) throw new FileTransferError(code);
}

function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  check(input !== null && typeof input === "object" && !Array.isArray(input), "INVALID_PLANNING_CONTEXT");
  const value = input as Record<string, unknown>;
  check(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), "UNKNOWN_OR_MISSING_CONTEXT_FIELD");
  return value;
}

function ref(input: unknown): void {
  check(typeof input === "string" && /^[A-Za-z0-9][A-Za-z0-9._:#/@-]{0,239}$/.test(input), "INVALID_CONTEXT_REFERENCE");
}

function sha(input: unknown): void {
  check(typeof input === "string" && /^[0-9a-f]{64}$/.test(input), "INVALID_CONTEXT_SHA256");
}

function node(input: unknown): void {
  check(typeof input === "string" && NODE_UID_RE.test(input), "INVALID_NODE_UID");
}

function safeOperandPath(path: unknown, absolute: boolean): asserts path is string {
  // Directory operands cross the SSH command boundary. File names are sent via NUL stdin.
  check(typeof path === "string" && path.length <= 4096 && /^[\p{L}\p{N}\p{M} ._/-]+$/u.test(path)
    && path === path.normalize("NFC"), "UNSUPPORTED_OPERAND_PATH");
  if (!absolute && path === ".") return;
  check(absolute ? path.startsWith("/") && !path.startsWith("//") : !path.startsWith("/"), "INVALID_ROOT_PATH_STYLE");
  const parts = path.split("/");
  if (absolute) parts.shift();
  check(parts.length > 0 && parts.every(p => p.length > 0 && p !== "." && p !== ".." && !/[ .]$/.test(p)), "INVALID_ROOT_PATH");
}

function executablePath(input: unknown): void {
  // rsync parses -e itself; keep executable/config tokens outside shell grammar.
  check(typeof input === "string" && /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(input)
    && !input.split("/").some(p => p === "." || p === ".."), "UNSUPPORTED_EXECUTABLE_PATH");
}

function inventory(input: unknown): void {
  const value = object(input, ["package_build", "security_baseline_ref", "capabilities"]);
  ref(value.package_build); ref(value.security_baseline_ref);
  const required = ["from0", "files-from-no-recursion", "remote-arg-escaping", "partial-dir"];
  check(Array.isArray(value.capabilities) && value.capabilities.length === required.length
    && required.every(k => (value.capabilities as unknown[]).includes(k)), "UNVERIFIED_TOOL_CAPABILITIES");
}

function join(root: string, relative: string): string {
  return relative === "." ? root : root === "." ? relative : `${root}/${relative}`;
}

/** No spawn/SSH/MCP side effect. SFTP is a contract seam, not an implemented backend. */
export function planRsyncFileTransfer(intentInput: unknown, manifestInput: unknown, contextInput: unknown): RsyncFileTransferPlan {
  const intent = validateFileTransferIntent(intentInput);
  const manifest = validateFileManifest(manifestInput);
  check(intent.backend === "rsync-ssh", "BACKEND_NOT_IMPLEMENTED");
  const intentSha = fileTransferIntentSha256(intent);
  check(intent.manifest_sha256 === fileManifestSha256(manifest) && intent.source_version === manifest.source_version, "MANIFEST_BINDING_MISMATCH");
  check(intent.destination.relative_path !== ".", "NEW_DESTINATION_CHILD_REQUIRED");
  const raw = snapshotFileTransferValue(contextInput);
  const value = object(raw, ["now_ms", "dispatch_state", "approval", "executor", "source_root", "destination_root", "peer", "programs", "local_tools", "peer_tools", "staging"]);
  check(typeof value.now_ms === "number" && Number.isSafeInteger(value.now_ms) && value.now_ms >= 0, "INVALID_CLOCK");
  check(value.dispatch_state === "NOT_DISPATCHED", "RECONCILE_BEFORE_PLANNING");
  const approval = object(value.approval, ["intent_sha256", "operation_id", "actor_ref", "work_ref", "policy_revision", "expires_at_ms", "evidence_ref"]);
  ref(approval.evidence_ref);
  check(approval.intent_sha256 === intentSha && approval.operation_id === intent.operation_id && approval.actor_ref === intent.actor_ref
    && approval.work_ref === intent.work_ref && approval.policy_revision === intent.policy_revision, "APPROVAL_BINDING_MISMATCH");
  check(typeof approval.expires_at_ms === "number" && Number.isSafeInteger(approval.expires_at_ms) && approval.expires_at_ms > value.now_ms, "APPROVAL_EXPIRED");
  const executor = object(value.executor, ["node_uid", "platform"]);
  node(executor.node_uid);
  check(executor.platform === "linux" || executor.platform === "windows-msys2", "UNSUPPORTED_EXECUTOR_PLATFORM");
  const peer = object(value.peer, ["node_uid", "platform", "ssh_alias", "ssh_config_path", "ssh_config_sha256", "target_proof", "auth_mode", "rrsync_no_overwrite", "config_ref"]);
  node(peer.node_uid);
  check(peer.platform === "linux", "WINDOWS_SSH_SERVER_NOT_VERIFIED");
  check(peer.auth_mode === "rsync-shell" || peer.auth_mode === "rrsync", "RSYNC_REMOTE_EXEC_REQUIRED");
  check(typeof peer.rrsync_no_overwrite === "boolean", "INVALID_RRSYNC_POLICY");
  check(!peer.rrsync_no_overwrite, "RRSYNC_NO_OVERWRITE_PARTIAL_CONFLICT");
  check(typeof peer.ssh_alias === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(peer.ssh_alias), "INVALID_SSH_ALIAS");
  executablePath(peer.ssh_config_path); sha(peer.ssh_config_sha256); ref(peer.config_ref);
  const proof = object(peer.target_proof, ["method", "detail_digest"]);
  check(proof.method === "pinned_host_key", "PINNED_HOST_KEY_REQUIRED");
  sha(proof.detail_digest);
  const local = intent.direction === "push" ? intent.source : intent.destination;
  const remote = intent.direction === "push" ? intent.destination : intent.source;
  check(executor.node_uid === local.node_uid && peer.node_uid === remote.node_uid, "ENDPOINT_IDENTITY_MISMATCH");
  for (const name of ["source_root", "destination_root"] as const) {
    const root = object(value[name], ["node_uid", "root_ref", "path", "owner_ref", "no_links", "evidence_ref"]);
    const expected = name === "source_root" ? intent.source : intent.destination;
    check(root.node_uid === expected.node_uid && root.root_ref === expected.root_ref, "ROOT_BINDING_MISMATCH");
    ref(root.owner_ref); ref(root.evidence_ref);
    check(root.no_links === true, "ROOT_CONFINEMENT_PROOF_REQUIRED");
    safeOperandPath(root.path, root.node_uid !== peer.node_uid || peer.auth_mode !== "rrsync");
    if (root.node_uid === executor.node_uid && executor.platform === "windows-msys2") {
      check(typeof root.path === "string" && /^\/[a-z]\//.test(root.path), "MSYS_DRIVE_PATH_REQUIRED");
    }
  }
  const programs = object(value.programs, ["rsync", "ssh"]);
  executablePath(programs.rsync); executablePath(programs.ssh);
  if (executor.platform === "windows-msys2") {
    const rsyncPath = programs.rsync as string;
    const sshPath = programs.ssh as string;
    const rsyncBin = rsyncPath.slice(0, rsyncPath.lastIndexOf("/"));
    const sshBin = sshPath.slice(0, sshPath.lastIndexOf("/"));
    check(rsyncBin === sshBin && /(?:^|\/)usr\/bin$/.test(rsyncBin)
      && /\/rsync(?:\.exe)?$/.test(rsyncPath) && /\/ssh(?:\.exe)?$/.test(sshPath), "MSYS_RUNTIME_PAIR_REQUIRED");
  }
  // The runtime must additionally verify that these exact files belong to the approved build.
  inventory(value.local_tools); inventory(value.peer_tools);
  const staging = object(value.staging, ["intent_sha256", "operation_id", "manifest_sha256", "source_version", "owner_ref", "state", "inventory_state", "private", "no_links", "destination", "evidence_ref"]);
  ref(staging.evidence_ref);
  const destinationRoot = value.destination_root as unknown as FileTransferRootBinding;
  check(staging.intent_sha256 === intentSha && staging.operation_id === intent.operation_id && staging.manifest_sha256 === intent.manifest_sha256
    && staging.source_version === intent.source_version && staging.owner_ref === destinationRoot.owner_ref, "STAGING_BINDING_MISMATCH");
  check((staging.state === "new" && staging.inventory_state === "empty") || (staging.state === "resume-matching" && staging.inventory_state === "verified-subset"), "UNVERIFIED_PARTIAL_STATE");
  check(staging.private === true && staging.no_links === true && staging.destination === "absent", "STAGING_CONFINEMENT_REQUIRED");
  const context = value as unknown as FileTransferPlanningContext;
  const sourcePath = join(context.source_root.path, intent.source.relative_path);
  const destinationPath = join(destinationRoot.path, intent.destination.relative_path);
  const stagingPath = join(destinationRoot.path, `.ghostfleet-transfer/${intentSha}/incoming`);
  safeOperandPath(sourcePath, intent.direction === "push" || context.peer.auth_mode !== "rrsync");
  safeOperandPath(destinationPath, intent.direction === "pull" || context.peer.auth_mode !== "rrsync");
  // The leading ./ is rsync's safe relative operand, not an authorized path component.
  const remoteOperand = (path: string): string => `${context.peer.ssh_alias}:${path.startsWith("/") ? path : path === "." ? "." : `./${path}`}/`;
  const sourceOperand = intent.direction === "push" ? `${sourcePath}/` : remoteOperand(sourcePath);
  const destinationOperand = intent.direction === "push" ? remoteOperand(stagingPath) : `${stagingPath}/`;
  const ssh = [context.programs.ssh, "-F", context.peer.ssh_config_path,
    "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oIdentitiesOnly=yes", "-oForwardAgent=no", "-oClearAllForwardings=yes", "-oRequestTTY=no"].join(" ");
  // No -r: explicit directory entries must not recursively select unapproved children.
  // No -s: rrsync must inspect the server arguments. Require tested default arg escaping.
  const argv = ["--no-recursive", "--dirs", "--relative", "--from0", "--files-from=-", "--no-links", "--no-devices", "--no-specials",
    "--no-owner", "--no-group", "--no-perms", "--partial-dir=.ghostfleet-partial", `--rsh=${ssh}`, "--rsync-path=rsync", "--", sourceOperand, destinationOperand];
  const stdin = manifest.entries.map(e => `${e.path}\0`).join("");
  const plan = {
    status: "SOURCE_PLAN_ONLY" as const, backend: "rsync-ssh" as const, intent_sha256: intentSha, manifest_sha256: intent.manifest_sha256,
    context_sha256: fileTransferValueSha256(context),
    executor_node_uid: context.executor.node_uid, program: context.programs.rsync, argv, stdin_utf8: stdin,
    stdin_sha256: createHash("sha256").update(stdin, "utf8").digest("hex"),
    environment: {LC_ALL: "C.UTF-8", RSYNC_OLD_ARGS: "0", RSYNC_PROTECT_ARGS: "0"},
    requires_clean_environment: true as const, shell: false as const, staging_path: stagingPath, destination_path: destinationPath,
    publication: "runtime-no-replace-required" as const, ssh_config_sha256: context.peer.ssh_config_sha256,
    approval_evidence_ref: context.approval.evidence_ref, staging_evidence_ref: context.staging.evidence_ref,
    local_package_build: context.local_tools.package_build, peer_package_build: context.peer_tools.package_build,
    local_security_baseline_ref: context.local_tools.security_baseline_ref, peer_security_baseline_ref: context.peer_tools.security_baseline_ref,
    windows_server_status: "NOT_VERIFIED" as const,
  };
  return snapshotFileTransferValue({...plan, plan_sha256: fileTransferValueSha256(plan)}) as RsyncFileTransferPlan;
}
