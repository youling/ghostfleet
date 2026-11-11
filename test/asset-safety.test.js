import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAssetBytes, scanAssetDirectory, ASSET_SAFETY_SCHEMA } from "../scripts/asset-safety.mjs";

// Fixtures are assembled at runtime. A literal private-key header or token in a
// tracked file would itself be a publication finding, and the scanner under test
// must not require the repository to carry the material it refuses.
const PEM = ["-----BEGIN ", "RSA ", "PRIVATE KEY-----"].join("");
const OPENSSH = ["-----BEGIN ", "OPENSSH ", "PRIVATE KEY-----"].join("");
const ip = (...parts) => parts.join(".");
const token = (prefix, body) => prefix + body;

const scan = (name, text) => scanAssetBytes({ name, bytes: Buffer.from(text, "utf8") });
const rules = (name, text) => scan(name, text).map((finding) => finding.rule);

test("private key material is refused in any published byte", () => {
  assert.deepEqual(rules("install.sh", PEM + "\nMIIE...\n"), ["private-key"]);
  assert.deepEqual(rules("key.txt", OPENSSH + "\nAAAA\n"), ["private-key"]);
});

test("credential-shaped literals, prefixes and JWTs are refused", () => {
  assert.deepEqual(rules("notes.txt", 'api_key = "' + "A".repeat(24) + '"'), ["credential-literal"]);
  assert.deepEqual(rules("notes.txt", token("ghp" + "_", "A".repeat(24))), ["credential-prefix"]);
  assert.deepEqual(rules("notes.txt", token("tskey" + "-auth-", "A".repeat(20))), ["credential-prefix"]);
  assert.deepEqual(rules("notes.txt", ["eyJhbGciOiJIUzI1NiJ9", "payloadxyz", "signaturexyz"].join(".")), ["jwt"]);
});

test("private topology and node identities are refused", () => {
  assert.deepEqual(rules("config.yaml", "host: " + ip(10, 20, 30, 40)), ["private-ip"]);
  assert.deepEqual(rules("config.yaml", "host: " + ip(192, 168, 1, 10)), ["private-ip"]);
  assert.deepEqual(rules("config.yaml", "host: " + ip(100, 100, 64, 7)), ["private-ip"]);
  assert.deepEqual(rules("config.md", "see nas01.internal for details"), ["private-host"]);
  assert.deepEqual(rules("config.md", "peer box" + "." + "tailnet" + "." + "ts.net"), ["private-host"]);
  assert.deepEqual(rules("config.md", "node " + ["node", "00000000", "0000", "4000", "8000", "000000000001"].join("-")), ["node-identity"]);
});

test("dotenv blocks and secret-shaped file names are refused", () => {
  assert.deepEqual(rules("env.txt", "SERVICE_TOKEN=abc123\nB_TWO=2\nC_THREE=3\n"), ["dotenv-block"]);
  // A plain shell assignment block is not dotenv material.
  assert.deepEqual(rules("install.sh", "PATH=/usr/bin\nIFS= \nset -eu\n"), []);
  assert.deepEqual(rules(".env.production", "anything"), ["secret-file-name"]);
  assert.deepEqual(rules("device.pem", "anything"), ["secret-file-name"]);
  assert.deepEqual(rules("id_ed25519", "anything"), ["secret-file-name"]);
});

test("binary and non-UTF-8 assets are refused rather than published unreviewed", () => {
  const binary = scanAssetBytes({ name: "blob.bin", bytes: Buffer.from([0x00, 0xff, 0x10]) });
  assert.deepEqual(binary.map((finding) => finding.rule), ["unreviewed-binary"]);
});

test("ordinary reviewed shell and unit material passes", () => {
  const clean = [
    "#!/bin/sh",
    "set -eu",
    'PATH="/usr/sbin:/usr/bin:/sbin:/bin"',
    'printf "%s\\n" "fleet-enroll: synthetic fixture"',
    "for tool in curl sha256sum; do command -v \"$tool\" >/dev/null 2>&1 || exit 1; done",
  ].join("\n");
  assert.deepEqual(rules("installer.sh", clean), []);
  assert.deepEqual(rules("unit.service", "[Service]\nType=oneshot\nExecStart=/bin/true\n"), []);
});

test("a directory scan reports paths and rules without echoing the value", async () => {
  const root = await mkdtemp(join(tmpdir(), "gf-asset-safety-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "clean.sh"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(root, "nested", "leak.txt"), "token = " + '"' + "Z".repeat(20) + '"' + "\n");
    // Creating a symlink needs an elevated token on Windows; the Linux CI job
    // is where the symlink rule is proven.
    if (process.platform !== "win32") await symlink(join(root, "clean.sh"), join(root, "link.sh"));
    const result = await scanAssetDirectory(root);
    assert.equal(result.schema, ASSET_SAFETY_SCHEMA);
    assert.equal(result.ok, false);
    const summary = JSON.stringify(result.findings);
    assert.match(summary, /credential-literal/);
    if (process.platform !== "win32") assert.match(summary, /symlink/);
    assert.equal(summary.includes("Z".repeat(20)), false, "findings must never echo the material");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean directory scans as ok and refuses a missing root", async () => {
  const root = await mkdtemp(join(tmpdir(), "gf-asset-clean-"));
  try {
    await writeFile(join(root, "a.sh"), "#!/bin/sh\nset -eu\n");
    const result = await scanAssetDirectory(root);
    assert.deepEqual({ ok: result.ok, scanned: result.scanned }, { ok: true, scanned: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(() => scanAssetDirectory(join(tmpdir(), "gf-does-not-exist-" + Date.now())), /ASSET_SCAN_ROOT_REQUIRED/);
});
