/** Dedicated optional privileged lane. No ordinary exec scope/key inheritance and no shell input. */
import { z } from "zod";
import { PRIVILEGED_SCOPE, actorAllows, type ControlActor } from "./controlPolicy.js";
import { parseControlTargets } from "./targets.js";
import { connectControlTarget, type ControlNetworkEnv } from "./transport.js";
import { executeSshCommand, SshExecutionError, sshKeyFingerprintSha256 } from "./sshClient.js";
import { importKey } from "@microsoft/dev-tunnels-ssh-keys";
import { createDeadlineAt, withDeadline } from "./deadline.js";

export const PRIVILEGED_SCHEMA = "youling-fleet-privileged-operations/v3";
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const uid = z.string().regex(/^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const privilegedOperationSchema = z.enum(["root-probe", "android-udev-access"]);
const operation = privilegedOperationSchema;
const binding = {
  schema: z.literal(PRIVILEGED_SCHEMA),
  node_uid: uid,
  request_id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{7,79}$/),
  actor_ref: hex,
  generation: hex,
  profile_generation: digest,
  operation,
  vendor_ids: z.array(z.string().regex(/^[0-9a-f]{4}$/)).max(16),
};
export const privilegedRequestSchema = z.object(binding).strict().superRefine((r, ctx) => {
  if ((r.operation === "root-probe" ? r.vendor_ids.length !== 0 : !r.vendor_ids.length) ||
    JSON.stringify(r.vendor_ids) !== JSON.stringify([...new Set(r.vendor_ids)].sort())) {
    ctx.addIssue({code:"custom", message:"PRIVILEGED_VENDOR_SET_INVALID"});
  }
});
export type PrivilegedRequest = z.infer<typeof privilegedRequestSchema>;
export const privilegedExecuteToolShape = {
  node_uid: uid,
  request_id: binding.request_id,
  operation,
  vendor_ids: binding.vendor_ids,
};
export const privilegedStatusToolShape = {
  ...privilegedExecuteToolShape,
  generation: hex,
  profile_generation: digest,
};
const inputSchema = z.object({
  action: z.enum(["execute", "status"]),
  ...privilegedStatusToolShape,
}).strict();
export type PrivilegedInput = z.infer<typeof inputSchema>;
const policySchema = z.object({
  protocol: z.literal(PRIVILEGED_SCHEMA), generation: hex, profile_generation: digest,
  operations: z.array(operation).min(1).max(2),
}).strict();

export interface PrivilegedRuntimeEnv extends ControlNetworkEnv {
  CONTROL_PRIVILEGED_TARGETS_JSON?: string;
  CONTROL_PRIVILEGED_USERNAME?: string;
  CONTROL_PRIVILEGED_POLICY_JSON?: string;
  CONTROL_PRIVILEGED_SSH_PRIVATE_KEY?: string;
  CONTROL_SSH_PRIVATE_KEY?: string;
  CONTROL_SSH_PRIVATE_KEY_WINDOWS?: string;
  CONTROL_TARGETS_JSON?: string;
  CONTROL_WINDOWS_TARGETS_JSON?: string;
}

export function currentPrivilegedPolicyBinding(
  env: PrivilegedRuntimeEnv,
  nodeUid: string,
  op: z.infer<typeof privilegedOperationSchema>,
): {generation:string; profile_generation:string} {
  const node = uid.parse(nodeUid);
  const selected = privilegedOperationSchema.parse(op);
  const policy = z.record(uid, policySchema).parse(JSON.parse(env.CONTROL_PRIVILEGED_POLICY_JSON ?? "{}"))[node];
  if (!policy || !policy.operations.includes(selected)) throw new Error("PRIVILEGED_POLICY_BINDING_MISMATCH");
  return {generation:policy.generation, profile_generation:policy.profile_generation};
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b=>b.toString(16).padStart(2,"0")).join("");
}

/** All protocol strings are ASCII and all values are scalars or a string array. */
export async function canonicalRequestDigest(request: PrivilegedRequest): Promise<string> {
  const valid = privilegedRequestSchema.parse(request);
  return sha256(JSON.stringify(valid, Object.keys(valid).sort()));
}

