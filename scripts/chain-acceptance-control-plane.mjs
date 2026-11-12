#!/usr/bin/env node
// Local control-plane stub for the disposable chained-acceptance CI job.
//
// It is the server half of one enrollment, and nothing else: it serves the
// exact published courier bytes at /sha256/<digest>, verifies the one-time
// short code with the real src/control-plane/tickets.js module, and answers
// the claim with the reviewed capability selection bound to the ticket's
// template_digest. The completion receipt is accepted and recorded.
//
// It runs only on the disposable GitHub-hosted VM, listens on loopback and
// never contacts another service. The client half of every request is the
// real published code under test.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { BOOTSTRAP_SH, encodeCapabilitySelection, normalizeSelectedCapability } =
  await import(pathToFileURL(join(repoRoot, "packages/bootstrap/src/index.js")).href);
const { createTicketRecord, createTicketDelivery, verifyTicketClaim, validateClaimMaterial } =
  await import(pathToFileURL(join(repoRoot, "src/control-plane/tickets.js")).href);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(name + " is required");
  return value;
}

const work = required("--work");
const certPath = required("--cert");
const keyPath = required("--key");
const privilegedKeyFile = required("--privileged-key");
const nodeId = required("--node-id");
const shortCode = required("--short-code");
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(nodeId)) throw new Error("--node-id is not a safe host name");
if (!/^[0-9]{8}$/.test(shortCode)) throw new Error("--short-code must be eight digits");

const privilegedRoot = join(
  repoRoot,
  "packages/runtime-python/src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged",
);
const readArtifact = (name) => readFileSync(join(privilegedRoot, name), "utf8");

// The unit is data pinned by the selection. It is a one-shot canary: this job
// proves installation, ownership, enablement and Linger, not a managed runtime.
const unitText = [
  "[Unit]",
  "Description=GhostFleet managed runtime (disposable chained acceptance)",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/bin/true",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");

// Synthetic test template digest: no reviewed enrollment template carries this
// value. The ticket binds it and the claim repeats it, so the recorded
// capability state proves the binding end to end inside this run.
const templateDigest = "sha256:" + createHash("sha256").update("ghostfleet-chain-acceptance-template/v1").digest("hex");
const selection = {
  source: "template",
  template_digest: templateDigest,
  version: "managed-linux-privileged-operations/chain-acceptance-1",
  helper_required: true,
  linger_required: true,
  user_service_required: true,
  // The run identity owns the unit and Linger; the privileged identity stays with
  // the reviewed installer. The courier creates the former when it is absent.
  control_account: "ghostfleet-managed",
  privileged_account: "ghostfleet-ops",
  installer: "managed-linux-privileged-operations.sh",
  privileged_key: "privileged-ops.pub",
  user_unit: { name: "ghostfleet-managed.service", artifact: "ghostfleet-managed.service" },
  artifacts: [
    { name: "managed-linux-privileged-operations.sh", mode: "0750", content: readArtifact("managed-linux-privileged-operations.sh") },
    { name: "fleet_privctl.py", mode: "0755", content: readArtifact("fleet_privctl.py") },
    { name: "fleet_privileged_ssh_entry.py", mode: "0755", content: readArtifact("fleet_privileged_ssh_entry.py") },
    { name: "fleet_admin_command.py", mode: "0755", content: readArtifact("fleet_admin_command.py") },
    { name: "privileged-ops.pub", mode: "0644", content: readFileSync(privilegedKeyFile, "utf8") },
    { name: "ghostfleet-managed.service", mode: "0644", content: unitText },
  ],
};
const shape = normalizeSelectedCapability(selection);
const selectionBase64 = encodeCapabilitySelection(selection, { templateDigest });
const artifactSha = (name) => shape.artifacts.find((item) => item.name === name).sha256;

const ticketId = "ticket-" + randomUUID();
const record = createTicketRecord({
  ticket_id: ticketId,
  attempt: {
    attempt_id: "attempt-" + randomUUID(),
    template_binding: {
      template_id: "managed-linux-privileged-operations",
      template_generation: 1,
      template_digest: templateDigest,
    },
  },
  short_code: shortCode,
  issued_at: new Date(Date.now() - 300_000).toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
});

const courierBody = Buffer.from(BOOTSTRAP_SH, "utf8");

// The immutable material store: exactly the public bytes, addressed by digest.
// The courier and the launcher both fetch from this map, never from an inline
// claim payload, so the content-addressing path is the one under test.
const assetBytes = new Map();
const addAsset = (bytes) => {
  const digest = createHash("sha256").update(bytes).digest("hex");
  assetBytes.set(digest, bytes);
  return digest;
};
const bootstrapDigest = addAsset(courierBody);
for (const artifact of shape.artifacts) addAsset(Buffer.from(artifact.content, "utf8"));

const claimPath = "/v1/enrollment-tickets/" + encodeURIComponent(ticketId) + "/claim";
const counters = { bootstrap: 0, artifact: 0, claim: 0 };
const counterFile = (name) => join(work, name + "-count");
for (const name of Object.keys(counters)) writeFileSync(counterFile(name), "0");
const bump = (name) => {
  counters[name] += 1;
  writeFileSync(counterFile(name), String(counters[name]));
};

function readBody(request, limit = 65536) {
  return new Promise((done, failRead) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        request.destroy();
        failRead(new Error("request body too large"));
      }
    });
    request.on("end", () => done(body));
  });
}

