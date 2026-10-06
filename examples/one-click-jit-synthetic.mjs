import { createHash } from "node:crypto";
import {
  createProviderOptionRegistry, resolveEnrollmentTemplate, applyUserOverrides, bindTemplateToAttempt,
} from "../packages/enrollment-template/src/index.js";
import {
  createEnrollmentTicketStore, evaluateBootstrapPreflight, createBootstrapSession,
  recordRootCeremony, attachPreflight, attachClaim, completeBootstrap,
  assertNoPostBootstrapPasswordPrompt, createBootstrapReceipt,
} from "../packages/bootstrap/src/index.js";
import {
  createOperationRegistry, evaluatePrivilegeRequest, createApprovalRequest, resolveApproval,
  createSyntheticSigner, issuePrivilegeLease, validatePrivilegeLease,
} from "../packages/privilege-broker/src/index.js";
import {
  createLinuxTypedOperations, createHelperEffectFenceStore, createPrivilegedHelper,
} from "../packages/privileged-helper/src/index.js";
import {
  TAILSCALE_PROVIDER_MANIFEST, planTailscaleTransport, reconcileTailscaleOutcome,
} from "../src/adapters/tailscale/index.js";

const ref = (value) => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");

function syntheticTemplate() {
  const providerRegistry=createProviderOptionRegistry([TAILSCALE_PROVIDER_MANIFEST]);
  const template={
    template_id:"managed-linux-tailscale",
    version:"1.0.0",
    generation:"public-v1",
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
  const resolved=resolveEnrollmentTemplate({template_id:template.template_id,templates:[template],providerRegistry});
  return applyUserOverrides(resolved,{"providers.tailscale.ssh":true},providerRegistry);
}

function makeCanaryOs() {
  let generation=0;
  let active=true;
  return {
    async serviceStatus(target_ref) {
      return {state_ref:`${target_ref}:generation:${generation}:active:${active}`,public_data:{active,generation}};
    },
    async serviceRestart(target_ref) {
      generation += 1;
      active=true;
      return {outcome:"SUCCESS",recovery_ref:`${target_ref}:rollback:generation:${generation-1}`};
    },
    readback(target_ref) {
      return Object.freeze({target_ref,active,generation,state_ref:`${target_ref}:generation:${generation}:active:${active}`});
    },
  };
}

function makeLeaseVerifier({leases,signer,useCounts,node_uid,subject_ref,audience_ref}) {
  return async ({lease_id,context}) => {
    const lease=leases.get(lease_id);
    const result=validatePrivilegeLease({
      lease,
      signer,
      now:new Date("2026-10-07T00:02:00Z"),
      policy_revision:"policy-e2e-v1",
      use_count:useCounts.get(lease_id) ?? 0,
      context:{...context,node_uid,subject_ref,audience_ref},
    });
    if(result.ok) useCounts.set(lease_id,(useCounts.get(lease_id) ?? 0)+1);
    return result;
  };
}

function issueHumanLease({request,registry,signer,lease_id,approval_id}) {
  const decision=evaluatePrivilegeRequest(request,{registry,deploymentPolicy:{force_human:true}});
  const approvalRequest=createApprovalRequest({
    approval_request_id:`${approval_id}-request`,
    request,
    expires_at:"2026-10-07T00:10:00Z",
  });
  const approval=resolveApproval(approvalRequest,{
    approval_record_id:approval_id,
    approver_ref:"human-synthetic",
    decision:"APPROVE",
    decided_at:"2026-10-07T00:01:00Z",
  });
  return issuePrivilegeLease({
    lease_id,
    request,
    policyDecision:decision,
    approvalRecord:approval,
    signer,
    audience_ref:"helper-synthetic",
    now:new Date("2026-10-07T00:01:00Z"),
  });
}

export async function runSyntheticOneClickJitE2E() {
  const resolved=syntheticTemplate();
  const binding=bindTemplateToAttempt({attempt_id:"attempt-synthetic-e2e",resolved_template:resolved});

  const ticketStore=createEnrollmentTicketStore({
    now:()=>Date.parse("2026-10-07T00:00:00Z"),
    secretFactory:()=>"synthetic-claim-factor-0001",
    codeFactory:()=>"FACEB00C",
  });
  const issued=ticketStore.issue({
    ticket_id:"ticket-synthetic-e2e",
    attempt_id:binding.attempt_id,
    template_generation:binding.template_generation,
    template_digest:binding.template_digest,
    ttl_seconds:600,
  });

  let bootstrap=createBootstrapSession({attempt_id:binding.attempt_id,template_binding:binding});
  bootstrap=recordRootCeremony(bootstrap);

  const preflight=evaluateBootstrapPreflight({
    os_family:"debian-family",
    os_id:"debian",
    os_version_id:"13",
    architecture:"x86_64",
    init_system:"systemd",
    package_manager:"apt",
    appliance:"openmediavault",
    ssh_present:true,
    tailscale_state:"ABSENT",
    docker_socket_present:false,
    nopasswd_sudo_hint:false,
    root_equivalent_bypass:false,
    recovery_class:"local-console",
  });
  if(preflight.status!=="PASS") throw new Error("SYNTHETIC_PREFLIGHT_FAILED");
  bootstrap=attachPreflight(bootstrap,preflight);

  const claim=ticketStore.claim({
    ticket_id:issued.delivery.ticket_id,
    claim_secret:issued.delivery.claim_secret,
    short_code:issued.delivery.short_code,
    attempt_id:binding.attempt_id,
    template_digest:binding.template_digest,
    preflight_digest:preflight.digest,
  });
  if(!claim.ok) throw new Error("SYNTHETIC_CLAIM_FAILED");
  bootstrap=attachClaim(bootstrap,{ticket_id:claim.record.ticket_id});

  const transportPlan=planTailscaleTransport({
    desired:{enabled:true,ssh:true},
    observed:{state:"ABSENT",ssh_enabled:false},
    policy:{allow_tailscale:true,allow_tailscale_ssh:true},
  });
  const transportResult=reconcileTailscaleOutcome({
    plan:transportPlan,
    external_outcome:"SUCCESS",
    observed_after:{state:"PRESENT",ssh_enabled:true},
  });
  if(transportResult.status!=="COMPLETED") throw new Error("SYNTHETIC_TRANSPORT_NOT_CONVERGED");

  ticketStore.complete(issued.delivery.ticket_id,{outcome:"COMPLETED"});
  bootstrap=completeBootstrap(bootstrap,{receipt_ref:"bootstrap-receipt-synthetic"});
  assertNoPostBootstrapPasswordPrompt(bootstrap);
  const bootstrapReceipt=createBootstrapReceipt(bootstrap);

  const os=makeCanaryOs();
  const operations=createLinuxTypedOperations(os);
  const target_ref="service/ghostfleet-synthetic-canary";
  let unauthorizedMutations=0;
  const unauthorizedOs={
    ...os,
    async serviceRestart(...args) {
      unauthorizedMutations += 1;
      return os.serviceRestart(...args);
    },
  };
  const unauthorizedHelper=createPrivilegedHelper({
    leaseVerifier:async()=>({ok:false,code:"LEASE_REQUIRED"}),
    operations:createLinuxTypedOperations(unauthorizedOs),
    effectFences:createHelperEffectFenceStore(),
  });
  const denied=await unauthorizedHelper.handle({
    request_id:"request-denied",
    lease_id:"missing",
    operation_id:"service.restart",
    target_ref,
    effect_ref:"effect-denied",
    parameters:{mode:"graceful"},
  },{caller_ref:"deployment-consumer",helper_ref:"helper-synthetic",node_uid:"node-synthetic"});
  if(denied.code!=="LEASE_REQUIRED" || unauthorizedMutations!==0) throw new Error("UNAUTHORIZED_PRIVILEGE_WAS_NOT_DENIED");

  const registry=createOperationRegistry([{
    operation_id:"service.restart",
    risk_floor:"MEDIUM",
    auto_approvable:false,
    recovery_requirement:"ROLLBACK",
    max_ttl_seconds:300,
    max_uses:1,
  }]);
  const signer=createSyntheticSigner("deployment-owned-synthetic-signing-authority");
  const leases=new Map(), useCounts=new Map();
  const operation=(request_id)=>({
    request_id,
    node_uid:"node-synthetic",
    requester_ref:"deployment-consumer",
    intent:"restart dedicated GhostFleet synthetic canary",
    policy_revision:"policy-e2e-v1",
    requested_ttl_seconds:120,
    requested_max_uses:1,
    operations:[{
      operation_id:"service.restart",
      scope_ref:target_ref,
      parameters:{mode:"graceful"},
      recovery:{mode:"ROLLBACK",ref:"rollback/synthetic-canary"},
    }],
  });

  const originRequest=operation("request-origin");
  const originLease=issueHumanLease({
    request:originRequest,registry,signer,lease_id:"lease-origin",approval_id:"approval-origin",
  });
  leases.set(originLease.lease_id,originLease);
  const originHelper=createPrivilegedHelper({
    leaseVerifier:makeLeaseVerifier({leases,signer,useCounts,node_uid:"node-synthetic",subject_ref:"deployment-consumer",audience_ref:"helper-synthetic"}),
    operations,
    effectFences:createHelperEffectFenceStore(),
  });
  const originResult=await originHelper.handle({
    request_id:originRequest.request_id,
    lease_id:originLease.lease_id,
    operation_id:"service.restart",
    target_ref,
    effect_ref:"effect-origin",
    parameters:{mode:"graceful"},
  },{caller_ref:"deployment-consumer",helper_ref:"helper-synthetic",node_uid:"node-synthetic"});
  if(!originResult.ok) throw new Error("ORIGIN_JIT_OPERATION_FAILED");
  const originReceiptRef=ref(originResult.receipt);
  const originReadbackRef=ref(os.readback(target_ref));

  // Fresh context: new Helper process-local state, no origin session/workspace
  // material, but the same deployment-owned signer and policy semantics.
  const freshRequest=operation("request-fresh");
  const freshLease=issueHumanLease({
    request:freshRequest,registry,signer,lease_id:"lease-fresh",approval_id:"approval-fresh",
  });
  leases.set(freshLease.lease_id,freshLease);
  const freshHelper=createPrivilegedHelper({
    leaseVerifier:makeLeaseVerifier({leases,signer,useCounts,node_uid:"node-synthetic",subject_ref:"deployment-consumer",audience_ref:"helper-synthetic"}),
    operations,
    effectFences:createHelperEffectFenceStore(),
  });
  const freshResult=await freshHelper.handle({
    request_id:freshRequest.request_id,
    lease_id:freshLease.lease_id,
    operation_id:"service.restart",
    target_ref,
    effect_ref:"effect-fresh",
    parameters:{mode:"graceful"},
  },{caller_ref:"deployment-consumer",helper_ref:"helper-synthetic",node_uid:"node-synthetic"});
  if(!freshResult.ok) throw new Error("FRESH_CONTEXT_JIT_OPERATION_FAILED");
  const freshReceiptRef=ref(freshResult.receipt);
  const freshReadbackRef=ref(os.readback(target_ref));

  if(originReceiptRef===freshReceiptRef) throw new Error("EXECUTOR_INDEPENDENCE_RECEIPT_REUSED");
  if(originReadbackRef===freshReadbackRef) throw new Error("EXECUTOR_INDEPENDENCE_READBACK_REUSED");

  const replay=ticketStore.claim({
    ticket_id:issued.delivery.ticket_id,
    claim_secret:issued.delivery.claim_secret,
    short_code:issued.delivery.short_code,
    attempt_id:binding.attempt_id,
    template_digest:binding.template_digest,
    preflight_digest:preflight.digest,
  });
  if(replay.ok || replay.code!=="TICKET_NOT_CLAIMABLE") throw new Error("TICKET_REPLAY_WAS_NOT_DENIED");

  const summary=Object.freeze({
    template_digest:binding.template_digest,
    template_generation:binding.template_generation,
    tailscale_ssh:true,
    transport_status:transportResult.status,
    bootstrap_root_ceremonies:bootstrapReceipt.root_ceremony_count,
    post_bootstrap_root_or_sudo_password_prompts:bootstrapReceipt.post_bootstrap_password_prompts,
    ticket_replay:"DENIED",
    unauthorized_privileged_operation:"DENIED",
    origin_receipt_ref:originReceiptRef,
    origin_readback_ref:originReadbackRef,
    fresh_receipt_ref:freshReceiptRef,
    fresh_readback_ref:freshReadbackRef,
    fresh_context_independence:"PASS",
    final_canary_generation:os.readback(target_ref).generation,
  });
  const serialized=JSON.stringify(summary);
  if (serialized.includes(issued.delivery.claim_secret) || serialized.includes(issued.delivery.short_code)) {
    throw new Error("SUMMARY_EPHEMERAL_ENROLLMENT_FACTOR_LEAK");
  }
  if (/private.?key|auth.?key|claim_secret|short_code/i.test(serialized)) throw new Error("SUMMARY_SECRET_SURFACE");
  return summary;
}

if(import.meta.url===`file://${process.argv[1]}`) {
  const result=await runSyntheticOneClickJitE2E();
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
}
