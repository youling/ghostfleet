import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { handleMcpRequest } from "../src/integrations/mcp-http.js";
import worker from "../src/adapters/cloudflare/worker.js";

test("official MCP client initializes, discovers and calls read-only tools", async () => {
  const controller = new GhostFleetController();
  controller.createEnrollmentAttempt({ asset_hint: "synthetic-mcp-client" });
  const before = controller.store.snapshot();
  const transport = new StreamableHTTPClientTransport(new URL("https://ghostfleet.test/mcp"), {
    fetch: async (input, init) => handleMcpRequest(controller, new Request(input, init)),
  });
  const client = new Client({ name: "ghostfleet-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 4);
    assert.ok(tools.tools.every((tool) => tool.annotations.readOnlyHint));
    const result = await client.callTool({ name: "ghostfleet_list_enrollment_attempts", arguments: {} });
    assert.equal(result.structuredContent.attempts[0].asset_hint, "synthetic-mcp-client");
    await assert.rejects(client.callTool({ name: "ghostfleet_execute", arguments: {} }));
    await assert.rejects(client.callTool({ name: "ghostfleet_list_nodes", arguments: { command: "ignored" } }));
    assert.deepEqual(controller.store.snapshot(), before);
  } finally { await client.close(); }
});

test("remote MCP denies missing credentials and cross-origin requests", async () => {
  const request = new Request("https://ghostfleet.test/mcp", { method: "POST" });
  assert.equal((await worker.fetch(request, { GHOSTFLEET_READ_TOKEN: "synthetic-mcp-reader-".repeat(3) })).status, 401);
  const crossOrigin = new Request("https://ghostfleet.test/mcp", { method: "POST", headers: { origin: "https://other.test" } });
  assert.equal((await handleMcpRequest(new GhostFleetController(), crossOrigin)).status, 403);
});
