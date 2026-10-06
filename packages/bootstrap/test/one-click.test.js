import test from "node:test";
import assert from "node:assert/strict";
import {
  createEnrollmentTicketStore,evaluateBootstrapPreflight,createBootstrapSession,recordRootCeremony,
  attachPreflight,attachClaim,completeBootstrap,assertNoPostBootstrapPasswordPrompt,createBootstrapReceipt,BOOTSTRAP_SH,
} from "../src/index.js";

const binding={template_id:"managed-linux",template_generation:"g1",template_digest:"sha256:template"};
const passFacts={os_family:"debian-family",os_id:"debian",os_version_id:"13",architecture:"x86_64",init_system:"systemd",package_manager:"apt",appliance:"openmediavault",recovery_class:"local-console"};

test("Phase 0 preflight accepts supported OMV-like Debian without mutating",()=>{
  const report=evaluateBootstrapPreflight(passFacts);
  assert.equal(report.status,"PASS");
  assert.ok(report.warnings.includes("PROTECTED_STORAGE_APPLIANCE"));
  assert.match(report.digest,/^sha256:/);
});
test("preflight fails closed before materialization for unsupported or bypassed host",()=>{
  assert.equal(evaluateBootstrapPreflight({...passFacts,init_system:"other"}).status,"STOP");
  assert.ok(evaluateBootstrapPreflight({...passFacts,root_equivalent_bypass:true}).reason_codes.includes("ROOT_EQUIVALENT_BYPASS_PRESENT"));
});
test("bootstrap shell runs Phase 0 before bootstrap transport mutation",()=>{
  const preflight=BOOTSTRAP_SH.indexOf("bootstrap_phase0_preflight");
  const transport=BOOTSTRAP_SH.indexOf("bootstrap_transport_baseline");
  assert.ok(preflight>=0 && transport>preflight);
  assert.ok(BOOTSTRAP_SH.includes("x-ghostfleet-preflight-digest"));
});
test("ticket requires two distinct factors and binds attempt/template",()=>{
  let clock=Date.parse("2026-01-01T00:00:00Z");
  const store=createEnrollmentTicketStore({now:()=>clock,secretFactory:()=>"high-entropy-fixture",codeFactory:()=>"ABCD1234"});
  const issued=store.issue({ticket_id:"ticket-1",attempt_id:"attempt-1",template_generation:"g1",template_digest:"sha256:template",ttl_seconds:60});
  assert.equal(issued.record.state,"ISSUED");
  assert.equal("claim_secret" in issued.record,false);
  const preflight=evaluateBootstrapPreflight(passFacts);
  const claimed=store.claim({ticket_id:"ticket-1",claim_secret:issued.delivery.claim_secret,short_code:issued.delivery.short_code,attempt_id:"attempt-1",template_digest:"sha256:template",preflight_digest:preflight.digest});
  assert.equal(claimed.ok,true);
  assert.equal(store.claim({ticket_id:"ticket-1",claim_secret:issued.delivery.claim_secret,short_code:issued.delivery.short_code,attempt_id:"attempt-1",template_digest:"sha256:template",preflight_digest:preflight.digest}).code,"TICKET_NOT_CLAIMABLE");
});
test("wrong code attempt and stale template do not consume ticket",()=>{
  const store=createEnrollmentTicketStore({secretFactory:()=>"fixture-secret",codeFactory:()=>"C0DE"});
  const issued=store.issue({ticket_id:"ticket-2",attempt_id:"attempt-2",template_generation:"g1",template_digest:"sha256:template"});
  const p=evaluateBootstrapPreflight(passFacts);
  assert.equal(store.claim({ticket_id:"ticket-2",claim_secret:issued.delivery.claim_secret,short_code:"BAD",attempt_id:"attempt-2",template_digest:"sha256:template",preflight_digest:p.digest}).code,"TICKET_SHORT_CODE_INVALID");
  assert.equal(store.claim({ticket_id:"ticket-2",claim_secret:issued.delivery.claim_secret,short_code:issued.delivery.short_code,attempt_id:"other",template_digest:"sha256:template",preflight_digest:p.digest}).code,"TICKET_ATTEMPT_MISMATCH");
  assert.equal(store.claim({ticket_id:"ticket-2",claim_secret:issued.delivery.claim_secret,short_code:issued.delivery.short_code,attempt_id:"attempt-2",template_digest:"sha256:other",preflight_digest:p.digest}).code,"TICKET_TEMPLATE_STALE");
  assert.equal(store.get("ticket-2").state,"ISSUED");
});
test("expired ticket is terminal and cannot be reclaimed",()=>{
  let clock=0;
  const store=createEnrollmentTicketStore({now:()=>clock,secretFactory:()=>"fixture-secret",codeFactory:()=>"C0DE"});
  const issued=store.issue({ticket_id:"ticket-3",attempt_id:"attempt-3",template_generation:"g1",template_digest:"sha256:template",ttl_seconds:1});
  clock=2000;
  assert.equal(store.claim({ticket_id:"ticket-3",claim_secret:issued.delivery.claim_secret,short_code:issued.delivery.short_code,attempt_id:"attempt-3",template_digest:"sha256:template",preflight_digest:"sha256:p"}).code,"TICKET_EXPIRED");
  assert.equal(store.get("ticket-3").state,"EXPIRED");
});
test("ambiguous completion becomes reconcile required without reminting ticket",()=>{
  const store=createEnrollmentTicketStore({secretFactory:()=>"fixture-secret",codeFactory:()=>"C0DE"});
  const issued=store.issue({ticket_id:"ticket-4",attempt_id:"attempt-4",template_generation:"g1",template_digest:"sha256:template"});
  store.claim({ticket_id:"ticket-4",claim_secret:issued.delivery.claim_secret,short_code:issued.delivery.short_code,attempt_id:"attempt-4",template_digest:"sha256:template",preflight_digest:"sha256:p"});
  const result=store.complete("ticket-4",{outcome:"RECONCILE_REQUIRED"});
  assert.equal(result.record.state,"RECONCILE_REQUIRED");
  assert.equal(store.claim({ticket_id:"ticket-4",claim_secret:issued.delivery.claim_secret,short_code:issued.delivery.short_code,attempt_id:"attempt-4",template_digest:"sha256:template",preflight_digest:"sha256:p"}).code,"TICKET_NOT_CLAIMABLE");
});
test("session permits exactly one root ceremony and zero post-bootstrap prompts",()=>{
  let session=createBootstrapSession({attempt_id:"attempt-5",template_binding:binding});
  session=recordRootCeremony(session);
  assert.throws(()=>recordRootCeremony(session),/ROOT_CEREMONY_ALREADY_CONSUMED/);
  const p=evaluateBootstrapPreflight(passFacts);
  session=attachPreflight(session,p);
  session=attachClaim(session,{ticket_id:"ticket-5"});
  session=completeBootstrap(session,{receipt_ref:"receipt-5"});
  assert.equal(assertNoPostBootstrapPasswordPrompt(session),true);
  const receipt=createBootstrapReceipt(session);
  assert.equal(receipt.root_ceremony_count,1);
  assert.equal(receipt.post_bootstrap_password_prompts,0);
  assert.equal(JSON.stringify(receipt).includes("fixture-secret"),false);
});
test("failed preflight stops before claim",()=>{
  let session=createBootstrapSession({attempt_id:"attempt-6",template_binding:binding});
  session=recordRootCeremony(session);
  session=attachPreflight(session,evaluateBootstrapPreflight({...passFacts,os_family:"other"}));
  assert.equal(session.state,"STOPPED");
  assert.throws(()=>attachClaim(session,{ticket_id:"ticket-6"}),/CLAIM_BEFORE_PREFLIGHT_PASS/);
});
