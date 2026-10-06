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
