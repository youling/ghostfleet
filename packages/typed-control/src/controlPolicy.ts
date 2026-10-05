import { z } from "zod";
import { NODE_UID_RE } from "./routing.js";

export const READ_SCOPE = "fleet.read";
export const OPERATE_SCOPE = "fleet.operate";
export const EXEC_SCOPE = "fleet.exec";
export const PRIVILEGED_SCOPE = "fleet.privileged";
export const CONTROL_SCOPES = [READ_SCOPE, OPERATE_SCOPE, EXEC_SCOPE, PRIVILEGED_SCOPE] as const;

/** Constructed only by the authenticated ingress; never part of tool input. */
export interface ControlActor {
  userId: string;
  scopes: string[];
  authKind: "oauth" | "break_glass";
}

export async function controlActorRef(actor: ControlActor): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(actor.authKind+":"+actor.userId));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
}

export function actorAllows(actor: ControlActor | undefined, scope: string): boolean {
  const valid = !!actor && typeof actor.userId === "string" && actor.userId.length > 0 && actor.userId.length <= 256 &&
    (actor.authKind === "oauth" || actor.authKind === "break_glass") && Array.isArray(actor.scopes);
  if (!valid) return false;
  // Privileged authority is never inherited from the ordinary arbitrary-shell grant.
  if (scope === PRIVILEGED_SCOPE) return actor.scopes.includes(PRIVILEGED_SCOPE);
  // Legacy owner-approved shell grants retain their existing broader ordinary authority.
  return actor.scopes.includes(scope) || actor.scopes.includes(EXEC_SCOPE);
}

const service = z.object({
  unit: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/),
  restart_allowed: z.boolean(),
}).strict();
const rootlessHelper = {
  helper_sha256:z.string().regex(/^[0-9a-f]{64}$/),
  max_runtime_seconds:z.number().int().min(1).max(14400),
};
export const nodePolicySchema = z.object({
  display_name: z.string().min(1).max(100),
  aliases: z.array(z.string().min(1).max(100)).max(32),
  platform: z.enum(["linux", "windows"]),
  execution_privilege: z.enum(["normal", "administrator"]),
  asset_ref: z.string().regex(/^asset-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).nullable(),
  observations: z.array(z.enum(["identity", "disk", "memory", "uptime"])).max(4),
  services: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), service),
  jobs:z.object({protocol:z.literal("fleet-job/v1"),...rootlessHelper}).strict().optional(),
  sessions:z.object({protocol:z.literal("fleet-session/v2"),...rootlessHelper}).strict().optional(),
}).strict().superRefine((node, ctx) => {
  if (node.jobs && (node.platform!=="linux" || node.execution_privilege!=="normal")) ctx.addIssue({code:"custom",message:"ROOTLESS_LINUX_JOBS_REQUIRED"});
  if (node.sessions && (node.platform!=="linux" || node.execution_privilege!=="normal")) ctx.addIssue({code:"custom",message:"ROOTLESS_LINUX_SESSIONS_REQUIRED"});
  if (new Set(node.observations).size !== node.observations.length) ctx.addIssue({code:"custom",message:"DUPLICATE_OBSERVATION"});
  for (const service of Object.values(node.services)) {
    if (node.platform === "linux" && !service.unit.endsWith(".service")) ctx.addIssue({code:"custom",message:"SERVICE_UNIT_REQUIRED"});
    if (service.restart_allowed && (node.platform !== "linux" || node.execution_privilege !== "normal")) {
      ctx.addIssue({code:"custom",message:"NORMAL_LINUX_USER_SERVICE_REQUIRED"});
    }
  }
});
export const controlPolicySchema = z.object({
  schema_version: z.literal(1),
  source: z.object({repository:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), revision:z.string().regex(/^[0-9a-f]{40}$/)}).strict(),
  nodes: z.record(z.string().regex(NODE_UID_RE), nodePolicySchema),
}).strict();
export type ControlPolicy = z.infer<typeof controlPolicySchema>;
export type NodePolicy = z.infer<typeof nodePolicySchema>;

/** Rebuildable capability projection, independent from transport/credential secrets. */
export interface ControlSource { repository:string; revision:string }
export interface ControlSourceEnv { CONTROL_POLICY_SOURCE_REPOSITORY?:string; CONTROL_POLICY_SOURCE_REVISION?:string }
export function expectedControlSource(env:ControlSourceEnv):ControlSource {
  const repository=env.CONTROL_POLICY_SOURCE_REPOSITORY; const revision=env.CONTROL_POLICY_SOURCE_REVISION;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !revision || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("CONTROL_SOURCE_NOT_CONFIGURED");
  return {repository,revision};
}
export function parseControlPolicy(raw: string | undefined, expected:ControlSource): ControlPolicy {
  if (!raw || raw.length > 256 * 1024) throw new Error("CONTROL_POLICY_NOT_CONFIGURED");
  try {
    if(!expected || !expected.repository || !/^[0-9a-f]{40}$/.test(expected.revision)) throw new Error("CONTROL_SOURCE_NOT_CONFIGURED");
    const policy=controlPolicySchema.parse(JSON.parse(raw));
    if(policy.source.repository!==expected.repository || policy.source.revision!==expected.revision) throw new Error("CONTROL_SOURCE_MISMATCH");
    return policy;
  }
  catch(error) { if(error instanceof Error && ["CONTROL_SOURCE_NOT_CONFIGURED","CONTROL_SOURCE_MISMATCH"].includes(error.message)) throw error; throw new Error("CONTROL_POLICY_INVALID"); }
}
