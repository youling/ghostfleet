import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSETS_INVENTORY_SCHEMA, ASSETS_MANIFEST_SCHEMA, buildAssets, readInventory, sha256Hex,
} from "../scripts/build-assets.mjs";
import { scanAssetDirectory } from "../scripts/asset-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const PRIVILEGED_OPS = join(repoRoot, "packages/runtime-python/src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged");
const COURIER = "#!/bin/sh\nset -eu\nprintf '%s\\n' 'synthetic courier'\n";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "gf-assets-build-"));
  await mkdir(join(root, "inputs"), { recursive: true });
  return root;
}

async function inventory(root, artifacts, extra = {}) {
  const path = join(root, "inventory.json");
  await writeFile(path, JSON.stringify({ schema: ASSETS_INVENTORY_SCHEMA, artifacts, ...extra }, null, 2));
  return path;
}

test("builds a digest-named tree and a manifest with no local paths", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "inputs", "installer.sh"), "#!/bin/sh\napply() { :; }\n", { mode: 0o750 });
    await writeFile(join(root, "inputs", "unit.service"), "[Service]\nType=oneshot\nExecStart=/bin/true\n");
    const inv = await readInventory(await inventory(root, [
      { name: "installer.sh", path: "inputs/installer.sh", mode: "0750" },
      { name: "managed.service", path: "inputs/unit.service" },
    ]));
    const out = join(root, "dist", "assets");
    const result = await buildAssets({ outDir: out, inventory: inv, courierBytes: COURIER });
    assert.equal(result.ok, true);
    assert.equal(result.manifest.schema, ASSETS_MANIFEST_SCHEMA);
    assert.equal(result.manifest.bootstrap.sha256, sha256Hex(Buffer.from(COURIER, "utf8")));
    assert.deepEqual(result.manifest.assets.map((item) => item.name), ["installer.sh", "managed.service"]);
    // Every object lives at its digest and is byte-identical.
    for (const item of [result.manifest.bootstrap, ...result.manifest.assets]) {
      assert.equal(item.path, "/sha256/" + item.sha256);
      assert.match(item.sha256, /^[0-9a-f]{64}$/);
      const bytes = await readFile(join(out, "sha256", item.sha256), "utf8");
      assert.equal(sha256Hex(Buffer.from(bytes, "utf8")), item.sha256);
    }
    assert.equal(await readFile(join(out, "sha256", result.manifest.assets[0].sha256), "utf8"), "#!/bin/sh\napply() { :; }\n");
    // The manifest is inventory, not a map to the build machine.
    const manifestText = await readFile(join(out, "manifest.json"), "utf8");
    assert.equal(manifestText.includes(root), false);
    assert.equal(manifestText.includes("inputs/"), false);
    assert.deepEqual((await readdir(out)).sort(), ["manifest.json", "sha256"]);
    // The published tree itself must pass the hygiene scan.
    assert.equal((await scanAssetDirectory(out)).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identical bytes are published once and keep one name per digest", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "inputs", "a.sh"), "same bytes\n");
    await writeFile(join(root, "inputs", "b.sh"), "same bytes\n");
    const inv = await readInventory(await inventory(root, [
      { name: "a.sh", path: "inputs/a.sh" },
      { name: "b.sh", path: "inputs/b.sh" },
    ]));
    const out = join(root, "dist");
    const result = await buildAssets({ outDir: out, inventory: inv, courierBytes: COURIER });
    assert.equal(result.ok, true);
    assert.equal((await readdir(join(out, "sha256"))).length, 2, "courier + one deduplicated object");
    assert.deepEqual(result.manifest.assets.map((item) => item.sha256), [sha256Hex(Buffer.from("same bytes\n")), sha256Hex(Buffer.from("same bytes\n"))]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("secret-shaped or private material is refused and nothing is published", async () => {
  const root = await workspace();
  try {
    const pem = ["-----BEGIN ", "RSA ", "PRIVATE KEY-----", "MIIEfixture", "-----END ", "RSA ", "PRIVATE KEY-----"].join("");
    await writeFile(join(root, "inputs", "leak.txt"), pem + "\n");
    await writeFile(join(root, "inputs", "clean.sh"), "#!/bin/sh\nexit 0\n");
    const cases = [
      { artifacts: [{ name: "leak.txt", path: "inputs/leak.txt" }], rule: "private-key" },
      { artifacts: [{ name: "clean.sh", path: "inputs/clean.sh" }], rule: "private-host", options: { denyHosts: ["fleet-acceptance.internal"] }, body: "#!/bin/sh\nprintf '%s\\n' fleet-acceptance.internal\n" },
    ];
    for (const item of cases) {
      if (item.body) await writeFile(join(root, "inputs", "clean.sh"), item.body);
      const inv = await readInventory(await inventory(root, item.artifacts));
      const out = join(root, "dist-" + item.rule);
      const result = await buildAssets({ outDir: out, inventory: inv, courierBytes: COURIER, ...(item.options ?? {}) });
      assert.equal(result.ok, false, item.rule);
      assert.ok(result.findings.some((finding) => finding.rule === item.rule), item.rule + ": " + JSON.stringify(result.findings));
      await assert.rejects(() => stat(out), undefined, item.rule + ": nothing may be published");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inventory shape is validated before any byte is written", async () => {
  const root = await workspace();
  try {
    const write = async (body) => {
      const path = join(root, "bad.json");
      await writeFile(path, JSON.stringify(body));
      return path;
    };
    await assert.rejects(async () => readInventory(await write({ schema: "wrong", artifacts: [] })), /ASSET_INVENTORY_SCHEMA_INVALID/);
    await assert.rejects(async () => readInventory(await write({ schema: ASSETS_INVENTORY_SCHEMA })), /ASSET_INVENTORY_ARTIFACTS_REQUIRED/);
    await assert.rejects(async () => readInventory(await write({ schema: ASSETS_INVENTORY_SCHEMA, artifacts: [{ name: "../escape", path: "x" }] })), /ASSET_NAME_INVALID/);
    await assert.rejects(async () => readInventory(await write({ schema: ASSETS_INVENTORY_SCHEMA, artifacts: [{ name: "a", path: "x", mode: "9999" }] })), /ASSET_MODE_INVALID/);
    await assert.rejects(async () => readInventory(await write({ schema: ASSETS_INVENTORY_SCHEMA, artifacts: [
      { name: "same", path: "x" }, { name: "same", path: "y" },
    ] })), /ASSET_NAME_DUPLICATE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the reviewed privileged operations directory is publishable as-is", async () => {
  // The exact bytes the courier installs must be publishable: this is the
  // automated public-asset hygiene check required for A1, run over real input.
  const result = await scanAssetDirectory(PRIVILEGED_OPS);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.ok(result.scanned >= 4, "the reviewed operations set is scanned");
});

test("a dirty tree is reported, and the check never echoes the material", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "notes.txt"), 'secret = "' + "Q".repeat(20) + '"\n');
    const result = await scanAssetDirectory(root);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result.findings).includes("Q".repeat(20)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
