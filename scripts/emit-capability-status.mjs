#!/usr/bin/env node
// Single writer for the public capability projection.
//
// capability_status_projection() in the published courier is the ONLY
// implementation of this file: this entry point extracts that exact shell
// function from BOOTSTRAP_SH and runs it. The courier and the console
// acceptance therefore can never drift apart, and no test may hand-write
// /etc/ghostfleet/capability-status.json to fake a product output.
//
// The wrapper only adds what a command line needs: explicit inputs (artifact
// name/sha256/mode rows, template digest, accounts, applied_at), fail-closed
// validation, an explicit applied_at seam for reproducible acceptance, and a
// stable error code contract.
//
// Usage (root on the managed node):
//   node scripts/emit-capability-status.mjs \
//     --artifact fleet_privctl.py=sha256:<64hex>:0755 \
//     --artifact privileged-ops.pub=sha256:<64hex>:0644 \
//     --artifact ghostfleet-managed.service=sha256:<64hex>:0644 \
//     --artifact node-agent.pyz=sha256:<64hex>:0755 \
//     --artifact managed-linux-privileged-operations.sh=sha256:<64hex>:0750 \
//     --template-digest sha256:<64hex> \
//     --installer managed-linux-privileged-operations.sh \
//     --privileged-key privileged-ops.pub \
//     --unit ghostfleet-managed.service \
//     --unit-artifact ghostfleet-managed.service \
//     --payload-artifact node-agent.pyz \
//     --control-account ghostfleet-managed \
//     --privileged-account ghostfleet-ops
//
// Output: /etc/ghostfleet/capability-status.json, root:root 0644, directory
// 0755, written atomically (tmp + fsync + rename) by the shared function.
// Missing or illegal input, a fragment that is not exactly the published one,
// or a projection that carries a forbidden field fails closed with a non-zero
// exit and one stable code on stderr:
//   EMIT_CAPABILITY_STATUS_INPUT_INVALID   (exit 2)
//   EMIT_CAPABILITY_STATUS_ENVIRONMENT     (exit 3)
//   EMIT_CAPABILITY_STATUS_WRITE_FAILED    (exit 4)
//   EMIT_CAPABILITY_STATUS_OUTPUT_UNSAFE   (exit 4)

import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const EXIT_INPUT = 2;
const EXIT_ENVIRONMENT = 3;
const EXIT_WRITE = 4;

