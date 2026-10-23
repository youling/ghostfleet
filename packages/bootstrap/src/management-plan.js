// Read-only, provider-neutral planning contract. NEVER execute actions from
// this object alone: observations must be independently verified by the
// deployment's host-side preflight, and authority is checked at effect time.
const STATES = new Set(["ABSENT","COMPLIANT","DRIFT_REPAIRABLE","CONFLICT","UNKNOWN"]);

const DEFINITIONS = Object.freeze([
  {id:"host_compatibility",scope:"HOST",action:null,needs:()=>true},
  {id:"immutable_identity",scope:"HOST",action:"reconcile_identity",needs:()=>true},
  {id:"primary_transport",scope:"HOST_ADMIN",action:"converge_primary_transport",needs:p=>p.roles?.includes("managed")||p.providers?.tailscale?.enabled===true},
  {id:"control_account",scope:"HOST_ADMIN",action:"install_scoped_control_account",needs:p=>p.roles?.includes("managed")},
  {id:"ssh_admission",scope:"HOST_ADMIN",action:"verify_scoped_ssh_admission",needs:p=>p.roles?.includes("managed")||p.providers?.tailscale?.ssh===true},
  {id:"user_manager",scope:"HOST_ADMIN",action:"converge_user_manager",needs:p=>p.roles?.includes("managed")},
  {id:"linger",scope:"HOST_ADMIN",action:"enable_selected_linger",needs:p=>p.roles?.includes("managed")},
  {id:"privileged_helper",scope:"HOST_ADMIN",action:"install_bound_privileged_helper",needs:p=>p.privilege?.helper_required===true},
  {id:"consumer_route",scope:"DEPLOYMENT",action:"configure_node_scoped_consumer",needs:p=>p.consumer_acceptance==="STRICT"},
  {id:"recovery_path",scope:"DEPLOYMENT",action:null,needs:p=>p.recovery?.break_glass_required===true},
  {id:"omv_config_owner",scope:"HOST",action:null,needs:(_p,o)=>o.appliance==="openmediavault"},
  {id:"omv_storage_isolation",scope:"HOST",action:null,needs:(_p,o)=>o.appliance==="openmediavault"},
]);

const VALID_POSTURES = new Set(["ONE_TIME","HUMAN","NONE"]);

export function planManagedLinuxInstallation({posture={},observed={}}={}) {
  if (!posture || typeof posture!=="object" || Array.isArray(posture)
      || !observed || typeof observed!=="object" || Array.isArray(observed)) {
    throw new Error("INSTALL_PLAN_INPUT_INVALID");
  }
  if (posture.platforms && (!Array.isArray(posture.platforms) || !posture.platforms.includes("linux"))) {
    throw new Error("LINUX_TEMPLATE_REQUIRED");
  }
  const selected=DEFINITIONS.filter(def=>def.needs(posture,observed));
  const components=selected.map(def=>{
    const state=observed[def.id] ?? "UNKNOWN";
    if (!STATES.has(state)) throw new Error("INSTALL_OBSERVATION_STATE_INVALID");
    return Object.freeze({id:def.id,state,authority:def.scope,proposed_action:def.action});
  });
  const missing=components.filter(c=>c.state==="UNKNOWN");
  const conflicts=components.filter(c=>c.state==="CONFLICT");
  // Never infer an absent resource from an unreadable service or missing key.
  const delta=components.filter(c=>c.state==="ABSENT"||c.state==="DRIFT_REPAIRABLE");
  const actions=delta.filter(c=>c.proposed_action!==null).map(c=>Object.freeze({
    id:c.proposed_action, component:c.id, required_authority:c.authority,
  }));
  const identity=components.find(c=>c.id==="immutable_identity");
  const mode=identity?.state==="ABSENT"?"NEW"
    :identity?.state==="COMPLIANT"?(delta.length?"REPAIR":"ADOPT"):"UNRESOLVED";
  const status=conflicts.length?"BLOCKED_CONFLICT"
    :missing.length?"PREFLIGHT_REQUIRED"
    :delta.some(c=>c.proposed_action===null)?"MANUAL_EVIDENCE_REQUIRED"
    :delta.length?"PLAN_READY":"ZERO_DELTA";
  // PLAN_READY is NOT permission to mutate or a successful host-side preflight.
  return Object.freeze({
    schema:"ghostfleet-linux-install-plan/v1",
    nature:"READ_ONLY_PREVIEW_NOT_AUTHORITY",
    mode, status,
    root_ceremony_target:posture.bootstrap?.root_ceremony==="ONE_TIME"?1:null,
    components:Object.freeze(components),
    unknown:Object.freeze(missing.map(c=>c.id)),
    conflicts:Object.freeze(conflicts.map(c=>c.id)),
    proposed_actions:Object.freeze(actions),
    effects_executed:0,
    consumer_accepted:false,
  });
}