const server = createServer(
  { cert: readFileSync(certPath), key: readFileSync(keyPath) },
  async (request, response) => {
    const url = new URL(request.url, "https://" + (request.headers.host || "loopback.invalid"));
    const send = (status, body, type = "application/json") => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };
    try {
      if (request.method === "GET" && /^\/sha256\/[0-9a-f]{64}$/.test(url.pathname)) {
        const digest = url.pathname.slice("/sha256/".length);
        if (digest === bootstrapDigest) {
          bump("bootstrap");
          // Record the exact digest handed to the socket, so the job can compare
          // what the server sent with what the launcher wrote and verified.
          writeFileSync(join(work, "served-bootstrap.sha256"), bootstrapDigest + "\n");
          send(200, courierBody, "application/octet-stream");
          console.log("stub: served the published courier at its content address");
          return;
        }
        const bytes = assetBytes.get(digest);
        if (bytes) {
          bump("artifact");
          send(200, bytes, "application/octet-stream");
          console.log("stub: served a pinned artifact at its content address");
          return;
        }
        send(404, "not found", "text/plain");
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        send(200, "ok", "text/plain");
        return;
      }
      if (request.method === "POST" && url.pathname === claimPath) {
        const body = await readBody(request);
        const preflight = String(request.headers["x-ghostfleet-preflight-digest"] || "");
        const verdict = verifyTicketClaim(record, {
          short_code: body.trim(),
          preflight_digest: preflight,
          now_ms: Date.now(),
        });
        if (!verdict.ok) {
          send(verdict.status, JSON.stringify({ code: verdict.code }));
          console.log("stub: claim refused (" + verdict.code + ")");
          return;
        }
        const delivery = {
          resume_session: "resume-" + randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
          auth_key: "tskey-auth-" + randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "").slice(0, 8),
          identity_kind: "canonical",
          node_id: nodeId,
          node_uid: "uid-" + randomUUID().replaceAll("-", ""),
        };
        validateClaimMaterial({ outcome: "READY", delivery });
        bump("claim");
        writeFileSync(
          join(work, "claim-request.json"),
          JSON.stringify(
            {
              path: url.pathname,
              os_family: String(request.headers["x-fleet-os-family"] || ""),
              os_id: String(request.headers["x-fleet-os-id"] || ""),
              preflight_digest: preflight,
              ticket_verification: verdict.ok ? "PASSED_BY_TICKETS_MODULE" : verdict.code,
            },
            null,
            2,
          ) + "\n",
        );
        send(200, JSON.stringify({ ...delivery, capability_required: true, capability_selection: selectionBase64 }));
        console.log("stub: claim verified against the ticket short code; selection delivered");
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/enroll/complete") {
        const body = await readBody(request, 1048576);
        const receipt = JSON.parse(body);
        if (typeof receipt.resume_session !== "string" || typeof receipt.report !== "object" || receipt.report === null) {
          send(400, JSON.stringify({ code: "COMPLETION_INVALID" }));
          return;
        }
        writeFileSync(join(work, "completion-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
        send(200, JSON.stringify({ accepted: true }));
        console.log("stub: completion receipt accepted");
        return;
      }
      send(404, JSON.stringify({ code: "NOT_FOUND" }));
    } catch (error) {
      send(500, JSON.stringify({ code: "STUB_ERROR" }));
      console.log("stub: error " + (error && error.message));
    }
  },
);

server.on("error", (error) => {
  console.log("stub: server error " + (error && error.message));
  process.exit(1);
});

const quoteShell = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // Two public surfaces on one HTTPS listener: the certificate names both
  // 127.0.0.1 and localhost, so the asset origin and the enrollment bridge stay
  // distinguishable origins while exercising one process.
  const assetsOrigin = "https://127.0.0.1:" + port;
  const enrollOrigin = "https://localhost:" + port;
  // The launcher text is the real createTicketDelivery output, unmodified.
  const delivery = createTicketDelivery({
    record, short_code: shortCode,
    assets_origin: assetsOrigin, enroll_origin: enrollOrigin, bootstrap_sha256: bootstrapDigest,
  });
  writeFileSync(join(work, "launcher.sh"), "#!/bin/sh\n" + delivery.command + "\n", { mode: 0o755 });
  // The delivered selection text, decoded from the exact claim bytes, so the job
  // can count the pinned artifact rows instead of trusting the module's summary.
  writeFileSync(join(work, "claim-selection.txt"), Buffer.from(selectionBase64, "base64").toString("utf8"));
  const facts = {
    origin: enrollOrigin,
    assets_origin: assetsOrigin,
    bootstrap_sha256: bootstrapDigest,
    ticket_id: ticketId,
    short_code: shortCode,
    template_digest: templateDigest,
    selection_digest: shape.selection_digest,
    node_id: nodeId,
    control_account: shape.control_account,
    privileged_account: shape.privileged_account,
    unit_sha256: artifactSha("ghostfleet-managed.service"),
    helper_sha256: artifactSha("fleet_privctl.py"),
    installer_sha256: artifactSha("managed-linux-privileged-operations.sh"),
    artifact_count: shape.artifacts.length,
  };
  writeFileSync(join(work, "expected.json"), JSON.stringify(facts, null, 2) + "\n");
  writeFileSync(
    join(work, "facts.sh"),
    Object.entries(facts).map(([name, value]) => name.toUpperCase() + "=" + quoteShell(value)).join("\n") + "\n",
  );
  console.log("stub: listening on " + enrollOrigin + " (assets " + assetsOrigin + ")");
  writeFileSync(join(work, "ready"), enrollOrigin + "\n");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
