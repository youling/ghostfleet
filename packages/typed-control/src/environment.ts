import type { RuntimeTargetEnv } from "./runtimeTarget.js";
import type { ControlNetworkEnv } from "./transport.js";
import type { ControlSourceEnv } from "./controlPolicy.js";

/** Installed by a trusted deployment; never accepted from MCP/tool arguments. */
export interface ControlEnvironment extends RuntimeTargetEnv, ControlNetworkEnv, ControlSourceEnv {
  CONTROL_POLICY_JSON?: string;
}
