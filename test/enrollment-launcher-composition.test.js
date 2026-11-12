import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTicketDelivery } from "../src/control-plane/tickets.js";

const pty = existsSync("/usr/bin/script") ? "/usr/bin/script" : "/bin/script";
// The elevated script needs a real root workspace under /run, so this suite
// runs as root (the disposable jobs and the ubuntu CI step invoke it that way).
const linuxOnly = process.platform === "win32" || !existsSync(pty) || process.getuid?.() !== 0;
const ticketId = "ticket-12345678-1234-1234-1234-123456789abc";
const caller = userInfo().username;
// Run as root, only the root path is meaningful: there is no Human to hand over.
const isRoot = process.getuid?.() === 0;
const ROOT_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

// The immutable material origin: exactly one success path, addressed by digest.
function serveAssets(body, digest) {
  return new Promise((resolve) => {
    let hits = 0;
    const server = createServer((request, response) => {
      hits += 1;
      if (request.url === "/sha256/" + digest) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: "http://127.0.0.1:" + server.address().port, hits: () => hits }));
  });
}

// A second, distinct origin for the enrollment bridge. The launcher only
// validates the ticket URL against it here; this composition does not claim.
function serveEnroll() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: "http://127.0.0.1:" + server.address().port }));
  });
}

function stub(dir, name, body) {
  writeFileSync(join(dir, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
}

// The composition under test: the Console-generated launcher text, evaluated by
// a shell, hands exactly one name to the bootstrap that runs inside env -i.
async function compose({ mode, pollute = false }) {
  const work = mkdtempSync(join(tmpdir(), "gf-launcher-"));
  const bin = join(work, "bin");
  const poison = join(work, "poison");
  const record = join(work, "record.json");
  mkdirSync(bin);
  mkdirSync(poison);
  // Anything the caller puts on PATH must never run as root.
  const marker = join(work, "poison-ran");
  stub(poison, "sh", "printf ran > " + JSON.stringify(marker));
  stub(poison, "curl", "printf ran > " + JSON.stringify(marker));

  const bootstrapBody = "#!/bin/sh\n" +
    "printf '{\"user\":\"%s\",\"path\":\"%s\",\"home\":\"%s\",\"sudo_user\":\"%s\",\"url\":\"%s\",\"assets\":\"%s\"}\\n' " +
    "\"$GHOSTFLEET_OPERATING_USER\" \"$PATH\" \"$HOME\" \"$SUDO_USER\" \"$GHOSTFLEET_ENROLLMENT_URL\" \"$GHOSTFLEET_ASSETS_ORIGIN\" > " +
    JSON.stringify(record) + "\n";
  const digest = createHash("sha256").update(bootstrapBody).digest("hex");
  const { server, origin, hits } = await serveAssets(bootstrapBody, digest);
  const enroll = await serveEnroll();

  const idBody = mode === "root"
    ? 'case "$1" in -u) echo 0 ;; -un) echo root ;; esac'
    : 'case "$1" in -u) echo 1000 ;; -un) echo ' + JSON.stringify(caller) + ' ;; esac';
  stub(bin, "id", idBody);
  if (mode !== "root") {
    if (mode === "sudo") stub(bin, "sudo", 'exec "$@"');
    if (mode === "su") stub(bin, "su", 'shift 3; exec /bin/sh -c "$1"');
  }

  const delivery = createTicketDelivery({
    record: { ticket_id: ticketId }, short_code: "12345678",
    assets_origin: origin, enroll_origin: enroll.origin, bootstrap_sha256: digest,
  });
  const env = {
    PATH: (pollute ? poison + ":" : "") + bin + ":" + ROOT_PATH,
    HOME: work,
  };
  const child = spawn(pty, ["-qec", delivery.command, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  child.stdin.write(enroll.origin + "/v1/enrollment-tickets/" + ticketId + "\n");
  child.stdin.end();
  const code = await closed;
  const value = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null;
  const hitsAfter = hits();
  server.close();
  enroll.server.close();
  rmSync(work, { recursive: true, force: true });
  return { code, output, value, poisoned: existsSync(marker), hits: hitsAfter, assets_origin: origin, enroll_origin: enroll.origin };
}

test("the Console launcher hands the Human identity through sudo and su without weakening env -i", { skip: linuxOnly || isRoot }, async () => {
  for (const mode of ["sudo", "su"]) {
    const result = await compose({ mode });
    assert.equal(result.code, 0, mode + " output: " + result.output);
    assert.ok(result.value, mode + ": the bootstrap never ran");
    assert.equal(result.value.user, caller, mode + ": the bootstrap received the caller identity");
    assert.equal(result.value.path, ROOT_PATH, mode + ": the elevated PATH is the fixed root PATH");
    assert.equal(result.value.home, "/root", mode + ": HOME is root's");
    assert.equal(result.value.sudo_user, "", mode + ": the caller environment is still dropped");
    assert.match(result.value.url, /\/v1\/enrollment-tickets\/ticket-/, mode + ": the one-time URL still reaches the bootstrap");
    assert.equal(result.value.assets, result.assets_origin, mode + ": the asset origin reaches the courier as a fixed value");
  }
});

test("non-root composition evidence is NOT_RUN when this suite runs as root", { skip: linuxOnly || !isRoot }, (t) => {
  // Visible in CI logs instead of silently skipping: the sudo/su/pollution
  // cases need a real ordinary Human with NOPASSWD sudo.
  t.diagnostic("NOT_RUN_NON_ROOT_COMPOSITION: run as an ordinary Human (e.g. su - gf-review-human) with NOPASSWD sudo to exercise the sudo/su/pollution cases");
});

test("a root caller hands no Human identity over, so the bootstrap can fail closed", { skip: linuxOnly }, async () => {
  const result = await compose({ mode: "root" });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.value);
  assert.equal(result.value.user, "", "a root caller has no Human account to hand over");
  assert.equal(result.value.path, ROOT_PATH);
});

test("a polluted caller PATH cannot execute inside the elevated environment", { skip: linuxOnly || isRoot }, async () => {
  const result = await compose({ mode: "sudo", pollute: true });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.value.path, ROOT_PATH, "the caller PATH does not survive elevation");
  assert.equal(result.poisoned, false, "nothing from the caller PATH ran as root");
});
