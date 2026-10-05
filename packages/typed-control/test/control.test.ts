import {describe,it,expect,vi} from "vitest";
import {runControlOperation,listControlNodes,parseControlPolicy,expectedControlSource,actorAllows,PRIVILEGED_SCOPE,createNativeBackend,parseControlTargets,prepareJobRpc,prepareSessionRpc,parseJobResponse,parseSessionResponse,withDeadline} from "../src/index.js";
import {resolveControlNetworkBinding} from "../src/transport.js";
import type {ControlActor,NodePolicy} from "../src/controlPolicy.js";
import type {ControlEnvironment} from "../src/environment.js";

const uid="node-00000000-0000-4000-8000-000000000001";
const revision="a".repeat(40);
const source={repository:"example/fixture-product",revision};
const node:NodePolicy={display_name:"Synthetic device",aliases:[],platform:"linux",execution_privilege:"normal",asset_ref:null,observations:["identity"],services:{fixture:{unit:"fixture.service",restart_allowed:false}},jobs:{protocol:"fleet-job/v1",helper_sha256:"c".repeat(64),max_runtime_seconds:60},sessions:{protocol:"fleet-session/v2",helper_sha256:"d".repeat(64),max_runtime_seconds:60}};
function environment():ControlEnvironment {
  return {CONTROL_POLICY_SOURCE_REPOSITORY:source.repository,CONTROL_POLICY_SOURCE_REVISION:revision,CONTROL_POLICY_JSON:JSON.stringify({schema_version:1,source,nodes:{[uid]:node}}),CONTROL_TARGETS_JSON:JSON.stringify({[uid]:{username:"fixture",transport_mode:"local_ssh",ssh_host_key_algorithm:"ssh-ed25519",ssh_host_key_sha256:"SHA256:AAAA"}}),CONTROL_SSH_PRIVATE_KEY:"synthetic-adapter-label-no-key-material"};
}
const request={operation:"node.inspect" as const,node_uid:uid,observation:"identity" as const,timeout_seconds:1};
const contactCounts=new WeakMap<object,{connect:number;execute:number}>();
function backend(){
  const counts={connect:0,execute:0};
  const selected=createNativeBackend({connect:async()=>{counts.connect++;return {close:async()=>{},closed:Promise.resolve()} as never;},execute:async()=>{counts.execute++;return {exit_code:0,stdout:"synthetic observation",stderr:"",truncated:false};}});
  contactCounts.set(selected,counts);return selected;
}

