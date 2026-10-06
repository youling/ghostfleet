# Privilege Broker Runtime v0 / 权限代理运行时 v0

## 中文

本包实现 ADR 003 的纯运行时语义，不拥有 transport、OS root、provider 或生产 signing custody。

机器可判链路：

```text
PrivilegeRequest
  -> PolicyDecision
  -> optional HumanApprovalRecord
  -> PrivilegeLease
  -> Lease validation
  -> EffectFence
  -> PrivilegeReceipt
  -> append-only AuditLedger
```

不变量：

- caller risk 非权威；
- unknown operation fail closed；
- required recovery 缺失即 REJECT；
- Human approval 绑定 exact normalized request digest；
- transport session 不能替代 lease；
- lease 必须绑定 node / subject / audience / policy revision / TTL / max-use；
- revoked / expired / stale / wrong-target lease DENY；
- effect fence 防重放；
- uncertain side effect 进入 RECONCILE_REQUIRED；
- break-glass 不是普通 Agent fallback；
- credential classes 不得静默合并；
- synthetic signer 仅用于测试，不能描述为 production custody。

## English

This package implements provider-neutral, OS-neutral ADR 003 runtime semantics only. It does not own transport, root execution, provider mutation or production signing custody. Caller risk is non-authoritative, unknown operations fail closed, approvals bind exact normalized digests, leases are bounded/currentness-checked, effect fences prevent replay, uncertain effects reconcile, break-glass stays outside ordinary Agent authority, and credential classes cannot silently collapse.
