#!/usr/bin/env node
// Build the immutable, content-addressed public asset tree.
//
// Output (default dist/assets):
//   sha256/<64 hex>     the exact reviewed bytes, byte-identical
//   manifest.json       ghostfleet-assets-manifest/v1 (deployment inventory only)
//
// The manifest is NOT served: workers/assets answers only /sha256/<digest>.
// Every input byte is scanned by scripts/asset-safety.mjs before it is written,
// and the written tree is scanned again, because "content addressed" does not
// mean "safe to publish".
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { scanAssetBytes, scanAssetDirectory, summarizeAssetSafety } from "./asset-safety.mjs";

export const ASSETS_MANIFEST_SCHEMA = "ghostfleet-assets-manifest/v1";
export const ASSETS_INVENTORY_SCHEMA = "ghostfleet-assets-inventory/v1";
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_MODE = /^0?[0-7]{3}$/;

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The build removes the output directory before writing it. That is only safe
 * for a dedicated, deep path: never the filesystem root, the current workspace,
 * an ancestor of it, or the inventory's own directory.
 */
export function assertSafeOutDir(value, { cwd = process.cwd(), inventoryPath = null } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error("ASSET_OUT_DIR_INVALID");
  const outDir = resolve(value);
  const root = parse(outDir).root;
  if (outDir === root) throw new Error("ASSET_OUT_DIR_UNSAFE");
  const containsCwd = relative(outDir, resolve(cwd));
  if (outDir === resolve(cwd) || (!containsCwd.startsWith("..") && !isAbsolute(containsCwd))) throw new Error("ASSET_OUT_DIR_UNSAFE");
  if (inventoryPath) {
    const inventoryDir = dirname(resolve(inventoryPath));
    const containsInventory = relative(outDir, inventoryDir);
    if (outDir === inventoryDir || (!containsInventory.startsWith("..") && !isAbsolute(containsInventory))) throw new Error("ASSET_OUT_DIR_UNSAFE");
  }
  // A single top-level entry (/tmp, D:\) is a shared location, not an asset tree.
  const depth = outDir.slice(root.length).split(sep).filter(Boolean).length;
  if (depth < 2) throw new Error("ASSET_OUT_DIR_TOO_SHALLOW");
  return outDir;
}

export function normalizeArtifactEntry(entry, baseDir) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("ASSET_ENTRY_INVALID");
  const name = entry.name;
  if (typeof name !== "string" || !ARTIFACT_NAME.test(name)) throw new Error("ASSET_NAME_INVALID");
  const mode = String(entry.mode ?? "0644");
  if (!FILE_MODE.test(mode)) throw new Error("ASSET_MODE_INVALID");
  const path = entry.path;
  if (typeof path !== "string" || !path.length) throw new Error("ASSET_PATH_INVALID");
  return Object.freeze({ name, mode: "0" + mode.replace(/^0/, ""), source: resolve(baseDir, path) });
}

export async function readInventory(inventoryPath) {
  const raw = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (!raw || raw.schema !== ASSETS_INVENTORY_SCHEMA) throw new Error("ASSET_INVENTORY_SCHEMA_INVALID");
  if (!Array.isArray(raw.artifacts)) throw new Error("ASSET_INVENTORY_ARTIFACTS_REQUIRED");
  const baseDir = dirname(resolve(inventoryPath));
  const seen = new Set();
  const artifacts = raw.artifacts.map((entry) => {
    const normalized = normalizeArtifactEntry(entry, baseDir);
    if (seen.has(normalized.name)) throw new Error("ASSET_NAME_DUPLICATE");
    seen.add(normalized.name);
    return normalized;
  });
  return { artifacts, denyHosts: Array.isArray(raw.deny_hosts) ? raw.deny_hosts.map(String) : [] };
}

/**
 * Build the tree. Returns the manifest and the safety report; throws on any
 * hygiene finding, duplicate content under two names with different modes, or
 * an unreadable input.
 */
