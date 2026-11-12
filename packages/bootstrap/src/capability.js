import { createHash } from "node:crypto";

// Selected-capability contract.
//
// A reviewed enrollment template decides whether a node needs the bounded
// privileged helper and the dedicated user-service/Linger lane. When it does,
// the deployment renders those capabilities into the SAME authorized first-root
// courier together with the exact artifact version and digests it reviewed.
// The courier then installs inside that single root ceremony and never asks for
// a second password. A template that does not request a capability renders the
// immutable default block, which selects nothing and installs nothing.

export const SELECTED_CAPABILITY_SCHEMA = "ghostfleet-selected-capability/v2";
export const CAPABILITY_BLOCK_BEGIN = "# @@GHOSTFLEET_SELECTED_CAPABILITY_BEGIN@@";
export const CAPABILITY_BLOCK_END = "# @@GHOSTFLEET_SELECTED_CAPABILITY_END@@";
// The whole capability lane, including the data block and its functions, is
// delimited so a disposable root job can execute the exact published slice.
export const CAPABILITY_SECTION_BEGIN = "# @@GHOSTFLEET_CAPABILITY_SECTION_BEGIN@@";
export const CAPABILITY_SECTION_END = "# @@GHOSTFLEET_CAPABILITY_SECTION_END@@";

export const CAPABILITY_MAX_ARTIFACTS = 16;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_MODE = /^0?[0-7]{3}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$/;
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const UNIT_NAME = /^[a-z][a-z0-9_.-]{0,63}\.service$/;
const SELECTION_TEXT_KEYS = new Set([
  "schema", "version", "template_digest", "helper_required", "linger_required",
  "user_service_required", "control_account", "privileged_account", "installer",
  "privileged_key", "user_unit", "user_unit_artifact", "user_unit_payload_artifact",
  "user_unit_payload_path", "user_unit_payload_mode", "artifact",
]);
const SELECTION_KEYS = [
  "source", "template_digest", "version", "helper_required", "linger_required",
  "user_service_required", "control_account", "privileged_account", "installer",
  "privileged_key", "user_unit", "artifacts",
];
const USER_UNIT_KEYS = ["name", "artifact", "payload_artifact", "payload_path", "payload_mode"];

const invalid = (code) => new Error(code);

