import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketDelivery } from "../src/control-plane/tickets.js";
import { BOOTSTRAP_SH } from "../packages/bootstrap/src/index.js";

// End-to-end delivery against a REAL loopback HTTP content-addressed origin and
// the REAL published courier text. The launcher is the untouched generated
// command, only its trusted filesystem roots are rewritten into a fixture tree
// (the same technique the portable launcher suite uses, because a unit test
// cannot create /run or real root).
const pty = existsSync("/usr/bin/script") ? "/usr/bin/script" : "/bin/script";
const hasPty = process.platform !== "win32" && existsSync(pty);
const ticketId = "ticket-12345678-1234-1234-1234-123456789abc";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function systemTool(name) {
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("fixture requires system tool: " + name);
}

// A content-addressed origin with exactly three behaviors: serve the reviewed
// bytes, serve different bytes at the same address, or redirect.
async function serveAssets(bytes, { mode = "ok" } = {}) {
  const requests = [];
  const state = { mode };
  const server = createServer((request, response) => {
    requests.push(request.url);
    const match = /^\/sha256\/([0-9a-f]{64})$/.exec(request.url);
    if (!match) { response.writeHead(404); response.end(); return; }
    if (state.mode === "redirect") { response.writeHead(302, { location: "/elsewhere" }); response.end(); return; }
    if (state.mode === "missing") { response.writeHead(404); response.end(); return; }
    const body = state.mode === "tamper" ? Buffer.concat([bytes, Buffer.from("\n# tampered\n")]) : bytes;
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    server,
    origin: "http://127.0.0.1:" + server.address().port,
    requests,
    setMode: (next) => { state.mode = next; },
  };
}

// The enrollment bridge origin only owns the ticket URL in this suite; the
// launcher never contacts it before it executes the courier.
async function serveEnroll() {
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: "http://127.0.0.1:" + server.address().port };
}

function writeScript(path, lines, mode = 0o700) {
  writeFileSync(path, lines.join("\n") + "\n", { mode });
}
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

async function sandbox(delivery) {
  const dir = mkdtempSync(join(tmpdir(), "ghostfleet-assets-"));
  for (const path of ["usr/sbin", "usr/bin", "bin", "sbin"]) mkdirSync(join(dir, path), { recursive: true, mode: 0o755 });
  mkdirSync(join(dir, "run"), { mode: 0o700 });
  const callerBin = join(dir, "caller-bin");
  mkdirSync(callerBin, { mode: 0o700 });
  for (const name of ["env", "mktemp", "stat", "cat", "sha256sum", "grep", "wc", "stty", "curl"]) {
    symlinkSync(systemTool(name), join(dir, "usr/bin", name));
  }
  for (const name of ["sh", "rm"]) symlinkSync(systemTool(name), join(dir, "bin", name));
  // A human caller: the launcher captures the name and hands it to root.
  writeScript(join(dir, "usr/bin/id"), [
    "#!/bin/sh",
    'case "$1" in',
    "  -u) printf '%s\\n' 1000 ;;",
    "  -un) printf '%s\\n' fixture-human ;;",
    "  *) exit 2 ;;",
    "esac",
  ]);
  writeScript(join(callerBin, "su"), [
    "#!/bin/sh",
    '[ "$1" = --login ] || exit 88',
    '[ "$2" = root ] || exit 88',
    '[ "$3" = -c ] || exit 88',
    'exec /bin/sh -c "$4"',
  ]);
  const launcher = join(dir, "launcher.sh");
  writeFileSync(launcher, delivery.command.replace(/\/usr\/sbin|\/usr\/bin|\/bin|\/sbin|\/run/g, (prefix) => dir + prefix), { mode: 0o600 });
  const session = [
    "/bin/sh " + quote(launcher),
    "status=$?",
    systemTool("stty") + " -a < /dev/tty > " + quote(join(dir, "echo-state")) + " 2>&1",
    "exit $status",
  ].join("; ");
  return {
    dir,
    launcher,
    echoState: join(dir, "echo-state"),
    argv: ["-qefc", session, "/dev/null"],
    env: { ...process.env, PATH: callerBin, SHELL: "/bin/sh", HOME: join(dir, "caller-home") },
  };
}

