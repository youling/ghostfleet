import test from "node:test";
import assert from "node:assert/strict";
import { templateDisplay, templatePostureSummary, templateSelectionPayload, applyTemplatePreviewOverrides } from "../console/enrollment/templates/model.js";
import { createEnrollmentWizard, attachBootstrapDelivery, markBootstrapRunning, markBootstrapResult, serializeWizardState } from "../console/enrollment/bootstrap/wizard.js";
import { renderProviders } from "../console/providers/view.js";

const template={
  template_id:"managed-linux-tailscale",
  display:{"zh-CN":{name:"Linux + Tailscale",description:"说明"},en:{name:"Linux + Tailscale",description:"Description"}},
  effective_posture:{
    providers:{tailscale:{enabled:true,ssh:false}},
    privilege:{broker_required:true,helper_required:true},
    recovery:{break_glass_required:true},
    consumer_acceptance:"STRICT",
    bootstrap:{root_ceremony:"ONE_TIME"},
  },
  allowed_override_paths:["providers.tailscale.ssh"],
  binding:{template_id:"managed-linux-tailscale",template_generation:"g1",template_digest:"sha256:"+"a".repeat(64)},
};

test("template picker localizes display without changing template identity",()=>{
  assert.equal(templateDisplay(template,"zh-CN").name,"Linux + Tailscale");
  assert.equal(templateSelectionPayload(template,{}).template_id,template.template_id);
});
test("allowed Tailscale SSH override changes preview but does not imply privilege",()=>{
  const selection=applyTemplatePreviewOverrides(template,{"providers.tailscale.ssh":true});
  assert.equal(selection.posture.providers.tailscale.ssh,true);
  const summary=templatePostureSummary(template,{"providers.tailscale.ssh":true});
  assert.equal(summary.tailscale_ssh,true);
  assert.equal(summary.privilege_broker,true);
  assert.throws(()=>applyTemplatePreviewOverrides(template,{"providers.tailscale.enabled":false}),/OVERRIDE_PATH_NOT_ALLOWED/);
});
test("wizard keeps bootstrap delivery ephemeral when serialized",()=>{
  let wizard=createEnrollmentWizard({attempt_id:"attempt-1",template_binding:template.binding});
  wizard=attachBootstrapDelivery(wizard,{short_code:"ABCD-1234",bootstrap_command:"curl synthetic.example.invalid/bootstrap?ticket=opaque"});
  const durable=serializeWizardState(wizard);
  assert.equal(durable.delivery_present,true);
  assert.equal(JSON.stringify(durable).includes("ABCD-1234"),false);
  assert.equal(JSON.stringify(durable).includes("ticket=opaque"),false);
  wizard=markBootstrapRunning(wizard);
  wizard=markBootstrapResult(wizard,"RECONCILE_REQUIRED");
  assert.equal(wizard.state,"RECONCILE_REQUIRED");
});

test("provider settings render only safe readiness metadata",()=>{
  const html=renderProviders({providers:{tailscale:{
    status:"MISSING",
    requirements:{scope:"auth_keys",tag:"tag:fleet-ssh-target"},
    authority_generation:null,
    secret_state:{client_id:"MISSING",client_secret:"MISSING"},
  }}});
  assert.match(html,/auth_keys/);
  assert.match(html,/tag:fleet-ssh-target/);
  assert.match(html,/data-provider-setup="tailscale"/);
  assert.equal(html.includes("client-secret-value"),false);
});