export async function buildAssets({ outDir, inventory, courierBytes, denyHosts = [], cwd = process.cwd(), inventoryPath = null }) {
  const safeOutDir = assertSafeOutDir(outDir, { cwd, inventoryPath });
  const findings = [];
  const assets = [];
  const bytesByDigest = new Map();
  const pushFinding = (name, entry, rules) => {
    for (const finding of rules) findings.push({ path: name + " -> " + finding.path, rule: finding.rule, line: finding.line });
  };

  const courier = Buffer.from(courierBytes, "utf8");
  const bootstrapName = inventory.bootstrap_name ?? "ghostfleet-bootstrap.sh";
  if (!ARTIFACT_NAME.test(bootstrapName)) throw new Error("ASSET_NAME_INVALID");
  pushFinding(bootstrapName, null, scanAssetBytes({ name: bootstrapName, bytes: courier, denyHosts }));
  const bootstrapDigest = sha256Hex(courier);
  bytesByDigest.set(bootstrapDigest, courier);
  assets.push({ name: bootstrapName, sha256: bootstrapDigest, mode: "0755", bytes: courier.length, path: "/sha256/" + bootstrapDigest });

  for (const artifact of inventory.artifacts) {
    const bytes = await readFile(artifact.source);
    pushFinding(artifact.name, null, scanAssetBytes({ name: artifact.name, bytes, denyHosts }));
    const digest = sha256Hex(bytes);
    const previous = assets.find((item) => item.name === artifact.name);
    if (previous && previous.sha256 !== digest) throw new Error("ASSET_NAME_CONFLICT");
    bytesByDigest.set(digest, bytes);
    assets.push({ name: artifact.name, sha256: digest, mode: artifact.mode, bytes: bytes.length, path: "/sha256/" + digest });
  }
  if (findings.length) return { ok: false, findings, assets: [], manifest: null };

  const manifest = {
    schema: ASSETS_MANIFEST_SCHEMA,
    generated_by: "scripts/build-assets.mjs",
    bootstrap: assets[0],
    assets: assets.slice(1).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  };

  // Content addressing deduplicates identical bytes by design; two different
  // names for the same bytes are allowed only with the same mode.
  await rm(safeOutDir, { recursive: true, force: true });
  await mkdir(join(safeOutDir, "sha256"), { recursive: true });
  for (const [digest, bytes] of bytesByDigest) await writeFile(join(safeOutDir, "sha256", digest), bytes, { mode: 0o644 });
  await writeFile(join(safeOutDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Postcondition: scan what will actually be uploaded, not just the inputs.
  const published = await scanAssetDirectory(safeOutDir, { denyHosts });
  if (!published.ok) return { ok: false, findings: published.findings, assets, manifest };
  return { ok: true, findings: [], assets, manifest, safety: summarizeAssetSafety(published) };
}

function parseArgs(argv) {
  const args = { denyHosts: [], outDir: null, inventory: null, check: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out") args.outDir = argv[++index];
    else if (value === "--inventory") args.inventory = argv[++index];
    else if (value === "--check") args.check = argv[++index];
    else if (value === "--deny-host") args.denyHosts.push(argv[++index]);
    else throw new Error("UNKNOWN_ARGUMENT " + value);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { BOOTSTRAP_SH } = await import("../packages/bootstrap/src/index.js");
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.check) {
      const result = await scanAssetDirectory(resolve(args.check), { denyHosts: args.denyHosts });
      console.log(JSON.stringify(summarizeAssetSafety(result), null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } else {
      if (!args.outDir) throw new Error("--out is required");
      if (!args.inventory) throw new Error("--inventory is required");
      const inventory = await readInventory(args.inventory);
      const result = await buildAssets({
        outDir: args.outDir, inventory, courierBytes: BOOTSTRAP_SH, inventoryPath: args.inventory,
        denyHosts: [...inventory.denyHosts, ...args.denyHosts],
      });
      if (!result.ok) {
        console.log(JSON.stringify({ ok: false, schema: "ghostfleet-assets-build/v1", findings: result.findings }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify({
          ok: true, schema: "ghostfleet-assets-build/v1",
          bootstrap_sha256: result.manifest.bootstrap.sha256,
          artifacts: result.manifest.assets.length,
          out: resolve(args.outDir),
          safety: result.safety,
        }, null, 2));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
}
