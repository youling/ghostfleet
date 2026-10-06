import test from "node:test";
import assert from "node:assert/strict";
import {
  createOperationRegistry, evaluatePrivilegeRequest, normalizedRequestDigest,
  createApprovalRequest, resolveApproval, createSyntheticSigner, issuePrivilegeLease,
  validatePrivilegeLease, createEffectFenceStore, createPrivilegeReceipt, createAuditLedger,
  createRecoveryAttempt, authorizeRecovery, ordinaryAgentBreakGlassRequest,
  validateCredentialClassBindings,
} from "../packages/privilege-broker/src/index.js";

const registry = createOperationRegistry([
  { operation_id:"service.status.read", risk_floor:"LOW", auto_approvable:true, recovery_requirement:"NONE", max_ttl_seconds:900, max_uses:4 },
  { operation_id:"service.restart", risk_floor:"MEDIUM", auto_approvable:true, recovery_requirement:"ROLLBACK", max_ttl_seconds:300, max_uses:1 },
  { operation_id:"credential.rotate", risk_floor:"CRITICAL", auto_approvable:false, recovery_requirement:"COMPENSATING", max_ttl_seconds:120, max_uses:1 },
]);
const request = (overrides={}) => ({
  request_id:"req-1", node_uid:"node-1", requester_ref:"agent-1", intent:"restart canary",
  policy_revision:"policy-1", requested_ttl_seconds:120, requested_max_uses:1,
  operations:[{operation_id:"service.restart",scope_ref:"service/canary",parameters:{mode:"graceful"},recovery:{mode:"ROLLBACK",ref:"rollback-1"}}],
  ...overrides,
});

