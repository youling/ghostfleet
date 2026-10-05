# Privilege Lease Validator v0 / 权限租约验证器 v0

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:lease -->
### Lease 最小语义

`PrivilegeLease` 是短时 capability，不是 root credential。最小字段：

```yaml
schema_version: 1
lease_id: lease-...
issuer_ref: broker/...
subject_ref: agent/...
audience_ref: helper/...
node_uid: node-...
request_id: request-...
normalized_request_digest: sha256:...
policy_decision_ref: policy-decision/...
approval_ref: approval-record/...   # AUTO path 可为空，但必须有可审计 policy authority ref
policy_revision: policy/...
allowed_operations:
  - operation_id: systemd.unit.create
    scope_ref: service/cloudflared
    parameter_constraints_ref: constraints/...
not_before: timestamp
expires_at: timestamp
max_uses: 1
effect_fence_namespace: privilege/...
authenticity_ref: signature-or-equivalent/...
```

Lease 不得携带 secret plaintext、private key、provider token 或 unrestricted shell authority。

<!-- topic:authenticity -->
### Authenticity / authority

Validator 必须确认 lease 来自受信 issuer，且 authenticity 可机器验证；“调用方递交一段自报 JSON”不能成为 authority。具体签名/认证机制由 adapter/deployment 实现，但 public contract 必须保留 issuer/audience/authority binding。

AUTO path 必须绑定允许自动授权的 `PolicyDecision`。HUMAN path 必须绑定与 `normalized_request_digest` 完全一致且仍有效的 Human approval record。

<!-- topic:currentness -->
### Currentness

执行前至少验证：

- `node_uid` 与当前目标一致；
- `subject_ref` 与请求执行者一致；
- `audience_ref` 与当前 helper 一致；
- request digest 未漂移；
- lease 本身未撤销；
- policy revision / authority record 未失效或被撤销；
- 当前时间在 `not_before <= now < expires_at`；
- lease 尚未超过 `max_uses`。

任何 UNKNOWN / missing / stale 条件 fail closed。

<!-- topic:scope -->
### Operation / scope / parameter

Helper 收到的 operation 必须精确出现在 `allowed_operations`，target resource 必须落在 scope 内，参数必须通过该 operation 的 canonical schema 与 constraints。Lease 不能把“允许 service.restart”解释成“允许任意 service command”。

Agent 提供的 risk label 不参与 validator 的 authority 判定。

<!-- topic:replay -->
### Replay / effect fence

每次执行必须带唯一 execution/effect reference。对有副作用操作，v0 默认 `max_uses=1`。

Helper 必须在 side effect 前原子 reserve/consume effect fence，避免 RPC timeout 后同一 mutation 被 blind retry。若 crash/网络中断发生在“可能已产生 effect、但 receipt 未确认”的窗口，结果进入：

```text
RECONCILE_REQUIRED
```

而不是再次执行。

<!-- topic:outcomes -->
### Validator / execution outcomes

- `ALLOW`：所有 precondition PASS，才可进入 typed OS action。
- `DENY`：lease 无效/过期/越界/重放/authority 不匹配；产生 rejection receipt，零 side effect。
- `RECONCILE_REQUIRED`：不是 validator 放行状态，而是 side effect outcome 不确定时的 execution receipt；必须先观测真实状态再决定恢复/续跑。

Receipt 必须绑定 lease、request、operation、effect fence、result，以及可判时的 before/after/recovery evidence refs。

## English

<!-- topic:lease -->
### Lease semantics

A `PrivilegeLease` is a short-lived capability, not a root credential. It binds issuer, subject, audience/helper, node, normalized request digest, policy/approval authority, operations and scope, validity window, use limit, effect-fence namespace, and authenticity proof. It carries no secret plaintext or unrestricted shell authority.

<!-- topic:authenticity -->
### Authenticity and authority

The validator must machine-verify a trusted issuer and lease authenticity. Self-asserted JSON is not authority. Auto approval binds an auditable policy decision; Human-required issuance binds a still-valid approval for the exact normalized request digest.

<!-- topic:currentness -->
### Currentness

Target, subject, audience, digest, lease revocation state, policy/authority revision, time window, currentness, and remaining uses must all match. Missing or unknown facts fail closed.

<!-- topic:scope -->
### Scope and parameters

The requested operation must be explicitly leased, the resource must be inside the bound scope, and parameters must satisfy canonical operation schemas/constraints. Caller-provided risk labels never grant authority.

<!-- topic:replay -->
### Replay and effect fences

Mutating v0 leases default to one use. The helper reserves/consumes a unique effect fence before side effects. If the effect may have happened but the receipt is uncertain, the result is `RECONCILE_REQUIRED`; blind retry is forbidden.

<!-- topic:outcomes -->
### Outcomes

`ALLOW` proceeds to the typed OS action. `DENY` produces a rejection receipt with zero side effects. Uncertain execution effects produce `RECONCILE_REQUIRED` receipts and require state reconciliation before any continuation.
