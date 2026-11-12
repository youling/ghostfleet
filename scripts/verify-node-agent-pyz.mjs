#!/usr/bin/env node
// Deterministic rebuild assertion for the pinned node-agent payload.
//
// The managed capability lane installs /usr/local/libexec/ghostfleet/node-agent.pyz
// as a reviewed artifact: the bytes committed under packages/node-agent/dist must
// be exactly the bytes the build produces from packages/node-agent source, and the
// artifact must start under an isolated interpreter (python3 -I). A missing
// artifact is a FAILURE here, never a skip: a silent pass would let an unbuilt
// payload reach a reviewed selection.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "node-agent");
const artifact = join(packageRoot, "dist", "node-agent.pyz");
const builder = join(packageRoot, "tools", "build_pyz.py");

function fail(message) {
  process.stderr.write("verify-node-agent-pyz: " + message + "\n");
  process.exit(1);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (!existsSync(packageRoot)) {
  fail(
    "packages/node-agent is not present in this checkout; the pinned payload cannot be rebuilt or verified. " +
      "Add the agent package or remove this check deliberately - it must not be skipped silently.",
  );
}
if (!existsSync(artifact)) {
  fail(
    artifact + " is missing; the pinned payload artifact must be committed under packages/node-agent/dist.",
  );
}
if (!existsSync(builder)) {
  fail(builder + " is missing; the deterministic payload builder must be committed with the agent package.");
}

const work = mkdtempSync(join(tmpdir(), "ghostfleet-node-agent-pyz-"));
try {
  const rebuilt = join(work, "node-agent.pyz");
  execFileSync("python3", [builder, "--out", rebuilt], { cwd: packageRoot, stdio: "inherit" });
  const committedSha = sha256(artifact);
  const rebuiltSha = sha256(rebuilt);
  if (committedSha !== rebuiltSha) {
    fail(
      "the committed payload is not reproducible: committed sha256=" + committedSha +
        " rebuilt sha256=" + rebuiltSha + "; rebuild and commit packages/node-agent/dist/node-agent.pyz.",
    );
  }
  let smoke = null;
  try {
    smoke = execFileSync("python3", ["-I", artifact, "--version"], { encoding: "utf8" });
  } catch (error) {
    fail("the payload does not start under python3 -I: " + String(error.stderr || error.message));
  }
  process.stdout.write(
    "verify-node-agent-pyz: OK sha256=" + committedSha + " smoke=" + JSON.stringify(String(smoke).trim()) + "\n",
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
