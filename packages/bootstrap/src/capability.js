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
  "privileged_key", "user_unit", "user_unit_artifact", "artifact",
]);
const SELECTION_KEYS = [
  "source", "template_digest", "version", "helper_required", "linger_required",
  "user_service_required", "control_account", "privileged_account", "installer",
  "privileged_key", "user_unit", "artifacts",
];

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

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw invalid("CAPABILITY_ARTIFACTS_REQUIRED");
  const seen = new Set();
  return artifacts.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid("CAPABILITY_ARTIFACT_INVALID");
    const name = item.name;
    if (typeof name !== "string" || !ARTIFACT_NAME.test(name)) throw invalid("CAPABILITY_ARTIFACT_NAME_INVALID");
    if (seen.has(name)) throw invalid("CAPABILITY_ARTIFACT_DUPLICATE");
    seen.add(name);
    if (typeof item.content !== "string" || item.content.includes("\u0000")) throw invalid("CAPABILITY_ARTIFACT_CONTENT_INVALID");
    if (!item.content.length) throw invalid("CAPABILITY_ARTIFACT_CONTENT_INVALID");
    const mode = String(item.mode ?? "0644");
    if (!FILE_MODE.test(mode)) throw invalid("CAPABILITY_ARTIFACT_MODE_INVALID");
    const sha256 = "sha256:" + createHash("sha256").update(item.content, "utf8").digest("hex");
    // A declared digest is an assertion about the reviewed bytes, not a second
    // source of truth: a mismatch means the artifact changed after review.
    if (item.sha256 !== undefined && String(item.sha256).replace(/^sha256:/, "") !== sha256.slice(7)) {
      throw invalid("CAPABILITY_ARTIFACT_DIGEST_MISMATCH");
    }
    return Object.freeze({
      name,
      mode: "0" + mode.replace(/^0/, ""),
      sha256: sha256.slice("sha256:".length),
      content: item.content,
      base64: Buffer.from(item.content, "utf8").toString("base64"),
    });
  });
}

/**
 * Validate a deployment-rendered selection. Every failure is a hard error at
 * render time, so a malformed or unrequested privileged component can never
 * reach a host.
 */
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
    const unit = selection.user_unit;
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) throw invalid("CAPABILITY_USER_UNIT_REQUIRED");
    if (typeof unit.name !== "string" || !UNIT_NAME.test(unit.name)) throw invalid("CAPABILITY_USER_UNIT_INVALID");
    if (typeof unit.artifact !== "string" || !names.has(unit.artifact)) throw invalid("CAPABILITY_USER_UNIT_NOT_PINNED");
    user_unit = Object.freeze({ name: unit.name, artifact: unit.artifact });
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
      "CAPABILITY_ARTIFACT_COUNT=0");
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
    "CAPABILITY_ARTIFACT_COUNT=" + normalized.artifacts.length,
  );
  normalized.artifacts.forEach((item, index) => {
    const row = [item.name, item.sha256, item.mode, item.base64].join("|");
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
      content: item.content,
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
  ];
  for (const item of normalized.artifacts) {
    lines.push("artifact=" + [item.name, item.sha256, item.mode, item.base64].join("|"));
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
      if (parts.length !== 4) throw invalid("CAPABILITY_SELECTION_INVALID");
      const [name, sha256, mode, base64] = parts;
      if (!name || !sha256 || !mode || !base64) throw invalid("CAPABILITY_SELECTION_INVALID");
      artifacts.push({ name, sha256: "sha256:" + sha256, mode, content: Buffer.from(base64, "base64").toString("utf8") });
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
    user_unit: fields.get("user_unit") ? { name: fields.get("user_unit"), artifact: fields.get("user_unit_artifact") } : null,
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
