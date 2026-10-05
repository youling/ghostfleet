import { z } from "zod";
import type { NodePolicy } from "./controlPolicy.js";

export const jobOperationId=z.string().regex(/^oj1-[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const jobHandle=z.string().regex(/^fj1-[0-9a-f]{64}$/);
export const jobGeneration=z.string().regex(/^[0-9a-f]{32}$/);
const start=z.object({action:z.literal("start"),operation_id:jobOperationId,argv:z.array(z.string().min(1).max(4096).refine(v=>!v.includes("\0"))).min(1).max(64),runtime_seconds:z.number().int().min(1).max(14400)}).strict();
export const jobRequestSchema=z.discriminatedUnion("action",[
  start,
  z.object({action:z.literal("status"),handle:jobHandle,generation:jobGeneration}).strict(),
  z.object({action:z.literal("read"),handle:jobHandle,generation:jobGeneration,cursor:z.number().int().min(0).max(4*1024*1024),max_bytes:z.number().int().min(1).max(32768)}).strict(),
  z.object({action:z.literal("cancel"),handle:jobHandle,generation:jobGeneration}).strict(),
]);
export type JobRequest=z.infer<typeof jobRequestSchema>;
const bytes=(value:string)=>new TextEncoder().encode(value);
async function sha256(value:string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes(value))),b=>b.toString(16).padStart(2,"0")).join("");
}

/** Server-selected helper/path and actor; caller controls only bounded job input. */
export async function prepareJobRpc(node:NodePolicy,nodeUid:string,actorRef:string,raw:JobRequest) {
  if (!node.jobs || node.platform!=="linux" || node.execution_privilege!=="normal") throw new Error("JOB_CAPABILITY_NOT_CONFIGURED");
  const parsed=jobRequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_JOB_REQUEST");
  const request=parsed.data;
  const envelope:Record<string,unknown>={protocol:"fleet-job/v1",node_uid:nodeUid,actor_ref:actorRef,...request};
  if(request.action==="start") {
    if (!request.argv[0]!.startsWith("/") || request.argv.some(s=>bytes(s).length>4096) || request.argv.reduce((n,s)=>n+bytes(s).length,0)>8192 || request.runtime_seconds>node.jobs.max_runtime_seconds) throw new Error("JOB_SPEC_NOT_ALLOWED");
    envelope.spec_digest=await sha256(JSON.stringify({argv:request.argv,runtime_seconds:request.runtime_seconds}));
  }
  if(request.action==="cancel") envelope.confirm=true;
  const stdin=JSON.stringify(envelope);
  if(bytes(stdin).length>16*1024) throw new Error("JOB_REQUEST_TOO_LARGE");
  // No request payload is interpolated into a shell command or process argv.
  // The installation/hash are a release-integrity check, not a security claim
  // against another arbitrary process running as the same ordinary OS user.
  const script=[
    "import hashlib,pathlib,runpy,sys",
    "p=pathlib.Path.home()/\".local/lib/ghostfleet/jobctl.py\"",
    `sys.exit(\"JOB_HELPER_HASH_MISMATCH\") if hashlib.sha256(p.read_bytes()).hexdigest()!=\"${node.jobs.helper_sha256}\" else None`,
    `sys.argv=[str(p),\"rpc\",str(pathlib.Path.home()/\".local/state/ghostfleet/jobs\"),\"${nodeUid}\"]`,
    "runpy.run_path(str(p),run_name=\"__main__\")",
  ].join(";");
  const expectedHandle=request.action==="start" ? "fj1-"+await sha256(JSON.stringify([nodeUid,actorRef,request.operation_id])) : request.handle;
  return {command:`/usr/bin/python3 -I -c '${script}'`,stdin,expectedHandle,specDigest:envelope.spec_digest as string|undefined};
}

export function parseJobResponse(raw:string,request:JobRequest,binding:{expectedHandle:string;specDigest?:string}):Record<string,unknown> {
  let value:unknown;
  try {value=JSON.parse(raw);} catch {throw new Error("JOB_RESPONSE_INVALID");}
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("JOB_RESPONSE_INVALID");
  const body=value as Record<string,unknown>;
  if(body.protocol!=="fleet-job/v1" || body.ok!==true || body.action!==request.action || !jobHandle.safeParse(body.handle).success || !jobGeneration.safeParse(body.generation).success || !jobOperationId.safeParse(body.operation_id).success || typeof body.spec_digest!=="string" || !/^[0-9a-f]{64}$/.test(body.spec_digest) || body.retry_submit!==false || typeof body.state!=="string" || !["UNKNOWN","RUNNING","SUCCEEDED","FAILED","CANCELLED","INTERRUPTED"].includes(body.state)) throw new Error("JOB_RESPONSE_INVALID");
  if(body.reconcile_required!==["UNKNOWN","INTERRUPTED"].includes(body.state)) throw new Error("JOB_RESPONSE_INVALID");
  if(body.state==="SUCCEEDED" && body.exit_code!==0) throw new Error("JOB_RESPONSE_INVALID");
  if(body.state==="FAILED" && (!Number.isInteger(body.exit_code) || body.exit_code===0)) throw new Error("JOB_RESPONSE_INVALID");
  if(["RUNNING","CANCELLED","INTERRUPTED"].includes(body.state) && body.exit_code!==null) throw new Error("JOB_RESPONSE_INVALID");
  if(body.handle!==binding.expectedHandle || (request.action!=="start" && body.generation!==request.generation)) throw new Error("JOB_RESPONSE_IDENTITY_MISMATCH");
  if(request.action==="start" && (body.operation_id!==request.operation_id || body.spec_digest!==binding.specDigest)) throw new Error("JOB_RESPONSE_IDENTITY_MISMATCH");
  if(request.action==="read") {
    if(typeof body.output_base64!=="string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.output_base64) || body.output_base64.length>4*Math.ceil(request.max_bytes/3)) throw new Error("JOB_RESPONSE_INVALID");
    const length=atob(body.output_base64).length;
    if(length>request.max_bytes || body.cursor!==request.cursor || body.next_cursor!==request.cursor+length || !Number.isInteger(body.output_bytes) || (body.output_bytes as number)<(body.next_cursor as number) || (body.output_bytes as number)>4*1024*1024 || body.more_available!==((body.next_cursor as number)<(body.output_bytes as number)) || typeof body.output_capped!=="boolean" || body.gap!==false) throw new Error("JOB_RESPONSE_INVALID");
  }
  return body;
}
