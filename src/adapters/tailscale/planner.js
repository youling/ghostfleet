import { validateTailscaleDesired } from "./options.js";

const STATES=new Set(["ABSENT","PRESENT","UNKNOWN"]);

export function planTailscaleTransport({desired,observed={},policy={}}={}) {
  const target=validateTailscaleDesired(desired);
  const state=STATES.has(observed.state)?observed.state:"UNKNOWN";
  if(state==="UNKNOWN" || observed.ssh_enabled==="UNKNOWN") {
    return Object.freeze({
      status:"RECONCILE_REQUIRED",
      reason_codes:["CURRENT_STATE_UNKNOWN"],
      actions:[],
      request_new_enrollment_material:false,
      privilege_implication:"NONE",
      desired:target,
    });
  }

  if(policy.allow_tailscale===false && target.enabled) {
    return Object.freeze({status:"DENIED",reason_codes:["DEPLOYMENT_POLICY_DENIED_TAILSCALE"],actions:[],request_new_enrollment_material:false,privilege_implication:"NONE",desired:target});
  }
  if(policy.allow_tailscale_ssh===false && target.ssh) {
    return Object.freeze({status:"DENIED",reason_codes:["DEPLOYMENT_POLICY_DENIED_TAILSCALE_SSH"],actions:[],request_new_enrollment_material:false,privilege_implication:"NONE",desired:target});
  }

  const actions=[];
  if(target.enabled && state==="ABSENT") {
    actions.push(Object.freeze({
      kind:"TAILSCALE_ENROLL",
      required_authority:["PROVIDER_ENROLLMENT_MATERIAL","NODE_PRIVILEGE_LEASE"],
      reversible:true,
    }));
  } else if(!target.enabled && state==="PRESENT") {
    actions.push(Object.freeze({
      kind:"TAILSCALE_DISABLE",
      required_authority:["HUMAN_OR_DEPLOYMENT_POLICY","NODE_PRIVILEGE_LEASE"],
      reversible:true,
    }));
  }

  if(target.enabled && state==="PRESENT" && Boolean(observed.ssh_enabled)!==target.ssh) {
    actions.push(Object.freeze({
      kind:"TAILSCALE_SSH_SET",
      desired:target.ssh,
      required_authority:["NODE_PRIVILEGE_LEASE","DEPLOYMENT_POLICY"],
      reversible:true,
      privilege_implication:"NONE",
    }));
  }
  if(target.enabled && state==="ABSENT" && target.ssh) {
    actions.push(Object.freeze({
      kind:"TAILSCALE_SSH_SET_AFTER_ENROLL",
      desired:true,
      required_authority:["NODE_PRIVILEGE_LEASE","DEPLOYMENT_POLICY"],
      reversible:true,
      privilege_implication:"NONE",
    }));
  }

  return Object.freeze({
    status:actions.length?"CHANGE_REQUIRED":"COMPLIANT",
    reason_codes:[],
    actions,
    request_new_enrollment_material:actions.some(a=>a.kind==="TAILSCALE_ENROLL"),
    privilege_implication:"NONE",
    desired:target,
  });
}

export function reconcileTailscaleOutcome({plan,external_outcome,observed_after}={}) {
  if(!plan) throw new Error("PLAN_REQUIRED");
  if(external_outcome==="UNKNOWN" || !observed_after || observed_after.state==="UNKNOWN") {
    return Object.freeze({status:"RECONCILE_REQUIRED",retry_allowed:false,reason_codes:["PROVIDER_OR_NODE_OUTCOME_UNKNOWN"]});
  }
  if(external_outcome==="FAILED") return Object.freeze({status:"FAILED",retry_allowed:false,reason_codes:["APPLY_FAILED_REVIEW_REQUIRED"]});
  if(!plan.desired) throw new Error("PLAN_DESIRED_REQUIRED");
  const after=planTailscaleTransport({desired:plan.desired,observed:observed_after,policy:{allow_tailscale:true,allow_tailscale_ssh:true}});
  return Object.freeze({status:after.status==="COMPLIANT"?"COMPLETED":"RECONCILE_REQUIRED",retry_allowed:false,reason_codes:after.status==="COMPLIANT"?[]:["POST_STATE_NOT_CONVERGED"]});
}
