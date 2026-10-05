import { connectControlTarget } from "./transport.js";
import { executeSshCommand } from "./sshClient.js";
import type { OperationDependencies } from "./operations.js";

/** Optional VPC/socket backend. The deployment supplies its authenticated binding. */
export function createCloudflareBackend(): OperationDependencies {
  return Object.freeze({ connect: connectControlTarget, execute: executeSshCommand });
}
export { resolveControlNetworkBinding } from "./transport.js";
export { controlHostname, directTunnelBindingName } from "./routing.js";
