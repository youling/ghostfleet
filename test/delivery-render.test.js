import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTicketDelivery } from "../src/control-plane/tickets.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../scripts/render-delivery.mjs");
const assets_origin = "https://assets.example.invalid";
const enroll_origin = "https://enroll.example.invalid";
const bootstrap_sha256 = "c".repeat(64);
const ticket_id = "ticket-12345678-1234-1234-1234-123456789abc";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function render(extra = [], input = {}) {
  const args = [
    script,
    "--assets-origin", assets_origin,
    "--enroll-origin", enroll_origin,
    "--bootstrap-sha256", bootstrap_sha256,
    "--ticket-id", ticket_id,
    ...extra,
  ];
  return spawnSync(process.execPath, args, { encoding: "utf8", ...input });
}

test("the CLI renders exactly the library command, with no extra output", () => {
  const expected = createTicketDelivery({
    ticket_id, short_code: "12345678", assets_origin, enroll_origin, bootstrap_sha256,
  });
  const result = render(["--short-code", "12345678"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected.command + "\n");
  assert.equal(result.stderr, "");
  // The three pinned inputs are readable for a byte-for-byte deployment check.
  const json = JSON.parse(render(["--json"], { input: undefined }).stdout);
  assert.equal(json.assets_origin, assets_origin);
  assert.equal(json.enroll_origin, enroll_origin);
  assert.equal(json.bootstrap_sha256, bootstrap_sha256);
  assert.equal(json.one_time_url, enroll_origin + "/v1/enrollment-tickets/" + ticket_id);
  assert.equal(json.protocol, "ghostfleet-enrollment-delivery/v1");
});

test("the rendered command carries the hardening and no one-time handle", () => {
  const command = render(["--short-code", "12345678"]).stdout;
  assert.match(command, new RegExp(assets_origin + "/sha256/" + bootstrap_sha256));
  assert.match(command, /--no-location/);
  assert.match(command, /--max-redirs 0/);
  assert.match(command, /--write-out/);
  assert.match(command, /sha256sum "\$BOOTSTRAP"/);
  assert.match(command, /\/usr\/bin\/env -i PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin HOME=\/root \/bin\/sh -c /);
  assert.match(command, /TMPROOT=\/run\//);
  assert.match(command, /IFS= read -r GHOSTFLEET_ENROLLMENT_URL < \/dev\/tty/);
  assert.match(command, /GHOSTFLEET_OPERATING_USER="\$\{1-\}"/);
  // Neither the ticket id, the ticket URL, nor the short code reaches argv.
  assert.equal(command.includes(ticket_id), false);
  assert.equal(command.includes(enroll_origin + "/v1/enrollment-tickets/" + ticket_id), false, "the full one-time URL never reaches argv");
  assert.equal(command.includes("12345678"), false);
});

test("--print-sha256 pins exactly the default-mode bytes", () => {
  const command = render(["--short-code", "12345678"]).stdout;
  const pinned = render(["--short-code", "12345678", "--print-sha256"]);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, sha256(command) + "\n");
  assert.match(pinned.stdout, /^[0-9a-f]{64}\n$/);
  assert.equal(render(["--print-sha256"]).stdout, pinned.stdout, "deterministic for identical inputs");
  // The command carries coordinates, never the one-time handle: two tickets on
  // the same deployment pin the same command bytes.
  const otherTicket = spawnSync(process.execPath, [
    script, "--assets-origin", assets_origin, "--enroll-origin", enroll_origin,
    "--bootstrap-sha256", bootstrap_sha256, "--ticket-id", "ticket-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "--print-sha256",
  ], { encoding: "utf8" });
  assert.equal(otherTicket.stdout, pinned.stdout);
  // A different coordinate is a different pin.
  const otherDigest = spawnSync(process.execPath, [
    script, "--assets-origin", assets_origin, "--enroll-origin", enroll_origin,
    "--bootstrap-sha256", "d".repeat(64), "--ticket-id", ticket_id, "--print-sha256",
  ], { encoding: "utf8" });
  assert.notEqual(otherDigest.stdout, pinned.stdout);
});

test("the legacy public_origin alias is the enrollment bridge, never the console", () => {
  const result = spawnSync(process.execPath, [
    script, "--assets-origin", assets_origin, "--public-origin", enroll_origin,
    "--bootstrap-sha256", bootstrap_sha256, "--ticket-id", ticket_id,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp("'" + enroll_origin.replaceAll(".", "\\.") + "/v1/enrollment-tickets/'"));
});

test("a mistyped flag is an error, never a silently ignored option", () => {
  for (const extra of [["--jsno"], ["--print-sha256=x"], ["--assets-origin"]]) {
    const result = spawnSync(process.execPath, [
      script, "--assets-origin", assets_origin, "--enroll-origin", enroll_origin,
      "--bootstrap-sha256", bootstrap_sha256, "--ticket-id", ticket_id, ...extra,
    ], { encoding: "utf8" });
    assert.equal(result.status, 2, JSON.stringify(extra));
    assert.equal(result.stdout, "", JSON.stringify(extra) + " must not render a command");
    assert.match(result.stderr, /UNKNOWN_ARGUMENT|MISSING_VALUE/);
  }
});

test("invalid coordinates fail closed with an actionable code", () => {
  const cases = [
    { extra: ["--enroll-origin", assets_origin], code: "DELIVERY_ORIGINS_NOT_SEPARATED" },
    { extra: ["--assets-origin", "https://assets.example.invalid/path"], code: "ASSETS_ORIGIN_INVALID" },
    { extra: ["--bootstrap-sha256", "not-a-digest"], code: "BOOTSTRAP_DIGEST_INVALID" },
    { extra: ["--ticket-id", "ticket-not-a-uuid"], code: "TICKET_ID_INVALID" },
  ];
  for (const item of cases) {
    const args = [
      script,
      "--assets-origin", assets_origin,
      "--enroll-origin", enroll_origin,
      "--bootstrap-sha256", bootstrap_sha256,
      "--ticket-id", ticket_id,
      ...item.extra,
    ];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 2, item.code);
    assert.equal(result.stdout, "", item.code + " must not print a command");
    assert.match(result.stderr, new RegExp(item.code));
  }
});
