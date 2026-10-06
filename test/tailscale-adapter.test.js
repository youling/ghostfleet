import test from "node:test";
import assert from "node:assert/strict";
import {TAILSCALE_PROVIDER_MANIFEST,planTailscaleTransport,reconcileTailscaleOutcome,sanitizeTailscaleReceipt} from "../src/adapters/tailscale/index.js";

test("manifest exposes separate Tailscale and Tailscale SSH options",()=>{
  assert.equal(TAILSCALE_PROVIDER_MANIFEST.adapter_id,"tailscale");
  assert.deepEqual(TAILSCALE_PROVIDER_MANIFEST.options.map(o=>o.option_id),["enabled","ssh"]);
  assert.equal(TAILSCALE_PROVIDER_MANIFEST.options.find(o=>o.option_id==="ssh").user_overridable,true);
});
test("SSH cannot be desired when Tailscale is disabled",()=>{
  assert.throws(()=>planTailscaleTransport({desired:{enabled:false,ssh:true},observed:{state:"ABSENT",ssh_enabled:false}}),/SSH_REQUIRES_TAILSCALE/);
});
test("unknown current state reconciles and never requests blind remint",()=>{
  const plan=planTailscaleTransport({desired:{enabled:true,ssh:true},observed:{state:"UNKNOWN",ssh_enabled:"UNKNOWN"}});
  assert.equal(plan.status,"RECONCILE_REQUIRED");
  assert.equal(plan.request_new_enrollment_material,false);
});
test("fresh enrollment requests provider material but grants no privilege",()=>{
  const plan=planTailscaleTransport({desired:{enabled:true,ssh:false},observed:{state:"ABSENT",ssh_enabled:false}});
  assert.equal(plan.status,"CHANGE_REQUIRED");
  assert.equal(plan.request_new_enrollment_material,true);
  assert.equal(plan.privilege_implication,"NONE");
  assert.ok(plan.actions[0].required_authority.includes("NODE_PRIVILEGE_LEASE"));
});
test("Tailscale SSH toggle is a transport change not root authority",()=>{
  const plan=planTailscaleTransport({desired:{enabled:true,ssh:true},observed:{state:"PRESENT",ssh_enabled:false}});
  const action=plan.actions.find(a=>a.kind==="TAILSCALE_SSH_SET");
  assert.equal(action.desired,true);
  assert.equal(action.privilege_implication,"NONE");
});
test("deployment policy may deny a UI-selected option",()=>{
  const plan=planTailscaleTransport({desired:{enabled:true,ssh:true},observed:{state:"PRESENT",ssh_enabled:false},policy:{allow_tailscale:true,allow_tailscale_ssh:false}});
  assert.equal(plan.status,"DENIED");
  assert.ok(plan.reason_codes.includes("DEPLOYMENT_POLICY_DENIED_TAILSCALE_SSH"));
});
test("unknown external apply outcome requires reconcile and disallows blind retry",()=>{
  const plan=planTailscaleTransport({desired:{enabled:true,ssh:false},observed:{state:"ABSENT",ssh_enabled:false}});
  const result=reconcileTailscaleOutcome({plan,external_outcome:"UNKNOWN"});
  assert.equal(result.status,"RECONCILE_REQUIRED");
  assert.equal(result.retry_allowed,false);
});
test("receipt rejects secret-shaped fields and secret material",()=>{
  assert.throws(()=>sanitizeTailscaleReceipt({auth_key:"forbidden"}),/SECRET_FIELD_FORBIDDEN/);
  assert.throws(()=>sanitizeTailscaleReceipt({operation_ref:"tskey-fixture"}),/SECRET_MATERIAL_FORBIDDEN/);
});
test("receipt is public-safe and explicit about desired SSH",()=>{
  const receipt=sanitizeTailscaleReceipt({operation_ref:"op-1",node_ref:"node-ref",template_digest:"sha256:template",desired_enabled:true,desired_ssh:true,result:"PASS",reason_codes:[]});
  assert.equal(receipt.desired_ssh,true);
  assert.equal(receipt.schema,"ghostfleet-tailscale-receipt/v1");
});

test("reconcile compares post-state with original desired posture",()=>{
  const plan=planTailscaleTransport({desired:{enabled:true,ssh:true},observed:{state:"PRESENT",ssh_enabled:false}});
  const mismatch=reconcileTailscaleOutcome({plan,external_outcome:"SUCCESS",observed_after:{state:"PRESENT",ssh_enabled:false}});
  assert.equal(mismatch.status,"RECONCILE_REQUIRED");
  const converged=reconcileTailscaleOutcome({plan,external_outcome:"SUCCESS",observed_after:{state:"PRESENT",ssh_enabled:true}});
  assert.equal(converged.status,"COMPLETED");
});
