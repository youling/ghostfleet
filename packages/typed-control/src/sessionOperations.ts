import { z } from "zod";
import type { NodePolicy } from "./controlPolicy.js";

const bytes=(value:string)=>new TextEncoder().encode(value);
const boundedUtf8=(max:number)=>z.string().refine(value=>!value.includes("\0") && bytes(value).length<=max);
const boundedArg=z.string().min(1).max(4096).refine(value=>!value.includes("\0") && bytes(value).length<=4096);
export const sessionOperationId=z.string().regex(/^os1-[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const sessionHandle=z.string().regex(/^fs2-[0-9a-f]{64}$/);
export const sessionGeneration=z.string().regex(/^[0-9a-f]{32}$/);
export const sessionControlKey=z.enum(["ENTER","TAB","ESCAPE","BACKSPACE","CTRL_C","CTRL_D","CTRL_Z","UP","DOWN","LEFT","RIGHT"]);
const argv=z.array(boundedArg).min(1).max(64);
const create=z.object({
  action:z.literal("create"),
  operation_id:sessionOperationId,
  argv,
  cwd_profile:z.literal("home").default("home"),
  rows:z.number().int().min(10).max(200).default(24),
  cols:z.number().int().min(20).max(400).default(100),
  runtime_seconds:z.number().int().min(1).max(14400).default(3600),
}).strict();
const identity={handle:sessionHandle,generation:sessionGeneration};
export const sessionRequestSchema=z.discriminatedUnion("action",[
  create,
  z.object({action:z.literal("status"),...identity}).strict(),
  z.object({action:z.literal("read"),...identity,cursor:z.number().int().min(0).max(4*1024*1024).default(0),max_bytes:z.number().int().min(1).max(32768).default(8192)}).strict(),
  z.object({action:z.literal("input"),...identity,input_seq:z.number().int().min(1).max(2**31-1),text:boundedUtf8(16384).default(""),control_keys:z.array(sessionControlKey).max(16).default([])}).strict()
    .refine(value=>value.text.length>0 || value.control_keys.length>0,{message:"EMPTY_INPUT"}),
  z.object({action:z.literal("close"),...identity,confirm:z.literal(true)}).strict(),
]);
export type SessionRequest=z.infer<typeof sessionRequestSchema>;

async function sha256(value:string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes(value))),b=>b.toString(16).padStart(2,"0")).join("");
}

export async function prepareSessionRpc(node:NodePolicy,nodeUid:string,actorRef:string,raw:SessionRequest) {
  if (!node.sessions || node.platform!=="linux" || node.execution_privilege!=="normal") throw new Error("SESSION_CAPABILITY_NOT_CONFIGURED");
  const parsed=sessionRequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_SESSION_REQUEST");
  const request=parsed.data;
  const envelope:Record<string,unknown>={protocol:"fleet-session/v2",node_uid:nodeUid,actor_ref:actorRef,...request};
  let specDigest:string|undefined;
  if(request.action==="create") {
    if (!request.argv[0]!.startsWith("/") || request.argv.reduce((total,value)=>total+bytes(value).length,0)>8192 || request.runtime_seconds>node.sessions.max_runtime_seconds) {
      throw new Error("SESSION_SPEC_NOT_ALLOWED");
    }
    const spec={argv:request.argv,cols:request.cols,cwd_profile:request.cwd_profile,rows:request.rows,runtime_seconds:request.runtime_seconds};
    specDigest=await sha256(JSON.stringify(spec));
    envelope.spec_digest=specDigest;
  }
  const stdin=JSON.stringify(envelope);
  if(bytes(stdin).length>32*1024) throw new Error("SESSION_REQUEST_TOO_LARGE");
  const script=[
    "import hashlib,pathlib,runpy,sys",
    "p=pathlib.Path.home()/\".local/lib/ghostfleet/sessionctl.py\"",
    "sys.exit(\"SESSION_HELPER_HASH_MISMATCH\") if hashlib.sha256(p.read_bytes()).hexdigest()!=\"" + node.sessions.helper_sha256 + "\" else None",
    "sys.argv=[str(p),\"rpc\",str(pathlib.Path.home()/\".local/state/ghostfleet/sessions\"),\"" + nodeUid + "\"]",
    "runpy.run_path(str(p),run_name=\"__main__\")",
  ].join(";");
  const expectedHandle=request.action==="create" ? "fs2-"+await sha256(JSON.stringify([nodeUid,actorRef,request.operation_id])) : request.handle;
  return {command:"/usr/bin/python3 -I -c '"+script+"'",stdin,expectedHandle,specDigest};
}