export function capabilityDigest(selection) {
  const canonical = JSON.stringify({
    schema: SELECTED_CAPABILITY_SCHEMA,
    version: selection.version,
    template_digest: selection.template_digest,
    helper_required: selection.helper_required,
    linger_required: selection.linger_required,
    user_service_required: selection.user_service_required,
    control_account: selection.control_account,
    privileged_account: selection.privileged_account,
    artifacts: selection.artifacts.map((item) => [item.name, item.sha256, item.mode]),
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * Map a resolved enrollment-template posture to the capability inputs the
 * courier needs. Returns null when the template selects no privileged
 * component, so callers can render an install-nothing courier.
 */
export function selectedCapabilitiesFromPosture(posture, { userUnit = null } = {}) {
  const value = posture && typeof posture === "object" && !Array.isArray(posture) ? posture : {};
  const helper_required = value.privilege?.helper_required === true;
  const linger_required = Array.isArray(value.roles) && value.roles.includes("managed");
  const user_service_required = userUnit !== null && userUnit !== undefined;
  if (!helper_required && !linger_required && !user_service_required) return null;
  return Object.freeze({ helper_required, linger_required, user_service_required });
}

// Artifacts are pinned twice: by the content address that travels with the
// claim, and by the bytes the immutable asset origin serves. A selection may
// still carry the reviewed bytes (a deployment bundle computed them), but the
// wire form never does - the courier re-fetches and re-verifies every byte.
function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw invalid("CAPABILITY_ARTIFACTS_REQUIRED");
  const seen = new Set();
  return artifacts.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid("CAPABILITY_ARTIFACT_INVALID");
    const name = item.name;
    if (typeof name !== "string" || !ARTIFACT_NAME.test(name)) throw invalid("CAPABILITY_ARTIFACT_NAME_INVALID");
    if (seen.has(name)) throw invalid("CAPABILITY_ARTIFACT_DUPLICATE");
    seen.add(name);
    const mode = String(item.mode ?? "0644");
    if (!FILE_MODE.test(mode)) throw invalid("CAPABILITY_ARTIFACT_MODE_INVALID");
    const hasContent = item.content !== undefined && item.content !== null;
    let sha256;
    if (hasContent) {
      // A reviewed artifact is a byte string. Most fixtures are UTF-8 text, but
      // the pinned agent payload is a zipapp, so a deployment bundle may carry
      // raw bytes and the digest must cover exactly those bytes.
      const bytes = typeof item.content === "string"
        ? Buffer.from(item.content, "utf8")
        : (item.content instanceof Uint8Array ? Buffer.from(item.content) : null);
      if (!bytes) throw invalid("CAPABILITY_ARTIFACT_CONTENT_INVALID");
      if (typeof item.content === "string" && item.content.includes("\u0000")) throw invalid("CAPABILITY_ARTIFACT_CONTENT_INVALID");
      if (!bytes.length) throw invalid("CAPABILITY_ARTIFACT_CONTENT_INVALID");
      sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      // A declared digest is an assertion about the reviewed bytes, not a
      // second source of truth: a mismatch means the artifact changed after
      // review, so the deployment must re-review rather than relabel.
      if (item.sha256 !== undefined && String(item.sha256).replace(/^sha256:/, "") !== sha256.slice(7)) {
        throw invalid("CAPABILITY_ARTIFACT_DIGEST_MISMATCH");
      }
    } else {
      const declared = String(item.sha256 ?? "").replace(/^sha256:/, "");
      if (!RAW_DIGEST.test(declared)) throw invalid("CAPABILITY_ARTIFACT_DIGEST_REQUIRED");
      sha256 = "sha256:" + declared;
    }
    const normalized = {
      name,
      mode: "0" + mode.replace(/^0/, ""),
      sha256: sha256.slice("sha256:".length),
    };
    if (hasContent) normalized.content = item.content;
    return Object.freeze(normalized);
  });
}

/**
 * Validate a deployment-rendered selection. Every failure is a hard error at
 * render time, so a malformed or unrequested privileged component can never
 * reach a host.
 */
// Where the courier installs the pinned agent payload and the exact mode that
// payload must carry. The released user unit starts this path and nothing else,
// so the destination is part of the published contract and the courier
// re-asserts the installed unit against the file it just wrote.
export const AGENT_PAYLOAD_PATH = "/usr/local/libexec/ghostfleet/node-agent.pyz";
export const AGENT_PAYLOAD_MODE = "0755";
export const AGENT_USER_UNIT_NAME = "ghostfleet-managed.service";
// Non-secret agent configuration. The courier writes it root:root 0644 so the
// managed account reads its control-plane origin from a root-owned file
// instead of trusting anything the task channel could deliver.
export const AGENT_CONFIG_PATH = "/etc/ghostfleet/node-agent.json";

// A deployment renders the reviewed selection, and only the review pins the
// exact destination. The shape below keeps the courier from installing the
// payload anywhere that is not a ghostfleet libexec directory while still
// allowing the disposable-linux harness to relocate the prefix so the same
// code path runs without root. Production always renders AGENT_PAYLOAD_PATH.
const PAYLOAD_PATH_SHAPE = /^\/[A-Za-z0-9._/-]*\/libexec\/ghostfleet\/node-agent\.pyz$/;

function isPayloadPath(value) {
  return typeof value === "string"
    && PAYLOAD_PATH_SHAPE.test(value)
    && !value.includes("..")
    && !value.includes("//");
}

