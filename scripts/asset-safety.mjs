#!/usr/bin/env node
// Public-asset hygiene scanner.
//
// "Content addressed" is not "encrypted": every byte published on the asset
// origin is readable by anyone. This module refuses to package material that is
// secret-shaped or that describes private topology. It is deliberately
// conservative: a false positive costs a rename, a false negative publishes a
// private key.
//
// Findings never echo the matched value. Only the rule, path and line number are
// reported, so running the check cannot itself leak the material.
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, basename } from "node:path";

export const ASSET_SAFETY_SCHEMA = "ghostfleet-asset-safety/v1";

const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const CREDENTIAL_PREFIX = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|tskey-(?:auth|client|api)-[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
// A quoted literal assigned to a secret-shaped name. The value must be long
// enough to be a credential; prose such as "the token is required" never matches.
const CREDENTIAL_LITERAL = /\b(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|auth[_-]?key|client[_-]?secret)\b\s*[:=]\s*["'][A-Za-z0-9+/_=.-]{12,}["']/i;
const NODE_UID = /\bnode-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const PRIVATE_IPV4 = /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?![\d.])/;
const PRIVATE_HOST = /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|local|lan|home\.arpa|ts\.net|tailscale\.net)\b/i;
const SECRET_FILE_NAME = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)|known_hosts|\.dev\.vars|.*\.(?:pem|key|p12|pfx|jks))$/i;

function lineOf(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) if (text[cursor] === "\n") line += 1;
  return line;
}

/**
 * Scan one already-read asset.
 * @param {{name: string, bytes: Buffer, denyHosts?: string[]}} input
 */
export function scanAssetBytes({ name, bytes, denyHosts = [] }) {
  const findings = [];
  const add = (rule, line = 0) => findings.push({ path: name, rule, line });
  if (SECRET_FILE_NAME.test(name)) add("secret-file-name");
  let text;
  try {
    text = bytes.toString("utf8");
  } catch {
    add("unreadable-asset");
    return findings;
  }
  if (text.includes("\uFFFD")) {
    // Binary or non-UTF-8 content cannot be reviewed as text; refuse it rather
    // than publish an unreviewed blob.
    add("unreviewed-binary");
    return findings;
  }
  const checks = [
    ["private-key", PRIVATE_KEY_HEADER],
    ["credential-prefix", CREDENTIAL_PREFIX],
    ["jwt", JWT],
    ["credential-literal", CREDENTIAL_LITERAL],
    ["node-identity", NODE_UID],
    ["private-ip", PRIVATE_IPV4],
    ["private-host", PRIVATE_HOST],
  ];
  for (const [rule, pattern] of checks) {
    const match = pattern.exec(text);
    if (match) add(rule, lineOf(text, match.index));
  }
  for (const host of denyHosts) {
    if (!host) continue;
    const index = text.toLowerCase().indexOf(String(host).toLowerCase());
    if (index >= 0) add("deployment-denylist", lineOf(text, index));
  }
  // A dotenv block is a run of bare KEY=value assignments with at least one
  // secret-shaped key. A shell script's PATH/IFS assignments are not dotenv.
  const envLines = text.split("\n").filter((line) => /^[A-Z][A-Z0-9_]{2,}=/.test(line));
  const sensitive = envLines.find((line) => /^(?:[A-Z0-9_]*)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH_KEY|CREDENTIAL)S?(?:[A-Z0-9_]*)=/.test(line));
  if (sensitive) add("dotenv-block", lineOf(text, text.indexOf(sensitive)));
  return findings;
}

// Generated/VCS directories are not part of a reviewed source tree. The build
// itself scans every explicit input and the written output, so skipping caches
// here cannot hide a packaged byte.
export const DEFAULT_IGNORED_DIRECTORIES = Object.freeze([
  "__pycache__", ".git", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "dist",
]);

/** Recursively scan a directory of files that are about to be published. */
export async function scanAssetDirectory(root, { denyHosts = [], ignoreDirectories = DEFAULT_IGNORED_DIRECTORIES } = {}) {
  const findings = [];
  let scanned = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const name = relative(root, full);
      const info = await lstat(full);
      if (info.isSymbolicLink()) { findings.push({ path: name, rule: "symlink", line: 0 }); continue; }
      if (info.isDirectory()) {
        if (ignoreDirectories.includes(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!info.isFile()) { findings.push({ path: name, rule: "unsupported-entry", line: 0 }); continue; }
      scanned += 1;
      findings.push(...scanAssetBytes({ name, bytes: await readFile(full), denyHosts }));
    }
  };
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory()) throw new Error("ASSET_SCAN_ROOT_REQUIRED");
  await walk(root);
  return { ok: findings.length === 0, schema: ASSET_SAFETY_SCHEMA, scanned, findings };
}

export function summarizeAssetSafety(result) {
  return {
    ok: result.ok,
    schema: result.schema ?? ASSET_SAFETY_SCHEMA,
    scanned: result.scanned ?? 0,
    findings: result.findings.map((finding) => ({ path: finding.path, rule: finding.rule, line: finding.line })),
  };
}
