import { createProviderOptionRegistry, resolveEnrollmentTemplate, applyUserOverrides } from "../../packages/enrollment-template/src/index.js";
import { TAILSCALE_PROVIDER_MANIFEST } from "../adapters/tailscale/index.js";

export const PUBLIC_ENROLLMENT_TEMPLATES = Object.freeze([
  Object.freeze({
    template_id:"managed-linux-standard", version:"1.0.0", generation:"public-v1",
    posture:{
      platforms:["linux"], roles:["managed"], capabilities:["control.read"],
      privilege:{broker_required:true,helper_required:true},
      human_gate:"POLICY",
      recovery:{break_glass_required:true},
      consumer_acceptance:"STRICT",
      bootstrap:{root_ceremony:"ONE_TIME",requirements:["systemd"]},
    },
    allowed_override_paths:[],
  }),
  Object.freeze({
    template_id:"managed-linux-tailscale", version:"1.0.0", generation:"public-v1",
    posture:{
      platforms:["linux"], roles:["managed"], capabilities:["control.read"],
      providers:{tailscale:{enabled:true,ssh:false}},
      privilege:{broker_required:true,helper_required:true},
      human_gate:"POLICY",
      recovery:{break_glass_required:true},
      consumer_acceptance:"STRICT",
      bootstrap:{root_ceremony:"ONE_TIME",requirements:["systemd"]},
    },
    allowed_override_paths:["providers.tailscale.ssh"],
  }),
  Object.freeze({
    template_id:"customer-managed-limited", version:"1.0.0", generation:"public-v1",
    posture:{
      platforms:["linux"], roles:["customer-managed"], capabilities:["control.read"],
      privilege:{broker_required:false,helper_required:false},
      human_gate:"HUMAN",
      recovery:{break_glass_required:false},
      consumer_acceptance:"STANDARD",
      bootstrap:{root_ceremony:"ONE_TIME",requirements:["systemd"]},
    },
    allowed_override_paths:[],
  }),
]);

export const PUBLIC_TEMPLATE_DISPLAY = Object.freeze({
  "managed-linux-standard":Object.freeze({
    "zh-CN":Object.freeze({name:"标准 Linux 纳管",description:"GhostFleet 管理身份、验收和 JIT 提权，不预设具体传输 provider。"}),
    en:Object.freeze({name:"Standard Linux management",description:"GhostFleet identity, acceptance and JIT privilege without a required transport provider."}),
  }),
  "managed-linux-tailscale":Object.freeze({
    "zh-CN":Object.freeze({name:"Linux + Tailscale",description:"在标准纳管上启用 Tailscale；Tailscale SSH 可在纳管时调整。"}),
    en:Object.freeze({name:"Linux + Tailscale",description:"Standard management with Tailscale enabled; Tailscale SSH is adjustable during enrollment."}),
  }),
  "customer-managed-limited":Object.freeze({
    "zh-CN":Object.freeze({name:"有限纳管",description:"保留设备侧管理权，只登记基础身份与只读控制面能力。"}),
    en:Object.freeze({name:"Limited management",description:"Keep device-side administration external while registering basic identity and read-only control-plane capabilities."}),
  }),
});

function bindingOf(resolved) {
  return Object.freeze({
    template_id:resolved.template_id,
    template_version:resolved.version,
    template_generation:resolved.generation,
    template_digest:resolved.digest,
    overlay_refs:Object.freeze((resolved.overlay_refs ?? []).map((item)=>Object.freeze({...item}))),
  });
}

export function createEnrollmentTemplateCatalog({
  templates=PUBLIC_ENROLLMENT_TEMPLATES,
  overlays=[],
  display=PUBLIC_TEMPLATE_DISPLAY,
  providerManifests=[TAILSCALE_PROVIDER_MANIFEST],
}={}) {
  const providerRegistry=createProviderOptionRegistry(providerManifests);
  const ids=templates.map((item)=>item.template_id);

  function resolveSelection({template_id,overrides={}}={}) {
    if(!ids.includes(template_id)) throw new Error("TEMPLATE_NOT_FOUND");
    if(!overrides || typeof overrides!=="object" || Array.isArray(overrides)) throw new Error("TEMPLATE_OVERRIDES_INVALID");
    let resolved=resolveEnrollmentTemplate({template_id,templates,overlays,providerRegistry});
    resolved=applyUserOverrides(resolved,overrides,providerRegistry);
    return Object.freeze({
      template_id,
      display:display[template_id] ?? null,
      effective_posture:resolved.posture,
      allowed_override_paths:resolved.allowed_override_paths,
      binding:bindingOf(resolved),
    });
  }

  return Object.freeze({
    list() { return ids.map((template_id)=>resolveSelection({template_id})); },
    resolveSelection,
  });
}
