export const TAILSCALE_PROVIDER_MANIFEST=Object.freeze({
  adapter_id:"tailscale",
  options:Object.freeze([
    Object.freeze({option_id:"enabled",type:"boolean",user_overridable:false}),
    Object.freeze({option_id:"ssh",type:"boolean",user_overridable:true}),
  ]),
});

export function validateTailscaleDesired(desired={}) {
  if(typeof desired.enabled!=="boolean") throw new Error("TAILSCALE_ENABLED_REQUIRED");
  if(typeof desired.ssh!=="boolean") throw new Error("TAILSCALE_SSH_REQUIRED");
  if(desired.ssh && !desired.enabled) throw new Error("TAILSCALE_SSH_REQUIRES_TAILSCALE");
  return Object.freeze({enabled:desired.enabled,ssh:desired.ssh});
}