test("caller risk cannot downgrade canonical risk", () => {
  const r = request({ risk:"LOW", operations:[{operation_id:"credential.rotate",scope_ref:"credential/test",recovery:{mode:"COMPENSATING",ref:"recover-1"}}] });
  const decision = evaluatePrivilegeRequest(r,{registry});
  assert.equal(decision.derived_risk,"CRITICAL");
  assert.equal(decision.outcome,"HUMAN_REQUIRED");
});
test("unknown operation fails closed", () => {
  const decision=evaluatePrivilegeRequest(request({operations:[{operation_id:"shell.any",scope_ref:"node"}]}),{registry});
  assert.equal(decision.outcome,"REJECT");
  assert.ok(decision.reason_codes.includes("UNKNOWN_OPERATION"));
});
test("required recovery missing rejects", () => {
  const decision=evaluatePrivilegeRequest(request({operations:[{operation_id:"service.restart",scope_ref:"service/canary"}]}),{registry});
  assert.equal(decision.outcome,"REJECT");
  assert.ok(decision.reason_codes.includes("RECOVERY_REQUIRED"));
});
test("digest ignores caller risk but binds material scope", () => {
  const a=request({risk:"LOW"}), b=request({risk:"CRITICAL"});
  assert.equal(normalizedRequestDigest(a),normalizedRequestDigest(b));
  const c=request({operations:[{...a.operations[0],scope_ref:"service/other"}]});
  assert.notEqual(normalizedRequestDigest(a),normalizedRequestDigest(c));
});
test("approval cannot be reused after scope drift", () => {
  const r=request();
  const ar=createApprovalRequest({approval_request_id:"apr-1",request:r,expires_at:"2030-01-01T00:00:00Z"});
  const rec=resolveApproval(ar,{approval_record_id:"rec-1",approver_ref:"human",decision:"APPROVE",decided_at:"2026-01-01T00:00:00Z"});
  const drift=request({operations:[{...r.operations[0],scope_ref:"service/other"}]});
  const decision=evaluatePrivilegeRequest(drift,{registry,deploymentPolicy:{force_human:true}});
  assert.throws(()=>issuePrivilegeLease({lease_id:"lease-drift",request:drift,policyDecision:decision,approvalRecord:rec,signer:createSyntheticSigner(),audience_ref:"helper-1"}),/APPROVAL_DIGEST_MISMATCH/);
});
test("synthetic signer is explicitly non-production", () => {
  assert.equal(createSyntheticSigner().isProduction,false);
});
test("valid human-approved lease validates only exact node subject audience operation", () => {
  const r=request();
  const decision=evaluatePrivilegeRequest(r,{registry,deploymentPolicy:{force_human:true}});
  const ar=createApprovalRequest({approval_request_id:"apr-2",request:r,expires_at:"2030-01-01T00:00:00Z"});
  const rec=resolveApproval(ar,{approval_record_id:"rec-2",approver_ref:"human",decision:"APPROVE",decided_at:"2026-01-01T00:00:00Z"});
  const signer=createSyntheticSigner();
  const lease=issuePrivilegeLease({lease_id:"lease-1",request:r,policyDecision:decision,approvalRecord:rec,signer,audience_ref:"helper-1",now:new Date("2026-01-01T00:00:00Z")});
  assert.equal(validatePrivilegeLease({lease,signer,now:new Date("2026-01-01T00:01:00Z"),policy_revision:"policy-1",context:{node_uid:"node-1",subject_ref:"agent-1",audience_ref:"helper-1",operation_id:"service.restart",scope_ref:"service/canary",parameters:{mode:"graceful"}}}).ok,true);
  assert.equal(validatePrivilegeLease({lease,signer,now:new Date("2026-01-01T00:01:00Z"),context:{node_uid:"node-X"}}).code,"LEASE_NODE_MISMATCH");
  assert.equal(validatePrivilegeLease({lease,signer,now:new Date("2026-01-01T00:01:00Z"),context:{subject_ref:"agent-X"}}).code,"LEASE_SUBJECT_MISMATCH");
  assert.equal(validatePrivilegeLease({lease,signer,now:new Date("2026-01-01T00:01:00Z"),context:{audience_ref:"helper-X"}}).code,"LEASE_AUDIENCE_MISMATCH");
});
test("expired and revoked leases deny even when transport is authenticated", () => {
  const r=request({operations:[{operation_id:"service.status.read",scope_ref:"service/canary",parameters:null,recovery:null}]});
  const decision=evaluatePrivilegeRequest(r,{registry});
  const signer=createSyntheticSigner();
  const lease=issuePrivilegeLease({lease_id:"lease-2",request:r,policyDecision:decision,signer,audience_ref:"helper-1",now:new Date("2026-01-01T00:00:00Z"),ttl_seconds:60});
  assert.equal(validatePrivilegeLease({lease,signer,now:new Date("2026-01-01T00:02:00Z"),context:{transport_authenticated:true}}).code,"LEASE_EXPIRED");
  assert.equal(validatePrivilegeLease({lease,signer,now:new Date("2026-01-01T00:00:30Z"),revocations:["lease-2"],context:{transport_authenticated:true}}).code,"LEASE_REVOKED");
});
test("transport without lease cannot elevate", () => {
  assert.equal(validatePrivilegeLease({lease:null,signer:createSyntheticSigner(),context:{transport_authenticated:true}}).code,"LEASE_REQUIRED");
});
test("effect fence rejects replay and uncertain effect reconciles", () => {
  const fences=createEffectFenceStore();
  assert.equal(fences.reserve("effect-1").ok,true);
  assert.equal(fences.reserve("effect-1").code,"EFFECT_FENCE_REPLAY");
  assert.equal(fences.reconcile("effect-1").state,"RECONCILE_REQUIRED");
  assert.equal(fences.state("effect-1"),"RECONCILE_REQUIRED");
});
test("receipt preserves reconcile outcome", () => {
  const receipt=createPrivilegeReceipt({receipt_id:"receipt-1",lease_id:"lease-1",request_id:"req-1",operation_id:"service.restart",effect_ref:"effect-1",result:"RECONCILE_REQUIRED"});
  assert.equal(receipt.result,"RECONCILE_REQUIRED");
});
test("audit ledger is append-only hash chained", () => {
  const ledger=createAuditLedger();
  const a=ledger.append({type:"decision",id:1});
  const b=ledger.append({type:"receipt",id:2});
  assert.equal(b.previous_hash,a.entry_hash);
  assert.equal(ledger.list().length,2);
});
test("break-glass cannot be ordinary agent fallback", () => {
  assert.equal(ordinaryAgentBreakGlassRequest().code,"BREAK_GLASS_NOT_ORDINARY_AGENT_AUTHORITY");
  const attempt=createRecoveryAttempt({recovery_attempt_id:"recovery-1",target_ref:"node-1",reason_ref:"incident-1"});
  assert.equal(authorizeRecovery(attempt,{authority_type:"POLICY",authority_ref:"policy"}).state,"DENIED");
  assert.equal(authorizeRecovery(attempt,{authority_type:"HUMAN",authority_ref:"human-1"}).state,"HUMAN_AUTHORIZED");
});
test("universal credential reference collapses classes and is rejected", () => {
  const result=validateCredentialClassBindings({
    TRANSPORT_IDENTITY:"ref-universal",
    LEASE_SIGNING_AUTHORITY:"ref-universal",
  });
  assert.equal(result.ok,false);
  assert.equal(result.code,"CREDENTIAL_CLASS_COLLAPSE");
});
test("deployment policy can only tighten auto approval", () => {
  const r=request({operations:[{operation_id:"service.status.read",scope_ref:"service/canary",parameters:null,recovery:null}]});
  assert.equal(evaluatePrivilegeRequest(r,{registry}).outcome,"AUTO_APPROVE");
  assert.equal(evaluatePrivilegeRequest(r,{registry,deploymentPolicy:{force_human:true}}).outcome,"HUMAN_REQUIRED");
});
