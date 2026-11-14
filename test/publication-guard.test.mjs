import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "../scripts/publication-guard.mjs";
test("accepts reserved placeholders and reviewed public documentation URLs", () => {
  const text = ["ssh://127.0.0.1:22","https://developers.cloudflare.com/cloudflare-one/","https://tailscale.com/docs/install/linux","ssh.example.invalid","node.tailnet-name.example.invalid"].join("\n");
  const withOmvDocs = text + "\\nhttps://docs.openmediavault.org/en/8.x/administration/services/ssh.html";
  assert.deepEqual(scanText(withOmvDocs), []);
});
test("rejects realistic Tailscale MagicDNS locators", () => {
  const locator = ["node","private-tailnet","ts","net"].join(".");
  assert.ok(scanText(locator).some((x) => x.rule === "tailnet-locator"));
});
test("rejects GitHub and Tailscale credential shapes", () => {
  const github = "ghp_" + "A".repeat(36);
  const tailscale = "tskey-" + "b".repeat(32);
  const findings = scanText(github + "\n" + tailscale);
  assert.ok(findings.some((x) => x.rule === "github-token"));
  assert.ok(findings.some((x) => x.rule === "tailscale-auth-key"));
});
test("rejects private repository links and unreviewed endpoints", () => {
  const privateUrl = ["https:", "", "github.com", "youling", "ai-hub"].join("/");
  const unreviewedUrl = ["https:", "", "unreviewed.example.test/path"].join("/");
  const findings = scanText(privateUrl + "\n" + unreviewedUrl);
  assert.ok(findings.some((x) => x.rule === "private-repository-link"));
  assert.ok(findings.some((x) => x.rule === "unreviewed-endpoint"));
});
test("rejects private key headers and bearer credentials", () => {
  const privateKey = ["-----BEGIN RSA","PRIVATE KEY-----"].join(" ");
  const bearer = ["Authorization: Bearer","x".repeat(32)].join(" ");
  const findings = scanText(privateKey + "\n" + bearer);
  assert.ok(findings.some((x) => x.rule === "private-key"));
  assert.ok(findings.some((x) => x.rule === "bearer-credential"));
});

test("rejects a node UUID locator", () => {
  const identifier = ["node","12345678","1234","abcd","9876","1234567890ab"].join("-");
  assert.ok(scanText(identifier).some((x) => x.rule === "node-identifier"));
});

test("rejects encrypted and DSA private key headers", () => {
  for (const kind of ["ENCRYPTED", "DSA"]) {
    const header = ["-----BEGIN", kind, "PRIVATE KEY-----"].join(" ");
    assert.ok(scanText(header).some((x) => x.rule === "private-key"));
  }
});

test("rejects a tailnet domain without a machine label", () => {
  const locator = ["private-tailnet", "ts", "net"].join(".");
  assert.ok(scanText(locator).some((x) => x.rule === "tailnet-locator"));
});

test("rejects credentials even on an approved documentation host", () => {
  const url = "https://" + "operator:example-password@" + "developers.cloudflare.com/path";
  assert.ok(scanText(url).some((x) => x.rule === "credentialed-url"));
});

test("detects the documented Cloudflare service secret shape", () => {
  const token = "cfast_" + "A".repeat(40) + "a1b2c3d4";
  assert.ok(scanText(token).some((x) => x.rule === "cloudflare-service-token"));
  assert.deepEqual(scanText("cfast_ placeholder; checksum and activity are not validated"), []);
});

test("allows reviewed public repositories without allowing all GitHub URLs", () => {
  const approved = ["https:", "", "github.com", "youling", "ghostfleet", "pull", "85"].join("/");
  const unknown = ["https:", "", "github.com", "unreviewed-owner", "unknown-repository"].join("/");
  assert.deepEqual(scanText(approved), []);
  assert.ok(scanText(unknown).some((x) => x.rule === "unreviewed-endpoint"));
});

test("the CLI rejects unscannable tracked files instead of silently skipping them", async (t) => {
  const script = fileURLToPath(new URL("../scripts/publication-guard.mjs", import.meta.url));
  const policy = readFileSync(new URL("../publication-policy.json", import.meta.url));
  const keyHeader = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");
  const cases = [
    {name:"ordinary-utf8", bytes:Buffer.from("Reviewed public text.\n"), status:0},
    {name:"nul-prefixed-key", bytes:Buffer.from("\0" + keyHeader), status:1, rule:"non-text-tracked-file"},
    {name:"utf16-key", bytes:Buffer.from(keyHeader, "utf16le"), status:1, rule:"non-text-tracked-file"},
    {name:"invalid-utf8", bytes:Buffer.from([0xff, 0xfe, 0x41]), status:1, rule:"invalid-utf8-tracked-file"},
    {name:"tracked-symlink", symlink:true, status:1, rule:"unsupported-file-type"},
    {name:"missing-tracked-file", missing:true, status:1, rule:"unreadable-tracked-file"},
  ];
  for (const item of cases) await t.test(item.name, {skip:item.symlink && process.platform === "win32"}, () => {
    const fixture = mkdtempSync(join(tmpdir(), "ghostfleet-publication-"));
    try {
      execFileSync("git", ["init", "-q", fixture]);
      writeFileSync(join(fixture, "publication-policy.json"), policy);
      const payload = join(fixture, "payload.txt");
      if (item.symlink) {
        writeFileSync(join(fixture, "target.txt"), "Reviewed public text.\n");
        symlinkSync("target.txt", payload);
      } else writeFileSync(payload, item.bytes || "Temporary fixture.\n");
      execFileSync("git", ["add", "--", "payload.txt"], {cwd:fixture});
      if (item.missing) rmSync(payload);
      const result = spawnSync(process.execPath, [script], {cwd:fixture, encoding:"utf8"});
      assert.equal(result.status, item.status, result.stdout + result.stderr);
      if (item.rule) assert.ok(result.stderr.includes(item.rule), result.stderr);
    } finally { rmSync(fixture, {recursive:true, force:true}); }
  });
});

test("the CLI runs when its own path contains spaces", () => {
  const fixture = mkdtempSync(join(tmpdir(), "ghostfleet path with spaces "));
  try {
    execFileSync("git", ["init", "-q", fixture]);
    writeFileSync(join(fixture, "publication-policy.json"), readFileSync(new URL("../publication-policy.json", import.meta.url)));
    const copiedScript = join(fixture, "publication guard.mjs");
    writeFileSync(copiedScript, readFileSync(new URL("../scripts/publication-guard.mjs", import.meta.url)));
    writeFileSync(join(fixture, "payload.txt"), ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "));
    execFileSync("git", ["add", "--", "payload.txt"], {cwd:fixture});
    const result = spawnSync(process.execPath, [copiedScript], {cwd:fixture, encoding:"utf8"});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes("private-key"), result.stderr);
  } finally { rmSync(fixture, {recursive:true, force:true}); }
});
