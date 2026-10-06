const clone=(value)=>structuredClone(value);
const frozen=(value)=>Object.freeze(clone(value));
export function createEnrollmentWizard({attempt_id,template_binding}) {
  if(!attempt_id || !template_binding?.template_digest) throw new Error("WIZARD_BINDING_REQUIRED");
  return frozen({state:"ATTEMPT_CREATED",attempt_id,template_binding,delivery:null,result:null});
}
export function attachBootstrapDelivery(wizard,{short_code,bootstrap_command}) {
  if(wizard.state!=="ATTEMPT_CREATED") throw new Error("WIZARD_STATE_INVALID");
  if(!short_code || !bootstrap_command) throw new Error("BOOTSTRAP_DELIVERY_REQUIRED");
  return frozen({...wizard,state:"TICKET_READY",delivery:{short_code,bootstrap_command}});
}
export function markBootstrapRunning(wizard) {
  if(wizard.state!=="TICKET_READY") throw new Error("WIZARD_STATE_INVALID");
  return frozen({...wizard,state:"BOOTSTRAP_RUNNING"});
}
export function markBootstrapResult(wizard,result) {
  if(wizard.state!=="BOOTSTRAP_RUNNING") throw new Error("WIZARD_STATE_INVALID");
  if(!["COMPLETED","FAILED","RECONCILE_REQUIRED"].includes(result)) throw new Error("BOOTSTRAP_RESULT_INVALID");
  return frozen({...wizard,state:result,result});
}
export function serializeWizardState(wizard) {
  return frozen({
    state:wizard.state,
    attempt_id:wizard.attempt_id,
    template_binding:wizard.template_binding,
    delivery_present:Boolean(wizard.delivery),
    result:wizard.result,
  });
}
