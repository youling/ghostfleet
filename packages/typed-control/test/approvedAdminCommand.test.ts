import {createHash, generateKeyPairSync} from "node:crypto";
import {Buffer} from "node:buffer";
import {describe, expect, it, vi} from "vitest";
import {runApprovedAdminCommand, type ApprovedAdminEnvironment} from "../src/approvedAdminCommand.js";
import {controlActorRef, type ControlActor} from "../src/controlPolicy.js";
import {SshExecutionError} from "../src/sshClient.js";

const uid = "node-00000000-0000-4000-8000-000000000001";
const actor: ControlActor = {userId:"synthetic-admin", scopes:["fleet.privileged"], authKind:"oauth"};
// Generated for these in-memory tests only. No live host, fixture secret or
// production signer is used; node signature verification has Python tests.
function key() {
  return generateKeyPairSync("ec", {namedCurve:"prime256v1",
    publicKeyEncoding:{type:"spki",format:"pem"},
    privateKeyEncoding:{type:"pkcs8",format:"pem"}}).privateKey;
}
async function fixture(state = "STARTED") {
  const subject = await controlActorRef(actor);
  const generation = "b".repeat(64), profile = "sha256:" + "c".repeat(64);
  const now = Math.floor(Date.now()/1000);
  const lease = {schema:"ghostfleet-approved-admin-lease/v1", lease_id:"lease-fixture-01",
    request_id:"request-fixture-01", operation_id:"operation-fixture-01", operation:"admin.command",
    issuer_id:"synthetic-issuer", node_uid:uid, subject_ref:subject,
    audience_ref:"ghostfleet-approved-admin-command/v1", generation, profile_generation:profile,
    work_ref:"synthetic/work", purpose:"Synthetic command-effect test", approval_ref:"approval-fixture-01",
    rollback_ref:"synthetic/rollback", issued_at:now, not_before:now, expires_at:now+60,
    max_uses:1, max_runtime_seconds:30,
    command:{argv:["/usr/bin/true"],cwd:"/",env:{},executable_sha256:"d".repeat(64),output:"discard"}};
  const input = {node_uid:uid,action:"execute" as const,
    lease_b64:Buffer.from(JSON.stringify(lease)).toString("base64"),
    signature_b64:Buffer.alloc(64).toString("base64")};
  const target = (username:string) => ({username,transport_mode:"local_ssh",
    ssh_host_key_algorithm:"ecdsa-sha2-nistp256",ssh_host_key_sha256:"SHA256:AAAA"});
  const env:ApprovedAdminEnvironment = {
    CONTROL_APPROVED_ADMIN_POLICY_JSON:JSON.stringify({[uid]:{generation,profile_generation:profile,
      subject_ref:subject,issuer_ids:["synthetic-issuer"]}}),
    CONTROL_PRIVILEGED_USERNAME:"ghostfleet-ops",CONTROL_PRIVILEGED_SSH_PRIVATE_KEY:key(),
    CONTROL_SSH_PRIVATE_KEY:key(),
    CONTROL_PRIVILEGED_TARGETS_JSON:JSON.stringify({[uid]:target("ghostfleet-ops")}),
    CONTROL_TARGETS_JSON:JSON.stringify({[uid]:target("ghostfleet")}),
  };
  const receipt = {schema:"ghostfleet-approved-admin-receipt/v1",lease_id:lease.lease_id,
    request_id:lease.request_id,operation_id:lease.operation_id,node_uid:uid,actor_ref:subject,
    lease_digest:createHash("sha256").update(Buffer.from(input.lease_b64,"base64")).digest("hex"),
    command_digest:"e".repeat(64),state,duplicate:false,retry_safe:false,
    reconcile_required:["STARTED","RESERVED","UNKNOWN"].includes(state),
    exit_code:state === "SUCCEEDED" ? 0 : null,execution_privilege:state === "NOT_FOUND" ? null : "root",
    output:"discarded",persistent_effects_rolled_back:false,code:null};
  const connect = vi.fn(async()=>({close:async()=>{},closed:Promise.resolve()}) as never);
  const execute = vi.fn(async()=>({exit_code:0,stdout:JSON.stringify({ok:true,receipt}),stderr:"",truncated:false}));
  return {env,input,lease,receipt,dependencies:{connect,execute}};
}

