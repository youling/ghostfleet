import test from "node:test";
import assert from "node:assert/strict";
import { scanText } from "../scripts/publication-guard.mjs";
test("accepts reserved placeholders and reviewed public documentation URLs", () => {
  const text = ["ssh://127.0.0.1:22","https://developers.cloudflare.com/cloudflare-one/","https://tailscale.com/docs/install/linux","ssh.example.invalid","node.tailnet-name.example.invalid"].join("\n");
  assert.deepEqual(scanText(text), []);
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
  const privateUrl = ["https:", "", "github.com", "youling", "ghostfleet"].join("/");
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
