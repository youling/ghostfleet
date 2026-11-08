/**
 * DCR / MCP Adapter boundary for Approved Admin Commands.
 *
 * Exposes MCP tool schemas and declares the integration status with ChatGPT / ai-hub.
 * Generic product library — clean of concrete private deployment hostnames or secrets.
 */
import {
  FLEET_ADMIN_MCP_TOOLS,
  createAdminMcpDispatcher,
  dispatchAdminToolCall,
  type AdminConsumerContext,
  type AdminConsumerToolName,
  adminConsumerToolNames,
  fleetAdminToolDeclarations,
} from "./approvedAdminConsumer.js";

export {
  FLEET_ADMIN_MCP_TOOLS,
  createAdminMcpDispatcher,
  dispatchAdminToolCall,
  type AdminConsumerContext,
  type AdminConsumerToolName,
  adminConsumerToolNames,
  fleetAdminToolDeclarations,
};

export const DCR_INTEGRATION_STATUS = "PRIVATE_CONSUMER_NOT_WIRED" as const;

export interface DcrDeploymentBoundary {
  readonly status: typeof DCR_INTEGRATION_STATUS;
  readonly repository: string;
  readonly consumer_runtime: string;
  readonly target_endpoint: string;
  readonly target_host: string;
  readonly prerequisite: string;
  readonly required_deployment_actions: readonly string[];
}

export const DCR_DEPLOYMENT_BOUNDARY: DcrDeploymentBoundary = Object.freeze({
  status: DCR_INTEGRATION_STATUS,
  repository: "youling/ghostfleet",
  consumer_runtime: "chatgpt",
  target_endpoint: "https://fleet-control.example.org/mcp",
  target_host: process.env.FLEET_CONTROL_HOST ?? "fleet-control.example.org",
  prerequisite:
    "Live ChatGPT availability requires the private deployment owner (e.g. ai-hub Cloudflare Worker) to import createAdminMcpDispatcher and FLEET_ADMIN_MCP_TOOLS, configure private credentials, deploy to production, and register the MCP server with the ChatGPT Fleet consumer.",
  required_deployment_actions: Object.freeze([
    "Import @ghostfleet/typed-control into private cloudflare worker or gateway",
    "Configure CONTROL_PRIVILEGED_SSH_PRIVATE_KEY and CONTROL_APPROVED_ADMIN_POLICY_JSON in private secrets",
    "Mount FLEET_ADMIN_MCP_TOOLS in GET/POST /mcp endpoint with authenticated actor context",
    "Deploy Cloudflare Worker to production endpoint",
    "Verify tool appearance in ChatGPT MCP tool catalog",
  ]),
});
