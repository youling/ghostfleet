import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker, { GhostFleetState } from "../src/adapters/cloudflare/worker.js";
import { MCP_TOOLS } from "../src/integrations/mcp.js";

// Real SDK and HTTP traffic, synthetic storage: this is not a hardware or
// production Durable Object test. Client names are untrusted metadata.
test("two independent standard AI clients share the authenticated read-only protocol", { timeout: 15000 }, async () => {
  const reader = randomBytes(32).toString("hex");
  const values = new Map();
  const storage = { transaction: (fn) => fn({
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
  }) };
  const state = new GhostFleetState({ storage });
  const env = {
    GHOSTFLEET_READ_TOKEN: reader,
    GHOSTFLEET_STATE: { idFromName: () => "synthetic-global", get: () => state },
  };
  assert.equal(Object.keys(env).some((key) => /openai|chatgpt/i.test(key)), false);
  let base;
  const server = createServer(async (incoming, outgoing) => {
    try {
      let body = "";
      for await (const chunk of incoming) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) throw new Error("TEST_BODY_LIMIT");
      }
      const response = await worker.fetch(new Request(new URL(incoming.url, base), {
        method: incoming.method,
        headers: incoming.headers,
        ...(incoming.method !== "GET" && incoming.method !== "HEAD" ? { body } : {}),
      }), env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end("TEST_BRIDGE_FAILED"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const headers = { authorization: `Bearer ${reader}` };
    const access = await fetch(`${base}/v0/access`, { headers });
    assert.equal((await access.json()).access, "read_only");
    for (const name of ["synthetic-planner-client", "synthetic-maintenance-client"]) {
      const client = new Client({ name, version: "1.0.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), MCP_TOOLS.map((tool) => tool.name));
      assert.ok(tools.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
      const result = await client.callTool({ name: "ghostfleet_list_nodes", arguments: {} });
      assert.deepEqual(result.structuredContent, { nodes: [] });
      await assert.rejects(client.callTool({ name: "ghostfleet_execute", arguments: {} }));
    }
    const unauthenticated = new Client({ name: "synthetic-maintenance-client", version: "1.0.0" });
    clients.push(unauthenticated);
    await assert.rejects(unauthenticated.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))));
    const denied = await fetch(`${base}/v0/enrollment-attempts`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "READ_ONLY_CREDENTIAL");
    assert.equal(values.size, 0);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