// A pinned user unit is a launcher for the installed payload, never a script
// transport. A unit that spawns a shell interpreter with -c, fetches remote
// code, or declares any Exec directive other than ExecStart would let a later
// template change turn the managed run account into arbitrary code execution.
const UNIT_SHELL_INTERPRETER = /(^|[^A-Za-z0-9_.-])(sh|bash|dash|zsh)[ \t]+-c([^A-Za-z0-9_.-]|$)/;
const UNIT_REMOTE_FETCH = /(^|[^A-Za-z0-9_.-])(curl|wget|fetch)([^A-Za-z0-9_.-]|$)/;
const UNIT_BIN_SH = /(^|[^A-Za-z0-9_.-])\/bin\/sh([^A-Za-z0-9_.-]|$)/;
// systemd accepts a small, documented value set per hardening directive. A unit
// that asks for a value systemd rejects (ProtectHome=read-write was the shipped
// draft) fails to start at all, so the shape is refused at render time instead
// of being discovered on the managed host.
const UNIT_HARDENING = new Map([
  ["protecthome", ["yes", "no", "true", "false", "read-only", "tmpfs"]],
  ["protectsystem", ["yes", "no", "true", "false", "full", "strict"]],
  ["protectkerneltunables", ["yes", "no", "true", "false"]],
  ["protectkernelmodules", ["yes", "no", "true", "false"]],
  ["protectkernellogs", ["yes", "no", "true", "false"]],
  ["protectcontrolgroups", ["yes", "no", "true", "false"]],
  ["protectclock", ["yes", "no", "true", "false"]],
  ["protecthostname", ["yes", "no", "true", "false"]],
  ["protectproc", ["default", "invisible", "no", "yes", "true", "false"]],
  ["nonewprivileges", ["yes", "no", "true", "false"]],
  ["privatetmp", ["yes", "no", "true", "false", "disconnected"]],
  ["privatedevices", ["yes", "no", "true", "false"]],
  ["privateusers", ["yes", "no", "true", "false"]],
  ["privateipc", ["yes", "no", "true", "false"]],
  ["privatenetwork", ["yes", "no", "true", "false"]],
  ["lockpersonality", ["yes", "no", "true", "false"]],
  ["memorydenywriteexecute", ["yes", "no", "true", "false"]],
  ["restrictsuidgid", ["yes", "no", "true", "false"]],
  ["restrictrealtime", ["yes", "no", "true", "false"]],
  ["restrictnamespaces", ["yes", "no", "true", "false"]],
]);
// Directives that hand the manager unit a writable path outside the run
// account's own home. Only ReadWritePaths may open write access, and only for
// %h-owned state, so a later template edit cannot widen the filesystem view.
const UNIT_OUTSIDE_HOME = new Set([
  "bindpaths", "bindreadonlypaths", "rootdirectory", "mountimages",
  "runtimedirectory",
]);
// A --user unit resolves StateDirectory/ConfigurationDirectory under the run
// account's own XDG directories, which is exactly where ReadWritePaths points.
// systemd creates and owns those directories before the sandbox is built, so a
// unit that lists %h/... in ReadWritePaths without declaring the matching
// directory directive dies with status=226/NAMESPACE on a fresh host. Accept
// only a single relative component (it cannot escape the home) and require the
// directive to agree with every %h ReadWritePaths entry it has to provide.
const UNIT_HOME_DIRECTORY = new Map([
  ["statedirectory", ["%h/.local/state/", "state"]],
  ["configurationdirectory", ["%h/.config/", "config"]],
]);
const UNIT_HOME_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function assertUnitSafe(content, payloadPath) {
  let execStart = 0;
  let execStartArgv = "";
  const declaredDirectories = new Map();
  const requiredDirectories = new Map();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (/^\[[A-Za-z]+\]$/.test(trimmed)) continue;
    const directive = /^([A-Za-z][A-Za-z0-9]*)[ \t]*=(.*)$/.exec(trimmed);
    if (!directive) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    const key = directive[1];
    const value = directive[2].trim();
    const lower = key.toLowerCase();
    if (key === "ExecStart") {
      execStart += 1;
      execStartArgv = value;
      continue;
    }
    if (lower.startsWith("exec")) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    if (lower === "readwritepaths") {
      for (const token of value.split(/[ \t]+/).filter(Boolean)) {
        const target = token.replace(/^-/, "");
        if (!target.startsWith("%h/") || target.includes("..")) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
        for (const [directive, [prefix, kind]] of UNIT_HOME_DIRECTORY) {
          if (!target.startsWith(prefix)) continue;
          const name = target.slice(prefix.length);
          if (!name || name.includes("/")) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
          requiredDirectories.set(directive, { name, kind });
        }
      }
      continue;
    }
    if (UNIT_HOME_DIRECTORY.has(lower)) {
      if (!UNIT_HOME_DIRECTORY_NAME.test(value)) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
      declaredDirectories.set(lower, value);
      continue;
    }
    if (lower === "workingdirectory") {
      const target = value.replace(/^-/, "");
      if (!target.startsWith("%h") || target.includes("..")) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
      continue;
    }
    if (UNIT_OUTSIDE_HOME.has(lower)) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    const legal = UNIT_HARDENING.get(lower);
    if (legal && !legal.includes(value)) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
  }
  for (const [directive, required] of requiredDirectories) {
    if (declaredDirectories.get(directive) !== required.name) {
      throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    }
  }
  if (execStart > 1) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
  if (execStart === 1) {
    const argv = execStartArgv.split(/[ \t]+/).filter(Boolean);
    const binary = argv[0];
    if (!binary || !binary.startsWith("/")) throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    if (binary === "/usr/bin/env") throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    if (typeof payloadPath === "string" && payloadPath.length && !argv.includes(payloadPath)) {
      throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    }
    // The production launcher is exactly the reviewed literal: the system
    // interpreter with -I (no site-packages, no PYTHONPATH), the pinned payload
    // path and the run subcommand. --config/--token/--url style overrides are a
    // test seam on the agent and must never be reachable from the shipped unit.
    if (argv.some((token) => /^--(config|token|url|endpoint|host|auth|credential)(=|$)/.test(token))) {
      throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
    }
    if (typeof payloadPath === "string" && payloadPath.length) {
      const expectedArgv = ["/usr/bin/python3", "-I", payloadPath, "run"];
      if (argv.length !== expectedArgv.length || expectedArgv.some((token, index) => argv[index] !== token)) {
        throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
      }
    }
  }
  if (UNIT_SHELL_INTERPRETER.test(content) || UNIT_REMOTE_FETCH.test(content) || UNIT_BIN_SH.test(content)) {
    throw invalid("CAPABILITY_USER_UNIT_UNSAFE");
  }
}

