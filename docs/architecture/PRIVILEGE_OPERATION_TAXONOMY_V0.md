# 权限操作分类 v0 / Privilege Operation Taxonomy v0

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:classification -->
### 分类原则

风险类别是 canonical operation registry 的**下限**，不是 Agent 自报值。最终 derived risk 可因 scope、持久化影响、identity/secret involvement、TTL/max-use 或 recovery 缺口上调，但不能下调。

### LOW — observation

示例：`node.inspect`、`service.status.read`、`storage.status.read`。

若普通 agent 权限可完成，不进入 Privilege Broker；只有确实需要 OS privilege 时才申请 lease。

### MEDIUM — bounded reversible state change

示例：`service.restart`、`config.reload`、受限 cache cleanup。

要求 exact target、before/after receipt，以及 operation policy 要求的 recovery。

### HIGH — privileged infrastructure change

示例：`package.install`、`systemd.unit.create`、`firewall.rule.modify`、持久 mount 配置。

默认：显式 request、bounded lease、Human required，除非 canonical policy 对特定 operation 明确允许更窄的自动化路径。

### CRITICAL — identity/security boundary

示例：`credential.rotate`、`identity.authorize`、SSH authorization、secret materialization、trust-root change。

默认：Human required、one-shot lease、enhanced receipt；永不 AUTO_APPROVE。

<!-- topic:recovery -->
### Recovery 分类

每个 operation registry entry 必须声明：

```text
NONE | ROLLBACK | COMPENSATING | IRREVERSIBLE
```

- `ROLLBACK`：可恢复 prior state；
- `COMPENSATING`：不能复原，但有明确恢复/补偿动作；
- `IRREVERSIBLE`：只能在 policy 允许且 Human 明确认知后执行；
- 缺少 policy 要求的 plan/ref -> `REJECT`。

<!-- topic:forbidden -->
### Generic helper 禁止面

v0 不提供：arbitrary shell、unrestricted sudo/root shell、credential export、与 intent 无关的 private-data read、security bypass、未注册 typed contract 的 identity mutation。

<!-- topic:derivation -->
### Policy derivation

Agent 问的是“完成 intent 需要哪个 typed capability”，不是“如何拿 root”。Policy Engine 以 operation registry 为 authority source，再叠加 scope/impact/recovery/deployment policy，得到 derived risk 与 approval requirement。

## English

<!-- topic:classification -->
### Classification

Risk classes are canonical operation-policy floors, not caller-controlled values. Derived risk may increase with scope, persistence, identity/secret involvement, lease bounds, or recovery constraints, but cannot be lowered by the requester.

LOW observations bypass the broker when ordinary permissions suffice. MEDIUM covers bounded reversible changes. HIGH covers privileged infrastructure changes. CRITICAL covers identity/security boundaries and is never auto-approved.

<!-- topic:recovery -->
### Recovery

Each registered operation declares `NONE | ROLLBACK | COMPENSATING | IRREVERSIBLE`. Missing a required recovery plan causes rejection rather than a mere risk bump.

<!-- topic:forbidden -->
### Forbidden generic operations

No arbitrary shell, unrestricted sudo/root shell, credential export, unrelated private-data access, security bypass, or unregistered identity mutation.

<!-- topic:derivation -->
### Derivation

Agents request typed capabilities. Policy derives authority requirements from the operation registry plus scope, impact, recovery, and deployment constraints.
