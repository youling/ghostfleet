import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DEFAULT_ACCEPTANCE_EVIDENCE } from "../src/core/model.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
assert.equal((await call("/v0/access")).access, "operator");
assert.equal((await call("/v0/access", { token: vars.GHOSTFLEET_READ_TOKEN })).access, "read_only");
await call("/v0/access", { token: null, status: 401 });
await call("/v0/enrollment-attempts", { method: "POST", token: vars.GHOSTFLEET_READ_TOKEN, input: {}, status: 403 });
await call("/mcp", { method: "POST", token: null, input: {}, status: 401 });
const mcpClient = new Client({ name: "ghostfleet-cloud-smoke", version: "1.0.0" });
try {
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), {
    requestInit: { headers: { authorization: `Bearer ${vars.GHOSTFLEET_READ_TOKEN}` } },
  }));
  assert.equal((await mcpClient.listTools()).tools.length, 4);
  const viaMcp = await mcpClient.callTool({ name: "ghostfleet_list_nodes", arguments: {} });
  const viaHttp = await call("/v0/nodes", { token: vars.GHOSTFLEET_READ_TOKEN });
  assert.deepEqual(viaMcp.structuredContent.nodes, viaHttp.nodes);
  console.log("PASS: official remote MCP client connects to Worker and reads the same durable node state.");
} finally { await mcpClient.close(); }
if (process.argv.includes("--verify-restart")) {
  const expected = JSON.parse(await readFile(receipt, "utf8"));
  const { nodes } = await call("/v0/nodes", { token: vars.GHOSTFLEET_READ_TOKEN });
  assert.equal(nodes.filter((node) => node.node_uid === expected.node_uid).length, 1);
  const { attempt } = await call(`/v0/enrollment-attempts/${expected.attempt_id}`);
  assert.equal(attempt.state, "MATERIALIZING");
  assert.equal(attempt.node_uid, expected.node_uid);
  assert.equal(nodes.find((node) => node.node_uid === expected.node_uid).lifecycle, "PROVISIONAL");
  console.log("PASS: durable provisional identity and denied admission survive local runtime restart (synthetic).");
} else {
  const { attempt } = await call("/v0/enrollment-attempts", { method: "POST", input: { asset_hint: "synthetic-cloud-canary" }, status: 201 });
  const path = `/v0/enrollment-attempts/${attempt.attempt_id}`;
  await call(`${path}/prepare`, { method: "POST", input: {} });
  const { gate } = await call(`${path}/human-gates`, { method: "POST", input: {}, status: 201 });
  const bypass = await call(`${path}/claim`, { method: "POST", input: {}, status: 400 });
  assert.equal(bypass.error, "HUMAN_GATE_APPROVAL_REQUIRED");
  await call(`/v0/human-gates/${gate.gate_id}/resolve`, { method: "POST", input: { decision: "APPROVE" } });
  const { attempt: materializing } = await call(`${path}/materialize`, { method: "POST", input: { node_id: "synthetic-cloud-canary", platform: "linux" } });
  const { nodes: provisionalNodes } = await call("/v0/nodes", { token: vars.GHOSTFLEET_READ_TOKEN });
  assert.equal(provisionalNodes.find((node) => node.node_uid === materializing.node_uid)?.lifecycle, "PROVISIONAL");
  const before = await call(`${path}/accept`, { method: "POST", input: {}, status: 409 });
  assert.equal(before.error, "ACCEPTANCE_EVIDENCE_MISSING");
  const externalTypes = DEFAULT_ACCEPTANCE_EVIDENCE.filter((type) => !["identity.materialized", "catalog.admitted"].includes(type));
  assert.deepEqual(new Set(before.missing), new Set(externalTypes));
  for (const type of externalTypes) {
    const denied = await call(`${path}/evidence`, { method: "POST", input: {
      type, source: "ghostfleet-linux-adapter", data: { status: "PASS" },
    }, status: 403 });
    assert.equal(denied.error, "EVIDENCE_TRUSTED_INGRESS_REQUIRED");
  }
  const after = await call(`${path}/accept`, { method: "POST", input: {}, status: 409 });
  assert.equal(after.error, "ACCEPTANCE_EVIDENCE_MISSING");
  assert.deepEqual(new Set(after.missing), new Set(externalTypes));
  const current = await call(`${path}`);
  assert.equal(current.attempt.state, "MATERIALIZING");
  assert.equal(current.attempt.node_uid, materializing.node_uid);
  const { nodes: stillProvisional } = await call("/v0/nodes", { token: vars.GHOSTFLEET_READ_TOKEN });
  assert.equal(stillProvisional.find((node) => node.node_uid === materializing.node_uid)?.lifecycle, "PROVISIONAL");
  await mkdir(".wrangler", { recursive: true });
  await writeFile(receipt, JSON.stringify({ attempt_id: attempt.attempt_id, node_uid: materializing.node_uid }));
  console.log("PASS: Operator and HumanGate routes work; untrusted HTTP evidence cannot admit a node (synthetic).");
}
