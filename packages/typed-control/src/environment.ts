import type { RuntimeTargetEnv } from "./runtimeTarget.js";
import type { ControlNetworkEnv } from "./transport.js";
import type { ControlSourceEnv } from "./controlPolicy.js";
import type { ControlTopologyEnv } from "./topologyPolicy.js";

/** Installed by a trusted deployment; never accepted from MCP/tool arguments. */
export interface ControlEnvironment extends RuntimeTargetEnv, ControlNetworkEnv, ControlSourceEnv, ControlTopologyEnv {
  CONTROL_POLICY_JSON?: string;
}