function die(code, message, exitCode) {
  process.stderr.write("emit-capability-status: [" + code + "] " + message + "\n");
  process.exit(exitCode);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const bootstrapPath = join(repoRoot, "packages", "bootstrap", "src", "bootstrap.js");
const capabilityPath = join(repoRoot, "packages", "bootstrap", "src", "capability.js");

let BOOTSTRAP_SH;
let SELECTED_CAPABILITY_SCHEMA;
let AGENT_PAYLOAD_PATH;
let AGENT_PAYLOAD_MODE;
try {
  ({ BOOTSTRAP_SH } = await import(pathToFileURL(bootstrapPath).href));
  ({ SELECTED_CAPABILITY_SCHEMA, AGENT_PAYLOAD_PATH, AGENT_PAYLOAD_MODE } =
    await import(pathToFileURL(capabilityPath).href));
} catch (error) {
  die("EMIT_CAPABILITY_STATUS_ENVIRONMENT", "the published courier module cannot be loaded: " + error.message, EXIT_ENVIRONMENT);
}

function fragment(name) {
  const begin = "# @@GHOSTFLEET_CAPABILITY_STATUS_FRAGMENT_" + name + "_BEGIN@@";
  const end = "# @@GHOSTFLEET_CAPABILITY_STATUS_FRAGMENT_" + name + "_END@@";
  const beginAt = BOOTSTRAP_SH.indexOf(begin);
  const endAt = BOOTSTRAP_SH.indexOf(end);
  if (
    beginAt < 0 || endAt < 0 || endAt <= beginAt ||
    BOOTSTRAP_SH.indexOf(begin, beginAt + 1) >= 0 ||
    BOOTSTRAP_SH.indexOf(end, endAt + 1) >= 0
  ) {
    die(
      "EMIT_CAPABILITY_STATUS_ENVIRONMENT",
      "the published courier does not carry exactly one " + name + " fragment; refusing to emit a projection from an unknown implementation",
      EXIT_ENVIRONMENT,
    );
  }
  const text = BOOTSTRAP_SH.slice(beginAt + begin.length, endAt).trim();
  if (!text) die("EMIT_CAPABILITY_STATUS_ENVIRONMENT", "the " + name + " fragment is empty", EXIT_ENVIRONMENT);
  return text;
}

function shQuote(value) {
  return "'" + String(value).split("'").join("'\\''") + "'";
}

const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODE = /^0?[0-7]{3}$/;
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const APPLIED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const PAYLOAD_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*libexec\/ghostfleet\/node-agent\.pyz$/;
const FORBIDDEN = /token|secret|BEGIN [A-Z ]*PRIVATE KEY|\/home\//i;

function requireString(flag, value) {
  if (typeof value !== "string" || !value) {
    die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", flag + " requires a non-empty value", EXIT_INPUT);
  }
  if (FORBIDDEN.test(value)) {
    die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", flag + " carries a secret or a home path; the projection is public and never carries either", EXIT_INPUT);
  }
  return value;
}

const options = {
  artifacts: [],
  templateDigest: null,
  installer: null,
  privilegedKey: null,
  unit: null,
  unitArtifact: null,
  payloadArtifact: null,
  controlAccount: null,
  privilegedAccount: null,
  appliedAt: null,
  output: "/etc/ghostfleet",
  payloadPath: AGENT_PAYLOAD_PATH,
};

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.length % 2 !== 0) {
  die(
    "EMIT_CAPABILITY_STATUS_INPUT_INVALID",
    "expected --flag value pairs; see the usage comment for the complete list",
    EXIT_INPUT,
  );
}
for (let index = 0; index < argv.length; index += 2) {
  const flag = argv[index];
  const value = argv[index + 1];
  switch (flag) {
    case "--artifact":
      options.artifacts.push(requireString(flag, value));
      break;
    case "--template-digest":
      options.templateDigest = requireString(flag, value);
      break;
    case "--installer":
      options.installer = requireString(flag, value);
      break;
    case "--privileged-key":
      options.privilegedKey = requireString(flag, value);
      break;
    case "--unit":
      options.unit = requireString(flag, value);
      break;
    case "--unit-artifact":
      options.unitArtifact = requireString(flag, value);
      break;
    case "--payload-artifact":
      options.payloadArtifact = requireString(flag, value);
      break;
    case "--control-account":
      options.controlAccount = requireString(flag, value);
      break;
    case "--privileged-account":
      options.privilegedAccount = requireString(flag, value);
      break;
    case "--applied-at":
      options.appliedAt = requireString(flag, value);
      break;
    case "--output":
      options.output = requireString(flag, value);
      break;
    case "--payload-path":
      options.payloadPath = requireString(flag, value);
      break;
    default:
      die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "unknown option " + flag, EXIT_INPUT);
  }
}

if (!options.templateDigest) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--template-digest is required to derive release_pin", EXIT_INPUT);
}
if (!/^sha256:[0-9a-f]{64}$/.test(options.templateDigest)) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--template-digest must be sha256:<64 lowercase hex>", EXIT_INPUT);
}
if (!options.installer) die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--installer is required", EXIT_INPUT);
if (!options.privilegedKey) die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--privileged-key is required", EXIT_INPUT);
if (!options.unit) die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--unit is required", EXIT_INPUT);
if (!options.unitArtifact) die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--unit-artifact is required", EXIT_INPUT);
if (!options.payloadArtifact) die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--payload-artifact is required", EXIT_INPUT);
if (!options.controlAccount || !ACCOUNT.test(options.controlAccount)) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--control-account must be a plain account name", EXIT_INPUT);
}
if (!options.privilegedAccount || !ACCOUNT.test(options.privilegedAccount)) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--privileged-account must be a plain account name", EXIT_INPUT);
}
if (options.controlAccount === options.privilegedAccount) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "the control account and the privileged account must be distinct", EXIT_INPUT);
}
if (!isAbsolute(options.output)) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--output must be an absolute directory", EXIT_INPUT);
}
if (options.appliedAt && !APPLIED_AT.test(options.appliedAt)) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--applied-at must be an RFC3339 UTC instant such as 2026-01-01T00:00:00Z", EXIT_INPUT);
}
if (!PAYLOAD_PATH.test(options.payloadPath)) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "--payload-path must end in /libexec/ghostfleet/node-agent.pyz", EXIT_INPUT);
}
if (options.artifacts.length < 1) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "at least one --artifact name=sha256:<hex>:<mode> row is required", EXIT_INPUT);
}
if (options.artifacts.length > 16) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "at most 16 artifact rows are supported", EXIT_INPUT);
}

