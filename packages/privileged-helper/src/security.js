const ROOT_EQUIVALENT_GROUPS=new Set(["docker","lxd","libvirt","wheel","sudo","root"]);

export function validateOrdinaryPrincipalBoundary(input={}) {
  const findings=[];
  if(input.nopasswd_sudo===true) findings.push("NOPASSWD_SUDO");
  if(input.writable_helper_policy===true) findings.push("WRITABLE_PRIVILEGED_POLICY");
  if(input.root_equivalent_socket===true) findings.push("ROOT_EQUIVALENT_SOCKET");
  for(const group of input.groups ?? []) if(ROOT_EQUIVALENT_GROUPS.has(String(group))) findings.push("ROOT_EQUIVALENT_GROUP:"+group);
  return Object.freeze({ok:findings.length===0,findings});
}

export function validateHelperSocketConfig(config={}) {
  if(config.owner!=="root") return {ok:false,code:"HELPER_SOCKET_OWNER_MUST_BE_ROOT"};
  if(typeof config.group!=="string" || !config.group) return {ok:false,code:"HELPER_SOCKET_GROUP_REQUIRED"};
  if(!["0660","0600"].includes(String(config.mode))) return {ok:false,code:"HELPER_SOCKET_MODE_TOO_BROAD"};
  return {ok:true};
}