export function resolvePrivilegedTarget(env: PrivilegedRuntimeEnv, nodeUid: string) {
  const target = parseControlTargets(env.CONTROL_PRIVILEGED_TARGETS_JSON ?? "{}")[nodeUid];
  if (!env.CONTROL_PRIVILEGED_USERNAME || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(env.CONTROL_PRIVILEGED_USERNAME) || !target || target.username !== env.CONTROL_PRIVILEGED_USERNAME) throw new Error("PRIVILEGED_OPS_PRINCIPAL_REQUIRED");
  const key = env.CONTROL_PRIVILEGED_SSH_PRIVATE_KEY;
  if (!key || key.length > 65536) throw new Error("PRIVILEGED_KEY_REQUIRED");
  // Fail closed if ordinary lane metadata is absent: separation must be provable.
  if (!env.CONTROL_SSH_PRIVATE_KEY || !env.CONTROL_TARGETS_JSON) throw new Error("ORDINARY_LANE_EVIDENCE_REQUIRED");
  for (const ordinaryKey of [env.CONTROL_SSH_PRIVATE_KEY, env.CONTROL_SSH_PRIVATE_KEY_WINDOWS]) {
    if (ordinaryKey && ordinaryKey.replace(/\s/g, "") === key.replace(/\s/g, "")) throw new Error("PRIVILEGED_KEY_MUST_BE_SEPARATE");
  }
  for (const raw of [env.CONTROL_TARGETS_JSON, env.CONTROL_WINDOWS_TARGETS_JSON]) {
    if (raw && Object.values(parseControlTargets(raw)).some(t=>t.username === env.CONTROL_PRIVILEGED_USERNAME)) {
      throw new Error("ORDINARY_LANE_MUST_NOT_USE_OPS_PRINCIPAL");
    }
  }
  return {target, controllerPrivateKey:key};
}

const receiptSchema = z.object({
  ...binding, request_digest: hex,
  state:z.enum(["NOT_FOUND", "PENDING", "UNKNOWN", "SUCCEEDED"]),
  result:z.record(z.string(),z.unknown()).optional(), error:z.string().regex(/^[A-Z0-9_]{1,100}$/).optional(),
}).strict();
export type PrivilegedReceipt = z.infer<typeof receiptSchema>;

export async function parsePrivilegedResponse(raw: string, request: PrivilegedRequest, action: "execute" | "status"): Promise<PrivilegedReceipt> {
  if (new TextEncoder().encode(raw).length > 32768) throw new Error("PRIVILEGED_RECEIPT_TOO_LARGE");
  const r = receiptSchema.parse(JSON.parse(raw));
  for (const key of Object.keys(binding) as (keyof PrivilegedRequest)[]) {
    if (JSON.stringify(r[key]) !== JSON.stringify(request[key])) throw new Error("PRIVILEGED_RECEIPT_BINDING_MISMATCH");
  }
  if (r.request_digest !== await canonicalRequestDigest(request)) throw new Error("PRIVILEGED_RECEIPT_DIGEST_MISMATCH");
  if (r.state === "NOT_FOUND" && action !== "status") throw new Error("PRIVILEGED_RECEIPT_STATE_INVALID");
  if (r.state !== "SUCCEEDED") {
    if (r.result !== undefined || (r.state === "UNKNOWN" && !r.error)) throw new Error("PRIVILEGED_RECEIPT_INVALID");
    return r;
  }
  const result = r.result;
  if (!result || result.ok !== true || typeof result.changed !== "boolean" || typeof result.duplicate !== "boolean") throw new Error("PRIVILEGED_RESULT_INVALID");
  for (const key of ["schema", "request_id", "actor_ref", "node_uid", "operation", "generation", "profile_generation"] as const) {
    if (result[key] !== request[key]) throw new Error("PRIVILEGED_RESULT_BINDING_MISMATCH");
  }
  if (request.operation === "root-probe") {
    if (result.execution_privilege !== "root" || result.changed !== false) throw new Error("PRIVILEGED_RESULT_INVALID");
  } else if (JSON.stringify(result.vendor_ids) !== JSON.stringify(request.vendor_ids) || result.adb_group !== "ghostfleet_adb" ||
    ["group_created", "membership_added", "rule_changed", "new_login_required"].some(k=>typeof result[k] !== "boolean")) {
    throw new Error("PRIVILEGED_RESULT_INVALID");
  }
  return r;
}

