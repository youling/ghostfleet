import { validateHelperSocketConfig } from "./security.js";

const DEFAULTS=Object.freeze({
  service_path:"/etc/systemd/system/ghostfleet-privileged-helper.service",
  socket_path:"/run/ghostfleet/privileged-helper.sock",
  trust_root_path:"/etc/ghostfleet/helper-trust-root.pem",
  binary_path:"/usr/local/libexec/ghostfleet-privileged-helper",
});

export function desiredHelperInstall(config={}) {
  const desired={
    ...DEFAULTS,
    service_user:"root",
    service_group:"root",
    socket_owner:"root",
    socket_group:config.socket_group ?? "ghostfleet-agent",
    socket_mode:config.socket_mode ?? "0660",
    trust_root_ref:config.trust_root_ref ?? null,
  };
  const socketCheck=validateHelperSocketConfig({owner:desired.socket_owner,group:desired.socket_group,mode:desired.socket_mode});
  if(!socketCheck.ok) throw new Error(socketCheck.code);
  if(!desired.trust_root_ref) throw new Error("HELPER_TRUST_ROOT_REF_REQUIRED");
  return Object.freeze(desired);
}

export function planHelperInstall({observed={},desired}={}) {
  if(!desired) throw new Error("HELPER_DESIRED_REQUIRED");
  const actions=[];
  for(const key of ["binary_path","service_path","trust_root_path"]) {
    if(observed[key]!==desired[key] || observed[key+"_digest"]!==desired[key+"_digest"]) {
      actions.push(Object.freeze({kind:"MATERIALIZE",resource:key,path:desired[key]}));
    }
  }
  if(observed.socket_path!==desired.socket_path || observed.socket_group!==desired.socket_group || String(observed.socket_mode)!==String(desired.socket_mode)) {
    actions.push(Object.freeze({kind:"CONFIGURE_SOCKET",path:desired.socket_path,owner:"root",group:desired.socket_group,mode:desired.socket_mode}));
  }
  if(observed.service_enabled!==true) actions.push(Object.freeze({kind:"ENABLE_SERVICE",unit:"ghostfleet-privileged-helper.service"}));
  return Object.freeze({status:actions.length?"CHANGE_REQUIRED":"COMPLIANT",actions});
}

export function planHelperUninstall(desired) {
  if(!desired) throw new Error("HELPER_DESIRED_REQUIRED");
  return Object.freeze({
    actions:[
      Object.freeze({kind:"DISABLE_SERVICE",unit:"ghostfleet-privileged-helper.service"}),
      Object.freeze({kind:"REMOVE_EXACT",path:desired.service_path}),
      Object.freeze({kind:"REMOVE_EXACT",path:desired.socket_path}),
      Object.freeze({kind:"REMOVE_EXACT",path:desired.trust_root_path}),
      Object.freeze({kind:"REMOVE_EXACT",path:desired.binary_path}),
    ],
  });
}
