import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.cwd();
const policy = JSON.parse(readFileSync(resolve(root, "publication-policy.json"), "utf8"));
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["tailscale-auth-key", /\btskey-[A-Za-z0-9_-]{20,}\b/],
  ["project-api-key", /\bsk-proj-[A-Za-z0-9_-]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer-credential", /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{16,}/i],
  ["tailnet-locator", /\b(?:[a-z0-9-]+\.)+[a-z0-9-]+\.ts\.net\b/i],
  ["node-identifier", /\bnode-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["home-path", /(?:\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\)/i],
  ["private-repository-link", /github\.com\/(?:youling)\/(?:ghostfleet|fleet|ai-hub)(?:\/|\b)/i],
];
function hostAllowed(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
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
        if (!hostAllowed(url.hostname)) findings.push({path,line:i+1,rule:"unreviewed-endpoint"});
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
      const bytes = readFileSync(resolve(root,path));
      if (bytes.includes(0)) continue;
      findings.push(...scanText(bytes.toString("utf8"),path));
    } catch { findings.push({path,line:1,rule:"unreadable-tracked-file"}); }
  }
  return findings;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const findings = scanTrackedFiles();
  if (findings.length) {
    for (const item of findings) process.stderr.write(item.path + ":" + item.line + ": " + item.rule + "\n");
    process.stderr.write("PUBLICATION_GUARD_FAILED findings=" + findings.length + "\n");
    process.exitCode = 1;
  } else process.stdout.write("PUBLICATION_GUARD_OK findings=0\n");
}