const rows = new Map();
for (const raw of options.artifacts) {
  const match = /^([^=]+)=sha256:([0-9a-f]{64}):(0?[0-7]{3})$/.exec(raw);
  if (!match || !ARTIFACT_NAME.test(match[1]) || !MODE.test(match[3])) {
    die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "artifact row '" + raw + "' must be name=sha256:<64 hex>:<octal mode>", EXIT_INPUT);
  }
  const name = match[1];
  const digest = match[2];
  const mode = match[3].length === 4 ? match[3] : "0" + match[3];
  if (rows.has(name)) {
    die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "artifact name '" + name + "' is pinned twice", EXIT_INPUT);
  }
  rows.set(name, { digest, mode });
}
for (const [role, name] of [
  ["installer", options.installer],
  ["privileged key", options.privilegedKey],
  ["unit artifact", options.unitArtifact],
  ["payload artifact", options.payloadArtifact],
]) {
  if (!rows.has(name)) {
    die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "the " + role + " '" + name + "' is not one of the pinned --artifact rows", EXIT_INPUT);
  }
}
const payloadRow = rows.get(options.payloadArtifact);
if (payloadRow.mode !== AGENT_PAYLOAD_MODE) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "the payload artifact must be pinned mode " + AGENT_PAYLOAD_MODE, EXIT_INPUT);
}
if (!rows.has(options.unit)) {
  die("EMIT_CAPABILITY_STATUS_INPUT_INVALID", "the unit name '" + options.unit + "' is not one of the pinned --artifact rows", EXIT_INPUT);
}

const rowsText = [];
let index = 1;
for (const [name, row] of rows) {
  rowsText.push("CAPABILITY_ARTIFACT_" + index + "=" + shQuote(name + "|" + row.digest + "|" + row.mode));
  index += 1;
}

let artifactRowFragment;
let projectionFragment;
try {
  artifactRowFragment = fragment("ARTIFACT_ROW");
  projectionFragment = fragment("PROJECTION");
} catch (error) {
  die("EMIT_CAPABILITY_STATUS_ENVIRONMENT", error.message, EXIT_ENVIRONMENT);
}
if (!artifactRowFragment.includes("capability_artifact_row()") || !projectionFragment.includes("capability_status_projection()")) {
  die(
    "EMIT_CAPABILITY_STATUS_ENVIRONMENT",
    "the extracted fragments are not the published capability status implementation",
    EXIT_ENVIRONMENT,
  );
}

const workDir = mkdtempSync(join(tmpdir(), "ghostfleet-capability-status-"));
const scriptPath = join(workDir, "emit-capability-status.sh");
const lines = [
  "#!/bin/sh",
  "set -u",
  "CHECKPOINT_DIR=" + shQuote(workDir),
  "CAPABILITY_USER_SERVICE_REQUIRED=1",
  "CAPABILITY_SCHEMA=" + shQuote(SELECTED_CAPABILITY_SCHEMA),
  "CAPABILITY_TEMPLATE_DIGEST=" + shQuote(options.templateDigest),
  "CAPABILITY_ARTIFACT_COUNT=" + shQuote(String(rows.size)),
  ...rowsText,
  "CAPABILITY_INSTALLER=" + shQuote(options.installer),
  "CAPABILITY_PRIVILEGED_KEY=" + shQuote(options.privilegedKey),
  "CAPABILITY_USER_UNIT=" + shQuote(options.unit),
  "CAPABILITY_USER_UNIT_ARTIFACT=" + shQuote(options.unitArtifact),
  "CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT=" + shQuote(options.payloadArtifact),
  "CAPABILITY_AGENT_PAYLOAD_SHA256=" + shQuote(payloadRow.digest),
  "CAPABILITY_AGENT_PAYLOAD_PATH=" + shQuote(options.payloadPath),
  "CAPABILITY_AGENT_CONFIG_DIR=" + shQuote(options.output),
  "CAPABILITY_CONTROL_ACCOUNT=" + shQuote(options.controlAccount),
  "CAPABILITY_PRIVILEGED_ACCOUNT=" + shQuote(options.privilegedAccount),
  "CAPABILITY_STATUS_APPLIED_AT=" + shQuote(options.appliedAt || ""),
  artifactRowFragment,
  projectionFragment,
  "capability_status_projection",
  "",
];
writeFileSync(scriptPath, lines.join("\n"), { mode: 0o700 });

