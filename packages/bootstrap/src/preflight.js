import { createHash } from "node:crypto";

const digest=(value)=>"sha256:"+createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text=(value,fallback="UNKNOWN")=>typeof value==="string"&&value.trim()?value.trim():fallback;

export function evaluateBootstrapPreflight(input={}) {
  const facts={
    os_family:text(input.os_family),
    os_id:text(input.os_id),
    os_version_id:text(input.os_version_id),
    architecture:text(input.architecture),
    init_system:text(input.init_system),
    package_manager:text(input.package_manager),
    appliance:text(input.appliance,"generic-linux"),
    ssh_present:input.ssh_present===true,
    tailscale_state:text(input.tailscale_state,"UNKNOWN"),
    docker_socket_present:input.docker_socket_present===true,
    nopasswd_sudo_hint:input.nopasswd_sudo_hint===true,
    root_equivalent_bypass:input.root_equivalent_bypass===true,
    recovery_class:text(input.recovery_class,"UNKNOWN"),
  };
  const reasons=[], warnings=[];
  if(facts.os_family!=="debian-family") reasons.push("UNSUPPORTED_OS_FAMILY");
  if(facts.init_system!=="systemd") reasons.push("SYSTEMD_REQUIRED");
  if(!["apt","apt-get"].includes(facts.package_manager)) reasons.push("APT_REQUIRED");
  if(facts.architecture==="UNKNOWN") reasons.push("ARCHITECTURE_UNKNOWN");
  if(facts.root_equivalent_bypass) reasons.push("ROOT_EQUIVALENT_BYPASS_PRESENT");
  if(facts.docker_socket_present) warnings.push("DOCKER_SOCKET_PRESENT");
  if(facts.nopasswd_sudo_hint) warnings.push("NOPASSWD_SUDO_HINT_PRESENT");
  if(facts.appliance==="openmediavault") warnings.push("PROTECTED_STORAGE_APPLIANCE");
  if(facts.recovery_class==="UNKNOWN") warnings.push("RECOVERY_CLASS_UNKNOWN");
  const report={schema:"ghostfleet-bootstrap-preflight/v1",status:reasons.length?"STOP":"PASS",facts,reason_codes:reasons,warnings};
  return Object.freeze({...report,digest:digest(report)});
}
