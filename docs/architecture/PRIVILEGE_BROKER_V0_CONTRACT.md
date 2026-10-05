# Privilege Broker v0 Contract / 权限代理 v0 契约

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:request -->
### PrivilegeRequest

`PrivilegeRequest` 表达 intent 与 typed capability 需求，不携带具有权威性的 risk 结论：

```yaml
request_id: request-...
node_uid: node-...
requester_ref: agent/...
intent: human-readable goal
operations:
  - operation_id: typed.operation.name
    scope_ref: resource/...
    parameter_constraints_ref: constraints/...
requested_ttl_seconds: 900
requested_max_uses: 1
recovery:
  mode: ROLLBACK
  plan_ref: rollback/...
```

Policy Engine 将 request 规范化并产生 `normalized_request_digest` 与 `PolicyDecision`。

<!-- topic:decision -->
### PolicyDecision

```yaml
policy_decision_id: policy-decision-...
normalized_request_digest: sha256:...
policy_revision: policy/...
derived_risk: HIGH
outcome: AUTO_APPROVE|HUMAN_REQUIRED|REJECT
reason_codes: []
lease_bounds:
  ttl_seconds: 900
  max_uses: 1
recovery_requirement: ROLLBACK
```

Policy decision 是可审计判定，不等价 PrivilegeLease。

<!-- topic:lease -->
### PrivilegeLease

Lease 绑定 issuer、subject、audience/helper、node、request digest、policy/approval authority、typed operations/scope、time window、max uses 与 effect-fence。Human path 必须引用 exact digest 的 approval record；AUTO path 必须引用允许自动签发的 policy decision。

Lease 不含 root credential、private key、provider token 或 arbitrary shell authority。

<!-- topic:receipt -->
### PrivilegeReceipt

每次 allow/deny/execute 都必须产生可审计 receipt：

```yaml
receipt_id: receipt-...
lease_id: lease-...
request_id: request-...
operation_id: typed.operation.name
effect_ref: effect-...
result: SUCCESS|DENIED|FAILED|RECONCILE_REQUIRED
before_state_ref: optional
after_state_ref: optional
recovery_ref: optional
```

执行结果可能已产生 side effect 但无法确认时必须 `RECONCILE_REQUIRED`，禁止 blind retry。

<!-- topic:invariants -->
### 不变量

- Agent never becomes root；
- capability != unrestricted authority；
- no recurring Human password transport；
- no Builder/session/chat custody of privileged secrets；
- Human approval binds exact digest；
- policy auto-approval 只作用于 canonical operation registry 明确允许的 bounded operation；
- deployment/production authority 不从 lease 自动继承。

## English

<!-- topic:request -->
### PrivilegeRequest

Requests express intent, typed operations, scope, lease bounds, and recovery proposals. Caller risk is non-authoritative. Policy normalization produces an exact request digest.

<!-- topic:decision -->
### PolicyDecision

Policy returns `AUTO_APPROVE | HUMAN_REQUIRED | REJECT`, derived risk, reason codes, lease bounds, recovery requirements, and policy revision. A decision is auditable but is not itself a lease.

<!-- topic:lease -->
### PrivilegeLease

A lease binds issuer, subject, helper audience, node, normalized request digest, policy/approval authority, typed operations/scope, validity, use limits, and effect fences. It contains no root credential, private key, provider token, or arbitrary shell capability.

<!-- topic:receipt -->
### PrivilegeReceipt

Every accepted, denied, failed, or uncertain execution emits a receipt. Uncertain side effects become `RECONCILE_REQUIRED` and cannot be blindly retried.

<!-- topic:invariants -->
### Invariants

Agents do not become root; approval is intent/digest bound; privileged secrets never move into Builder/session/chat custody; auto approval is registry-controlled; lease authority does not imply deployment or production authority.
