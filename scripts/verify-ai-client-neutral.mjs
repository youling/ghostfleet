import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.argv[2] ? path.resolve(process.argv[2]) : tmpdir();
if (scratch === root || scratch.startsWith(root + path.sep)) throw new Error("SCRATCH_MUST_BE_OUTSIDE_CHECKOUT");
await mkdir(scratch, { recursive: true });
const owned = await mkdtemp(path.join(scratch, "ghostfleet-neutral-"));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(OPENAI_|CHATGPT_|FLEET_|GHOSTFLEET_|CLOUDFLARE_|TAILSCALE_|GH_TOKEN$|GITHUB_TOKEN$|NODE_OPTIONS$|NODE_PATH$|NPM_CONFIG_)/i.test(key)));
environment.WRANGLER_SEND_METRICS = "false";
try {
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  const files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    const source = path.resolve(root, relative);
    const target = path.resolve(owned, relative);
    if (!source.startsWith(root + path.sep) || !target.startsWith(owned + path.sep)) throw new Error("SOURCE_PATH_ESCAPE");
    if (!(await lstat(source)).isFile()) throw new Error("SOURCE_MUST_BE_REGULAR_FILE");
    const raw = await readFile(source);
    digest.update(relative).update("\0").update(raw).update("\0");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, raw, { flag: "wx" });
  }
  const emptyConfig = path.join(owned, "empty-npmrc");
  const emptyGlobal = path.join(owned, "empty-global-npmrc");
  await writeFile(emptyConfig, "", { flag: "wx" });
  await writeFile(emptyGlobal, "", { flag: "wx" });
  let npmCli;
  for (const relative of ["node_modules/npm/bin/npm-cli.js", "../lib/node_modules/npm/bin/npm-cli.js"]) {
    const candidate = path.resolve(path.dirname(process.execPath), relative);
    try { await access(candidate); npmCli = candidate; break; } catch { /* Try the other official Node layout. */ }
  }
  if (!npmCli) throw new Error("NPM_CLI_UNAVAILABLE");
  console.log("RUNNING: clean source dependency install, no provider/client configuration");
  await exec(process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org",
    "--userconfig=" + emptyConfig, "--globalconfig=" + emptyGlobal], { cwd: owned, env: environment, timeout: 180000, maxBuffer: 1048576 });
  console.log("RUNNING: two official SDK clients over authenticated loopback HTTP");
  await exec(process.execPath, ["--test", "test/ai-client-neutral.test.js"], { cwd: owned, env: environment, timeout: 30000, maxBuffer: 1048576 });
  console.log(JSON.stringify({ status: "PASS", source_files: files.length, source_sha256: digest.digest("hex"),
    clean_source_snapshot: true, ambient_provider_configuration_removed: true, standard_mcp_clients: 2,
    authenticated_http_verified: true, read_credential_mutation_denied: true, device_effects: 0 }));
} catch (error) {
  console.log(JSON.stringify({ status: "FAILED", error_code: typeof error.code === "string" ? error.code : "CHECK_FAILED",
    diagnostic_sha256: createHash("sha256").update(String(error.stderr || error.message)).digest("hex") }));
  process.exitCode = 1;
} finally {
  // The only recursive removal is this freshly created, path-checked directory.
  if (path.dirname(owned) !== scratch || !path.basename(owned).startsWith("ghostfleet-neutral-")) throw new Error("CLEANUP_OWNERSHIP_MISMATCH");
  await rm(owned, { recursive: true, force: true });
}
