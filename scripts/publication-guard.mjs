import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = process.cwd();
const policy = JSON.parse(readFileSync(resolve(root, "publication-policy.json"), "utf8"));
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["tailscale-auth-key", /\btskey-[A-Za-z0-9_-]{20,}\b/],
  // Official Cloudflare candidate-secret pattern (2026-11-11); not checksum validation.
  ["cloudflare-service-token", /cfast_[A-Za-z0-9]{40}[a-f0-9]{8}/],
  ["project-api-key", /\bsk-proj-[A-Za-z0-9_-]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer-credential", /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{16,}/i],
  ["tailnet-locator", /\b(?:[a-z0-9-]+\.)+ts\.net\b/i],
  ["node-identifier", /\bnode-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["home-path", /(?:\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\)/i],
  ["private-repository-link", /github\.com\/youling\/(?:fleet|ai-hub)(?:\/|\b)/i],
];
function urlAllowed(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "github.com") {
    const repository = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/").toLowerCase();
    return (policy.allowed_public_github_repositories || []).includes(repository);
  }
  if (policy.reserved_placeholder_domains.some((s) => host === s || host.endsWith("." + s))) return true;
  return policy.allowed_public_hosts.some((s) => host === s || host.endsWith("." + s));
}
export function scanText(content, path = "<memory>") {
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [rule, pattern] of rules) if (pattern.test(line)) findings.push({path,line:i+1,rule});
    for (const raw of line.match(/https?:\/\/[^\s<>"')\]]+/g) || []) {
      const cleaned = raw.replace(/[.,;!?]+$/, "");
      try {
        const url = new URL(cleaned);
        if (url.username || url.password) findings.push({path,line:i+1,rule:"credentialed-url"});
        if (!urlAllowed(url)) findings.push({path,line:i+1,rule:"unreviewed-endpoint"});
      } catch { findings.push({path,line:i+1,rule:"malformed-url"}); }
    }
  }
  return findings;
}
export function scanTrackedFiles() {
  const paths = execFileSync("git", ["ls-files", "-z"], {cwd:root,encoding:"utf8"}).split("\0").filter(Boolean);
  const findings = [];
  for (const path of paths) {
    try {
      const filename = resolve(root,path);
      if (!lstatSync(filename).isFile()) {
        findings.push({path,line:1,rule:"unsupported-file-type"});
        continue;
      }
      const bytes = readFileSync(filename);
      // This repository ships text only. Binary/NUL/UTF-16 content needs an
      // explicit publication review instead of silently escaping the scan.
      if (bytes.includes(0)) {
        findings.push({path,line:1,rule:"non-text-tracked-file"});
        continue;
      }
      let content;
      try { content = new TextDecoder("utf-8", {fatal:true}).decode(bytes); }
      catch { findings.push({path,line:1,rule:"invalid-utf8-tracked-file"}); continue; }
      findings.push(...scanText(content,path));
    } catch { findings.push({path,line:1,rule:"unreadable-tracked-file"}); }
  }
  return findings;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const findings = scanTrackedFiles();
  if (findings.length) {
    for (const item of findings) process.stderr.write(item.path + ":" + item.line + ": " + item.rule + "\n");
    process.stderr.write("PUBLICATION_GUARD_FAILED findings=" + findings.length + "\n");
    process.exitCode = 1;
  } else process.stdout.write("PUBLICATION_GUARD_OK findings=0\n");
}
