function receiptRefs(before,after,recovery_ref=null) {
  return {before_state_ref:before?.state_ref ?? null,after_state_ref:after?.state_ref ?? null,recovery_ref};
}

export function createLinuxTypedOperations(os) {
  if(!os) throw new Error("OS_BACKEND_REQUIRED");
  const map=new Map();

  map.set("service.status.read",Object.freeze({
    mutating:false,
    async execute({target_ref}) {
      const status=await os.serviceStatus(target_ref);
      return {result:"SUCCESS",...receiptRefs(status,status),data:status.public_data ?? null};
    },
  }));

  map.set("service.restart",Object.freeze({
    mutating:true,
    async execute({target_ref,parameters}) {
      if(parameters?.mode && !["graceful","normal"].includes(parameters.mode)) return {result:"DENIED",code:"SERVICE_RESTART_MODE_INVALID"};
      const before=await os.serviceStatus(target_ref);
      if(!before?.state_ref) return {result:"DENIED",code:"BEFORE_STATE_REQUIRED"};
      const applied=await os.serviceRestart(target_ref,{mode:parameters?.mode ?? "normal"});
      if(applied?.outcome==="UNKNOWN") return {result:"RECONCILE_REQUIRED",before_state_ref:before.state_ref,recovery_ref:applied.recovery_ref ?? null};
      const after=await os.serviceStatus(target_ref);
      if(!after?.state_ref) return {result:"RECONCILE_REQUIRED",before_state_ref:before.state_ref,recovery_ref:applied?.recovery_ref ?? null};
      return {result:"SUCCESS",...receiptRefs(before,after,applied?.recovery_ref ?? null)};
    },
  }));

  map.set("network.interface.enable",Object.freeze({
    mutating:true,
    async execute({target_ref,parameters}) {
      // target_ref is the lease-bound stable interface reference, never a raw device name.
      if(!target_ref || !parameters || typeof parameters!=="object" || Array.isArray(parameters) ||
         Object.keys(parameters).length!==1 || parameters.admin_state!=="UP") {
        return {result:"DENIED",code:"NETWORK_INTERFACE_PARAMETERS_INVALID"};
      }
      if(typeof os.networkInterfaceStatus!=="function" || typeof os.networkInterfaceEnable!=="function") {
        return {result:"DENIED",code:"NETWORK_INTERFACE_BACKEND_UNAVAILABLE"};
      }
      const before=await os.networkInterfaceStatus(target_ref);
      const safeObservation=(value) =>
        value && value.interface_ref===target_ref &&
        typeof value.state_ref==="string" && value.state_ref.length>0 &&
        ["UP","DOWN"].includes(value.admin_state) &&
        value.autoconfig_on_up===false &&
        value.route_impact==="NONE" &&
        value.control_path_dependency===false;
      if(!safeObservation(before)) {
        return {result:"DENIED",code:"NETWORK_INTERFACE_PREFLIGHT_NOT_SAFE"};
      }
      if(before.admin_state==="UP") {
        return {result:"SUCCESS",code:"NETWORK_INTERFACE_ALREADY_UP",...receiptRefs(before,before)};
      }
      // Fixed typed backend call only. Backend must re-check expected state before effect.
      const applied=await os.networkInterfaceEnable(target_ref,{
        expected_before_state_ref:before.state_ref,
        admin_state:"UP",
      });
      if(applied?.outcome!=="SUCCESS") {
        return {
          result:"RECONCILE_REQUIRED",
          code:applied?.code ?? "NETWORK_INTERFACE_ENABLE_OUTCOME_UNKNOWN",
          before_state_ref:before.state_ref,
          recovery_ref:applied?.recovery_ref ?? null,
        };
      }
      const after=await os.networkInterfaceStatus(target_ref);
      if(!safeObservation(after) || after.admin_state!=="UP") {
        return {
          result:"RECONCILE_REQUIRED",
          code:"NETWORK_INTERFACE_POSTCONDITION_UNPROVEN",
          before_state_ref:before.state_ref,
          after_state_ref:after?.state_ref ?? null,
          recovery_ref:applied.recovery_ref ?? null,
        };
      }
      return {result:"SUCCESS",...receiptRefs(before,after,applied.recovery_ref ?? null)};
    },
  }));

  map.set("managed.file.materialize",Object.freeze({
    mutating:true,
    async execute({target_ref,parameters}) {
      if(typeof parameters?.content_ref!=="string" || !parameters.content_ref) return {result:"DENIED",code:"CONTENT_REF_REQUIRED"};
      const before=await os.managedFileStatus(target_ref);
      const applied=await os.managedFileMaterialize(target_ref,{content_ref:parameters.content_ref,mode:parameters.mode ?? "0644"});
      if(applied?.outcome==="UNKNOWN") return {result:"RECONCILE_REQUIRED",before_state_ref:before?.state_ref ?? null,recovery_ref:applied.recovery_ref ?? null};
      const after=await os.managedFileStatus(target_ref);
      return {result:"SUCCESS",...receiptRefs(before,after,applied?.recovery_ref ?? null)};
    },
  }));

  return Object.freeze({
    get:(id)=>map.get(id) ?? null,
    list:()=>[...map.keys()],
  });
}
