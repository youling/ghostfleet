import { describe, it, expect, vi } from "vitest";
import {
  parseTopologyPolicy,
  resolveTopologyPolicy,
  enforceTopologyAuthorization,
  filterTopologyNodes,
  type ControlTopologyPolicy,
  type ControlTopologyEnv,
  runControlOperation,
  listControlNodes,
  runPrivilegedOperation,
  type ControlActor,
  type NodePolicy,
  type ControlEnvironment,
  type PrivilegedRuntimeEnv,
  type PrivilegedInput,
  type OperationDependencies,
  createNativeBackend,
  canonicalRequestDigest,
} from "../src/index.js";
import { SshExecutionError } from "../src/sshClient.js";

vi.mock("@microsoft/dev-tunnels-ssh-keys", () => ({
  importKey: async (pem: string) => ({
    dispose() {},
    getPublicKeyBytes: async () => new TextEncoder().encode(pem),
  }),
}));

// Build synthetic IDs to avoid raw node UUID literals flagged by publication guard
const makeNodeUid = (n: number) => ["node", "00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const node1 = makeNodeUid(1); // controller capable
const node2 = makeNodeUid(2); // managed only
const node3 = makeNodeUid(3); // managed only
const node4 = makeNodeUid(4); // controller capable (empty targets)

const repo = "example/synthetic-control-repo";
const revision = "a".repeat(40);
const source = { repository: repo, revision };

function makeTopology(overrides: Partial<ControlTopologyPolicy> = {}): ControlTopologyPolicy {
  return {
    schema_version: 1,
    source,
    nodes: {
      [node1]: { role: "CONTROLLER_CAPABLE" },
      [node2]: { role: "MANAGED_ONLY" },
      [node3]: { role: "MANAGED_ONLY" },
      [node4]: { role: "CONTROLLER_CAPABLE" },
    },
    bindings: [
      {
        auth_kind: "oauth",
        user_id: "central-operator",
        origin_node_uid: null,
        allowed_targets: [node1, node2, node3],
      },
      {
        auth_kind: "break_glass",
        user_id: "central-operator",
        origin_node_uid: null,
        allowed_targets: [node1],
      },
      {
        auth_kind: "oauth",
        user_id: "edge-controller",
        origin_node_uid: node1,
        allowed_targets: [node2],
      },
      {
        auth_kind: "oauth",
        user_id: "empty-controller",
        origin_node_uid: node4,
        allowed_targets: [],
      },
      {
        auth_kind: "oauth",
        user_id: "managed-actor",
        origin_node_uid: node2,
        allowed_targets: [node2, node3],
      },
    ],
    ...overrides,
  };
}

const nodePolicyLinuxNormal: NodePolicy = {
  display_name: "Synthetic Linux Device",
  aliases: [],
  platform: "linux",
  execution_privilege: "normal",
  asset_ref: null,
  observations: ["identity"],
  services: {
    testsvc: { unit: "testsvc.service", restart_allowed: true },
  },
  jobs: {
    protocol: "fleet-job/v1",
    helper_sha256: "b".repeat(64),
    max_runtime_seconds: 60,
  },
  sessions: {
    protocol: "fleet-session/v2",
    helper_sha256: "c".repeat(64),
    max_runtime_seconds: 60,
  },
};

function makeFullEnv(topologyMode?: string, topologyPolicyObj?: ControlTopologyPolicy): ControlEnvironment {
  const top = topologyPolicyObj ?? makeTopology();
  return {
    CONTROL_POLICY_SOURCE_REPOSITORY: repo,
    CONTROL_POLICY_SOURCE_REVISION: revision,
    CONTROL_POLICY_JSON: JSON.stringify({
      schema_version: 1,
      source,
      nodes: {
        [node1]: nodePolicyLinuxNormal,
        [node2]: nodePolicyLinuxNormal,
        [node3]: nodePolicyLinuxNormal,
        [node4]: nodePolicyLinuxNormal,
      },
    }),
    CONTROL_TARGETS_JSON: JSON.stringify({
      [node1]: { username: "syn_user", transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:AAAA" },
      [node2]: { username: "syn_user", transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:AAAA" },
      [node3]: { username: "syn_user", transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:AAAA" },
      [node4]: { username: "syn_user", transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:AAAA" },
    }),
    CONTROL_SSH_PRIVATE_KEY: "synthetic-ordinary-ssh-private-key-material",
    ...(topologyMode !== undefined ? { CONTROL_TOPOLOGY_MODE: topologyMode } : {}),
    ...(topologyPolicyObj !== undefined ? { CONTROL_TOPOLOGY_JSON: JSON.stringify(topologyPolicyObj) }
        : topologyMode !== undefined ? { CONTROL_TOPOLOGY_JSON: JSON.stringify(top) } : {}),
  };
}

function makeSpyBackend() {
  const calls = { connect: 0, execute: 0 };
  const backend = createNativeBackend({
    connect: async () => {
      calls.connect++;
      return { close: async () => {}, closed: Promise.resolve() } as never;
    },
    execute: async (_socket, _target, _key, _cmd, options) => {
      calls.execute++;
      const rpc = options?.stdin ? JSON.parse(options.stdin) : null;
      if (rpc?.protocol === "fleet-job/v1") {
        return { exit_code: 0, stdout: JSON.stringify({
          protocol: rpc.protocol, ok: true, action: rpc.action,
          handle: rpc.handle, generation: rpc.generation,
          operation_id: "oj1-1700000000000-00000000-0000-4000-8000-000000000001",
          spec_digest: "d".repeat(64), retry_submit: false,
          state: "RUNNING", exit_code: null, reconcile_required: false,
        }), stderr: "", truncated: false };
      }
      if (rpc?.protocol === "fleet-session/v2") {
        return { exit_code: 0, stdout: JSON.stringify({
          protocol: rpc.protocol, ok: true, action: rpc.action,
          handle: rpc.handle, generation: rpc.generation,
          operation_id: "os1-1700000000000-00000000-0000-4000-8000-000000000001",
          spec_digest: "d".repeat(64), retry_mutation: false,
          state: "RUNNING", exit_code: null, exit_signal: null,
          last_input_seq: 0, pending_input_seq: null,
          output_bytes: 0, output_capped: false, reconcile_required: false,
          idle_expires_at: 1700000001, absolute_expires_at: 1700000002,
          retention_until: 1700000003,
        }), stderr: "", truncated: false };
      }
      return { exit_code: 0, stdout: "synthetic execution ok", stderr: "", truncated: false };
    },
  });
  return { backend, calls };
}

describe("Topology Policy Schema and Resolution", () => {
  it("parses valid topology policy matching expected source", () => {
    const raw = JSON.stringify(makeTopology());
    const parsed = parseTopologyPolicy(raw, source);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.nodes[node1].role).toBe("CONTROLLER_CAPABLE");
  });

  it("rejects missing or invalid expected source", () => {
    const raw = JSON.stringify(makeTopology());
    expect(() => parseTopologyPolicy(raw, undefined as never)).toThrow("CONTROL_SOURCE_NOT_CONFIGURED");
    expect(() => parseTopologyPolicy(raw, { repository: "bad", revision: "short" })).toThrow("CONTROL_SOURCE_NOT_CONFIGURED");
  });

  it("rejects mismatched repository or revision", () => {
    const raw = JSON.stringify(makeTopology());
    expect(() => parseTopologyPolicy(raw, { repository: "other/repo", revision })).toThrow("CONTROL_SOURCE_MISMATCH");
    expect(() => parseTopologyPolicy(raw, { repository: repo, revision: "b".repeat(40) })).toThrow("CONTROL_SOURCE_MISMATCH");
  });

  it("rejects malformed or oversized JSON", () => {
    expect(() => parseTopologyPolicy("{ bad json", source)).toThrow("TOPOLOGY_POLICY_INVALID");
    expect(() => parseTopologyPolicy("x".repeat(300 * 1024), source)).toThrow("TOPOLOGY_POLICY_NOT_CONFIGURED");
  });

  it("rejects unknown origin node", () => {
    const bad = makeTopology();
    bad.bindings[0].origin_node_uid = makeNodeUid(99);
    expect(() => parseTopologyPolicy(JSON.stringify(bad), source)).toThrow("TOPOLOGY_POLICY_INVALID");
  });

  it("rejects unknown target node", () => {
    const bad = makeTopology();
    bad.bindings[0].allowed_targets = [makeNodeUid(99)];
    expect(() => parseTopologyPolicy(JSON.stringify(bad), source)).toThrow("TOPOLOGY_POLICY_INVALID");
  });

  it("rejects duplicate actor bindings", () => {
    const bad = makeTopology();
    bad.bindings.push({
      auth_kind: "oauth",
      user_id: "central-operator",
      origin_node_uid: null,
      allowed_targets: [node1],
    });
    expect(() => parseTopologyPolicy(JSON.stringify(bad), source)).toThrow("TOPOLOGY_POLICY_INVALID");
  });

  it("rejects duplicate target in allowed_targets", () => {
    const bad = makeTopology();
    bad.bindings[0].allowed_targets = [node1, node1];
    expect(() => parseTopologyPolicy(JSON.stringify(bad), source)).toThrow("TOPOLOGY_POLICY_INVALID");
  });

  it("resolves mode when both env vars are absent to legacy", () => {
    const res = resolveTopologyPolicy({});
    expect(res.mode).toBe("legacy");
    expect(res.policy).toBeUndefined();
  });

  it("fails closed when JSON is supplied without mode", () => {
    const env: ControlTopologyEnv = {
      CONTROL_POLICY_SOURCE_REPOSITORY: repo,
      CONTROL_POLICY_SOURCE_REVISION: revision,
      CONTROL_TOPOLOGY_JSON: JSON.stringify(makeTopology()),
    };
    expect(() => resolveTopologyPolicy(env)).toThrow("TOPOLOGY_MODE_REQUIRED");
  });

  it("rejects invalid mode string or empty mode string", () => {
    expect(() => resolveTopologyPolicy({ CONTROL_TOPOLOGY_MODE: "invalid_mode" })).toThrow("INVALID_TOPOLOGY_MODE");
    expect(() => resolveTopologyPolicy({ CONTROL_TOPOLOGY_MODE: "" })).toThrow("INVALID_TOPOLOGY_MODE");
  });

  it("rejects legacy mode when any JSON is supplied to avoid confusing bypass", () => {
    const env: ControlTopologyEnv = {
      CONTROL_POLICY_SOURCE_REPOSITORY: repo,
      CONTROL_POLICY_SOURCE_REVISION: revision,
      CONTROL_TOPOLOGY_MODE: "legacy",
      CONTROL_TOPOLOGY_JSON: JSON.stringify(makeTopology()),
    };
    expect(() => resolveTopologyPolicy(env)).toThrow("TOPOLOGY_CONFIG_REJECTED");
  });

  it("rejects enforced mode without JSON or with empty JSON", () => {
    const env: ControlTopologyEnv = {
      CONTROL_POLICY_SOURCE_REPOSITORY: repo,
      CONTROL_POLICY_SOURCE_REVISION: revision,
      CONTROL_TOPOLOGY_MODE: "enforced",
    };
    expect(() => resolveTopologyPolicy(env)).toThrow("TOPOLOGY_POLICY_NOT_CONFIGURED");
    expect(() => resolveTopologyPolicy({ ...env, CONTROL_TOPOLOGY_JSON: "" })).toThrow("TOPOLOGY_POLICY_NOT_CONFIGURED");
  });

  it("never treats a supplied empty topology variable as absence", () => {
    expect(() => resolveTopologyPolicy({ CONTROL_TOPOLOGY_JSON: "" })).toThrow("TOPOLOGY_MODE_REQUIRED");
    expect(() => resolveTopologyPolicy({ CONTROL_TOPOLOGY_MODE: "legacy", CONTROL_TOPOLOGY_JSON: "" })).toThrow("TOPOLOGY_CONFIG_REJECTED");
  });

  it.each(["unknown_field", "role"])("rejects unrecognized policy field %s", (field) => {
    expect(() => parseTopologyPolicy(JSON.stringify({ ...makeTopology(), [field]: "CONTROLLER_CAPABLE" }), source)).toThrow("TOPOLOGY_POLICY_INVALID");
  });

  it("refuses an unknown node role and string-coercible destination", () => {
    const bad = makeTopology();
    (bad.nodes[node1] as { role: string }).role = "UNKNOWN";
    expect(() => parseTopologyPolicy(JSON.stringify(bad), source)).toThrow("TOPOLOGY_POLICY_INVALID");
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "central-operator", scopes: ["fleet.read"], authKind: "oauth" };
    expect(() => enforceTopologyAuthorization(env, actor, new String(node1) as never)).toThrow("INVALID_NODE_UID");
  });

  it("resolves enforced mode with valid policy", () => {
    const env: ControlTopologyEnv = {
      CONTROL_POLICY_SOURCE_REPOSITORY: repo,
      CONTROL_POLICY_SOURCE_REVISION: revision,
      CONTROL_TOPOLOGY_MODE: "enforced",
      CONTROL_TOPOLOGY_JSON: JSON.stringify(makeTopology()),
    };
    const res = resolveTopologyPolicy(env);
    expect(res.mode).toBe("enforced");
    expect(res.policy).toBeDefined();
  });
});

describe("listControlNodes Topology Filtering", () => {
  it("preserves old consumers and returns all nodes in legacy mode", () => {
    const env = makeFullEnv(); // absent topology vars
    const actor: ControlActor = { userId: "any-user", scopes: ["fleet.read"], authKind: "oauth" };
    const catalog = listControlNodes(env, actor);
    expect(catalog.nodes).toHaveLength(4);
  });

  it("filters catalog strictly to allowed targets for central actor in enforced mode (no leak)", () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "central-operator", scopes: ["fleet.read"], authKind: "oauth" };
    const catalog = listControlNodes(env, actor);
    const uids = catalog.nodes.map((n) => n.node_uid);
    expect(uids).toEqual([node1, node2, node3]);
    expect(uids).not.toContain(node4);
  });

  it("filters catalog strictly to allowed targets for edge controller in enforced mode", () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "edge-controller", scopes: ["fleet.read"], authKind: "oauth" };
    const catalog = listControlNodes(env, actor);
    const uids = catalog.nodes.map((n) => n.node_uid);
    expect(uids).toEqual([node2]);
    expect(uids).not.toContain(node1);
    expect(uids).not.toContain(node3);
    expect(uids).not.toContain(node4);
  });

  it("returns empty catalog for controller with empty allowed_targets", () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "empty-controller", scopes: ["fleet.read"], authKind: "oauth" };
    const catalog = listControlNodes(env, actor);
    expect(catalog.nodes).toEqual([]);
  });

  it("denies managed-only origin caller from listing catalog", () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "managed-actor", scopes: ["fleet.read"], authKind: "oauth" };
    expect(() => listControlNodes(env, actor)).toThrow("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
  });

  it("denies unknown actor from listing catalog", () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "unbound-user", scopes: ["fleet.read"], authKind: "oauth" };
    expect(() => listControlNodes(env, actor)).toThrow("TOPOLOGY_ACTOR_NOT_BOUND");
  });

  it("distinguishes authKind for listing catalog (break_glass vs oauth)", () => {
    const env = makeFullEnv("enforced");
    const breakGlassActor: ControlActor = { userId: "central-operator", scopes: ["fleet.read"], authKind: "break_glass" };
    const catalog = listControlNodes(env, breakGlassActor);
    const uids = catalog.nodes.map((n) => n.node_uid);
    expect(uids).toEqual([node1]); // break_glass only has node1 allowed
  });
});

