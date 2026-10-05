import { controlHostname, directTunnelBindingName } from "./routing.js";
import type { ControlTarget } from "./targets.js";
import type { WorkersDuplexSocket } from "./workersSocketStream.js";

export interface VpcNetworkBinding {
  connect(address: string | { hostname: string; port: number }): Promise<WorkersDuplexSocket>;
}

export interface ControlNetworkEnv {
  PRIVATE_NETWORK?: VpcNetworkBinding;
  CONTROL_HOSTNAME_SUFFIX?: string;
  [key: string]: unknown;
}

function asVpcBinding(value: unknown): VpcNetworkBinding {
  if (!value || typeof value !== "object" || typeof (value as { connect?: unknown }).connect !== "function") {
    throw new Error("CONTROL_VPC_BINDING_MISSING");
  }
  return value as VpcNetworkBinding;
}

export function resolveControlNetworkBinding(
  env: ControlNetworkEnv,
  nodeUid: string,
  target: ControlTarget,
): { binding: VpcNetworkBinding; hostname: string; port: 22 } {
  if (target.transport_mode === "mesh_hostname") {
    return {
      binding: asVpcBinding(env.PRIVATE_NETWORK),
      hostname: controlHostname(nodeUid,env.CONTROL_HOSTNAME_SUFFIX),
      port: 22,
    };
  }

  if (target.transport_mode === "direct_tunnel") {
    const bindingName = directTunnelBindingName(nodeUid);
    return {
      binding: asVpcBinding(env[bindingName]),
      hostname: "127.0.0.1",
      port: 22,
    };
  }

  throw new Error("CONTROL_TRANSPORT_MODE_UNSUPPORTED");
}

export async function connectControlTarget(
  env: ControlNetworkEnv,
  nodeUid: string,
  target: ControlTarget,
): Promise<WorkersDuplexSocket> {
  const resolved = resolveControlNetworkBinding(env, nodeUid, target);
  return resolved.binding.connect({ hostname: resolved.hostname, port: resolved.port });
}
