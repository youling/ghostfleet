import test from "node:test";
import assert from "node:assert/strict";
import { planManagedLinuxInstallation } from "../packages/bootstrap/src/management-plan.js";
import { createEnrollmentTemplateCatalog } from "../src/control-plane/enrollment-templates.js";

const template={platforms:["linux"],roles:["managed"],
  providers:{tailscale:{enabled:true,ssh:true}},
  privilege:{broker_required:true,helper_required:true},
  consumer_acceptance:"STRICT",recovery:{break_glass_required:true},
  bootstrap:{root_ceremony:"ONE_TIME"}};
function observedWith(defaultState="COMPLIANT",more={}) {
  const empty=planManagedLinuxInstallation({posture:template});
  return Object.fromEntries(empty.components.map(c=>[c.id,defaultState]).concat(Object.entries(more)));
}

test("management plan preview lists the whole selected journey as UNKNOWN, not PASSED",()=>{
  const plan=planManagedLinuxInstallation({posture:template});
  assert.equal(plan.status,"PREFLIGHT_REQUIRED");
  assert.equal(plan.mode,"UNRESOLVED");
  assert.equal(plan.root_ceremony_target,1);
  assert.equal(plan.proposed_actions.length,0);
  assert.equal(plan.effects_executed,0);
  assert.equal(plan.consumer_accepted,false);
  assert.ok(plan.unknown.includes("privileged_helper"));
  assert.ok(plan.unknown.includes("consumer_route"));
  assert.ok(plan.unknown.includes("linger"));
});
test("adopt keeps immutable identity and never creates another enrollment",()=>{
  const observed=observedWith();
  const plan=planManagedLinuxInstallation({posture:template,observed});
  assert.equal(plan.status,"ZERO_DELTA");
  assert.equal(plan.mode,"ADOPT");
  assert.equal(plan.proposed_actions.length,0);
  observed.privileged_helper="DRIFT_REPAIRABLE";
  const repair=planManagedLinuxInstallation({posture:template,observed});
  assert.equal(repair.mode,"REPAIR");
  assert.deepEqual(repair.proposed_actions.map(a=>a.id),["install_bound_privileged_helper"]);
  assert.equal(repair.effects_executed,0);
});
test("fresh missing components are planned but never executed by a pure preview",()=>{
  const plan=planManagedLinuxInstallation({posture:template,
    observed:observedWith("COMPLIANT",{immutable_identity:"ABSENT",control_account:"ABSENT",linger:"ABSENT"})});
  assert.equal(plan.mode,"NEW");
  assert.equal(plan.status,"PLAN_READY");
  assert.deepEqual(plan.proposed_actions.map(a=>a.component),["immutable_identity","control_account","linger"]);
  assert.equal(plan.consumer_accepted,false);
});
test("unreadable and conflicting host facts fail closed without an effect",()=>{
  const unknown=planManagedLinuxInstallation({posture:template,observed:observedWith("COMPLIANT",{ssh_admission:"UNKNOWN"})});
  assert.equal(unknown.status,"PREFLIGHT_REQUIRED");
  const conflict=planManagedLinuxInstallation({posture:template,
    observed:observedWith("COMPLIANT",{immutable_identity:"CONFLICT"})});
  assert.equal(conflict.status,"BLOCKED_CONFLICT");
  assert.deepEqual(conflict.conflicts,["immutable_identity"]);
  assert.throws(()=>planManagedLinuxInstallation({posture:template,observed:{linger:"PASS"}}),/INSTALL_OBSERVATION_STATE_INVALID/);
});
test("OMV8 adds configuration ownership and storage non-interference gates",()=>{
  const unknown=planManagedLinuxInstallation({posture:template,observed:{appliance:"openmediavault"}});
  assert.ok(unknown.unknown.includes("omv_config_owner"));
  assert.ok(unknown.unknown.includes("omv_storage_isolation"));
  assert.equal(unknown.status,"PREFLIGHT_REQUIRED");
  const safe=planManagedLinuxInstallation({posture:template,
    observed:{...observedWith(),appliance:"openmediavault",omv_config_owner:"COMPLIANT",omv_storage_isolation:"COMPLIANT"}});
  assert.equal(safe.status,"ZERO_DELTA");
  assert.equal(safe.proposed_actions.length,0);
});
test("limited template does not inherit optional privilege/control-account effects",()=>{
  const limited={platforms:["linux"],roles:["customer-managed"],capabilities:["control.read"],
    privilege:{broker_required:false,helper_required:false},
    consumer_acceptance:"STANDARD",recovery:{break_glass_required:false},
    bootstrap:{root_ceremony:"ONE_TIME"}};
  const plan=planManagedLinuxInstallation({posture:limited});
  assert.deepEqual(plan.components.map(c=>c.id),["host_compatibility","immutable_identity"]);
  assert.equal(plan.effects_executed,0);
});
test("server enrollment catalog exposes a non-authoritative preview without private instance facts",()=>{
  const catalog=createEnrollmentTemplateCatalog();
  for (const selection of catalog.list()){
    assert.equal(selection.installation_plan.nature,"READ_ONLY_PREVIEW_NOT_AUTHORITY");
    assert.equal(selection.installation_plan.status,"PREFLIGHT_REQUIRED");
    assert.ok(selection.installation_plan.unknown.length>=2);
    assert.equal(selection.installation_plan.effects_executed,0);
  }
});