// The content-addressed origin is served by this process, so the PTY child must
// run asynchronously: spawnSync would block the server that answers it.
function runPty(fx, input) {
  return new Promise((resolve) => {
    const child = spawn(pty, fx.argv, { env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdin.end(input + "\n");
    child.on("close", (status) => resolve({ status, output }));
  });
}

async function withDelivery(bytes, run) {
  const assets = await serveAssets(bytes);
  const enroll = await serveEnroll();
  const delivery = createTicketDelivery({
    record: { ticket_id: ticketId },
    short_code: "12345678",
    assets_origin: assets.origin,
    enroll_origin: enroll.origin,
    node_plane_origin: "https://node-plane.example.invalid",
    bootstrap_sha256: sha256(bytes),
  });
  const fx = await sandbox(delivery);
  try {
    return await run({ assets, enroll, fx, url: enroll.origin + "/v1/enrollment-tickets/" + ticketId });
  } finally {
    assets.server.close();
    enroll.server.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
}

test("the real published courier is fetched by digest, verified and then executed", { skip: !hasPty }, async () => {
  const bytes = Buffer.from(BOOTSTRAP_SH, "utf8");
  await withDelivery(bytes, async ({ assets, fx, url }) => {
    const result = await runPty(fx, url);
    // The REAL courier ran: its first statement validates the ticket URL and
    // refuses this loopback HTTP origin before any effect. Reaching that refusal
    // proves the download was verified and executed, not merely fetched.
    assert.match(result.output, /fleet-enroll: invalid one-time enrollment URL/);
    assert.notEqual(result.status, 0, "the courier refuses a non-HTTPS ticket URL");
    assert.deepEqual(assets.requests, ["/sha256/" + sha256(bytes)], "only the pinned content address is requested");
  });
});

test("a recording payload proves the verified bytes run with the pinned coordinates", { skip: !hasPty }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostfleet-payload-"));
  const receiptPath = join(dir, "receipt");
  const payload = [
    "#!/bin/sh",
    "printf '%s\\n' \"$GHOSTFLEET_ASSETS_ORIGIN\" > " + quote(receiptPath),
    "printf '%s\\n' \"$GHOSTFLEET_ENROLLMENT_URL\" >> " + quote(receiptPath),
  ].join("\n") + "\n";
  const bytes = Buffer.from(payload, "utf8");
  const assets = await serveAssets(bytes);
  const enroll = await serveEnroll();
  const delivery = createTicketDelivery({
    record: { ticket_id: ticketId }, short_code: "12345678",
    assets_origin: assets.origin, enroll_origin: enroll.origin,
    node_plane_origin: "https://node-plane.example.invalid", bootstrap_sha256: sha256(bytes),
  });
  const fx = await sandbox(delivery);
  const url = enroll.origin + "/v1/enrollment-tickets/" + ticketId;
  try {
    const result = await runPty(fx, url);
    assert.equal(result.status, 0, result.output);
    const lines = readFileSync(receiptPath, "utf8").trim().split("\n");
    assert.deepEqual(lines, [assets.origin, url], "the verified payload ran with the pinned asset origin and ticket URL");
  } finally {
    assets.server.close();
    enroll.server.close();
    rmSync(fx.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [mode, expected] of [
  ["tamper", /integrity check failed: expected sha256 [0-9a-f]{64}, got [0-9a-f]{64}/],
  ["redirect", /download was refused: HTTP 302/],
  ["missing", /download failed: the pinned content address/],
]) {
  test("a " + mode + " answer from the content address is refused before execution", { skip: !hasPty }, async () => {
    const bytes = Buffer.from(BOOTSTRAP_SH, "utf8");
    await withDelivery(bytes, async ({ assets, fx, url }) => {
      assets.setMode(mode);
      const result = await runPty(fx, url);
      assert.notEqual(result.status, 0, "a refused download must exit non-zero");
      assert.match(result.output, expected);
      assert.doesNotMatch(result.output, /root privileges are required/, "the courier must never run");
    });
  });
}
