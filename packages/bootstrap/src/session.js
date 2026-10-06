const freeze=(value)=>Object.freeze(structuredClone(value));

export function createBootstrapSession({attempt_id,template_binding}) {
  if(!attempt_id||!template_binding?.template_digest) throw new Error("BOOTSTRAP_BINDING_REQUIRED");
  return freeze({
    attempt_id,
    template_binding,
    state:"CREATED",
    root_ceremony_count:0,
    post_bootstrap_password_prompts:0,
    preflight:null,
    claim:null,
  });
}
export function recordRootCeremony(session) {
  if(session.state!=="CREATED"||session.root_ceremony_count!==0) throw new Error("ROOT_CEREMONY_ALREADY_CONSUMED");
  return freeze({...session,state:"PREFLIGHT",root_ceremony_count:1});
}
export function attachPreflight(session,report) {
  if(session.state!=="PREFLIGHT") throw new Error("PREFLIGHT_STATE_INVALID");
  if(!report?.digest) throw new Error("PREFLIGHT_REPORT_REQUIRED");
  return freeze({...session,state:report.status==="PASS"?"PREFLIGHT_PASSED":"STOPPED",preflight:report});
}
export function attachClaim(session,claim) {
  if(session.state!=="PREFLIGHT_PASSED") throw new Error("CLAIM_BEFORE_PREFLIGHT_PASS");
  if(!claim?.ticket_id) throw new Error("CLAIM_RECORD_REQUIRED");
  return freeze({...session,state:"CLAIMED",claim});
}
export function completeBootstrap(session,{receipt_ref}) {
  if(session.state!=="CLAIMED") throw new Error("BOOTSTRAP_NOT_CLAIMED");
  if(session.root_ceremony_count!==1) throw new Error("ROOT_CEREMONY_COUNT_INVALID");
  return freeze({...session,state:"COMPLETED",receipt_ref});
}
export function assertNoPostBootstrapPasswordPrompt(session) {
  if(session.state!=="COMPLETED") throw new Error("BOOTSTRAP_NOT_COMPLETE");
  if(session.post_bootstrap_password_prompts!==0) throw new Error("POST_BOOTSTRAP_PASSWORD_PROMPT_FORBIDDEN");
  return true;
}
export function createBootstrapReceipt(session) {
  if(session.state!=="COMPLETED") throw new Error("BOOTSTRAP_NOT_COMPLETE");
  return freeze({
    schema:"ghostfleet-bootstrap-receipt/v1",
    attempt_id:session.attempt_id,
    template_generation:session.template_binding.template_generation,
    template_digest:session.template_binding.template_digest,
    preflight_digest:session.preflight?.digest ?? null,
    root_ceremony_count:session.root_ceremony_count,
    post_bootstrap_password_prompts:session.post_bootstrap_password_prompts,
    result:"COMPLETED",
    receipt_ref:session.receipt_ref ?? null,
  });
}
