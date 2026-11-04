import { z } from "zod";
import { NODE_UID_RE } from "./routing.js";
import { expectedControlSource, type ControlActor, type ControlSource, type ControlSourceEnv } from "./controlPolicy.js";

export const CONTROL_TOPOLOGY_MODES = ["legacy", "enforced"] as const;
export type ControlTopologyMode = (typeof CONTROL_TOPOLOGY_MODES)[number];

export const topologyNodeRoleSchema = z.enum(["CONTROLLER_CAPABLE", "MANAGED_ONLY"]);
export type TopologyNodeRole = z.infer<typeof topologyNodeRoleSchema>;

export const topologyNodeSchema = z.object({
  role: topologyNodeRoleSchema,
}).strict();
export type TopologyNode = z.infer<typeof topologyNodeSchema>;

export const topologyBindingSchema = z.object({
  auth_kind: z.enum(["oauth", "break_glass"]),
  user_id: z.string().min(1).max(256),
  origin_node_uid: z.string().regex(NODE_UID_RE).nullable(),
  allowed_targets: z.array(z.string().regex(NODE_UID_RE)).max(1024),
}).strict();
export type TopologyBinding = z.infer<typeof topologyBindingSchema>;

export const controlTopologySchema = z.object({
  schema_version: z.literal(1),
  source: z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
  }).strict(),
  nodes: z.record(z.string().regex(NODE_UID_RE), topologyNodeSchema),
  bindings: z.array(topologyBindingSchema).max(1024),
}).strict().superRefine((data, ctx) => {
  const seenBindings = new Set<string>();
  for (const binding of data.bindings) {
    const key = `${binding.auth_kind}:${binding.user_id}`;
    if (seenBindings.has(key)) {
      ctx.addIssue({ code: "custom", message: "DUPLICATE_TOPOLOGY_BINDING" });
    }
    seenBindings.add(key);

    if (binding.origin_node_uid !== null && !data.nodes[binding.origin_node_uid]) {
      ctx.addIssue({ code: "custom", message: "UNKNOWN_ORIGIN_NODE" });
    }

    if (new Set(binding.allowed_targets).size !== binding.allowed_targets.length) {
      ctx.addIssue({ code: "custom", message: "DUPLICATE_TARGET_NODE" });
    }

    for (const targetUid of binding.allowed_targets) {
      if (!data.nodes[targetUid]) {
        ctx.addIssue({ code: "custom", message: "UNKNOWN_TARGET_NODE" });
      }
    }
  }
});
export type ControlTopologyPolicy = z.infer<typeof controlTopologySchema>;

export interface ControlTopologyEnv extends ControlSourceEnv {
  CONTROL_TOPOLOGY_MODE?: string;
  CONTROL_TOPOLOGY_JSON?: string;
}

export function parseTopologyPolicy(raw: string | undefined, expected: ControlSource): ControlTopologyPolicy {
  if (!raw || raw.length > 256 * 1024) throw new Error("TOPOLOGY_POLICY_NOT_CONFIGURED");
  try {
    if (!expected || !expected.repository || !/^[0-9a-f]{40}$/.test(expected.revision)) {
      throw new Error("CONTROL_SOURCE_NOT_CONFIGURED");
    }
    const policy = controlTopologySchema.parse(JSON.parse(raw));
    if (policy.source.repository !== expected.repository || policy.source.revision !== expected.revision) {
      throw new Error("CONTROL_SOURCE_MISMATCH");
    }
    return policy;
  } catch (error) {
    if (error instanceof Error && ["CONTROL_SOURCE_NOT_CONFIGURED", "CONTROL_SOURCE_MISMATCH"].includes(error.message)) {
      throw error;
    }
    throw new Error("TOPOLOGY_POLICY_INVALID");
  }
}

export interface ResolvedTopologyPolicy {
  mode: ControlTopologyMode;
  policy?: ControlTopologyPolicy;
}

