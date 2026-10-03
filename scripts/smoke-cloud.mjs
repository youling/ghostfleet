import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DEFAULT_ACCEPTANCE_EVIDENCE } from "../src/core/model.js";

const base = process.env.GHOSTFLEET_LOCAL_URL || "http://127.0.0.1:8791";
const url = new URL(base);
assert.equal(url.protocol, "http:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Smoke test is local-only");
const vars = Object.fromEntries((await readFile(".dev.vars", "utf8")).trim().split("\n").filter((line) => line && !line.startsWith("#")).map((line) => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
const receipt = ".wrangler/smoke-receipt.json";
async function call(path, { method = "GET", input, token = vars.GHOSTFLEET_OPERATOR_TOKEN, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  assert.equal(response.status, status, `Unexpected HTTP status for ${method} ${path}`);
  return response.json();
}

await call("/healthz", { token: null });
await call("/v0/nodes", { token: null, status: 401 });
await call("/v0/enrollment-attempts", { method: "POST", token: vars.GHOSTFLEET_READ_TOKEN, input: {}, status: 403 });
if (process.argv.includes("--verify-restart")) {
  const expected = JSON.parse(await readFile(receipt, "utf8"));
  const { nodes } = await call("/v0/nodes", { token: vars.GHOSTFLEET_READ_TOKEN });
  assert.equal(nodes.filter((node) => node.node_uid === expected.node_uid).length, 1);
  const { attempt } = await call(`/v0/enrollment-attempts/${expected.attempt_id}`);
  assert.equal(attempt.state, "ACCEPTED");
  assert.equal(attempt.node_uid, expected.node_uid);
  console.log("PASS: durable state and authority survive local runtime restart (synthetic).");
} else {
  const { attempt } = await call("/v0/enrollment-attempts", { method: "POST", input: { asset_hint: "synthetic-cloud-canary" }, status: 201 });
  const path = `/v0/enrollment-attempts/${attempt.attempt_id}`;
  await call(`${path}/prepare`, { method: "POST", input: {} });
  const { gate } = await call(`${path}/human-gates`, { method: "POST", input: {}, status: 201 });
  const bypass = await call(`${path}/claim`, { method: "POST", input: {}, status: 400 });
  assert.equal(bypass.error, "HUMAN_GATE_APPROVAL_REQUIRED");
  await call(`/v0/human-gates/${gate.gate_id}/resolve`, { method: "POST", input: { decision: "APPROVE" } });
  await call(`${path}/materialize`, { method: "POST", input: {} });
  await call(`${path}/accept`, { method: "POST", input: {}, status: 409 });
  for (const type of DEFAULT_ACCEPTANCE_EVIDENCE) await call(`${path}/evidence`, { method: "POST", input: { type, source: "synthetic-cloud-smoke", data: { status: "PASS" } }, status: 201 });
  const { node } = await call(`${path}/accept`, { method: "POST", input: { node_id: "synthetic-cloud-canary", platform: "linux" }, status: 201 });
  await call(`${path}/accept`, { method: "POST", input: {}, status: 409 });
  await mkdir(".wrangler", { recursive: true });
  await writeFile(receipt, JSON.stringify({ attempt_id: attempt.attempt_id, node_uid: node.node_uid }));
  console.log("PASS: authenticated API, HumanGate, evidence admission and duplicate rejection (synthetic).");
}
