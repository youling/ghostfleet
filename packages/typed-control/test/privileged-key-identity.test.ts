import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { runPrivilegedOperation, type PrivilegedRuntimeEnv } from "../src/privilegedOperations.js";

// No importKey mock: ephemeral in-memory material verifies representation-independent identity.
describe("privileged key identity separation", () => {
  it("rejects one key encoded as PKCS#1 and PKCS#8 before connecting", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const ordinary = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const privileged = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(ordinary.replace(/\s/g, "") === privileged.replace(/\s/g, "")).toBe(false);
    const uid = ["node", "00000000", "0000", "4000", "8000", "000000000001"].join("-");
    const generation = "d".repeat(64);
    const profileGeneration = "sha256:" + "e".repeat(64);
    const target = { transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:AAAA" };
    const env: PrivilegedRuntimeEnv = {
      CONTROL_SSH_PRIVATE_KEY: ordinary,
      CONTROL_PRIVILEGED_SSH_PRIVATE_KEY: privileged,
      CONTROL_PRIVILEGED_USERNAME: "fixture_ops",
      CONTROL_TARGETS_JSON: JSON.stringify({ [uid]: { ...target, username: "fixture_user" } }),
      CONTROL_PRIVILEGED_TARGETS_JSON: JSON.stringify({ [uid]: { ...target, username: "fixture_ops" } }),
      CONTROL_PRIVILEGED_POLICY_JSON: JSON.stringify({ [uid]: {
        protocol: "youling-fleet-privileged-operations/v3", generation,
        profile_generation: profileGeneration, operations: ["root-probe"],
      } }),
    };
    const connect = vi.fn();
    const execute = vi.fn();
    const result = await runPrivilegedOperation(env, {
      userId: "synthetic-owner", authKind: "oauth", scopes: ["fleet.privileged"],
    }, {
      action: "execute", node_uid: uid, request_id: "req.same-key.1", operation: "root-probe",
      vendor_ids: [], generation, profile_generation: profileGeneration,
    }, { connect, execute });
    expect(result.error).toBe("PRIVILEGED_KEY_MUST_BE_SEPARATE");
    expect(result.outcome).toBe("NOT_DISPATCHED");
    expect(connect).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