export function resolveTopologyPolicy(env: ControlTopologyEnv): ResolvedTopologyPolicy {
  const mode = env.CONTROL_TOPOLOGY_MODE;
  const rawJson = env.CONTROL_TOPOLOGY_JSON;

  // Case 1: Both truly absent (=== undefined) -> legacy mode (preserve old consumers)
  if (mode === undefined && rawJson === undefined) {
    return { mode: "legacy" };
  }

  // Case 2: JSON supplied without mode -> deterministic fail-closed configuration rejection
  if (mode === undefined) {
    throw new Error("TOPOLOGY_MODE_REQUIRED");
  }

  // Case 3: Invalid mode (including empty string or unexpected values)
  if (mode !== "legacy" && mode !== "enforced") {
    throw new Error("INVALID_TOPOLOGY_MODE");
  }

  // Case 4: Legacy mode with ANY supplied JSON -> configuration rejection to avoid confusing bypass
  if (mode === "legacy") {
    if (rawJson !== undefined) {
      throw new Error("TOPOLOGY_CONFIG_REJECTED");
    }
    return { mode: "legacy" };
  }

  // Case 5: Enforced mode requires valid JSON
  if (rawJson === undefined || rawJson.length === 0) {
    throw new Error("TOPOLOGY_POLICY_NOT_CONFIGURED");
  }

  const policy = parseTopologyPolicy(rawJson, expectedControlSource(env));
  return { mode: "enforced", policy };
}

function findAuthenticatedBinding(
  topology: ControlTopologyPolicy,
  actor: ControlActor | undefined,
): TopologyBinding {
  if (
    !actor ||
    typeof actor.userId !== "string" ||
    actor.userId.length === 0 ||
    actor.userId.length > 256 ||
    (actor.authKind !== "oauth" && actor.authKind !== "break_glass")
  ) {
    throw new Error("TOPOLOGY_ACTOR_NOT_BOUND");
  }

  const matching = topology.bindings.filter(
    (b) => b.auth_kind === actor.authKind && b.user_id === actor.userId,
  );
  if (matching.length === 0) {
    throw new Error("TOPOLOGY_ACTOR_NOT_BOUND");
  }
  if (matching.length > 1) {
    throw new Error("TOPOLOGY_POLICY_INVALID");
  }
  return matching[0];
}

function assertOriginIsControllerCapable(
  topology: ControlTopologyPolicy,
  binding: TopologyBinding,
): void {
  if (binding.origin_node_uid !== null) {
    const originNode = topology.nodes[binding.origin_node_uid];
    if (!originNode || originNode.role !== "CONTROLLER_CAPABLE") {
      throw new Error("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
    }
  }
}

export function enforceTopologyAuthorization(
  env: ControlTopologyEnv,
  actor: ControlActor | undefined,
  targetNodeUid: string,
): void {
  const resolved = resolveTopologyPolicy(env);
  if (resolved.mode === "legacy") {
    return;
  }

  const topology = resolved.policy!;
  const binding = findAuthenticatedBinding(topology, actor);
  assertOriginIsControllerCapable(topology, binding);

  if (typeof targetNodeUid !== "string" || !NODE_UID_RE.test(targetNodeUid)) {
    throw new Error("INVALID_NODE_UID");
  }

  const targetNode = topology.nodes[targetNodeUid];
  if (!targetNode || !binding.allowed_targets.includes(targetNodeUid)) {
    throw new Error("TOPOLOGY_TARGET_NOT_ALLOWED");
  }
}

export function filterTopologyNodes<T extends { node_uid: string }>(
  env: ControlTopologyEnv,
  actor: ControlActor | undefined,
  nodes: T[],
): T[] {
  const resolved = resolveTopologyPolicy(env);
  if (resolved.mode === "legacy") {
    return nodes;
  }

  const topology = resolved.policy!;
  const binding = findAuthenticatedBinding(topology, actor);
  assertOriginIsControllerCapable(topology, binding);

  const allowed = new Set(binding.allowed_targets);
  return nodes.filter((node) => allowed.has(node.node_uid));
}
