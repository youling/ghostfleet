import test from "node:test";
import assert from "node:assert/strict";
import { GhostFleetController } from "../src/control-plane/controller.js";
import { createHttpHandler } from "../src/control-plane/http.js";

test("control plane lists public enrollment templates without private FULLY_MANAGED defaults",async()=>{
  const controller=new GhostFleetController();
  const templates=controller.listEnrollmentTemplates();
  assert.ok(templates.length>=3);
  assert.equal(templates.some((item)=>item.template_id==="FULLY_MANAGED"),false);
  assert.ok(templates.every((item)=>/^sha256:[0-9a-f]{64}$/.test(item.binding.template_digest)));
});

test("create attempt binds exact server-resolved template generation and digest",()=>{
  const controller=new GhostFleetController();
  const base=controller.listEnrollmentTemplates().find((item)=>item.template_id==="managed-linux-tailscale");
  const attempt=controller.createEnrollmentAttempt({
    asset_hint:"test-node",
    template_selection:{template_id:"managed-linux-tailscale",overrides:{"providers.tailscale.ssh":true}},
  });
  assert.equal(attempt.template_binding.template_id,"managed-linux-tailscale");
  assert.equal(attempt.template_binding.template_generation,base.binding.template_generation);
  assert.notEqual(attempt.template_binding.template_digest,base.binding.template_digest);
});

test("unknown create fields and invalid template overrides fail closed",async()=>{
  const controller=new GhostFleetController();
  assert.throws(()=>controller.createEnrollmentAttempt({asset_hint:"x",template_binding:{template_id:"forged"}}),/CREATE_INPUT_INVALID/);
  assert.throws(()=>controller.createEnrollmentAttempt({asset_hint:"x",template_selection:{template_id:"managed-linux-standard",overrides:{"providers.tailscale.ssh":true}}}),/OVERRIDE_PATH_NOT_ALLOWED/);
  const handle=createHttpHandler(controller);
  const response=await handle(new Request("http://ghostfleet.test/v0/enrollment-attempts",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({asset_hint:"x",template_selection:{template_id:"missing",overrides:{}}}),
  }));
  assert.equal(response.status,404);
  assert.equal((await response.json()).error,"TEMPLATE_NOT_FOUND");
});
