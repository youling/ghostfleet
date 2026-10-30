import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketDelivery } from "../src/control-plane/tickets.js";

const origin = "https://ghostfleet.invalid";
const ticketId = "ticket-12345678-1234-1234-1234-123456789abc";
const url = origin + "/v1/enrollment-tickets/" + ticketId;
const delivery = () => createTicketDelivery({ record: { ticket_id: ticketId }, short_code: "12345678", public_origin: origin });
const pty = existsSync("/usr/bin/script") ? "/usr/bin/script" : "/bin/script";
const hasPty = process.platform !== "win32" && existsSync(pty);

test("delivered launcher does not disclose one-time material in copied shell history", () => {
  const d = delivery();
  assert.equal(d.one_time_url, url);
  assert.equal(d.short_code, "12345678");
  assert.equal(d.command.includes(ticketId), false);
  assert.equal(d.command.includes(url), false);
  assert.equal(d.command.includes(d.short_code), false);
  assert.match(d.command, /su root -c /);
  assert.match(d.command, /sudo sh -c /);
  assert.match(d.command, /stty -echo/);
  assert.match(d.command, /mktemp/);
  assert.doesNotMatch(d.command, /curl[^\n]*\|\s*sudo/);
});

test("portable root launcher is valid POSIX sh", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("sh", ["-n"], { input: delivery().command, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

function fixture(mode) {
  const dir = mkdtempSync(join(tmpdir(), "ghostfleet-launcher-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const trace = join(dir, "trace"), receipt = join(dir, "receipt"), launcher = join(dir, "launcher.sh");
  writeFileSync(launcher, delivery().command, { mode: 0o600 });
  for (const name of ["sh", "mktemp", "rm", "stty", "stat", "cat"]) {
    const path = name === "sh" || name === "rm" ? "/bin/" + name : "/usr/bin/" + name;
    symlinkSync(path, join(bin, name));
  }
  const stub = {
    id: [
      "#!/bin/sh",
      '[ "$1" = -u ] || exit 2',
      "printf '%s\\n' \"$MOCK_UID\"",
    ].join("\n"),
    curl: [
      "#!/bin/sh",
      "set -eu",
      "printf 'curl\\n' >> \"$MOCK_TRACE\"",
      "out=",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in -o) shift; out=\"$1\" ;; esac",
      "  shift",
      "done",
      "[ -n \"$out\" ] || exit 81",
      "[ \"$(stat -c '%a' \"$out\")\" = 600 ] || exit 82",
      "printf 'file=%s\\n' \"$out\" >> \"$MOCK_TRACE\"",
      "cat > \"$out\" <<'BOOTSTRAP'",
      "#!/bin/sh",
      "printf '%s' \"$GHOSTFLEET_ENROLLMENT_URL\" > \"$MOCK_RECEIPT\"",
      "BOOTSTRAP",
    ].join("\n"),
    su: [
      "#!/bin/sh",
      "printf 'su\\n' >> \"$MOCK_TRACE\"",
      "[ \"$1\" = root ] && [ \"$2\" = -c ] || exit 88",
      "exec /bin/sh -c \"$3\"",
    ].join("\n"),
    sudo: [
      "#!/bin/sh",
      "printf 'sudo\\n' >> \"$MOCK_TRACE\"",
      "[ \"$1\" = sh ] && [ \"$2\" = -c ] || exit 88",
      "exec /bin/sh -c \"$3\"",
    ].join("\n"),
  };
  for (const [name, script] of Object.entries(stub)) {
    if (name === "sudo" && mode !== "sudo") continue;
    if (name === "su" && mode !== "su") continue;
    writeFileSync(join(bin, name), script + "\n", { mode: 0o700 });
  }
  return { dir, trace, receipt, launcher, env: {
    ...process.env, PATH: bin, MOCK_UID: mode === "root" ? "0" : "1000",
    MOCK_TRACE: trace, MOCK_RECEIPT: receipt,
  } };
}

for (const mode of ["su", "sudo", "root"]) {
  test("synthetic one-time root ceremony: " + mode, { skip: !hasPty }, () => {
    const f = fixture(mode);
    try {
      const result = spawnSync(pty, ["-qefc", "/bin/sh " + f.launcher, "/dev/null"], {
        input: url + "\n", env: f.env, encoding: "utf8", timeout: 12000,
      });
      assert.equal(result.status, 0, "launcher should succeed against synthetic bootstrap");
      assert.equal(readFileSync(f.receipt, "utf8"), url);
      const trace = readFileSync(f.trace, "utf8");
      assert.match(trace, /curl/);
      assert.equal(trace.includes("sudo\n"), mode === "sudo");
      assert.equal(trace.includes("su\n"), mode === "su");
      assert.equal(trace.includes(ticketId), false);
      const downloadPath = trace.match(/file=([^\n]+)/)?.[1];
      assert.ok(downloadPath);
      assert.equal(existsSync(downloadPath), false, "temporary downloaded script must be removed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

test("foreign ticket origin is refused before running bootstrap", { skip: !hasPty }, () => {
  const f = fixture("su");
  try {
    const bad = "https://attacker.invalid/v1/enrollment-tickets/" + ticketId;
    const result = spawnSync(pty, ["-qefc", "/bin/sh " + f.launcher, "/dev/null"], {
      input: bad + "\n", env: f.env, encoding: "utf8", timeout: 12000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(f.receipt), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
