import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform === "win32") throw new Error("Run this cloud-runtime verifier on Linux; core tests remain cross-platform.");
const port = 18791;
const base = `http://127.0.0.1:${port}`;
await import("./init-local.mjs");
await mkdir(".wrangler", { recursive: true });
const log = await open(".wrangler/verify-cloud.log", "w", 0o600);
let server;
async function stop() {
  if (!server) return;
  const current = server;
  server = null;
  const closed = new Promise((resolve) => current.once("close", resolve));
  if (current.exitCode === null) {
    try { process.kill(-current.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await closed;
  }
}
async function start() {
  server = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0"], {
    detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: ".wrangler/runtime.log" },
  });
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error("Local Worker exited; inspect .wrangler/verify-cloud.log");
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).service === "ghostfleet") return;
    } catch { /* Startup isn't ready yet. */ }
    await delay(250);
  }
  throw new Error("Local Worker did not become ready; inspect .wrangler/verify-cloud.log");
}
async function smoke(args = []) {
  const child = spawn(process.execPath, ["scripts/smoke-cloud.mjs", ...args], {
    stdio: "inherit", env: { ...process.env, GHOSTFLEET_LOCAL_URL: base },
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error("Cloud smoke failed");
}
try {
  await start();
  const html = await fetch(base);
  if (!html.ok || !(await html.text()).includes("GhostFleet")) throw new Error("Console assets unavailable");
  await smoke();
  await stop();
  await start();
  await smoke(["--verify-restart"]);
} finally {
  await stop();
  await log.close();
}