const releasePin = options.templateDigest.slice("sha256:".length, "sha256:".length + 40);
const projectionFile = join(options.output, "capability-status.json");
let run;
try {
  run = spawnSync("/bin/sh", [scriptPath], { encoding: "utf8" });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
if (run.error) {
  die(
    "EMIT_CAPABILITY_STATUS_ENVIRONMENT",
    "/bin/sh cannot run the published projection (" + run.error.message + "); this entry point is for the managed Linux node",
    EXIT_ENVIRONMENT,
  );
}
if (run.status !== 0) {
  if (run.stderr) process.stderr.write(run.stderr);
  die(
    "EMIT_CAPABILITY_STATUS_WRITE_FAILED",
    "the published capability_status_projection refused to write " + projectionFile + " (exit " + String(run.status) + ")",
    EXIT_WRITE,
  );
}

let body;
try {
  const stat = lstatSync(projectionFile);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o644 || stat.uid !== 0 || stat.gid !== 0) {
    die(
      "EMIT_CAPABILITY_STATUS_OUTPUT_UNSAFE",
      projectionFile + " is not a root:root 0644 regular file after the projection",
      EXIT_WRITE,
    );
  }
  body = readFileSync(projectionFile, "utf8");
} catch (error) {
  die("EMIT_CAPABILITY_STATUS_WRITE_FAILED", "cannot verify " + projectionFile + ": " + error.message, EXIT_WRITE);
}

let parsed;
try {
  parsed = JSON.parse(body);
} catch (error) {
  die("EMIT_CAPABILITY_STATUS_OUTPUT_UNSAFE", "the projected JSON is not parseable: " + error.message, EXIT_WRITE);
}
function check(condition, message) {
  if (!condition) die("EMIT_CAPABILITY_STATUS_OUTPUT_UNSAFE", message, EXIT_WRITE);
}
check(parsed.schema === "ghostfleet-capability-status/v1", "schema is not ghostfleet-capability-status/v1");
check(parsed.selection_schema === SELECTED_CAPABILITY_SCHEMA, "selection_schema is not " + SELECTED_CAPABILITY_SCHEMA);
check(parsed.release_pin === releasePin, "release_pin is not the first 40 hex of the template digest");
check(parsed.control_account === options.controlAccount, "control_account does not match the input");
check(parsed.privileged_account === options.privilegedAccount, "privileged_account does not match the input");
check(Array.isArray(parsed.artifacts) && parsed.artifacts.length === rows.size, "artifact rows do not match the input count");
check(parsed.user_unit && parsed.user_unit.name === options.unit, "user_unit.name does not match the input");
check(parsed.user_unit.sha256 === rows.get(options.unitArtifact).digest, "user_unit.sha256 does not match the unit artifact digest");
check(parsed.user_unit.payload_sha256 === payloadRow.digest, "user_unit.payload_sha256 does not match the payload digest");
check(parsed.user_unit.payload_path === options.payloadPath, "user_unit.payload_path does not match the payload path");
if (options.appliedAt) check(parsed.applied_at === options.appliedAt, "applied_at does not match --applied-at");
if (FORBIDDEN.test(body)) {
  die(
    "EMIT_CAPABILITY_STATUS_OUTPUT_UNSAFE",
    "the projection carries a token, secret or home path; the public file must never do that",
    EXIT_WRITE,
  );
}

process.stdout.write(
  "capability-status: " + projectionFile + " release_pin=" + parsed.release_pin +
  " artifacts=" + String(parsed.artifacts.length) + " applied_at=" + String(parsed.applied_at) + "\n",
);
