import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createTicketDelivery } from "../src/control-plane/tickets.js";

// Two public surfaces, never interchangeable: immutable content-addressed
// material, and the narrow enrollment bridge that owns the one-time ticket URL.
const assets_origin = "https://assets.example.invalid";
const enroll_origin = "https://enroll.example.invalid";
const ticketId = "ticket-12345678-1234-1234-1234-123456789abc";
const url = enroll_origin + "/v1/enrollment-tickets/" + ticketId;
const shortCode = "12345678";
const delivery = (bootstrap_sha256 = "b".repeat(64)) => createTicketDelivery({
  record: { ticket_id: ticketId }, short_code: shortCode,
  assets_origin, enroll_origin, bootstrap_sha256,
});
const pty = existsSync("/usr/bin/script") ? "/usr/bin/script" : "/bin/script";
const hasPty = process.platform !== "win32" && existsSync(pty);

function systemTool(name) {
  for (const dir of ["/usr/bin", "/bin"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("fixture requires system tool: " + name);
}
// The PTY suite only runs on POSIX hosts, so only resolve system tools there.
const systemStty = hasPty ? systemTool("stty") : "stty";

// The delivered command embeds the privileged script in single quotes, so a
// literal quote reaches a shell as '\''. Undo that only to assert on the script
// text that actually runs.
function unquoteShell(command) {
  return command.replaceAll("'\\''", "'");
}

function quoteShell(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

test("only names the bootstrap would accept reach the elevation boundary", { skip: process.platform === "win32" }, () => {
  const command = delivery().command;
  const start = command.indexOf("OPERATING_USER=");
  const end = command.indexOf('if [ "$CALLER_UID" -eq 0 ]');
  assert.ok(start > 0 && end > start, "the capture block is present");
  const dir = mkdtempSync(join(tmpdir(), "gf-capture-"));
  writeFileSync(join(dir, "id"), "#!/bin/sh\ncase \"$1\" in\n  -u) printf '1000\\n' ;;\n  -un) printf '%s\\n' \"$NAME\" ;;\n  *) exit 2 ;;\nesac\n", { mode: 0o755 });
  const block = command.slice(start, end).split("/usr/bin/id").join(join(dir, "id")) + "\nexit 0\n";
  const run = (name) => spawnSync("/bin/sh", ["-c", block], { env: { ...process.env, NAME: name }, encoding: "utf8" });
  for (const ok of ["gf-review-human", "alice", "_service", "a", "a".repeat(32)]) {
    assert.equal(run(ok).status, 0, "accepted: " + ok);
  }
  for (const bad of ["Alice", "john.doe", "-alice", "12345", "a".repeat(40), "alice'", "a b", "alice;id", ""]) {
    assert.notEqual(run(bad).status, 0, "rejected before elevation: " + bad);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("the launcher hands over one validated Human name and nothing else", () => {
  const command = delivery().command;
  // Captured from the kernel before elevation, validated for shell safety.
  // The trusted absolute tool, never a caller-PATH id.
  assert.match(command, /TRUSTED_ID=\/usr\/bin\/id/);
  assert.match(command, /OPERATING_USER="\$\("\$TRUSTED_ID" -un\)"/);
  // Exactly the bootstrap rule: first character, character class, length.
  assert.match(command, /\|\[!a-z_\]\*/);
  assert.match(command, /\*\[!a-z0-9_-\]\*/);
  assert.match(command, /-gt 32/);
  assert.doesNotMatch(command, /\$\{?SUDO_USER\b/);
  // It crosses as the shell's first positional parameter, for both paths.
  assert.match(command, /ghostfleet-enroll "\$OPERATING_USER"/);
  assert.match(command, /su --login root -c "\$ELEVATED '\$OPERATING_USER'"/);
  // The clean environment keeps exactly the two values it already had.
  assert.match(command, /\/usr\/bin\/env -i PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin HOME=\/root \/bin\/sh -c /);
  // The bootstrap re-reads it from its positional parameter, not from argv soup.
  assert.match(command, /GHOSTFLEET_OPERATING_USER="\$\{1-\}"/);
});

test("delivered launcher does not disclose one-time material in copied shell history", () => {
  const d = delivery();
  assert.equal(d.one_time_url, url);
  assert.equal(d.short_code, shortCode);
  assert.equal(d.command.includes(ticketId), false);
  assert.equal(d.command.includes(url), false);
  assert.equal(d.command.includes(d.short_code), false);
  assert.match(d.command, /su --login root -c /);
  assert.match(d.command, /sudo \/usr\/bin\/env -i /);
  assert.match(d.command, /stty -echo/);
  assert.match(d.command, /mktemp/);
  assert.doesNotMatch(d.command, /curl[^\n]*\|\s*sudo/);
  assert.doesNotMatch(unquoteShell(d.command), /GHOSTFLEET_ENROLLMENT_URL=/);
});

test("elevated script starts from a clean root-owned environment", () => {
  const command = delivery().command;
  // The elevation entry point starts env -i with a fixed root-owned PATH; the
  // su branch asks for login semantics instead of inheriting caller state.
  assert.match(command, /\/usr\/bin\/env -i PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin HOME=\/root \/bin\/sh -c /);
  assert.match(command, /su --login root -c /);
  assert.match(command, /sudo \/usr\/bin\/env -i /);
  // Nothing is resolved through the caller PATH or caller environment.
  assert.doesNotMatch(command, /command -v (curl|wget|mktemp|stty|sh|rm)\b/);
  assert.doesNotMatch(command, /(^|\n)\s*(mktemp|curl|wget|stty|rm|sh)\s/m);
  assert.doesNotMatch(command, /\$\{?TMPDIR\b/);
  assert.doesNotMatch(command, /\$\{?PATH\b/);
  assert.doesNotMatch(command, /\$\{?HOME\b/);
  assert.doesNotMatch(command, /\$\{?(ENV|BASH_ENV|LD_PRELOAD)\b/);
});

test("elevated script keeps the download in a root-created workspace", () => {
  const command = delivery().command;
  assert.match(command, /TMPROOT=\/run\//);
  assert.match(command, /TMPROOT=\/var\/tmp\//);
  assert.match(command, /\/usr\/bin\/mktemp -d "\$TMPROOT"ghostfleet-enroll\.XXXXXXXX/);
  // Content-addressed URL, no redirect following, digest verified before use.
  // The script text is asserted after undoing the shell quoting of the
  // elevated -c argument, so the flag sequence is the one root actually runs.
  const script = unquoteShell(command);
  assert.match(script, /\/usr\/bin\/curl --fail --silent --show-error --no-location --max-redirs 0 --proto '=https'/);
  assert.match(script, /\/usr\/bin\/wget --quiet --max-redirect=0 /);
  assert.match(command, /assets\.example\.invalid\/sha256\/b{64}/);
  assert.match(script, /\/bin\/sh "\$BOOTSTRAP"/);
  assert.match(script, /\/bin\/rm -rf "\$WORK_DIR"/);
  const download = script.indexOf('--output "$BOOTSTRAP"');
  const verify = script.indexOf('/usr/bin/sha256sum "$BOOTSTRAP"');
  const execute = script.indexOf('/bin/sh "$BOOTSTRAP"');
  assert.ok(download >= 0 && verify > download, "the download must precede the digest check");
  assert.ok(execute > verify, "the digest check must precede execution");
});

test("delivered command carries both public coordinates and the pinned digest", () => {
  const d = delivery();
  assert.equal(d.assets_origin, assets_origin);
  assert.equal(d.enroll_origin, enroll_origin, "the enrollment origin is readable for a byte-for-byte deployment check");
  assert.equal(d.bootstrap_sha256, "b".repeat(64));
  assert.equal(d.one_time_url, enroll_origin + "/v1/enrollment-tickets/" + ticketId);
  const script = unquoteShell(d.command);
  assert.ok(script.includes("'" + assets_origin + "'"), "the asset origin is a fixed assignment");
  assert.ok(script.includes("'" + enroll_origin + "/v1/enrollment-tickets/'"));
  // The immutable material origin is exported to the courier as a fixed value.
  assert.ok(script.includes("GHOSTFLEET_ASSETS_ORIGIN='" + assets_origin + "'"));
});

test("delivered command is origin-only: claim-material fields cannot reach argv, URL or script", () => {
  const plain = createTicketDelivery({ record: { ticket_id: ticketId }, short_code: shortCode, assets_origin, enroll_origin, bootstrap_sha256: "b".repeat(64) });
  const enriched = createTicketDelivery({
    record: {
      ticket_id: ticketId,
      // #55 adds a server-authoritative capability_selection to claim material.
      // The launcher must stay a pure function of the public origin: no claim
      // field may become command argv, a URL query handle, or script input.
      capability_selection: {
        capability_id: "helper-user-service",
        pinned_version: "1.0.0",
        sha256: "sha256:" + "c".repeat(64),
        template_digest: "sha256:" + "d".repeat(64),
      },
    },
    short_code: shortCode,
    assets_origin,
    enroll_origin,
    bootstrap_sha256: "b".repeat(64),
  });
  assert.equal(enriched.command, plain.command);
  assert.equal(enriched.one_time_url, plain.one_time_url);
  assert.doesNotMatch(plain.command, /capability/i);
  assert.doesNotMatch(plain.command, /\/v1\/bootstrap\.sh\?/);
  assert.doesNotMatch(plain.one_time_url, /\?/);
});

test("interruption traps clean up and restore terminal echo", () => {
  const script = unquoteShell(delivery().command);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /trap 'stop 129' HUP/);
  assert.match(script, /trap 'stop 130' INT/);
  assert.match(script, /trap 'stop 131' QUIT/);
  assert.match(script, /trap 'stop 143' TERM/);
  assert.match(script, /trap '' HUP INT QUIT TERM/);
  assert.match(script, /trap - EXIT HUP INT QUIT TERM/);
  assert.match(script, /\/usr\/bin\/stty "\$TTY_STATE" < \/dev\/tty/);
  assert.match(script, /IFS= read -r GHOSTFLEET_ENROLLMENT_URL < \/dev\/tty/);
  // NEW-1: cleanup ignores signals before it touches the terminal, restores the
  // terminal, removes the workspace, and only then resets the trap set.
  const cleanup = script.slice(script.indexOf("cleanup() {"), script.indexOf("trap cleanup EXIT"));
  const ignore = cleanup.indexOf("trap '' HUP INT QUIT TERM");
  const restore = cleanup.indexOf('/usr/bin/stty "$TTY_STATE"');
  const remove = cleanup.indexOf('/bin/rm -rf "$WORK_DIR"');
  const reset = cleanup.indexOf("trap - EXIT HUP INT QUIT TERM");
  assert.ok(ignore >= 0 && ignore < restore, "signals must be ignored before the terminal restore");
  assert.ok(restore < remove, "terminal echo must be restored before the workspace removal");
  assert.ok(remove < reset, "the trap set may only be reset after the workspace is gone");
  // The signal path ignores further signals before it decides the exit code.
  const stop = script.slice(script.indexOf("stop() {"), script.indexOf("trap cleanup EXIT"));
  assert.ok(stop.indexOf("trap '' HUP INT QUIT TERM") >= 0 && stop.indexOf("trap '' HUP INT QUIT TERM") < stop.indexOf('exit "$1"'));
});

test("portable root launcher is valid POSIX sh", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("sh", ["-n"], { input: delivery().command, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

// The launcher resolves every executable through an absolute root-owned path and
// keeps its download in a directory that root creates after elevation. A
// portable unit test cannot create that tree or real root, so the fixture
// materializes a private look-alike tree in a temporary directory and rewrites
// only the trusted prefixes of the generated text
// (/usr/bin -> <fixture>/usr/bin, /bin -> <fixture>/bin, /run -> <fixture>/run).
// Every instruction, trap and environment assignment under test stays identical;
// only the filesystem root moves. The pristine text is asserted above, so the
// rewrite cannot hide a regression.
const trustedPrefix = /\/usr\/sbin|\/usr\/bin|\/bin|\/sbin|\/run/g;

function rewriteTrustedRoots(command, root) {
  return command.replace(trustedPrefix, (prefix) => root + prefix);
}

function writeScript(path, lines, mode = 0o700) {
  writeFileSync(path, lines.join("\n") + "\n", { mode });
}

function callerStub(marker) {
  return ["#!/bin/sh", "printf 'caller-controlled\\n' >> " + quoteShell(marker), "exit 78"];
}

// A pinned, content-addressed payload: the fixture serves these exact bytes and
// the delivered command pins their digest, so the digest check under test is the
// real one and a mismatch is a genuine byte difference.
function sandbox({ elevation = "su", pollutePath = false, slowStty = false, pinnedSha = null, servedPayload = null, httpCode = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ghostfleet-launcher-"));
  const runRoot = join(dir, "run");
  const callerBin = join(dir, "caller-bin");
  const callerTmp = join(dir, "caller-tmp");
  const trace = join(dir, "trace");
  const receipt = join(dir, "receipt");
  const marker = join(dir, "marker");
  const echoState = join(dir, "echo-state");
  const launcher = join(dir, "launcher.sh");

  for (const path of ["usr/sbin", "usr/bin", "bin", "sbin"]) mkdirSync(join(dir, path), { recursive: true, mode: 0o755 });
  mkdirSync(runRoot, { mode: 0o700 });
  mkdirSync(callerBin, { mode: 0o700 });
  mkdirSync(callerTmp, { mode: 0o700 });

  // System tools the fixture still runs for real inside the rewritten tree.
  // sha256sum is the real verifier, never a stub: the digest check must be able
  // to fail for real.
  // grep/wc are the launcher's PATH-resolved validators; the fixture tree is the
  // elevated PATH, so the real binaries must exist there for the same reason.
  for (const name of ["env", "mktemp", "stat", "cat", "sha256sum", "grep", "wc"]) symlinkSync(systemTool(name), join(dir, "usr/bin", name));
  if (slowStty) {
    // Delay the terminal restore so a second signal is guaranteed to land inside
    // cleanup. The real stty still performs the restore; only the timing moves,
    // which is the same race window a loaded machine has.
    writeScript(join(dir, "usr/bin/stty"), [
      "#!/bin/sh",
      systemTool("sleep") + " 0.15",
      "exec " + systemTool("stty") + ' "$@"',
    ]);
  } else {
    symlinkSync(systemTool("stty"), join(dir, "usr/bin/stty"));
  }
  for (const name of ["sh", "rm"]) symlinkSync(systemTool(name), join(dir, "bin", name));

  // The launcher reads the Human identity from the trusted absolute path, so the
  // sandbox materializes that tool inside its rewritten root as well. A caller
  // PATH that shadows id must never be consulted.
  writeScript(join(dir, "usr/bin/id"), [
    "#!/bin/sh",
    "case \"$1\" in",
    "  -u) printf '%s\\n' '" + (elevation === "root" ? "0" : "1000") + "' ;;",
    "  -un) printf '%s\\n' 'fixture-human' ;;",
    "  *) exit 2 ;;",
    "esac",
  ]);
  writeScript(join(callerBin, "id"), callerStub(marker));
  if (elevation === "su") {
    // Deliberately leaky: a non-login su keeps the caller environment. The
    // launcher must still start root execution from a clean environment.
    writeScript(join(callerBin, "su"), [
      "#!/bin/sh",
      "printf 'su\\n' >> " + quoteShell(trace),
      '[ "$1" = --login ] || exit 88',
      '[ "$2" = root ] || exit 88',
      '[ "$3" = -c ] || exit 88',
      '[ -n "$4" ] || exit 88',
      'exec /bin/sh -c "$4"',
    ]);
  }
  if (elevation === "sudo") {
    writeScript(join(callerBin, "sudo"), [
      "#!/bin/sh",
      "printf 'sudo\\n' >> " + quoteShell(trace),
      '[ "$2" = -i ] || exit 88',
      'exec "$@"',
    ]);
  }
  if (pollutePath) {
    for (const name of ["mktemp", "curl", "wget", "sh", "stty", "rm", "env", "install"]) {
      writeScript(join(callerBin, name), callerStub(marker));
    }
  }

  const payload = servedPayload ?? "#!/bin/sh\nprintf '%s' \"$GHOSTFLEET_ENROLLMENT_URL\" > " + quoteShell(receipt) + "\n";
  const sha256 = pinnedSha ?? createHash("sha256").update(payload).digest("hex");
  const payloadLines = payload.split("\n");
  if (payloadLines.at(-1) === "") payloadLines.pop();
  writeScript(join(dir, "usr/bin/curl"), [
    "#!/bin/sh",
    "set -eu",
    "arguments=\"$*\"",
    "printf 'curl\\n' >> " + quoteShell(trace),
    "printf 'pid=%s\\n' \"$PPID\" >> " + quoteShell(trace),
    "out=",
    "write_out=",
    'while [ "$#" -gt 0 ]; do case "$1" in -o|--output) shift; out="$1" ;; --write-out) shift; write_out="$1" ;; esac; shift; done',
    '[ -n "$out" ] || exit 81',
    // No redirect following: the delivered command must ask for it explicitly,
    // and a delivery that did not would be visible in the pristine command text.
    'case " $arguments " in *" --no-location "*) ;; *) exit 83 ;; esac',
    'case " $arguments " in *" --max-redirs 0 "*) ;; *) exit 83 ;; esac',
    // The status is baked into the fixture script: env -i drops inherited
    // variables, so an environment-driven status could never reach root.
    'case "' + (httpCode ?? "200") + '" in 2[0-9][0-9]) ;; *) printf "%s" "' + (httpCode ?? "200") + '"; exit 0 ;; esac',
    // curl creates the output itself, so the payload umask decides the mode.
    ': > "$out"',
    '[ "$(' + systemTool("stat") + ' -c %a "$out")" = 600 ] || exit 82',
    "printf 'file=%s\\n' \"$out\" >> " + quoteShell(trace),
    systemTool("cat") + ' > "$out" <<\'BOOTSTRAP\'',
    ...payloadLines,
    "BOOTSTRAP",
    '[ -z "$write_out" ] || printf "%s" "' + (httpCode ?? "200") + '"',
  ]);

  writeFileSync(launcher, rewriteTrustedRoots(delivery(sha256).command, dir), { mode: 0o600 });
  const sessionCommand = [
    "/bin/sh " + quoteShell(launcher),
    "status=$?",
    systemStty + " -a < /dev/tty > " + quoteShell(echoState) + " 2>&1",
    "exit $status",
  ].join("; ");

  return {
    dir, runRoot, callerBin, callerTmp, trace, receipt, marker, echoState, launcher, sha256, payload,
    env: { ...process.env, PATH: callerBin, SHELL: "/bin/sh", TMPDIR: callerTmp, HOME: join(dir, "caller-home") },
    argv: ["-qefc", sessionCommand, "/dev/null"],
  };
}

function runSync(fx, { input } = {}) {
  return spawnSync(pty, fx.argv, { input, env: fx.env, encoding: "utf8", timeout: 12000 });
}

function runAsync(fx) {
  const child = spawn(pty, fx.argv, { env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  return {
    child,
    closed,
    output: () => output,
    async waitFor(pattern, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(output)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("timed out waiting for " + pattern + "; captured: " + output);
    },
  };
}

function traceLines(fx) {
  if (!existsSync(fx.trace)) return [];
  return readFileSync(fx.trace, "utf8").split("\n").filter(Boolean);
}

function downloadedFile(fx) {
  const line = traceLines(fx).find((entry) => entry.startsWith("file="));
  return line ? line.slice("file=".length) : undefined;
}

function privilegedShellPid(fx) {
  const line = traceLines(fx).find((entry) => entry.startsWith("pid="));
  return line ? Number(line.slice("pid=".length)) : undefined;
}

// temporary_file_left: the download and the private workspace must both be gone.
function temporaryFileLeft(file) {
  return existsSync(file) || existsSync(dirname(file));
}

// echo_restored: stty -a lists the exact flag tokens, so echo on and -echo off.
function echoRestored(statePath) {
  const flags = readFileSync(statePath, "utf8").split(/[\s;]+/);
  return flags.includes("echo") && !flags.includes("-echo");
}

for (const mode of ["su", "sudo", "root"]) {
  test("synthetic one-time root ceremony: " + mode, { skip: !hasPty }, () => {
    const fx = sandbox({ elevation: mode });
    try {
      const result = runSync(fx, { input: url + "\n" });
      assert.equal(result.status, 0, "launcher should succeed against synthetic bootstrap: " + result.stdout + result.stderr);
      assert.equal(readFileSync(fx.receipt, "utf8"), url);
      const trace = traceLines(fx);
      assert.ok(trace.includes("curl"));
      assert.equal(trace.includes("sudo"), mode === "sudo");
      assert.equal(trace.includes("su"), mode === "su");
      assert.equal(trace.join("\n").includes(ticketId), false);
      const downloadPath = downloadedFile(fx);
      assert.ok(downloadPath);
      assert.ok(downloadPath.startsWith(fx.runRoot + "/"), "download must live in the root-created workspace: " + downloadPath);
      assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false");
      assert.equal(echoRestored(fx.echoState), true, "echo_restored=true");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
}

test("foreign ticket origin is refused before running bootstrap", { skip: !hasPty }, () => {
  const fx = sandbox({ elevation: "su" });
  try {
    const bad = "https://attacker.invalid/v1/enrollment-tickets/" + ticketId;
    const result = runSync(fx, { input: bad + "\n" });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(fx.receipt), false);
    assert.match(result.stdout + result.stderr, /Invalid enrollment URL for this enrollment origin/);
    const downloadPath = downloadedFile(fx);
    assert.ok(downloadPath);
    assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false after a rejected origin");
    assert.equal(echoRestored(fx.echoState), true, "echo_restored=true after a rejected origin");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// The immutable asset origin is a material host, never the enrollment bridge.
// A ticket URL minted there must be refused even though the host is trusted.
test("a ticket URL on the asset origin is refused", { skip: !hasPty }, () => {
  const fx = sandbox({ elevation: "su" });
  try {
    const bad = assets_origin + "/v1/enrollment-tickets/" + ticketId;
    const result = runSync(fx, { input: bad + "\n" });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(fx.receipt), false);
    assert.match(result.stdout + result.stderr, /Invalid enrollment URL for this enrollment origin/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a ticket URL that is more than one ticket id is refused", { skip: !hasPty }, () => {
  const fx = sandbox({ elevation: "su" });
  try {
    const bad = url + "/../../v0/nodes";
    const result = runSync(fx, { input: bad + "\n" });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(fx.receipt), false);
    assert.match(result.stdout + result.stderr, /Invalid enrollment URL for this enrollment origin/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a bootstrap whose bytes do not match the pinned digest is never executed", { skip: !hasPty }, () => {
  // The fixture serves the real payload; only the pinned digest is wrong.
  const fx = sandbox({ elevation: "su", pinnedSha: "f".repeat(64) });
  try {
    const result = runSync(fx, { input: url + "\n" });
    assert.notEqual(result.status, 0, "a digest mismatch must exit non-zero");
    assert.match(result.stdout + result.stderr, /integrity check failed: expected sha256 f{64}/);
    assert.equal(existsSync(fx.receipt), false, "unknown bytes must never run");
    const downloadPath = downloadedFile(fx);
    assert.ok(downloadPath);
    assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false after a digest mismatch");
    assert.equal(echoRestored(fx.echoState), true, "echo_restored=true after a digest mismatch");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a redirect from the content address is refused, never followed", { skip: !hasPty }, () => {
  // The fixture answers 302 like a real static host would. curl without -L
  // treats it as a final response, so the launcher must reject the status
  // explicitly instead of trusting whatever body came with it.
  const fx = sandbox({ elevation: "su", httpCode: "302" });
  try {
    const result = runSync(fx, { input: url + "\n" });
    assert.notEqual(result.status, 0, "a redirect must exit non-zero");
    assert.match(result.stdout + result.stderr, /download was refused: HTTP 302/);
    assert.match(result.stdout + result.stderr, /redirects are not followed/);
    assert.equal(existsSync(fx.receipt), false, "a redirect body must never execute");
    const downloadPath = downloadedFile(fx);
    if (downloadPath) assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false after a redirect");
    assert.equal(echoRestored(fx.echoState), true, "echo_restored=true after a redirect");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("the happy path verifies the pinned digest before executing the payload", { skip: !hasPty }, () => {
  const fx = sandbox({ elevation: "su" });
  try {
    const result = runSync(fx, { input: url + "\n" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(fx.receipt, "utf8"), url);
    // The fixture only serves bytes whose digest equals the pinned value, and
    // the payload records the URL it received, so execution is a real effect.
    const downloadPath = downloadedFile(fx);
    assert.ok(downloadPath.startsWith(fx.runRoot + "/"));
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("caller PATH substitution cannot run a privileged tool", { skip: !hasPty }, () => {
  const fx = sandbox({ elevation: "su", pollutePath: true });
  try {
    const result = runSync(fx, { input: url + "\n" });
    assert.equal(result.status, 0, "caller PATH must not decide which tools root runs: " + result.stdout + result.stderr);
    assert.equal(readFileSync(fx.receipt, "utf8"), url);
    assert.equal(existsSync(fx.marker), false, "a caller-controlled tool was executed");
    assert.ok(traceLines(fx).includes("curl"), "the trusted download path must be used");
    const downloadPath = downloadedFile(fx);
    assert.ok(downloadPath.startsWith(fx.runRoot + "/"), "download must ignore the caller TMPDIR: " + downloadPath);
    assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false");
    assert.equal(echoRestored(fx.echoState), true, "echo_restored=true");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("caller TMPDIR entry replacement during the hidden prompt cannot change root execution", { skip: !hasPty }, async () => {
  const fx = sandbox({ elevation: "su" });
  try {
    // A caller-owned file that the old launcher would have created and later
    // reopened; the replacement below is exactly the review's reproducer.
    writeFileSync(join(fx.callerTmp, "bootstrap.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const run = runAsync(fx);
    await run.waitFor(/from protected Console/);
    const downloadPath = downloadedFile(fx);
    assert.ok(downloadPath, "download must already exist while the Human types");
    const workspace = dirname(downloadPath);
    assert.ok(downloadPath.startsWith(fx.runRoot + "/"), "download must live in the root-created workspace: " + downloadPath);
    assert.equal(statSync(workspace).mode & 0o777, 0o700, "root workspace must be private");
    assert.equal(statSync(downloadPath).mode & 0o777, 0o600, "downloaded script must be private");
    // Attacker swaps the caller-owned directory entries while root waits.
    for (const name of readdirSync(fx.callerTmp)) {
      writeFileSync(join(fx.callerTmp, name), ["#!/bin/sh", "printf 'replaced\\n' >> " + quoteShell(fx.marker)].join("\n"), { mode: 0o700 });
    }
    writeFileSync(join(fx.callerTmp, "bootstrap.sh"), ["#!/bin/sh", "printf 'replaced\\n' >> " + quoteShell(fx.marker)].join("\n"), { mode: 0o700 });
    run.child.stdin.write(url + "\n");
    const { code } = await run.closed;
    assert.equal(code, 0, run.output());
    assert.equal(readFileSync(fx.receipt, "utf8"), url);
    assert.equal(existsSync(fx.marker), false, "caller-owned replacement content was executed as root");
    assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

for (const [signal, expected] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGQUIT", 131], ["SIGHUP", 129]]) {
  test("interrupted hidden input " + signal + " leaves no temporary file and restores echo", { skip: !hasPty }, async () => {
    const fx = sandbox({ elevation: "su" });
    try {
      const run = runAsync(fx);
      await run.waitFor(/from protected Console/);
      const downloadPath = downloadedFile(fx);
      const pid = privilegedShellPid(fx);
      assert.ok(downloadPath, "download must exist before the interruption");
      assert.ok(Number.isInteger(pid) && pid > 0, "fixture must see the privileged shell pid");
      process.kill(pid, signal);
      const { code } = await run.closed;
      assert.equal(code, expected, "signal exit status: " + run.output());
      assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false");
      assert.equal(echoRestored(fx.echoState), true, "echo_restored=true");
      assert.equal(existsSync(fx.receipt), false, "an interrupted delivery must not run the bootstrap");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
}

// NEW-1: a second (or burst of) signals while cleanup runs must not abort the
// restore. The fixture delays the terminal restore by 150 ms, so at least one
// burst signal is guaranteed to land inside cleanup (the same race a loaded
// machine or a Human double Ctrl-C produces).
for (const [signal, expected] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test("signal burst during cleanup " + signal + " still restores echo and removes the workspace", { skip: !hasPty }, async () => {
    const fx = sandbox({ elevation: "su", slowStty: true });
    try {
      const run = runAsync(fx);
      await run.waitFor(/from protected Console/);
      const downloadPath = downloadedFile(fx);
      const pid = privilegedShellPid(fx);
      assert.ok(downloadPath, "download must exist before the interruption");
      assert.ok(Number.isInteger(pid) && pid > 0, "fixture must see the privileged shell pid");
      process.kill(pid, signal);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        try {
          process.kill(pid, signal);
        } catch {
          break;
        }
      }
      const { code } = await run.closed;
      // Only one signal number is ever delivered here, so 128+signal is exact.
      // Mixed numbers are dispatched by signal number; the invariant that spans
      // every burst is the cleanup below, which the next test covers.
      assert.equal(code, expected, "only " + signal + " was delivered, so 128+" + (expected - 128) + " is exact: " + run.output());
      assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false");
      assert.equal(echoRestored(fx.echoState), true, "echo_restored=true");
      assert.equal(existsSync(fx.receipt), false, "an interrupted delivery must not run the bootstrap");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
}

test("mixed TERM and INT burst during cleanup keeps the cleanup invariant", { skip: !hasPty }, async () => {
  const fx = sandbox({ elevation: "su", slowStty: true });
  try {
    const run = runAsync(fx);
    await run.waitFor(/from protected Console/);
    const downloadPath = downloadedFile(fx);
    const pid = privilegedShellPid(fx);
    assert.ok(downloadPath, "download must exist before the interruption");
    assert.ok(Number.isInteger(pid) && pid > 0, "fixture must see the privileged shell pid");
    // Back-to-back signals of different numbers are dispatched by signal number
    // (INT=2 before TERM=15), and the shell may coalesce them, so any delivered
    // signal's 128+n is a correct status. What must hold is the cleanup: no
    // leftover workspace, echo restored, bootstrap never executed.
    process.kill(pid, "SIGTERM");
    process.kill(pid, "SIGINT");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      try {
        process.kill(pid, attempt % 2 === 0 ? "SIGINT" : "SIGTERM");
      } catch {
        break;
      }
    }
    const { code } = await run.closed;
    assert.ok([130, 143].includes(code), "exit status must be 128+ a delivered signal (130 or 143), got " + code + ": " + run.output());
    assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false");
    assert.equal(echoRestored(fx.echoState), true, "echo_restored=true");
    assert.equal(existsSync(fx.receipt), false, "an interrupted delivery must not run the bootstrap");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

const setsid = ["/usr/bin/setsid", "/bin/setsid"].find((candidate) => existsSync(candidate));

test("a session without a controlling terminal fails with an explicit remediation", { skip: !hasPty || !setsid }, () => {
  const fx = sandbox({ elevation: "su" });
  try {
    // -w: setsid may fork when the caller is already a process group leader, so
    // wait for the actual session child before reading its status.
    const result = spawnSync(setsid, ["-w", "/bin/sh", fx.launcher], { env: fx.env, encoding: "utf8", timeout: 12000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interactive terminal/);
    assert.doesNotMatch(result.stderr, /cannot open \/dev\/tty/, "the shell redirect error must not leak before the remediation");
    const downloadPath = downloadedFile(fx);
    assert.ok(downloadPath, "the download happens before the terminal check");
    assert.equal(temporaryFileLeft(downloadPath), false, "temporary_file_left=false");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
