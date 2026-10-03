export const MCP_TOOLS = Object.freeze([
  {
    name: "ghostfleet_list_nodes",
    description: "List admitted GhostFleet nodes and their lifecycle metadata.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "ghostfleet_list_enrollment_attempts",
    description: "List enrollment attempts, durable states, Human Gates and evidence summaries.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "ghostfleet_inspect_enrollment_attempt",
    description: "Inspect one enrollment attempt by attempt_id.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["attempt_id"],
      properties: { attempt_id: { type: "string" } },
    },
  },
  {
    name: "ghostfleet_list_capabilities",
    description: "List capability definitions exposed by the control plane. Definitions do not contain provider credentials.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
]);

export function createMcpDispatcher(controller) {
  return async function dispatch(name, args = {}) {
    if (name === "ghostfleet_list_nodes") return { nodes: controller.listNodes() };
    if (name === "ghostfleet_list_enrollment_attempts") return { attempts: controller.listEnrollmentAttempts() };
    if (name === "ghostfleet_inspect_enrollment_attempt") return { attempt: controller.getEnrollmentAttempt(args.attempt_id) };
    if (name === "ghostfleet_list_capabilities") return { capabilities: controller.listCapabilityDefinitions() };
    throw new Error("MCP_TOOL_NOT_FOUND");
  };
}