function integerOrNull(value:unknown) {
  return value===null || Number.isInteger(value);
}

export function parseSessionResponse(raw:string,request:SessionRequest,binding:{expectedHandle:string;specDigest?:string}):Record<string,unknown> {
  let value:unknown;
  try { value=JSON.parse(raw); } catch { throw new Error("SESSION_RESPONSE_INVALID"); }
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("SESSION_RESPONSE_INVALID");
  const body=value as Record<string,unknown>;
  const state=body.state;
  if (
    body.protocol!=="fleet-session/v2" || body.ok!==true || body.action!==request.action ||
    !sessionHandle.safeParse(body.handle).success || !sessionGeneration.safeParse(body.generation).success ||
    !sessionOperationId.safeParse(body.operation_id).success || typeof body.spec_digest!=="string" || !/^[0-9a-f]{64}$/.test(body.spec_digest) ||
    body.retry_mutation!==false || typeof state!=="string" || !["RUNNING","EXITED","CLOSED","UNKNOWN"].includes(state) ||
    !integerOrNull(body.exit_code) || !(body.exit_signal===null || typeof body.exit_signal==="string") ||
    !Number.isInteger(body.last_input_seq) || (body.last_input_seq as number)<0 ||
    !(body.pending_input_seq===null || (Number.isInteger(body.pending_input_seq) && (body.pending_input_seq as number)>0)) ||
    !Number.isInteger(body.output_bytes) || (body.output_bytes as number)<0 || (body.output_bytes as number)>4*1024*1024 ||
    typeof body.output_capped!=="boolean" || typeof body.reconcile_required!=="boolean" ||
    !Number.isFinite(body.idle_expires_at) || !Number.isFinite(body.absolute_expires_at) || !Number.isFinite(body.retention_until)
  ) throw new Error("SESSION_RESPONSE_INVALID");
  const expectedReconcile=state==="UNKNOWN" || body.pending_input_seq!==null;
  if(body.reconcile_required!==expectedReconcile) throw new Error("SESSION_RESPONSE_INVALID");
  if(state==="RUNNING" && (body.exit_code!==null || body.exit_signal!==null)) throw new Error("SESSION_RESPONSE_INVALID");
  if(body.handle!==binding.expectedHandle || (request.action!=="create" && body.generation!==request.generation)) throw new Error("SESSION_RESPONSE_IDENTITY_MISMATCH");
  if(request.action==="create") {
    if(body.operation_id!==request.operation_id || body.spec_digest!==binding.specDigest || typeof body.duplicate!=="boolean") throw new Error("SESSION_RESPONSE_IDENTITY_MISMATCH");
  }
  if(request.action==="input") {
    if(body.input_seq!==request.input_seq || typeof body.duplicate!=="boolean") throw new Error("SESSION_RESPONSE_INVALID");
  }
  if(request.action==="close" && typeof body.duplicate!=="boolean") throw new Error("SESSION_RESPONSE_INVALID");
  if(request.action==="read") {
    if(typeof body.output_base64!=="string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.output_base64) || body.output_base64.length>4*Math.ceil(request.max_bytes/3)) throw new Error("SESSION_RESPONSE_INVALID");
    const length=atob(body.output_base64).length;
    if(length>request.max_bytes || body.cursor!==request.cursor || body.next_cursor!==request.cursor+length || (body.output_bytes as number)<(body.next_cursor as number) || body.more_available!==((body.next_cursor as number)<(body.output_bytes as number)) || body.gap!==false) throw new Error("SESSION_RESPONSE_INVALID");
  }
  return body;
}