// The managed role pins two artifacts by name: the launcher bytes and the
// runtime bytes the launcher starts. A deployment may address the runtime by
// its content digest instead of its pinned name; both forms resolve to the
// pinned row so the encoded claim and the rendered block stay name-addressed.
function resolveManagedArtifact(declared, artifacts, names) {
  if (typeof declared !== "string" || !declared.length) {
    throw invalid("CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE");
  }
  if (names.has(declared)) return artifacts.find((item) => item.name === declared);
  const digest = declared.replace(/^sha256:/, "");
  if (RAW_DIGEST.test(digest)) {
    const matches = artifacts.filter((item) => item.sha256 === digest);
    if (matches.length === 1) return matches[0];
  }
  throw invalid("CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE");
}

export function normalizeSelectedCapability(selection) {
  if (selection === null || selection === undefined) return null;
  if (typeof selection !== "object" || Array.isArray(selection)) throw invalid("CAPABILITY_SELECTION_INVALID");
  for (const key of Object.keys(selection)) {
    if (!SELECTION_KEYS.includes(key)) throw invalid("CAPABILITY_SELECTION_INVALID");
  }
  const version = selection.version;
  if (typeof version !== "string" || !VERSION.test(version)) throw invalid("CAPABILITY_VERSION_INVALID");
  const template_digest = selection.template_digest;
  if (typeof template_digest !== "string" || !DIGEST.test(template_digest)) throw invalid("CAPABILITY_TEMPLATE_DIGEST_INVALID");
  const source = selection.source ?? "template";
  if (source !== "template") throw invalid("CAPABILITY_SOURCE_INVALID");
  const helper_required = selection.helper_required === true;
  const linger_required = selection.linger_required === true;
  const user_service_required = selection.user_service_required === true;
  const selected = helper_required || linger_required || user_service_required;
  const artifacts = normalizeArtifacts(selection.artifacts ?? []);
  if (artifacts.length > CAPABILITY_MAX_ARTIFACTS) throw invalid("CAPABILITY_TOO_MANY_ARTIFACTS");
  // The template — not the caller — decides whether a privileged component is
  // installed. Supplying pinned artifacts without a template request is refused
  // rather than silently ignored.
  if (!selected) throw invalid("CAPABILITY_NOT_REQUESTED_BY_TEMPLATE");
  if (!artifacts.length) throw invalid("CAPABILITY_ARTIFACTS_REQUIRED");
  const names = new Set(artifacts.map((item) => item.name));

  let control_account = selection.control_account ?? null;
  // The privileged account is the identity the reviewed installer provisions
  // with the bounded NOPASSWD helper rule. It is a deployment fact the courier
  // must be told: guessing a default here would forge the security boundary the
  // run account is supposed to be separated from.
  let privileged_account = selection.privileged_account ?? null;
  if (helper_required || linger_required || user_service_required) {
    if (typeof control_account !== "string" || !ACCOUNT.test(control_account)) throw invalid("CAPABILITY_CONTROL_ACCOUNT_INVALID");
    if (control_account === "root") throw invalid("CAPABILITY_CONTROL_ACCOUNT_INVALID");
    if (typeof privileged_account !== "string" || !ACCOUNT.test(privileged_account)) throw invalid("CAPABILITY_PRIVILEGED_ACCOUNT_REQUIRED");
    if (privileged_account === "root") throw invalid("CAPABILITY_PRIVILEGED_ACCOUNT_INVALID");
    if (privileged_account === control_account) throw invalid("CAPABILITY_ACCOUNT_COLLISION");
  } else {
    control_account = null;
    privileged_account = null;
  }

  let installer = selection.installer ?? null;
  let privileged_key = selection.privileged_key ?? null;
  let user_unit = null;
  if (helper_required) {
    if (typeof installer !== "string" || !names.has(installer)) throw invalid("CAPABILITY_INSTALLER_NOT_PINNED");
    if (typeof privileged_key !== "string" || !names.has(privileged_key)) throw invalid("CAPABILITY_PRIVILEGED_KEY_NOT_PINNED");
    if (privileged_key === installer) throw invalid("CAPABILITY_PRIVILEGED_KEY_INVALID");
  } else {
    if (installer !== null || privileged_key !== null) throw invalid("CAPABILITY_NOT_REQUESTED_BY_TEMPLATE");
    installer = null;
    privileged_key = null;
  }
  if (user_service_required) {
    // A user service without Linger disappears when the Human's last session
    // ends, so it is not a managed service at all: refuse the shape instead of
    // installing a lane whose lifetime is decided by someone else's logout.
    if (!linger_required) throw invalid("CAPABILITY_USER_SERVICE_REQUIRES_LINGER");
    const unit = selection.user_unit;
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) throw invalid("CAPABILITY_USER_UNIT_REQUIRED");
    for (const key of Object.keys(unit)) {
      if (!USER_UNIT_KEYS.includes(key)) throw invalid("CAPABILITY_USER_UNIT_INVALID");
    }
    if (typeof unit.name !== "string" || !UNIT_NAME.test(unit.name)) throw invalid("CAPABILITY_USER_UNIT_INVALID");
    if (typeof unit.artifact !== "string" || !names.has(unit.artifact)) throw invalid("CAPABILITY_USER_UNIT_NOT_PINNED");
    // The managed role owns two artifacts: the launcher bytes and the runtime
    // bytes it starts. A selection that pins only one of them is refused here,
    // which is the only place that can stop a half-installable managed lane.
    const payloadArtifact = resolveManagedArtifact(unit.payload_artifact, artifacts, names);
    if (payloadArtifact.name === unit.artifact) throw invalid("CAPABILITY_USER_UNIT_PAYLOAD_INVALID");
    // The destination and the mode are contract, not preference: the courier
    // writes the payload root:root 0755 at the reviewed path and starts exactly
    // that file, so a selection that redirects either one is refused.
    if (unit.payload_path !== AGENT_PAYLOAD_PATH && !isPayloadPath(unit.payload_path)) {
      throw invalid("CAPABILITY_USER_UNIT_PAYLOAD_INVALID");
    }
    if (unit.payload_mode !== AGENT_PAYLOAD_MODE) throw invalid("CAPABILITY_USER_UNIT_PAYLOAD_INVALID");
    if (payloadArtifact.mode !== AGENT_PAYLOAD_MODE) throw invalid("CAPABILITY_USER_UNIT_PAYLOAD_INVALID");
    const unitArtifact = artifacts.find((item) => item.name === unit.artifact);
    if (typeof unitArtifact.content === "string") assertUnitSafe(unitArtifact.content, unit.payload_path);
    user_unit = Object.freeze({
      name: unit.name,
      artifact: unit.artifact,
      payload_artifact: payloadArtifact.name,
      payload_path: unit.payload_path,
      payload_mode: AGENT_PAYLOAD_MODE,
    });
  } else if (selection.user_unit !== null && selection.user_unit !== undefined) {
    throw invalid("CAPABILITY_NOT_REQUESTED_BY_TEMPLATE");
  }

  const normalized = Object.freeze({
    schema: SELECTED_CAPABILITY_SCHEMA,
    source,
    version,
    template_digest,
    helper_required,
    linger_required,
    user_service_required,
    control_account,
    privileged_account,
    installer,
    privileged_key,
    user_unit,
    artifacts: Object.freeze(artifacts),
  });
  return Object.freeze({ ...normalized, selection_digest: capabilityDigest(normalized) });
}

