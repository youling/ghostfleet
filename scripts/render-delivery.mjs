#!/usr/bin/env node
// Deterministic renderer for the one-click enrollment delivery.
//
// A deployment must never hand-write this command: the hardened launcher (clean
// env -i root environment, root-owned /run workspace, interactive ticket paste,
// $1 Human handover, digest-before-execute) lives in createTicketDelivery. This
// CLI exposes that exact function so CI can render it from the pinned public code
// and diff it byte-for-byte against the deployment's sample.
//
// Usage:
//   node scripts/render-delivery.mjs \
//     --assets-origin https://asset.example.invalid \
//     --enroll-origin https://enroll.example.invalid \
//     --node-plane-origin https://node-plane.example.invalid \
//     --bootstrap-sha256 <64 hex> \
//     --ticket-id ticket-<uuid> [--short-code <8 digits>] [--json | --print-sha256]
//
// Default output is the command text alone (one trailing newline). --json prints
// the whole delivery object, including the three pinned inputs. --print-sha256
// prints one line: the SHA-256 of the DEFAULT-MODE BYTES (command + newline), so
// a deployment can pin exactly what the default mode renders and verify it with
// "node scripts/render-delivery.mjs ... | sha256sum".
import { createHash } from "node:crypto";
import { createTicketDelivery } from "../src/control-plane/tickets.js";

// Strict allowlists: a mistyped optional flag must fail loudly instead of
// silently rendering a command without the requested mode.
const STRING_FLAGS = new Set(["assets-origin", "enroll-origin", "public-origin", "node-plane-origin", "bootstrap-sha256", "ticket-id", "short-code"]);
const BOOLEAN_FLAGS = new Set(["json", "print-sha256"]);

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error("UNKNOWN_ARGUMENT " + flag);
    const name = flag.slice(2);
    if (BOOLEAN_FLAGS.has(name)) { values[name.replaceAll("-", "_")] = true; continue; }
    if (!STRING_FLAGS.has(name)) throw new Error("UNKNOWN_ARGUMENT " + flag);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error("MISSING_VALUE " + flag);
    values[name.replaceAll("-", "_")] = value;
  }
  return values;
}

try {
  const args = parse(process.argv.slice(2));
  const delivery = createTicketDelivery({
    ticket_id: args.ticket_id,
    short_code: args.short_code ?? null,
    assets_origin: args.assets_origin,
    enroll_origin: args.enroll_origin,
    public_origin: args.public_origin,
    node_plane_origin: args.node_plane_origin,
    bootstrap_sha256: args.bootstrap_sha256,
  });
  if (args.print_sha256) {
    process.stdout.write(createHash("sha256").update(delivery.command + "\n").digest("hex") + "\n");
  } else if (args.json) {
    process.stdout.write(JSON.stringify(delivery, null, 2) + "\n");
  } else {
    process.stdout.write(delivery.command + "\n");
  }
} catch (error) {
  process.stderr.write("render-delivery: " + (error?.code || error?.message || "INVALID_INPUT") + "\n");
  process.exitCode = 2;
}
