import { describe, expect, it } from "vitest";
import { DispatchStateUnrecoverableError, PurposeUnspecifiedError, evaluateGate } from "../src/transportContract.js";
import { pythonLegacyToContract, tsControlTargetToContract } from "../src/transportCompat.js";

function caller() {
  return { auth_kind: "oauth" as const, actor_ref: "actor:test" };
}
function authority() {
  return { scope: "machine-control", policy_revision: "rev-1" };
}

describe("transportCompat", () => {
  it("python legacy compat preserves fail-closed for missing purpose", () => {
    const request = pythonLegacyToContract({
      nodeUid: "node-11111111-1111-4111-8111-111111111111",
      providerRef: "opaque-tailscale-ref",
      legacyMode: "NORMAL",
      purpose: null,
      dispatchState: "NOT_DISPATCHED",
      caller: caller(),
      authority: authority(),
    });
    expect(() => evaluateGate(request)).toThrow(PurposeUnspecifiedError);
  });

  it("python legacy compat preserves fail-closed for missing dispatch_state", () => {
    const request = pythonLegacyToContract({
      nodeUid: "node-11111111-1111-4111-8111-111111111111",
      providerRef: "opaque-tailscale-ref",
      legacyMode: "NORMAL",
      purpose: "machine-control",
      dispatchState: null,
      caller: caller(),
      authority: authority(),
    });
    expect(() => evaluateGate(request)).toThrow(DispatchStateUnrecoverableError);
  });

  it("ts compat maps transport_mode to plane without synthesizing purpose", () => {
    const request = tsControlTargetToContract({
      nodeUid: "node-11111111-1111-4111-8111-111111111111",
      transportMode: "direct_tunnel",
      purpose: null,
      dispatchState: "NOT_DISPATCHED",
      caller: caller(),
      authority: authority(),
    });
    expect(request.plane_bindings[0].plane).toBe("cloudflare-vpc");
    expect(request.purpose).toBeNull();
  });

  it("legacy required_tags not merged with observed_tags", () => {
    const request = pythonLegacyToContract({
      nodeUid: "node-11111111-1111-4111-8111-111111111111",
      providerRef: "opaque-tailscale-ref",
      legacyMode: "NORMAL",
      purpose: "machine-control",
      dispatchState: "NOT_DISPATCHED",
      caller: caller(),
      authority: authority(),
      observedTags: ["tag:other"],
    });
    expect(request.plane_bindings[0].required_tags).toEqual(["tag:fleet-ssh-target"]);
    expect(request.plane_bindings[0].runtime_tags).toEqual(["tag:other"]);
  });

  it("RF-1: opaque provider_ref maps to tailnet not native-lan", () => {
    const request = pythonLegacyToContract({
      nodeUid: "node-11111111-1111-4111-8111-111111111111",
      providerRef: "opaque-tailscale-ref-xyz-123",
      legacyMode: "NORMAL",
      purpose: "machine-control",
      dispatchState: "NOT_DISPATCHED",
      caller: caller(),
      authority: authority(),
    });
    expect(request.plane_bindings[0].plane).toBe("tailnet");
    expect(request.plane_bindings[0].provider).toBe("tailscale");
    expect(request.plane_bindings[0].provider_ref).toBe("opaque-tailscale-ref-xyz-123");
  });

  it("RF-4: unknown transport_mode fails closed", () => {
    expect(() =>
      tsControlTargetToContract({
        nodeUid: "node-11111111-1111-4111-8111-111111111111",
        transportMode: "unknown_mode_xyz",
        purpose: "machine-control",
        dispatchState: "NOT_DISPATCHED",
        caller: caller(),
        authority: authority(),
      }),
    ).toThrow(/unknown transport_mode/);
  });
});
