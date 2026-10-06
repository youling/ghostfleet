import test from "node:test";
import assert from "node:assert/strict";
import {
  createProviderOptionRegistry, resolveEnrollmentTemplate, applyUserOverrides,
  bindTemplateToAttempt, assertAttemptTemplateCurrent,
} from "../packages/enrollment-template/src/index.js";

const providers=createProviderOptionRegistry([
  {adapter_id:"tailscale",options:[
    {option_id:"enabled",type:"boolean",user_overridable:false},
    {option_id:"ssh",type:"boolean",user_overridable:true},
  ]},
]);
const baseTemplate={
  template_id:"managed-linux",
  version:"1.0.0",
  generation:"g1",
  posture:{
    platforms:["linux"],
    roles:["managed"],
    capabilities:["control.read"],
    providers:{tailscale:{enabled:true,ssh:false}},
    privilege:{broker_required:true,helper_required:true},
    human_gate:"POLICY",
    recovery:{break_glass_required:true},
    consumer_acceptance:"STRICT",
    bootstrap:{root_ceremony:"ONE_TIME",requirements:["systemd"]},
  },
  allowed_override_paths:["providers.tailscale.ssh"],
};

test("resolution and digest are deterministic across set-like ordering",()=>{
  const a=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],providerRegistry:providers});
  const b=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[{...baseTemplate,posture:{...baseTemplate.posture,capabilities:["control.read"],roles:["managed"],platforms:["linux"]}}],providerRegistry:providers});
  assert.equal(a.digest,b.digest);
});
test("deployment overlay applies deterministically and binds generation",()=>{
  const overlay={overlay_id:"fleet-defaults",target_template_id:"managed-linux",base_generation:"g1",generation:"o1",posture:{providers:{tailscale:{ssh:true}}}};
  const resolved=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],overlays:[overlay],providerRegistry:providers});
  assert.equal(resolved.posture.providers.tailscale.ssh,true);
  assert.deepEqual(resolved.overlay_refs,[{generation:"o1",overlay_id:"fleet-defaults"}]);
});
test("stale overlay generation fails closed",()=>{
  const overlay={overlay_id:"old",target_template_id:"managed-linux",base_generation:"g0",posture:{}};
  assert.throws(()=>resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],overlays:[overlay],providerRegistry:providers}),/OVERLAY_STALE_BASE_GENERATION/);
});
test("overlay cannot mutate template identity",()=>{
  const overlay={overlay_id:"bad",target_template_id:"managed-linux",base_generation:"g1",template_id:"other",posture:{}};
  assert.throws(()=>resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],overlays:[overlay],providerRegistry:providers}),/OVERLAY_IMMUTABLE_FIELD/);
});
test("extends cycle is rejected",()=>{
  const templates=[
    {template_id:"a",version:"1",generation:"1",extends:"b",posture:{}},
    {template_id:"b",version:"1",generation:"1",extends:"a",posture:{}},
  ];
  assert.throws(()=>resolveEnrollmentTemplate({template_id:"a",templates,providerRegistry:createProviderOptionRegistry([])}),/TEMPLATE_EXTENDS_CYCLE/);
});
test("unknown provider adapter and option fail closed",()=>{
  assert.throws(()=>resolveEnrollmentTemplate({template_id:"x",templates:[{template_id:"x",version:"1",generation:"1",posture:{providers:{unknown:{enabled:true}}}}],providerRegistry:providers}),/UNKNOWN_PROVIDER_ADAPTER/);
  assert.throws(()=>resolveEnrollmentTemplate({template_id:"x",templates:[{template_id:"x",version:"1",generation:"1",posture:{providers:{tailscale:{magic:true}}}}],providerRegistry:providers}),/UNKNOWN_PROVIDER_OPTION/);
});
test("secret-shaped plaintext fields are rejected",()=>{
  assert.throws(()=>resolveEnrollmentTemplate({template_id:"x",templates:[{template_id:"x",version:"1",generation:"1",posture:{provider_secret:"do-not-store"}}],providerRegistry:createProviderOptionRegistry([])}),/SECRET_PLAINTEXT_FORBIDDEN/);
});
test("opaque references remain allowed",()=>{
  const resolved=resolveEnrollmentTemplate({template_id:"x",templates:[{template_id:"x",version:"1",generation:"1",posture:{bootstrap:{requirements:["opaque_ref:bootstrap/material"]}}}],providerRegistry:createProviderOptionRegistry([])});
  assert.equal(resolved.template_id,"x");
});
test("user override requires both template allowlist and provider permission",()=>{
  const resolved=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],providerRegistry:providers});
  const adjusted=applyUserOverrides(resolved,{"providers.tailscale.ssh":true},providers);
  assert.equal(adjusted.posture.providers.tailscale.ssh,true);
  assert.notEqual(adjusted.digest,resolved.digest);
  assert.throws(()=>applyUserOverrides(resolved,{"providers.tailscale.enabled":false},providers),/OVERRIDE_PATH_NOT_ALLOWED/);
});
test("provider manifest may deny an allowlisted override",()=>{
  const lockedProviders=createProviderOptionRegistry([{adapter_id:"tailscale",options:[{option_id:"ssh",type:"boolean",user_overridable:false},{option_id:"enabled",type:"boolean",user_overridable:false}]}]);
  const resolved=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],providerRegistry:lockedProviders});
  assert.throws(()=>applyUserOverrides(resolved,{"providers.tailscale.ssh":true},lockedProviders),/PROVIDER_OPTION_NOT_USER_OVERRIDABLE/);
});
test("attempt binding is immutable to template generation and digest",()=>{
  const resolved=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],providerRegistry:providers});
  const binding=bindTemplateToAttempt({attempt_id:"attempt-1",resolved_template:resolved});
  assert.equal(assertAttemptTemplateCurrent(binding,resolved),true);
  const changed=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[{...baseTemplate,generation:"g2"}],providerRegistry:providers});
  assert.throws(()=>assertAttemptTemplateCurrent(binding,changed),/GENERATION_STALE/);
});
test("template changes cannot silently preserve old digest",()=>{
  const a=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[baseTemplate],providerRegistry:providers});
  const changed={...baseTemplate,posture:{...baseTemplate.posture,consumer_acceptance:"STANDARD"}};
  const b=resolveEnrollmentTemplate({template_id:"managed-linux",templates:[changed],providerRegistry:providers});
  assert.notEqual(a.digest,b.digest);
});
