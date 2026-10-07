import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ContractValidationError,
  DispatchStateUnrecoverableError,
  JsonFileDispatchStateStore,
  PurposeUnspecifiedError,
  assertNoSecretFields,
  derivePurposeForLegacyMachineControlEntry,
  evaluateGate,
  tagPolicySatisfied,
  type TransportRequest,
} from "../src/transportContract.js";

function baseRequest(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    node_uid: "node-11111111-1111-4111-8111-111111111111",
    caller: { auth_kind: "oauth", actor_ref: "actor:test" },
    authority: { scope: "machine-control", policy_revision: "rev-1" },
    purpose: null,
    dispatch_state: null,
    plane_bindings: [
      {
        plane: "tailnet",
        provider: "tailscale",
        provider_ref: "ref-1",
        required_tags: ["tag:fleet-ssh-target"],
        runtime_tags: ["tag:fleet-ssh-target"],
      },
    ],
    ...overrides,
  };
}

describe("transportContract", () => {
  it("fails closed when purpose is missing", () => {
    expect(() => evaluateGate(baseRequest({ dispatch_state: "NOT_DISPATCHED" }))).toThrow(
      PurposeUnspecifiedError,
    );
  });

  it("fails closed when dispatch_state is missing", () => {
    expect(() => evaluateGate(baseRequest({ purpose: "machine-control" }))).toThrow(
      DispatchStateUnrecoverableError,
    );
  });

  it("requires reconcile for MAY_HAVE_EXECUTED", () => {
    const result = evaluateGate(
      baseRequest({ purpose: "machine-control", dispatch_state: "MAY_HAVE_EXECUTED" }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.reason).toBe("reconcile_required");
  });

  it("requires reconcile for UNKNOWN dispatch state", () => {
    const result = evaluateGate(
      baseRequest({ purpose: "machine-control", dispatch_state: "UNKNOWN" }),
    );
    expect(result.reason).toBe("reconcile_required");
  });

  it("allows candidates only for NOT_DISPATCHED + explicit purpose", () => {
    const result = evaluateGate(
      baseRequest({ purpose: "machine-control", dispatch_state: "NOT_DISPATCHED" }),
    );
    expect(result.reason).toBe("ok");
    expect(result.candidates).toHaveLength(1);
  });

  it("derives purpose only for the legacy machine-control entry", () => {
    expect(derivePurposeForLegacyMachineControlEntry()).toBe("machine-control");
  });

  it("keeps required_tags separate from runtime_tags", () => {
    expect(tagPolicySatisfied(["tag:fleet-ssh-target"], ["tag:other"])).toBe(false);
  });

  it("rejects secret-like fields in contract records", () => {
    expect(() => assertNoSecretFields({ oauth_token: "abc" })).toThrow(ContractValidationError);
  });

  it("json file dispatch state store survives restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-contract-"));
    const file = path.join(dir, "state.json");
    const store = new JsonFileDispatchStateStore(file);
    store.put("node-1", "MAY_HAVE_EXECUTED");
    const reloaded = new JsonFileDispatchStateStore(file);
    expect(reloaded.get("node-1")).toBe("MAY_HAVE_EXECUTED");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ "node-1": "MAY_HAVE_EXECUTED" });
  });

  it("RF-2: cloudflare binding uses cloudflare not tailnet facts", () => {
    const result = evaluateGate(
      baseRequest({
        purpose: "machine-control",
        dispatch_state: "NOT_DISPATCHED",
        authority: { scope: "machine-control", policy_revision: "rev-1" },
        plane_bindings: [
          {
            plane: "cloudflare-vpc",
            provider: "cloudflare",
            provider_ref: "cf-binding-1",
            required_tags: [],
            runtime_tags: [],
          },
        ],
      }),
    );
    expect(result.reason).toBe("ok");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].plane).toBe("cloudflare-vpc");
    expect(result.candidates[0].endpoint.kind).toBe("cloudflared_forwarded_sshd");
    expect(result.candidates[0].target_proof.method).toBe("pinned_host_key");
    expect(result.candidates[0].locator_kind).toBe("binding_name");
    expect(result.candidates[0].failure_domain).toBe("worker_vpc");
  });

  it("RF-3: cross-authority yields no candidate", () => {
    const result = evaluateGate(
      baseRequest({
        purpose: "machine-control",
        dispatch_state: "NOT_DISPATCHED",
        authority: { scope: "human-maintenance", policy_revision: "rev-1" },
      }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.reason).toBe("authority_mismatch");
  });

  it("RF-3: missing required tag yields no candidate", () => {
    const result = evaluateGate(
      baseRequest({
        purpose: "machine-control",
        dispatch_state: "NOT_DISPATCHED",
        authority: { scope: "machine-control", policy_revision: "rev-1" },
        plane_bindings: [
          {
            plane: "tailnet",
            provider: "tailscale",
            provider_ref: "ref-1",
            required_tags: ["tag:fleet-ssh-target"],
            runtime_tags: ["tag:other"],
          },
        ],
      }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.reason).toBe("tag_policy_unsatisfied");
  });
});