describe("explicit optional control library",()=>{
  it("preserves a class adapter receiver and its custody state",async()=>{
    class CustodyAdapter {
      count=0;label="synthetic protected adapter";
      async connect(){this.count++;return {close:async()=>{},closed:Promise.resolve()} as never;}
      async execute(){this.count++;return {exit_code:0,stdout:this.label,stderr:"",truncated:false};}
    }
    const adapter=new CustodyAdapter();const selected=createNativeBackend(adapter);
    const receipt=await runControlOperation(environment(),{userId:"fixture",scopes:["fleet.read"],authKind:"oauth"},request,selected);
    expect(receipt.outcome).toBe("SUCCEEDED");expect(adapter.count).toBe(2);expect(receipt.stdout).toBe(adapter.label);
  });
  it.each(["synthetic-client-alpha","synthetic-client-beta"])("operates for neutral trusted actor %s with no OpenAI config",async(client)=>{
    const actor:ControlActor={userId:client,scopes:["fleet.read"],authKind:"oauth"};
    const result=await runControlOperation(environment(),actor,request,backend());
    expect(result.outcome).toBe("SUCCEEDED");expect(result.risk).toBe("R0");expect(result.policy_revision).toBe(revision);
    expect(listControlNodes(environment(),actor).nodes).toHaveLength(1);
  });
  it("denies the missing default backend and never creates implicit execution",async()=>{
    const result=await runControlOperation(environment(),{userId:"fixture",scopes:["fleet.read"],authKind:"oauth"},request);
    expect(result.outcome).toBe("NOT_DISPATCHED");expect(result.error).toBe("CONTROL_BACKEND_NOT_CONFIGURED");
  });
  it.each(["repository","revision"])("rejects wrong source %s before target contact",async(field)=>{
    const env=environment();const policy=JSON.parse(env.CONTROL_POLICY_JSON!);policy.source[field]=field==="repository"?"example/untrusted-product":"b".repeat(40);env.CONTROL_POLICY_JSON=JSON.stringify(policy);
    const deps=backend();const result=await runControlOperation(env,{userId:"fixture",scopes:["fleet.read"],authKind:"oauth"},request,deps);
    expect(result.error).toBe("CONTROL_SOURCE_MISMATCH");expect(contactCounts.get(deps)!.connect).toBe(0);
  });
  it("requires configured source and rejects nontrusted actor without contacting a target",async()=>{
    expect(()=>expectedControlSource({})).toThrow("CONTROL_SOURCE_NOT_CONFIGURED");
    expect(()=>parseControlPolicy(environment().CONTROL_POLICY_JSON,undefined as never)).toThrow("CONTROL_SOURCE_NOT_CONFIGURED");
    const deps=backend();const result=await runControlOperation(environment(),undefined,request,deps);expect(result.error).toBe("INSUFFICIENT_SCOPE");expect(contactCounts.get(deps)!.connect).toBe(0);
  });
  it("never inherits privileged authority from ordinary exec",()=>{
    expect(actorAllows({userId:"fixture",scopes:["fleet.exec"],authKind:"oauth"},PRIVILEGED_SCOPE)).toBe(false);
  });
  it("rejects unknown uid and unsupported observations before contact",async()=>{
    const deps=backend();const actor:ControlActor={userId:"fixture",scopes:["fleet.read"],authKind:"oauth"};
    const missing=await runControlOperation(environment(),actor,{...request,node_uid:"node-00000000-0000-4000-8000-000000000002"},deps);
    expect(missing.error).toBe("CAPABILITY_NOT_CONFIGURED");
    const observation=await runControlOperation(environment(),actor,{...request,observation:"memory"},deps);expect(observation.error).toBe("CAPABILITY_NOT_ALLOWED");expect(contactCounts.get(deps)!.connect).toBe(0);
  });
  it("keeps native transport explicit and refuses it in the Workers backend",()=>{
    const target=parseControlTargets(environment().CONTROL_TARGETS_JSON)[uid]!;
    expect(()=>resolveControlNetworkBinding({},uid,target)).toThrow("CONTROL_TRANSPORT_MODE_UNSUPPORTED");
    expect(()=>resolveControlNetworkBinding({},uid,{...target,transport_mode:"mesh_hostname"})).toThrow();
  });
  it("rejects wrong types, coercion and malformed envelopes without target contact",async()=>{
    const actor:ControlActor={userId:"fixture",scopes:["fleet.exec"],authKind:"oauth"};
    for(const invalid of [null,{...request,node_uid:new String(uid)},{...request,node_uid:{toString:()=>uid}},{...request,operation:"unrecognized"},{operation:"job.rpc",node_uid:uid,timeout_seconds:1},{operation:"session.rpc",node_uid:uid,timeout_seconds:1,session:null}]) {
      const deps=backend();const receipt=await runControlOperation(environment(),actor,invalid as never,deps);
      expect(receipt.outcome).toBe("NOT_DISPATCHED");expect(receipt.error).toMatch(/^INVALID_/);expect(contactCounts.get(deps)!.connect).toBe(0);
    }
  });
  it("marks uncertain mutation outcome for reconciliation without retry",async()=>{
    const deps={...backend(),execute:vi.fn(async()=>{throw new Error("SYNTHETIC_DISPATCH_LOST");})};
    const receipt=await runControlOperation(environment(),{userId:"fixture",scopes:["fleet.exec"],authKind:"oauth"},{operation:"shell.exec",node_uid:uid,command:"/usr/bin/true",timeout_seconds:1},deps);
    expect(receipt.outcome).toBe("UNKNOWN");expect(receipt.retry_safe).toBe(false);expect(receipt.reconcile_required).toBe(true);expect(deps.execute).toHaveBeenCalledTimes(1);
  });
  it("never invokes an expired deadline factory and disposes late resources",async()=>{
    const late=vi.fn();const factory=vi.fn(async()=>1);await expect(withDeadline(factory,Date.now()-1,"EXPIRED",late)).rejects.toThrow("EXPIRED");expect(factory).not.toHaveBeenCalled();
    let resolve!:(value:number)=>void;const promise=new Promise<number>(r=>resolve=r);
    await expect(withDeadline(()=>promise,Date.now()+5,"LATE",late)).rejects.toThrow("LATE");resolve(2);await new Promise(r=>setTimeout(r,5));expect(late).toHaveBeenCalledWith(2);
  });
});

describe("jobs and sessions preserve helper and receipt binding",()=>{
  const actor="f".repeat(64);
  it("keeps job payload on stdin and binds helper digest/handle",async()=>{
    const operation_id="oj1-1700000000000-00000000-0000-4000-8000-000000000001";
    const rpc=await prepareJobRpc(node,uid,actor,{action:"start",operation_id,argv:["/usr/bin/printf","$(synthetic-not-executed)"],runtime_seconds:60});
    expect(rpc.command).not.toContain("$(synthetic");expect(rpc.stdin).toContain("$(synthetic");expect(rpc.command).toContain(node.jobs!.helper_sha256);
    expect(()=>parseJobResponse(JSON.stringify({}),{action:"start",operation_id,argv:["/usr/bin/true"],runtime_seconds:1},rpc)).toThrow("JOB_RESPONSE_INVALID");
  });
  it("denies oversized or relative job specs",async()=>{
    const request={action:"start" as const,operation_id:"oj1-1700000000000-00000000-0000-4000-8000-000000000001",argv:["relative-command"],runtime_seconds:60};
    await expect(prepareJobRpc(node,uid,actor,request)).rejects.toThrow("JOB_SPEC_NOT_ALLOWED");await expect(prepareJobRpc({...node,execution_privilege:"administrator"},uid,actor,request)).rejects.toThrow("JOB_CAPABILITY_NOT_CONFIGURED");
  });
  it("bounds session spec, binds actor and refuses malformed response",async()=>{
    const request={action:"create" as const,operation_id:"os1-1700000000000-00000000-0000-4000-8000-000000000001",argv:["/usr/bin/true"],cwd_profile:"home" as const,rows:24,cols:100,runtime_seconds:30};
    const first=await prepareSessionRpc(node,uid,actor,request);const other=await prepareSessionRpc(node,uid,"e".repeat(64),request);expect(first.expectedHandle).not.toBe(other.expectedHandle);
    expect(()=>parseSessionResponse("{}",request,first)).toThrow("SESSION_RESPONSE_INVALID");await expect(prepareSessionRpc(node,uid,actor,{...request,runtime_seconds:61})).rejects.toThrow("SESSION_SPEC_NOT_ALLOWED");
  });
});