describe("approved administrator command seam",()=>{
  it("denies ordinary scope before any connection",async()=>{
    const f=await fixture();
    const result=await runApprovedAdminCommand(f.env,{...actor,scopes:["fleet.exec"]},f.input,f.dependencies);
    expect(result.outcome).toBe("NOT_DISPATCHED");expect(result.error).toBe("PRIVILEGED_SCOPE_REQUIRED");
    expect(f.dependencies.connect).not.toHaveBeenCalled();
  });
  it.each(["subject_ref","node_uid","generation"])("rejects wrong signed %s before connection",async(field)=>{
    const f=await fixture();
    const bad={...f.lease,[field]:field === "node_uid" ? "node-00000000-0000-4000-8000-000000000002" : "f".repeat(64)};
    const result=await runApprovedAdminCommand(f.env,actor,{...f.input,lease_b64:Buffer.from(JSON.stringify(bad)).toString("base64")},f.dependencies);
    expect(result.outcome).toBe("NOT_DISPATCHED");expect(f.dependencies.connect).not.toHaveBeenCalled();
  });
  it("rejects noncanonical base64 and caller-supplied actor",async()=>{
    const f=await fixture();
    for(const bad of [{...f.input,lease_b64:f.input.lease_b64+"\n"},{...f.input,actor_ref:"f".repeat(64)}]) {
      const result=await runApprovedAdminCommand(f.env,actor,bad,f.dependencies);
      expect(result.outcome).toBe("NOT_DISPATCHED");
    }
    expect(f.dependencies.connect).not.toHaveBeenCalled();
  });
  it("reports started as RUNNING with same-lease reconciliation",async()=>{
    const f=await fixture();const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("RUNNING");expect(result.reconcile_required).toBe(true);
    expect(result.retry_safe).toBe(false);expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
    const args=f.dependencies.execute.mock.calls[0] as unknown as unknown[];
    expect(args[3]).toBe(null);
    const wire=JSON.parse((args[4] as {stdin:string}).stdin);
    expect(wire.actor_ref).toBe(await controlActorRef(actor));expect(wire.lease_b64).toBe(f.input.lease_b64);
  });
  it("reports success only from the bound terminal receipt",async()=>{
    const f=await fixture("SUCCEEDED");const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("SUCCEEDED");expect(result.receipt?.persistent_effects_rolled_back).toBe(false);
  });
  it("classifies an unavailable or mismatched receipt as UNKNOWN without retry",async()=>{
    const f=await fixture();f.receipt.lease_digest="f".repeat(64);
    const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");expect(result.retry_safe).toBe(false);
    expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  });
  it("does not convert transport acceptance or a missing receipt into success",async()=>{
    const f=await fixture("NOT_FOUND");
    const result=await runApprovedAdminCommand(f.env,actor,{...f.input,action:"status"},f.dependencies);
    expect(result.outcome).toBe("UNKNOWN");expect(result.reconcile_required).toBe(true);
  });
  it("preserves pre-dispatch versus post-dispatch transport uncertainty",async()=>{
    for(const state of ["NOT_DISPATCHED","MAY_HAVE_EXECUTED"] as const) {
      const f=await fixture();f.dependencies.execute.mockImplementation(async()=>{throw new SshExecutionError("SYNTHETIC_TRANSPORT_FAILURE",state);});
      const result=await runApprovedAdminCommand(f.env,actor,f.input,f.dependencies);
      expect(result.outcome).toBe(state === "NOT_DISPATCHED" ? "NOT_DISPATCHED" : "UNKNOWN");
      expect(result.retry_safe).toBe(false);
    }
  });
});
