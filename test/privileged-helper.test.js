import test from "node:test";
import assert from "node:assert/strict";
import {
  validateIpcEnvelope,validateOrdinaryPrincipalBoundary,desiredHelperInstall,planHelperInstall,planHelperUninstall,
  createLinuxTypedOperations,createHelperEffectFenceStore,createPrivilegedHelper,
} from "../packages/privileged-helper/src/index.js";

test("IPC rejects arbitrary shell/command fields",()=>{
  assert.equal(validateIpcEnvelope({request_id:"r",lease_id:"l",operation_id:"x",target_ref:"t",effect_ref:"e",command:"id"}).code,"IPC_FORBIDDEN_FIELD");
  assert.equal(validateIpcEnvelope({request_id:"r",lease_id:"l",operation_id:"x",target_ref:"t",effect_ref:"e",parameters:{}}).ok,true);
});
test("ordinary principal boundary rejects root-equivalent bypasses",()=>{
  assert.equal(validateOrdinaryPrincipalBoundary({groups:["users"],nopasswd_sudo:false}).ok,true);
  const result=validateOrdinaryPrincipalBoundary({groups:["docker"],nopasswd_sudo:true});
  assert.equal(result.ok,false);
  assert.ok(result.findings.includes("NOPASSWD_SUDO"));
  assert.ok(result.findings.includes("ROOT_EQUIVALENT_GROUP:docker"));
});
test("install plan is root-owned scoped and idempotent",()=>{
  const desired=desiredHelperInstall({socket_group:"ghostfleet-agent",trust_root_ref:"trust-root/v1"});
  const first=planHelperInstall({observed:{},desired});
  assert.equal(first.status,"CHANGE_REQUIRED");
  assert.ok(first.actions.every(a=>!String(a.path??"").includes("/home/")));
  const compliant={
    ...desired,
    binary_path_digest:desired.binary_path_digest,
    service_path_digest:desired.service_path_digest,
    trust_root_path_digest:desired.trust_root_path_digest,
    service_enabled:true,
  };
  assert.equal(planHelperInstall({observed:compliant,desired}).status,"COMPLIANT");
});
test("uninstall removes only exact helper-owned artifacts",()=>{
  const desired=desiredHelperInstall({trust_root_ref:"trust-root/v1"});
  const plan=planHelperUninstall(desired);
  const paths=plan.actions.filter(a=>a.path).map(a=>a.path);
  assert.deepEqual(paths.sort(),[desired.binary_path,desired.service_path,desired.socket_path,desired.trust_root_path].sort());
});
test("helper denies unknown operation before OS execution",async()=>{
  let executed=0;
  const operations={get:()=>null};
  const helper=createPrivilegedHelper({leaseVerifier:async()=>({ok:true}),operations,effectFences:createHelperEffectFenceStore()});
  const result=await helper.handle({request_id:"r1",lease_id:"l1",operation_id:"shell.any",target_ref:"node",effect_ref:"e1",parameters:{}},{caller_ref:"agent",helper_ref:"helper",node_uid:"node"});
  assert.equal(result.ok,false);assert.equal(result.code,"UNKNOWN_TYPED_OPERATION");assert.equal(executed,0);
});
test("transport/caller context cannot substitute denied lease",async()=>{
  const os={serviceStatus:async()=>({state_ref:"state-1",public_data:{active:true}})};
  const helper=createPrivilegedHelper({
    leaseVerifier:async()=>({ok:false,code:"LEASE_REQUIRED"}),
    operations:createLinuxTypedOperations(os),effectFences:createHelperEffectFenceStore(),
  });
  const result=await helper.handle({request_id:"r2",lease_id:"missing",operation_id:"service.status.read",target_ref:"service/canary",effect_ref:"e2",parameters:{}},{caller_ref:"authenticated-transport-user",helper_ref:"helper",node_uid:"node"});
  assert.equal(result.ok,false);assert.equal(result.code,"LEASE_REQUIRED");
});
test("read operation succeeds through injected verifier without root shell",async()=>{
  const os={serviceStatus:async(target)=>({state_ref:"state:"+target,public_data:{active:true}})};
  const helper=createPrivilegedHelper({
    leaseVerifier:async()=>({ok:true}),operations:createLinuxTypedOperations(os),effectFences:createHelperEffectFenceStore(),
  });
  const result=await helper.handle({request_id:"r3",lease_id:"l3",operation_id:"service.status.read",target_ref:"service/canary",effect_ref:"e3",parameters:{}},{caller_ref:"agent",helper_ref:"helper",node_uid:"node"});
  assert.equal(result.ok,true);assert.equal(result.receipt.result,"SUCCESS");
});
test("mutating operation uses effect fence and rejects replay",async()=>{
  let restartCount=0;
  const os={
    serviceStatus:async()=>({state_ref:"active"}),
    serviceRestart:async()=>{restartCount++;return {outcome:"SUCCESS",recovery_ref:"recovery-1"};},
  };
  const fences=createHelperEffectFenceStore();
  const helper=createPrivilegedHelper({leaseVerifier:async()=>({ok:true}),operations:createLinuxTypedOperations(os),effectFences:fences});
  const req={request_id:"r4",lease_id:"l4",operation_id:"service.restart",target_ref:"service/canary",effect_ref:"effect-4",parameters:{mode:"graceful"}};
  assert.equal((await helper.handle(req,{caller_ref:"agent",helper_ref:"helper",node_uid:"node"})).ok,true);
  const replay=await helper.handle(req,{caller_ref:"agent",helper_ref:"helper",node_uid:"node"});
  assert.equal(replay.code,"EFFECT_FENCE_REPLAY");assert.equal(restartCount,1);
});
test("unknown mutation outcome becomes reconcile required and is not retried",async()=>{
  let count=0;
  const os={
    serviceStatus:async()=>({state_ref:"before"}),
    serviceRestart:async()=>{count++;return {outcome:"UNKNOWN",recovery_ref:"recovery-unknown"};},
  };
  const fences=createHelperEffectFenceStore();
  const helper=createPrivilegedHelper({leaseVerifier:async()=>({ok:true}),operations:createLinuxTypedOperations(os),effectFences:fences});
  const req={request_id:"r5",lease_id:"l5",operation_id:"service.restart",target_ref:"service/canary",effect_ref:"effect-5",parameters:{}};
  const result=await helper.handle(req,{caller_ref:"agent",helper_ref:"helper",node_uid:"node"});
  assert.equal(result.receipt.result,"RECONCILE_REQUIRED");
  assert.equal(fences.state("effect-5"),"RECONCILE_REQUIRED");
  assert.equal((await helper.handle(req,{caller_ref:"agent",helper_ref:"helper",node_uid:"node"})).code,"EFFECT_FENCE_REPLAY");
  assert.equal(count,1);
});
test("managed file operation accepts only content references",async()=>{
  const os={
    managedFileStatus:async()=>({state_ref:"before"}),
    managedFileMaterialize:async()=>({outcome:"SUCCESS",recovery_ref:"rollback-file"}),
  };
  const helper=createPrivilegedHelper({leaseVerifier:async()=>({ok:true}),operations:createLinuxTypedOperations(os),effectFences:createHelperEffectFenceStore()});
  const bad=await helper.handle({request_id:"r6",lease_id:"l6",operation_id:"managed.file.materialize",target_ref:"managed-file/canary",effect_ref:"e6",parameters:{content:"raw"}},{caller_ref:"agent",helper_ref:"helper",node_uid:"node"});
  assert.equal(bad.receipt.result,"DENIED");
});