export interface PrivilegedDependencies {connect:typeof connectControlTarget;execute:typeof executeSshCommand}
const defaults:PrivilegedDependencies = {connect:async()=>{throw new Error("CONTROL_BACKEND_NOT_CONFIGURED");},execute:async()=>{throw new Error("CONTROL_BACKEND_NOT_CONFIGURED");}};

async function assertDistinctKeyIdentities(env:PrivilegedRuntimeEnv, key:string, deadlineAt:number) {
  async function identity(pem:string) {
    const imported = await withDeadline(()=>importKey(pem),deadlineAt,"PRIVILEGED_KEY_IMPORT_TIMEOUT",late=>late.dispose());
    try {return await withDeadline(()=>sshKeyFingerprintSha256(imported),deadlineAt,"PRIVILEGED_KEY_IMPORT_TIMEOUT");}
    finally {imported.dispose();}
  }
  const privileged = await identity(key);
  for (const ordinary of [env.CONTROL_SSH_PRIVATE_KEY, env.CONTROL_SSH_PRIVATE_KEY_WINDOWS]) {
    if (ordinary && await identity(ordinary) === privileged) throw new Error("PRIVILEGED_KEY_MUST_BE_SEPARATE");
  }
}

/** Authenticated controller seam; not exposed by the ordinary MCP/exec catalog.
 * Trusted ingress supplies actor, deployment supplies target/pins/policy/key.
 * UNKNOWN is resolved only by status with the same original request binding.
 */
export async function runPrivilegedOperation(env:PrivilegedRuntimeEnv, actor:ControlActor | undefined,
  raw:PrivilegedInput, dependencies:PrivilegedDependencies=defaults) {
  let dispatched = false;
  try {
    if (!actor || !actorAllows(actor,PRIVILEGED_SCOPE)) throw new Error("PRIVILEGED_SCOPE_REQUIRED");
    const input = inputSchema.parse(raw);
    const policy = currentPrivilegedPolicyBinding(env,input.node_uid,input.operation);
    if (input.action === "execute" &&
      (policy.generation !== input.generation || policy.profile_generation !== input.profile_generation)) throw new Error("PRIVILEGED_POLICY_BINDING_MISMATCH");
    const {action, ...spec} = input;
    const request = privilegedRequestSchema.parse({...spec, schema:PRIVILEGED_SCHEMA,
      actor_ref:await sha256(actor.authKind+":"+actor.userId)});
    const resolved = resolvePrivilegedTarget(env, input.node_uid);
    const deadlineAt = createDeadlineAt(30000);
    await assertDistinctKeyIdentities(env,resolved.controllerPrivateKey,deadlineAt);
    const socket = await withDeadline(()=>dependencies.connect(env,input.node_uid,resolved.target),deadlineAt,"PRIVILEGED_CONNECT_TIMEOUT",
      late=>{void late.closed?.catch(()=>undefined);void Promise.resolve().then(()=>late.close()).catch(()=>undefined);});
    dispatched = true;
    const result = await dependencies.execute(socket, {username:resolved.target.username,
      hostKeyAlgorithm:resolved.target.ssh_host_key_algorithm, hostKeySha256:resolved.target.ssh_host_key_sha256},
      resolved.controllerPrivateKey, null, {deadlineAt,timeoutMs:30000,outputLimitBytes:32768,forcedCommandPrincipal:env.CONTROL_PRIVILEGED_USERNAME,stdin:JSON.stringify({...request,action})});
    if (result.exit_code !== 0 || result.truncated) throw new Error("PRIVILEGED_HELPER_RESPONSE_UNAVAILABLE");
    const receipt = await parsePrivilegedResponse(result.stdout,request,action);
    // A missing receipt can race the original execute request's admission.
    // Successful status transport is not proof that the operation had no effect.
    const uncertain = ["NOT_FOUND","PENDING","UNKNOWN"].includes(receipt.state);
    return {outcome:uncertain ? "UNKNOWN" : "SUCCEEDED",receipt,reconcile_required:uncertain,retry_safe:action === "status"};
  } catch (error) {
    if (error instanceof SshExecutionError) dispatched = error.dispatch_state === "MAY_HAVE_EXECUTED";
    const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "PRIVILEGED_OPERATION_INVALID";
    return {outcome:dispatched ? "UNKNOWN" : "NOT_DISPATCHED",error:code,reconcile_required:dispatched,retry_safe:false};
  }
}
