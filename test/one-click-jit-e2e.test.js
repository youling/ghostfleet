import test from "node:test";
import assert from "node:assert/strict";
import { runSyntheticOneClickJitE2E } from "../examples/one-click-jit-synthetic.mjs";

test("one-click + JIT privilege synthetic E2E proves zero recurring password prompts and fresh context",async()=>{
  const result=await runSyntheticOneClickJitE2E();
  assert.equal(result.transport_status,"COMPLETED");
  assert.equal(result.tailscale_ssh,true);
  assert.equal(result.bootstrap_root_ceremonies,1);
  assert.equal(result.post_bootstrap_root_or_sudo_password_prompts,0);
  assert.equal(result.ticket_replay,"DENIED");
  assert.equal(result.unauthorized_privileged_operation,"DENIED");
  assert.equal(result.fresh_context_independence,"PASS");
  assert.notEqual(result.origin_receipt_ref,result.fresh_receipt_ref);
  assert.notEqual(result.origin_readback_ref,result.fresh_readback_ref);
  assert.equal(result.final_canary_generation,2);
});
