import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS, createMcpDispatcher } from "./mcp.js";

export async function handleMcpRequest(controller, request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
  const dispatch = createMcpDispatcher(controller);
  const server = new Server({ name: "ghostfleet", version: "0.1.0-dev" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((tool) => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = MCP_TOOLS.find((item) => item.name === params.name);
    const args = params.arguments || {};
    if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
    if (Object.keys(args).some((key) => !Object.hasOwn(tool.inputSchema.properties, key))) throw new McpError(ErrorCode.InvalidParams, "Unexpected argument");
    if ((tool.inputSchema.required || []).some((key) => typeof args[key] !== "string" || !args[key])) throw new McpError(ErrorCode.InvalidParams, "Missing string argument");
    try {
      const result = await dispatch(params.name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Requested object is unavailable." }] };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536 });
  await server.connect(transport);
  try { return await transport.handleRequest(request); }
  finally { await server.close(); }
}
