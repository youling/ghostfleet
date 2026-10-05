import { actorAllows, controlActorRef, EXEC_SCOPE, OPERATE_SCOPE, READ_SCOPE, parseControlPolicy, expectedControlSource, type ControlActor, type NodePolicy } from "./controlPolicy.js";
import { observationCommand, serviceCommand, type Observation } from "./platformOperations.js";
import { NODE_UID_RE } from "./routing.js";
import { resolveRuntimeControlTarget } from "./runtimeTarget.js";
import { connectControlTarget } from "./transport.js";
import { executeSshCommand, SshExecutionError } from "./sshClient.js";
import { createDeadlineAt, withDeadline } from "./deadline.js";
import { prepareJobRpc, parseJobResponse, type JobRequest } from "./jobOperations.js";
import { prepareSessionRpc, parseSessionResponse, type SessionRequest } from "./sessionOperations.js";
import type { ControlEnvironment } from "./environment.js";

export type OperationInput =
  | { operation:"node.inspect"; node_uid:string; observation:Observation; timeout_seconds:number }
  | { operation:"service.status" | "service.restart"; node_uid:string; service_key:string; timeout_seconds:number }
  | { operation:"shell.exec"; node_uid:string; command:string; timeout_seconds:number }
  | { operation:"job.rpc"; node_uid:string; job:JobRequest; timeout_seconds:number }
  | { operation:"session.rpc"; node_uid:string; session:SessionRequest; timeout_seconds:number };
export type OperationOutcome = "NOT_DISPATCHED" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
export interface OperationReceipt {
  schema_version:1;
  operation_id:string;
  node_uid:string;
  operation:OperationInput["operation"] | "INVALID";
  risk:"R0" | "R1" | "R2";
  execution_privilege:"normal" | "administrator" | "unverified";
  actor_ref:string;
  policy_revision:string | null;
  started_at:string;
  completed_at:string;
  outcome:OperationOutcome;
  retry_safe:boolean;
  reconcile_required:boolean;
  exit_code:number | null;
  stdout:string;
  stderr:string;
  truncated:boolean;
  error?:string;
  job?:Record<string,unknown>;
  session?:Record<string,unknown>;
}
export interface OperationDependencies { connect:typeof connectControlTarget; execute:typeof executeSshCommand }
const defaults:OperationDependencies = { connect:async()=>{throw new Error("CONTROL_BACKEND_NOT_CONFIGURED");}, execute:async()=>{throw new Error("CONTROL_BACKEND_NOT_CONFIGURED");} };

export function safeControlError(error: unknown): string {
  const code = error instanceof Error ? error.message : "CONTROL_OPERATION_FAILED";
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : "CONTROL_OPERATION_FAILED";
}

export function listControlNodes(env:ControlEnvironment, actor:ControlActor | undefined) {
  if (!actorAllows(actor, READ_SCOPE)) throw new Error("INSUFFICIENT_SCOPE");
  const policy = parseControlPolicy(env.CONTROL_POLICY_JSON,expectedControlSource(env));
  return { source:policy.source, nodes:Object.entries(policy.nodes).map(([node_uid,node])=>({
    node_uid, display_name:node.display_name, aliases:node.aliases, asset_ref:node.asset_ref, platform:node.platform,
    configured_observations:node.observations,
    configured_services:Object.entries(node.services).map(([service_key,service])=>({service_key,restart_allowed:service.restart_allowed})),
    ...(node.jobs?{configured_jobs:{protocol:node.jobs.protocol,max_runtime_seconds:node.jobs.max_runtime_seconds}}:{}),
    ...(node.sessions?{configured_sessions:{protocol:node.sessions.protocol,max_runtime_seconds:node.sessions.max_runtime_seconds}}:{}),
    // Configuration presence is deliberately not an online/contact/lifecycle assertion.
  })) };
}