const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const flag = (value) => (value ? "1" : "0");

/** Render the data-only shell block consumed by the published courier. */
export function renderCapabilityBlock(selection) {
  const normalized = normalizeSelectedCapability(selection ?? null);
  const lines = [];
  if (!normalized) {
    lines.push("CAPABILITY_SELECTION_ORIGIN='none'", "CAPABILITY_SCHEMA=''", "CAPABILITY_SOURCE=''", "CAPABILITY_VERSION=''",
      "CAPABILITY_TEMPLATE_DIGEST=''", "CAPABILITY_SELECTION_DIGEST=''",
      "CAPABILITY_HELPER_REQUIRED=0", "CAPABILITY_LINGER_REQUIRED=0",
      "CAPABILITY_USER_SERVICE_REQUIRED=0", "CAPABILITY_CONTROL_ACCOUNT=''",
      "CAPABILITY_PRIVILEGED_ACCOUNT=''",
      "CAPABILITY_INSTALLER=''", "CAPABILITY_PRIVILEGED_KEY=''",
      "CAPABILITY_USER_UNIT=''", "CAPABILITY_USER_UNIT_ARTIFACT=''",
      "CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT=''", "CAPABILITY_USER_UNIT_PAYLOAD_PATH=''",
      "CAPABILITY_USER_UNIT_PAYLOAD_MODE=''", "CAPABILITY_ARTIFACT_COUNT=0");
    return lines.join("\n");
  }
  lines.push(
    "CAPABILITY_SELECTION_ORIGIN='render'",
    "CAPABILITY_SCHEMA=" + quote(normalized.schema),
    "CAPABILITY_SOURCE=" + quote(normalized.source),
    "CAPABILITY_VERSION=" + quote(normalized.version),
    "CAPABILITY_TEMPLATE_DIGEST=" + quote(normalized.template_digest),
    "CAPABILITY_SELECTION_DIGEST=" + quote(normalized.selection_digest),
    "CAPABILITY_HELPER_REQUIRED=" + flag(normalized.helper_required),
    "CAPABILITY_LINGER_REQUIRED=" + flag(normalized.linger_required),
    "CAPABILITY_USER_SERVICE_REQUIRED=" + flag(normalized.user_service_required),
    "CAPABILITY_CONTROL_ACCOUNT=" + quote(normalized.control_account),
    "CAPABILITY_PRIVILEGED_ACCOUNT=" + quote(normalized.privileged_account ?? ""),
    "CAPABILITY_INSTALLER=" + quote(normalized.installer ?? ""),
    "CAPABILITY_PRIVILEGED_KEY=" + quote(normalized.privileged_key ?? ""),
    "CAPABILITY_USER_UNIT=" + quote(normalized.user_unit?.name ?? ""),
    "CAPABILITY_USER_UNIT_ARTIFACT=" + quote(normalized.user_unit?.artifact ?? ""),
    "CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT=" + quote(normalized.user_unit?.payload_artifact ?? ""),
    "CAPABILITY_USER_UNIT_PAYLOAD_PATH=" + quote(normalized.user_unit?.payload_path ?? ""),
    "CAPABILITY_USER_UNIT_PAYLOAD_MODE=" + quote(normalized.user_unit?.payload_mode ?? ""),
    "CAPABILITY_ARTIFACT_COUNT=" + normalized.artifacts.length,
  );
  normalized.artifacts.forEach((item, index) => {
    // Address only. The courier resolves the bytes at the immutable asset
    // origin and refuses anything whose digest is not this exact value.
    const row = [item.name, item.sha256, item.mode].join("|");
    lines.push("CAPABILITY_ARTIFACT_" + (index + 1) + "=" + quote(row));
  });
  // Rows are data; the courier owns the fixed-width accessor so a claim-time
  // selection and a deployment-rendered selection share one implementation.
  return lines.join("\n");
}

