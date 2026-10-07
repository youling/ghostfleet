/**
 * Compatibility adapters: legacy TS ControlTarget inputs -> provider-neutral contract.
 *
 * Legacy ``ControlTarget.transport_mode`` does not carry explicit ``purpose``
 * or durable ``dispatch_state``. Adapters require those values explicitly;
 * missing values remain fail-closed and are never defaulted.
 */

import type {
  Authority,
  Caller,
  DispatchState,
  Plane,
  PlaneBinding,
  Purpose,
  TransportRequest,
} from "./transportContract.js";

const LEGACY_MODE_TO_PLANE: Record<string, Plane> = {
  mesh_hostname: "cloudflare-vpc",
  direct_tunnel: "cloudflare-vpc",
  local_ssh: "native-lan",
};

export function tsControlTargetToContract(args: {
  nodeUid: string;
  transportMode: string;
  purpose: Purpose | null;
  dispatchState: DispatchState | null;
  caller: Caller;
  authority: Authority;
  observedTags?: string[];
}): TransportRequest {
  const plane = LEGACY_MODE_TO_PLANE[args.transportMode] ?? "native-lan";
  const provider = plane === "cloudflare-vpc" ? "cloudflare" : "native";
  const binding: PlaneBinding = {
    plane,
    provider,
    provider_ref: "",
    required_tags: [],
    runtime_tags: args.observedTags ?? [],
  };
  return {
    node_uid: args.nodeUid,
    caller: args.caller,
    authority: args.authority,
    purpose: args.purpose,
    dispatch_state: args.dispatchState,
    plane_bindings: [binding],
  };
}

export function pythonLegacyToContract(args: {
  nodeUid: string;
  providerRef: string | null;
  legacyMode: "NORMAL" | "LEGACY_CANARY";
  purpose: Purpose | null;
  dispatchState: DispatchState | null;
  caller: Caller;
  authority: Authority;
  observedTags?: string[];
}): TransportRequest {
  const providerRef = args.providerRef ?? "";
  const plane: Plane = providerRef ? "tailnet" : "tailnet";
  const requiredTags = args.legacyMode === "NORMAL" ? ["tag:fleet-ssh-target"] : [];
  const binding: PlaneBinding = {
    plane,
    provider: "tailscale",
    provider_ref: providerRef,
    required_tags: requiredTags,
    runtime_tags: args.observedTags ?? [],
  };
  return {
    node_uid: args.nodeUid,
    caller: args.caller,
    authority: args.authority,
    purpose: args.purpose,
    dispatch_state: args.dispatchState,
    plane_bindings: [binding],
  };
}