/** Canonical operation boundary shared by MCP and future authenticated ingresses. */
export async function runControlOperation(
  env:ControlEnvironment, actor:ControlActor | undefined, input:OperationInput,
  dependencies:OperationDependencies=defaults,
):Promise<OperationReceipt> {
  const started = Date.now();
  const receipt:OperationReceipt = {
    schema_version:1, operation_id:crypto.randomUUID(), node_uid:"", operation:"INVALID",
    risk:"R0", execution_privilege:"unverified", actor_ref:"unverified", policy_revision:null,
    started_at:new Date(started).toISOString(), completed_at:new Date(started).toISOString(),
    outcome:"NOT_DISPATCHED", retry_safe:false, reconcile_required:false,
    exit_code:null, stdout:"", stderr:"", truncated:false,
  };
  let dispatchPossible = false;
  try {
    if(!input || typeof input!=="object" || Array.isArray(input) || typeof input.operation!=="string" || !["node.inspect","service.status","service.restart","shell.exec","job.rpc","session.rpc"].includes(input.operation)) throw new Error("INVALID_CONTROL_OPERATION");
    if(typeof input.node_uid!=="string" || !NODE_UID_RE.test(input.node_uid)) throw new Error("INVALID_NODE_UID");
    receipt.node_uid=input.node_uid;receipt.operation=input.operation;
    if(input.operation==="node.inspect" && typeof input.observation!=="string") throw new Error("INVALID_OBSERVATION");
    if((input.operation==="service.status" || input.operation==="service.restart") && typeof input.service_key!=="string") throw new Error("INVALID_SERVICE_KEY");
    if(input.operation==="shell.exec" && typeof input.command!=="string") throw new Error("INVALID_SSH_COMMAND");
    if(input.operation==="job.rpc" && (!input.job || typeof input.job!=="object" || Array.isArray(input.job) || typeof input.job.action!=="string" || !["start","status","read","cancel"].includes(input.job.action))) throw new Error("INVALID_JOB_REQUEST");
    if(input.operation==="session.rpc" && (!input.session || typeof input.session!=="object" || Array.isArray(input.session) || typeof input.session.action!=="string" || !["create","status","read","input","close"].includes(input.session.action))) throw new Error("INVALID_SESSION_REQUEST");
    const jobMutation=input.operation==="job.rpc" && ["start","cancel"].includes(input.job.action);
    const sessionMutation=input.operation==="session.rpc" && ["create","input","close"].includes(input.session.action);
    const risk = input.operation === "shell.exec" || jobMutation || sessionMutation ? "R2" : input.operation === "service.restart" ? "R1" : "R0";
    receipt.risk=risk;
    const scope = risk === "R2" ? EXEC_SCOPE : risk === "R1" ? OPERATE_SCOPE : READ_SCOPE;
    if (!actorAllows(actor,scope)) throw new Error("INSUFFICIENT_SCOPE");
    receipt.actor_ref = await controlActorRef(actor!);
    if (!Number.isInteger(input.timeout_seconds) || input.timeout_seconds<1 || input.timeout_seconds>120) throw new Error("INVALID_OPERATION_TIMEOUT");
    // Begin budget before resolution, key parsing or any transport I/O.
    const deadlineAt = Math.min(createDeadlineAt(input.timeout_seconds*1000),started+input.timeout_seconds*1000);
    const policy = parseControlPolicy(env.CONTROL_POLICY_JSON,expectedControlSource(env));
    receipt.policy_revision = policy.source.revision;
    let node:NodePolicy | undefined;
    if (input.operation !== "shell.exec") {
      node = policy.nodes[input.node_uid];
      if (!node) throw new Error("CAPABILITY_NOT_CONFIGURED");
      receipt.policy_revision = policy.source.revision;
      receipt.execution_privilege = node.execution_privilege;
    }
    const jobRpc=input.operation==="job.rpc"?await prepareJobRpc(node!,input.node_uid,receipt.actor_ref,input.job):null;
    const sessionRpc=input.operation==="session.rpc"?await prepareSessionRpc(node!,input.node_uid,receipt.actor_ref,input.session):null;
    const command = input.operation === "shell.exec" ? input.command
      : input.operation === "job.rpc" ? jobRpc!.command
      : input.operation === "session.rpc" ? sessionRpc!.command
      : input.operation === "node.inspect" ? observationCommand(node!,input.observation)
      : serviceCommand(node!,input.service_key,input.operation === "service.restart");
    if (!command || command.length>32768 || command.includes("\0")) throw new Error("INVALID_SSH_COMMAND");
    const resolved = resolveRuntimeControlTarget(env,input.node_uid);
    // Secret separation is not a platform detector: typed adapter selection
    // requires explicit policy, then must agree with the accepted target lane.
    if (node && ((node.platform === "windows") !== (resolved.keySource === "windows"))) throw new Error("TARGET_PLATFORM_MISMATCH");
    const socket = await withDeadline(
      ()=>dependencies.connect(env,input.node_uid,resolved.target), deadlineAt,"CONTROL_CONNECT_TIMEOUT",
      late=>{
        void late.closed?.catch(()=>undefined);
        void Promise.resolve().then(()=>late.close()).catch(()=>undefined);
      },
    );
    // The SSH adapter refines whether dispatch began. Unknown adapter failures
    // are conservatively uncertain after entering execute, never auto-retried.
    dispatchPossible = true;
    const stdin=jobRpc?.stdin ?? sessionRpc?.stdin;
    const result = await dependencies.execute(socket,{
      username:resolved.target.username,
      hostKeyAlgorithm:resolved.target.ssh_host_key_algorithm,
      hostKeySha256:resolved.target.ssh_host_key_sha256,
    },resolved.controllerPrivateKey,command,{timeoutMs:input.timeout_seconds*1000,deadlineAt,...(stdin?{stdin}:{})});
    Object.assign(receipt,result);
    receipt.outcome = result.exit_code === null ? "UNKNOWN" : result.exit_code === 0 ? "SUCCEEDED" : "FAILED";
    // Mutation helpers may exit nonzero after a remote side effect began.
    // Their process exit alone cannot prove that no job/session mutation happened.
    if((input.operation==="job.rpc" || input.operation==="session.rpc") && receipt.risk==="R2" && result.exit_code!==0) receipt.outcome="UNKNOWN";
    if(input.operation==="job.rpc" && result.exit_code===0) {
      if(result.truncated) throw new Error("JOB_RESPONSE_TRUNCATED");
      receipt.job=parseJobResponse(result.stdout,input.job,jobRpc!);
      receipt.stdout="";
      // RPC completion does not mean the background job completed. Preserve
      // uncertainty for start/cancel; status/read can successfully observe it.
      if(receipt.risk==="R2" && ["UNKNOWN","INTERRUPTED"].includes(String(receipt.job.state))) receipt.outcome="UNKNOWN";
    }
    if(input.operation==="session.rpc" && result.exit_code===0) {
      if(result.truncated) throw new Error("SESSION_RESPONSE_TRUNCATED");
      receipt.session=parseSessionResponse(result.stdout,input.session,sessionRpc!);
      receipt.stdout="";
      if(receipt.risk==="R2" && receipt.session.state==="UNKNOWN") receipt.outcome="UNKNOWN";
    }
  } catch (error) {
    if (error instanceof SshExecutionError) dispatchPossible = error.dispatch_state === "MAY_HAVE_EXECUTED";
    receipt.outcome = dispatchPossible ? "UNKNOWN" : "NOT_DISPATCHED";
    receipt.error = safeControlError(error);
  }
  receipt.completed_at = new Date().toISOString();
  receipt.retry_safe = receipt.risk === "R0" || receipt.outcome === "NOT_DISPATCHED";
  receipt.reconcile_required = receipt.outcome === "UNKNOWN" && receipt.risk !== "R0";
  return receipt;
}
