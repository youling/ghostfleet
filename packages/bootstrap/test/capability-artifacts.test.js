import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSelectedCapability } from "../src/index.js";
import {
  linuxOnly, makeHost, resetProviderIdentity, freshCheckpoint, runCourier,
  calls, installerLog, exists, UNIT_PATH,
} from "./support/capability-fixture.js";

// The claim is authoritative about WHAT to install. The bytes must come from the
// immutable asset origin and survive the pinned digest. Anything else stops
// before the identity join, the install, and the completion report.
//
// One test per case: each case runs a real published courier in its own process,
// so the package's per-test timeout covers one scenario instead of five.
// The claim is authoritative only about WHAT to install. The bytes must come
// from the immutable asset origin and survive the pinned digest. Anything else
// stops before the identity join, the install, and the completion report.
//
// One test per case: each case runs a real published courier, and the package
// test timeout is per test, not per file.
const artifactGovernanceCases = [
  {
    name: "no asset origin was delivered",
    env: { GHOSTFLEET_ASSETS_ORIGIN: "" },
    expected: /no immutable asset origin was delivered/,
  },
  {
    name: "asset origin is not an exact origin",
    env: { GHOSTFLEET_ASSETS_ORIGIN: "https://assets.fixture.invalid/redirected" },
    expected: /asset origin must be an exact https origin/,
  },
  {
    name: "asset origin answers with a redirect",
    assetTamper: (h) => h.setAssetMode("redirect"),
    expected: /could not be fetched from .*\/sha256\//,
  },
  {
    name: "asset is absent from the origin",
    assetTamper: (h, selection) => h.removeAsset(selection.artifacts[0].sha256),
    expected: /could not be fetched from .*\/sha256\//,
  },
  {
    name: "served bytes do not match the pinned digest",
    assetTamper: (h, selection) => h.serveAsset(selection.artifacts[0].sha256, "tampered bytes\n"),
    expected: /failed digest verification/,
  },
];

for (const item of artifactGovernanceCases) {
  test("artifact governance: " + item.name, { skip: linuxOnly }, async () => {
    const host = await makeHost();
    try {
      const selection = await host.buildSelection();
      await resetProviderIdentity(host);
      await freshCheckpoint(host);
      const result = await runCourier(host, selection, { assetTamper: item.assetTamper, env: item.env });
      assert.notEqual(result.status, 0, item.name + " must fail closed");
      assert.match(result.stderr, item.expected, item.name);
      const journal = await calls(host);
      assert.equal(journal.includes("tailscale-up"), false, item.name + ": no identity join before verified artifacts");
      assert.equal(journal.includes("curl complete"), false, item.name + ": no completion is reported");
      assert.deepEqual(await installerLog(host), [], item.name + ": the installer never ran");
      assert.equal(await exists(join(host.checkpoint, "capability-state.json")), false, item.name);
      assert.equal(await exists(UNIT_PATH(host)), false, item.name);
      // Only the content address is ever requested: no selection-supplied URL.
      assert.ok(host.assetRequests().every((path) => /^\/sha256\/[0-9a-f]{64}$/.test(path)), item.name + ": only content addresses are requested");
    } finally { await rm(host.root, { recursive: true, force: true }); }
  });
}

test("the pinned artifacts are fetched by digest from the asset origin, once each", { skip: linuxOnly }, async () => {
  const host = await makeHost();
  try {
    await freshCheckpoint(host);
    const selection = await host.buildSelection();
    const normalized = normalizeSelectedCapability(selection);
    const result = await runCourier(host, selection);
    assert.equal(result.status, 0, result.stderr);
    const expected = normalized.artifacts.map((artifact) => "/sha256/" + artifact.sha256).sort();
    const requested = [...new Set(host.assetRequests())].sort();
    assert.deepEqual(requested, expected, "every pinned artifact is fetched from its content address");
    assert.ok((await installerLog(host)).some((line) => line.includes("--apply")));
  } finally { await rm(host.root, { recursive: true, force: true }); }
});
