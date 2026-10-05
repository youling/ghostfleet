# Privilege Policy Engine v0 / 权限策略引擎 v0

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:inputs -->
### 输入

Policy Engine 接收已经规范化的 `PrivilegeRequest` 与 canonical operation registry。请求方可以表达 intent、operation、scope、TTL/recovery proposal，但**不能通过自报 `risk` 降低策略结果**。

Canonical operation policy 至少定义：

```yaml
operation_id: systemd.unit.create
risk_floor: HIGH
auto_approvable: false
max_ttl_seconds: 900
max_uses: 1
allowed_scope_types:
  - service
recovery_requirement: ROLLBACK
```

<!-- topic:decision -->
### 决策

v0 只有三个 authority-relevant outcome：

```text
AUTO_APPROVE
HUMAN_REQUIRED
REJECT
```

Policy Engine 输出 `PolicyDecision`，**不直接等价 PrivilegeLease**。Lease issuer 必须在满足 decision/approval/currentness 后另行签发 lease。

<!-- topic:risk -->
### 风险推导

最终风险至少取以下事实的上界：

- operation registry 的 `risk_floor`；
- scope 扩大程度；
- 是否修改持久状态；
- 是否涉及 identity / credential / secret / trust boundary；
- recovery 可用性；
- lease TTL / max uses；
- deployment policy 的更严格约束。

Caller-provided label 只能作为非权威 hint，不能降低 derived risk。

LOW observation 若普通 agent 权限已经可完成，直接走现有只读 capability，不需要 Privilege Broker。只有跨越 OS privilege boundary 时才签发 lease。

<!-- topic:recovery -->
### Recovery 语义

```text
NONE          — observation / 无需恢复
ROLLBACK      — 可回退到 prior state
COMPENSATING  — 不能恢复原状态，但有明确补偿/恢复路径
IRREVERSIBLE  — 无可接受恢复路径，必须 Human 明确认知并由 policy 允许
```

如果 operation policy 要求 `ROLLBACK` 或 `COMPENSATING` 而请求缺少对应 plan/evidence ref，结果直接 `REJECT`；不能仅“升一级风险”后放行。

`IRREVERSIBLE` 永不 AUTO_APPROVE。

<!-- topic:invariants -->
### 不变量

- capability，不是 shell；
- unknown operation -> `REJECT`；
- auto approval 只允许 operation registry 明确标记的 bounded operation；
- Human approval 绑定 normalized request digest；
- approval 不转移 secret custody；
- lease 过期/撤销/漂移后不可复用；
- production/deployment gate 不从 policy decision 自动继承。

## English

<!-- topic:inputs -->
### Inputs

The engine evaluates normalized requests against a canonical operation registry. Caller-provided risk is non-authoritative and cannot lower policy results.

<!-- topic:decision -->
### Decisions

v0 outcomes are `AUTO_APPROVE | HUMAN_REQUIRED | REJECT`. A `PolicyDecision` is not itself a lease; issuance happens only after all decision, approval, and currentness requirements are satisfied.

<!-- topic:risk -->
### Risk derivation

Derived risk is the upper bound of operation risk floor, scope, persistent impact, identity/credential/secret/trust-boundary involvement, recovery availability, requested lease bounds, and stricter deployment policy. Unprivileged observations bypass the broker when ordinary read capabilities already suffice.

<!-- topic:recovery -->
### Recovery

Recovery is explicit as `NONE | ROLLBACK | COMPENSATING | IRREVERSIBLE`. Missing required rollback/compensating plans causes `REJECT`. Irreversible actions are never auto-approved.

<!-- topic:invariants -->
### Invariants

Unknown operations fail closed; auto approval is registry-controlled; Human approval binds an exact digest; secret custody remains deployment-owned; stale/expired authority is unusable; policy approval never implies production deployment authority.
