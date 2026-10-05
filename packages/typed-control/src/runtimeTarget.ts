import { parseControlTargets, resolveControlTarget, type ControlTarget } from "./targets.js";

export interface RuntimeTargetEnv {
  CONTROL_TARGETS_JSON: string;
  CONTROL_SSH_PRIVATE_KEY: string;
  CONTROL_WINDOWS_TARGETS_JSON?: string;
  CONTROL_SSH_PRIVATE_KEY_WINDOWS?: string;
}

export interface ResolvedRuntimeControlTarget {
  target: ControlTarget;
  controllerPrivateKey: string;
  keySource: "default" | "windows";
}

export function resolveRuntimeControlTarget(
  env: RuntimeTargetEnv,
  nodeUid: string,
): ResolvedRuntimeControlTarget {
  const primary = parseControlTargets(env.CONTROL_TARGETS_JSON);
  const windows = env.CONTROL_WINDOWS_TARGETS_JSON
    ? parseControlTargets(env.CONTROL_WINDOWS_TARGETS_JSON)
    : {};
  const primaryTarget = primary[nodeUid];
  const windowsTarget = windows[nodeUid];
  if (primaryTarget && windowsTarget) throw new Error("CONTROL_TARGET_DUPLICATE");

  if (windowsTarget) {
    if (!env.CONTROL_SSH_PRIVATE_KEY_WINDOWS) {
      throw new Error("CONTROL_WINDOWS_PRIVATE_KEY_MISSING");
    }
    return {
      target: windowsTarget,
      controllerPrivateKey: env.CONTROL_SSH_PRIVATE_KEY_WINDOWS,
      keySource: "windows",
    };
  }

  if (primaryTarget) {
    return {
      target: primaryTarget,
      controllerPrivateKey: env.CONTROL_SSH_PRIVATE_KEY,
      keySource: "default",
    };
  }

  // Preserve canonical identity/error semantics for invalid or unknown node_uid.
  resolveControlTarget(env.CONTROL_TARGETS_JSON, nodeUid);
  throw new Error("CONTROL_TARGET_NOT_REGISTERED");
}