/** Encode a selection as the compact, shell-parsable text the claim delivers. */
function selectionInput(selection) {
  // A normalized selection carries derived fields; rebuild only the input shape
  // so encode/decode round-trips without re-declaring digests.
  return {
    source: selection.source ?? "template",
    version: selection.version,
    template_digest: selection.template_digest,
    helper_required: selection.helper_required === true,
    linger_required: selection.linger_required === true,
    user_service_required: selection.user_service_required === true,
    control_account: selection.control_account ?? null,
    privileged_account: selection.privileged_account ?? null,
    installer: selection.installer ?? null,
    privileged_key: selection.privileged_key ?? null,
    user_unit: selection.user_unit ?? null,
    artifacts: (selection.artifacts ?? []).map((item) => ({
      name: item.name,
      mode: item.mode,
      // A normalized selection from the claim has no bytes, only its digest.
      sha256: item.sha256,
      ...(item.content === undefined ? {} : { content: item.content }),
    })),
  };
}

export function encodeCapabilitySelection(selection, { templateDigest = null } = {}) {
  const input = selectionInput(selection);
  const normalized = normalizeSelectedCapability(
    templateDigest ? { ...input, template_digest: templateDigest } : input,
  );
  if (!normalized) throw invalid("CAPABILITY_SELECTION_REQUIRED");
  const lines = [
    "schema=" + normalized.schema,
    "version=" + normalized.version,
    "template_digest=" + normalized.template_digest,
    "helper_required=" + (normalized.helper_required ? "1" : "0"),
    "linger_required=" + (normalized.linger_required ? "1" : "0"),
    "user_service_required=" + (normalized.user_service_required ? "1" : "0"),
    "control_account=" + normalized.control_account,
    "privileged_account=" + (normalized.privileged_account ?? ""),
    "installer=" + (normalized.installer ?? ""),
    "privileged_key=" + (normalized.privileged_key ?? ""),
    "user_unit=" + (normalized.user_unit?.name ?? ""),
    "user_unit_artifact=" + (normalized.user_unit?.artifact ?? ""),
    "user_unit_payload_artifact=" + (normalized.user_unit?.payload_artifact ?? ""),
    "user_unit_payload_path=" + (normalized.user_unit?.payload_path ?? ""),
    "user_unit_payload_mode=" + (normalized.user_unit?.payload_mode ?? ""),
  ];
  for (const item of normalized.artifacts) {
    // A1: the claim delivers the content address, never the artifact bytes.
    lines.push("artifact=" + [item.name, item.sha256, item.mode].join("|"));
  }
  return Buffer.from(lines.join("\n") + "\n", "utf8").toString("base64");
}