describe("runControlOperation Topology Enforcement", () => {
  it.each([
    { op: "node.inspect", input: (target: string) => ({ operation: "node.inspect" as const, node_uid: target, observation: "identity" as const, timeout_seconds: 5 }) },
    { op: "shell.exec", input: (target: string) => ({ operation: "shell.exec" as const, node_uid: target, command: "/usr/bin/true", timeout_seconds: 5 }) },
    { op: "service.status", input: (target: string) => ({ operation: "service.status" as const, node_uid: target, service_key: "testsvc", timeout_seconds: 5 }) },
    { op: "service.restart", input: (target: string) => ({ operation: "service.restart" as const, node_uid: target, service_key: "testsvc", timeout_seconds: 5 }) },
    { op: "job.rpc", input: (target: string) => ({ operation: "job.rpc" as const, node_uid: target, job: { action: "status" as const, handle: "fj1-" + "e".repeat(64), generation: "f".repeat(32) }, timeout_seconds: 5 }) },
    { op: "session.rpc", input: (target: string) => ({ operation: "session.rpc" as const, node_uid: target, session: { action: "status" as const, handle: "fs2-" + "e".repeat(64), generation: "f".repeat(32) }, timeout_seconds: 5 }) },
  ])("allows central actor to control allowed target across all lanes: $op", async ({ input }) => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "central-operator", scopes: ["fleet.read", "fleet.operate", "fleet.exec"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(env, actor, input(node1), backend);
    expect(receipt.outcome).toBe("SUCCEEDED");
    expect(calls.connect).toBe(1);
    expect(calls.execute).toBe(1);
  });

  it("managed-only node remains remotely controllable by authorized central/controller actor", async () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "edge-controller", scopes: ["fleet.read"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(
      env,
      actor,
      { operation: "node.inspect", node_uid: node2, observation: "identity", timeout_seconds: 5 },
      backend,
    );
    expect(receipt.outcome).toBe("SUCCEEDED");
    expect(calls.connect).toBe(1);
    expect(calls.execute).toBe(1);
  });

  it.each([
    { op: "node.inspect", input: (target: string) => ({ operation: "node.inspect" as const, node_uid: target, observation: "identity" as const, timeout_seconds: 5 }) },
    { op: "shell.exec", input: (target: string) => ({ operation: "shell.exec" as const, node_uid: target, command: "/usr/bin/true", timeout_seconds: 5 }) },
    { op: "service.status", input: (target: string) => ({ operation: "service.status" as const, node_uid: target, service_key: "testsvc", timeout_seconds: 5 }) },
    { op: "service.restart", input: (target: string) => ({ operation: "service.restart" as const, node_uid: target, service_key: "testsvc", timeout_seconds: 5 }) },
    { op: "job.rpc", input: (target: string) => ({ operation: "job.rpc" as const, node_uid: target, job: { action: "status" as const, handle: "fj1-" + "e".repeat(64), generation: "f".repeat(32) }, timeout_seconds: 5 }) },
    { op: "session.rpc", input: (target: string) => ({ operation: "session.rpc" as const, node_uid: target, session: { action: "status" as const, handle: "fs2-" + "e".repeat(64), generation: "f".repeat(32) }, timeout_seconds: 5 }) },
  ])("denies managed-only origin caller with ZERO connect/execute across all lanes: $op", async ({ input }) => {
    const env = makeFullEnv("enforced");
    // Managed actor claims all scopes including exec and privileged
    const actor: ControlActor = { userId: "managed-actor", scopes: ["fleet.read", "fleet.operate", "fleet.exec", "fleet.privileged"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(env, actor, input(node2), backend);
    expect(receipt.outcome).toBe("NOT_DISPATCHED");
    expect(receipt.error).toBe("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
    expect(calls.connect).toBe(0);
    expect(calls.execute).toBe(0);
  });

  it("denies managed-only origin attempting cross-node control with ZERO connect/execute", async () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "managed-actor", scopes: ["fleet.read", "fleet.exec"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(
      env,
      actor,
      { operation: "node.inspect", node_uid: node3, observation: "identity", timeout_seconds: 5 },
      backend,
    );
    expect(receipt.outcome).toBe("NOT_DISPATCHED");
    expect(receipt.error).toBe("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
    expect(calls.connect).toBe(0);
    expect(calls.execute).toBe(0);
  });

  it("denies controller calling wrong destination (not in allowed_targets) with zero contact", async () => {
    const env = makeFullEnv("enforced");
    // edge-controller is only allowed node2, targeting node3
    const actor: ControlActor = { userId: "edge-controller", scopes: ["fleet.read"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(
      env,
      actor,
      { operation: "node.inspect", node_uid: node3, observation: "identity", timeout_seconds: 5 },
      backend,
    );
    expect(receipt.outcome).toBe("NOT_DISPATCHED");
    expect(receipt.error).toBe("TOPOLOGY_TARGET_NOT_ALLOWED");
    expect(calls.connect).toBe(0);
    expect(calls.execute).toBe(0);
  });

  it("denies controller with empty allowed_targets from controlling any node", async () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "empty-controller", scopes: ["fleet.read"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(
      env,
      actor,
      { operation: "node.inspect", node_uid: node4, observation: "identity", timeout_seconds: 5 },
      backend,
    );
    expect(receipt.outcome).toBe("NOT_DISPATCHED");
    expect(receipt.error).toBe("TOPOLOGY_TARGET_NOT_ALLOWED");
    expect(calls.connect).toBe(0);
    expect(calls.execute).toBe(0);
  });

  it("denies unknown actor with zero contact", async () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "unbound-user", scopes: ["fleet.read"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(
      env,
      actor,
      { operation: "node.inspect", node_uid: node1, observation: "identity", timeout_seconds: 5 },
      backend,
    );
    expect(receipt.outcome).toBe("NOT_DISPATCHED");
    expect(receipt.error).toBe("TOPOLOGY_ACTOR_NOT_BOUND");
    expect(calls.connect).toBe(0);
    expect(calls.execute).toBe(0);
  });

  it("ignores caller role/origin claims and rejects before reading controller custody", async () => {
    const env = makeFullEnv("enforced");
    const keyRead = vi.fn(() => { throw new Error("CUSTODY_MUST_NOT_BE_READ"); });
    Object.defineProperty(env, "CONTROL_SSH_PRIVATE_KEY", { get: keyRead });
    const actor = {
      userId: "managed-actor", scopes: ["fleet.exec", "fleet.privileged"], authKind: "oauth" as const,
      role: "CONTROLLER_CAPABLE", origin_node_uid: node1, execution_privilege: "administrator",
    };
    const input = {
      operation: "shell.exec" as const, node_uid: node3, command: "/usr/bin/true", timeout_seconds: 5,
      origin_node_uid: node1, role: "CONTROLLER_CAPABLE", userId: "central-operator",
    };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(env, actor, input, backend);
    expect(receipt.error).toBe("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
    expect(receipt.outcome).toBe("NOT_DISPATCHED");
    expect(keyRead).not.toHaveBeenCalled();
    expect(calls).toEqual({ connect: 0, execute: 0 });
  });

  it.each([
    { action: "job.start", operation: "job.rpc" as const, job: { action: "start" as const, operation_id: "oj1-1700000000000-00000000-0000-4000-8000-000000000001", argv: ["/usr/bin/true"], runtime_seconds: 1 } },
    { action: "job.cancel", operation: "job.rpc" as const, job: { action: "cancel" as const, handle: "fj1-" + "e".repeat(64), generation: "f".repeat(32) } },
    { action: "session.create", operation: "session.rpc" as const, session: { action: "create" as const, operation_id: "os1-1700000000000-00000000-0000-4000-8000-000000000001", argv: ["/usr/bin/true"], cwd_profile: "home" as const, rows: 24, cols: 80, runtime_seconds: 1 } },
    { action: "session.input", operation: "session.rpc" as const, session: { action: "input" as const, handle: "fs2-" + "e".repeat(64), generation: "f".repeat(32), input_seq: 1, text: "exit", control_keys: [] } },
    { action: "session.close", operation: "session.rpc" as const, session: { action: "close" as const, handle: "fs2-" + "e".repeat(64), generation: "f".repeat(32), confirm: true as const } },
  ])("denies managed-only job/session mutations before dispatch: $action", async (request) => {
    const { action: _label, ...input } = request;
    const actor: ControlActor = { userId: "managed-actor", scopes: ["fleet.exec"], authKind: "oauth" };
    const { backend, calls } = makeSpyBackend();
    const receipt = await runControlOperation(makeFullEnv("enforced"), actor, { ...input, node_uid: node3, timeout_seconds: 5 }, backend);
    expect(receipt.error).toBe("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
    expect(receipt.outcome).toBe("NOT_DISPATCHED");
    expect(calls).toEqual({ connect: 0, execute: 0 });
  });

  it("preserves UNKNOWN/reconcile behavior when dispatch begins on authorized operation", async () => {
    const env = makeFullEnv("enforced");
    const actor: ControlActor = { userId: "central-operator", scopes: ["fleet.exec"], authKind: "oauth" };
    const backend = createNativeBackend({
      connect: async () => ({ close: async () => {}, closed: Promise.resolve() } as never),
      execute: async () => {
        throw new SshExecutionError("SYNTHETIC_TIMEOUT", "MAY_HAVE_EXECUTED");
      },
    });
    const receipt = await runControlOperation(
      env,
      actor,
      { operation: "shell.exec", node_uid: node1, command: "/usr/bin/false", timeout_seconds: 5 },
      backend,
    );
    expect(receipt.outcome).toBe("UNKNOWN");
    expect(receipt.error).toBe("SYNTHETIC_TIMEOUT");
    expect(receipt.reconcile_required).toBe(true);
    expect(receipt.retry_safe).toBe(false);
  });

  it("does not switch actor identity during the asynchronous receipt hash", async () => {
    const actor: ControlActor = { userId: "managed-actor", scopes: ["fleet.exec"], authKind: "oauth" };
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce((algorithm, bytes) => {
      actor.userId = "central-operator";
      actor.scopes.push("fleet.privileged");
      return realDigest(algorithm, bytes);
    });
    const { backend, calls } = makeSpyBackend();
    try {
      const result = await runControlOperation(makeFullEnv("enforced"), actor, {
        operation: "shell.exec", node_uid: node3, command: "/usr/bin/true", timeout_seconds: 5,
      }, backend);
      expect(result.error).toBe("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
      expect(result.outcome).toBe("NOT_DISPATCHED");
      expect(calls).toEqual({ connect: 0, execute: 0 });
    } finally { digestSpy.mockRestore(); }
  });

  it("keeps the requested target and command stable while caller input changes", async () => {
    const actor: ControlActor = { userId: "edge-controller", scopes: ["fleet.exec"], authKind: "oauth" };
    const input = { operation: "shell.exec" as const, node_uid: node2, command: "/usr/bin/true", timeout_seconds: 5 };
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce((algorithm, bytes) => {
      input.node_uid = node3;
      input.command = "/usr/bin/false";
      return realDigest(algorithm, bytes);
    });
    const connect = vi.fn<OperationDependencies["connect"]>(async () => ({ close: async () => {}, closed: Promise.resolve() }) as never);
    const execute = vi.fn<OperationDependencies["execute"]>(async () => ({ exit_code: 0, stdout: "synthetic", stderr: "", truncated: false }));
    try {
      const receipt = await runControlOperation(makeFullEnv("enforced"), actor, input, createNativeBackend({ connect, execute }));
      expect(receipt.outcome).toBe("SUCCEEDED");
      expect(receipt.node_uid).toBe(node2);
      expect(connect.mock.calls[0]?.[1]).toBe(node2);
      expect(execute.mock.calls[0]?.[3]).toBe("/usr/bin/true");
    } finally { digestSpy.mockRestore(); }
  });
});

describe("runPrivilegedOperation Topology Enforcement", () => {
  const genHex = "d".repeat(64);
  const profileDigest = "sha256:" + "e".repeat(64);

  function makePrivEnv(topologyMode?: string): PrivilegedRuntimeEnv {
    const env = makeFullEnv(topologyMode);
    return {
      ...env,
      CONTROL_PRIVILEGED_USERNAME: "ops_priv",
      CONTROL_PRIVILEGED_SSH_PRIVATE_KEY: "synthetic-privileged-ssh-key-distinct-identity",
      CONTROL_PRIVILEGED_TARGETS_JSON: JSON.stringify({
        [node1]: { username: "ops_priv", transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:BBBB" },
        [node2]: { username: "ops_priv", transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:BBBB" },
        [node3]: { username: "ops_priv", transport_mode: "local_ssh", ssh_host_key_algorithm: "ssh-ed25519", ssh_host_key_sha256: "SHA256:BBBB" },
      }),
      CONTROL_PRIVILEGED_POLICY_JSON: JSON.stringify({
        [node1]: { protocol: "youling-fleet-privileged-operations/v3", generation: genHex, profile_generation: profileDigest, operations: ["root-probe"] },
        [node2]: { protocol: "youling-fleet-privileged-operations/v3", generation: genHex, profile_generation: profileDigest, operations: ["root-probe"] },
        [node3]: { protocol: "youling-fleet-privileged-operations/v3", generation: genHex, profile_generation: profileDigest, operations: ["root-probe"] },
      }),
    };
  }

  function makePrivSpyBackend(actorRef: string) {
    const calls = { connect: 0, execute: 0 };
    const backend = {
      connect: async () => {
        calls.connect++;
        return { close: async () => {}, closed: Promise.resolve() } as never;
      },
      execute: async (_s: unknown, _t: unknown, _k: unknown, _cmd: unknown, options: { stdin?: string }) => {
        calls.execute++;
        const parsedStdin = JSON.parse(options.stdin ?? "{}");
        const request = {
          schema: "youling-fleet-privileged-operations/v3" as const,
          node_uid: parsedStdin.node_uid,
          request_id: parsedStdin.request_id,
          actor_ref: actorRef,
          generation: genHex,
          profile_generation: profileDigest,
          operation: "root-probe" as const,
          vendor_ids: [],
        };
        const digest = await canonicalRequestDigest(request);
        const receipt = {
          ...request,
          request_digest: digest,
          state: "SUCCEEDED",
          result: {
            ok: true,
            changed: false,
            duplicate: false,
            execution_privilege: "root",
            schema: "youling-fleet-privileged-operations/v3",
            request_id: parsedStdin.request_id,
            actor_ref: actorRef,
            node_uid: parsedStdin.node_uid,
            operation: "root-probe",
            generation: genHex,
            profile_generation: profileDigest,
          },
        };
        return { exit_code: 0, stdout: JSON.stringify(receipt), stderr: "", truncated: false };
      },
    };
    return { backend, calls };
  }

  async function getActorRef(actor: ControlActor): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(actor.authKind + ":" + actor.userId));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  it.each(["execute", "status"] as const)(
    "allows central actor on allowed target for privileged action: %s",
    async (action) => {
      const env = makePrivEnv("enforced");
      const actor: ControlActor = { userId: "central-operator", scopes: ["fleet.privileged"], authKind: "oauth" };
      const actorRef = await getActorRef(actor);
      const { backend, calls } = makePrivSpyBackend(actorRef);
      const input: PrivilegedInput = {
        action,
        node_uid: node1,
        request_id: "req.test.priv.1",
        operation: "root-probe",
        vendor_ids: [],
        generation: genHex,
        profile_generation: profileDigest,
      };
      const res = await runPrivilegedOperation(env, actor, input, backend);
      expect(res.outcome).toBe("SUCCEEDED");
      expect(calls.connect).toBe(1);
      expect(calls.execute).toBe(1);
    },
  );

  it.each(["execute", "status"] as const)(
    "denies managed-only origin caller with ZERO connect/execute for privileged action: %s",
    async (action) => {
      const env = makePrivEnv("enforced");
      const actor: ControlActor = { userId: "managed-actor", scopes: ["fleet.privileged"], authKind: "oauth" };
      const actorRef = await getActorRef(actor);
      const { backend, calls } = makePrivSpyBackend(actorRef);
      const input: PrivilegedInput = {
        action,
        node_uid: node2,
        request_id: "req.test.priv.2",
        operation: "root-probe",
        vendor_ids: [],
        generation: genHex,
        profile_generation: profileDigest,
      };
      const res = await runPrivilegedOperation(env, actor, input, backend);
      expect(res.outcome).toBe("NOT_DISPATCHED");
      expect(res.error).toBe("TOPOLOGY_ORIGIN_NOT_CONTROLLER");
      expect(calls.connect).toBe(0);
      expect(calls.execute).toBe(0);
    },
  );

  it.each(["execute", "status"] as const)(
    "denies target not in allowed targets for privileged action: %s",
    async (action) => {
      const env = makePrivEnv("enforced");
      // edge-controller only allowed node2, targeting node3
      const actor: ControlActor = { userId: "edge-controller", scopes: ["fleet.privileged"], authKind: "oauth" };
      const actorRef = await getActorRef(actor);
      const { backend, calls } = makePrivSpyBackend(actorRef);
      const input: PrivilegedInput = {
        action,
        node_uid: node3,
        request_id: "req.test.priv.3",
        operation: "root-probe",
        vendor_ids: [],
        generation: genHex,
        profile_generation: profileDigest,
      };
      const res = await runPrivilegedOperation(env, actor, input, backend);
      expect(res.outcome).toBe("NOT_DISPATCHED");
      expect(res.error).toBe("TOPOLOGY_TARGET_NOT_ALLOWED");
      expect(calls.connect).toBe(0);
      expect(calls.execute).toBe(0);
    },
  );

  it("denies privileged operation when expected source is missing or mismatched", async () => {
    const env = makePrivEnv("enforced");
    delete (env as { CONTROL_POLICY_SOURCE_REPOSITORY?: string }).CONTROL_POLICY_SOURCE_REPOSITORY;
    const actor: ControlActor = { userId: "central-operator", scopes: ["fleet.privileged"], authKind: "oauth" };
    const actorRef = await getActorRef(actor);
    const { backend, calls } = makePrivSpyBackend(actorRef);
    const input: PrivilegedInput = {
      action: "execute",
      node_uid: node1,
      request_id: "req.test.priv.4",
      operation: "root-probe",
      vendor_ids: [],
      generation: genHex,
      profile_generation: profileDigest,
    };
    const res = await runPrivilegedOperation(env, actor, input, backend);
    expect(res.outcome).toBe("NOT_DISPATCHED");
    expect(res.error).toBe("CONTROL_SOURCE_NOT_CONFIGURED");
    expect(calls.connect).toBe(0);
    expect(calls.execute).toBe(0);
  });
});