/** Parse the claim-delivered selection back into the validated shape. */
export function decodeCapabilitySelection(text, { templateDigest = null } = {}) {
  if (typeof text !== "string" || !text.length) throw invalid("CAPABILITY_SELECTION_INVALID");
  const fields = new Map();
  const artifacts = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const index = line.indexOf("=");
    if (index <= 0) throw invalid("CAPABILITY_SELECTION_INVALID");
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!SELECTION_TEXT_KEYS.has(key)) throw invalid("CAPABILITY_SELECTION_INVALID");
    if (key === "artifact") {
      const parts = value.split("|");
      // v2-schema artifact rows are addresses: name|sha256|mode. Inline bytes
      // are a legacy shape that let the delivery carry unreviewed content, so
      // they are refused rather than silently preferenced over the asset origin.
      if (parts.length !== 3) throw invalid("CAPABILITY_ARTIFACT_ROW_INVALID");
      const [name, sha256, mode] = parts;
      if (!name || !sha256 || !mode) throw invalid("CAPABILITY_ARTIFACT_ROW_INVALID");
      artifacts.push({ name, sha256: "sha256:" + sha256, mode });
      continue;
    }
    if (fields.has(key)) throw invalid("CAPABILITY_SELECTION_INVALID");
    fields.set(key, value);
  }
  if (fields.get("schema") !== SELECTED_CAPABILITY_SCHEMA) throw invalid("CAPABILITY_SELECTION_INVALID");
  return normalizeSelectedCapability({
    source: "template",
    version: fields.get("version"),
    template_digest: templateDigest ?? fields.get("template_digest"),
    helper_required: fields.get("helper_required") === "1",
    linger_required: fields.get("linger_required") === "1",
    user_service_required: fields.get("user_service_required") === "1",
    control_account: fields.get("control_account"),
    privileged_account: fields.get("privileged_account"),
    installer: fields.get("installer") || null,
    privileged_key: fields.get("privileged_key") || null,
    user_unit: fields.get("user_unit")
      ? {
        name: fields.get("user_unit"),
        artifact: fields.get("user_unit_artifact"),
        payload_artifact: fields.get("user_unit_payload_artifact"),
        payload_path: fields.get("user_unit_payload_path"),
        payload_mode: fields.get("user_unit_payload_mode"),
      }
      : null,
    artifacts,
  });
}
/** The digest the node records: byte-identical in shell and JS. */
export function capabilitySelectionDigest(selection) {
  const lines = [
    SELECTED_CAPABILITY_SCHEMA,
    selection.version,
    selection.template_digest,
    (selection.helper_required ? "1" : "0") + (selection.linger_required ? "1" : "0") + (selection.user_service_required ? "1" : "0"),
    selection.control_account ?? "",
    selection.privileged_account ?? "",
    selection.installer ?? "",
    selection.privileged_key ?? "",
    selection.user_unit?.name ?? "",
    selection.user_unit?.artifact ?? "",
    selection.user_unit?.payload_artifact ?? "",
    selection.user_unit?.payload_path ?? "",
    selection.user_unit?.payload_mode ?? "",
  ];
  const rows = selection.artifacts
    .map((item) => item.name + "|" + item.sha256 + "|" + item.mode)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  // The shell writes every line with printf, so the stream ends with a newline.
  return "sha256:" + createHash("sha256").update([...lines, ...rows].join("\n") + "\n").digest("hex");
}

/**
 * The reviewed plan's required components must all be covered by the delivered
 * selection; shipping a weaker selection would silently under-install.
 */
export function selectionCovers(selection, requiredComponentIds = []) {
  const missing = [];
  const required = new Set(requiredComponentIds);
  if (required.has("privileged_helper") && selection.helper_required !== true) missing.push("privileged_helper");
  if (required.has("linger") && selection.linger_required !== true) missing.push("linger");
  if (required.has("user_manager") && selection.linger_required !== true && selection.user_service_required !== true) missing.push("user_manager");
  return Object.freeze(missing);
}
