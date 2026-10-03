# GhostFleet V0 Implementation Plan

status: `IN_PROGRESS`

## 中文版

### Phase 0 — 架构冻结

- `fleet#289` 作为来源；
- 公共仓库 `docs/ARCHITECTURE.md` 作为实现基线；
- 不再开平行 GhostFleet 架构工单。

### Phase 1 — Core vertical slice

- EnrollmentAttempt state machine；
- HumanGate；
- Evidence contract；
- Node admission；
- Capability Registry metadata；
- Event stream；
- public-safe payload guard。

验收：Node deterministic tests 全部 PASS。

### Phase 2 — Control Plane

- typed HTTP API；
- serializable store；
- Cloudflare Durable Object reference adapter；
- ambiguous outcome → reconcile state。

验收：HTTP contract tests PASS；控制平面重载后 state 可由 store snapshot 恢复。

### Phase 3 — Console

- 单入口；
- Nodes / Enrollment / Human Gates / Capabilities / Events；
- Tabler UI shell；
- 浏览器不处理 provider root credential。

### Phase 4 — AI surface

- read-only MCP inspection tools；
- mutation interface 只定义 adapter/policy contract，不在 core 内暴露万能执行接口。

### Phase 5 — Linux live canary

把现有私有 Fleet Linux 能力按公共 adapter contract 接入，并使用真实测试节点验证：

- canonical launcher；
- enrollment state 全程可见；
- evidence 完整；
- zero-delta repeat；
- reboot recovery；
- admission 后 Console/API/MCP 看到同一 NodeIdentity。

### Phase 6 — independent second canary

使用与首个 canary 不同的机器/重建路径证明 GhostFleet 不依赖临时调试通道或某一台 builder。

### Phase 7 — Windows / Android adapters

保持相同 core contract，只实现平台 adapter，不复制生命周期。

### Release gates

- test/CI PASS；
- live Linux canary PASS；
- independent second canary PASS；
- public/private provenance review；
- security review；
- OSS license 已按 Human 选择冻结为 AGPL-3.0-only；
- third-party notices 完整。

---

## English Version

### Phase 0 — Architecture freeze

- `fleet#289` remains the architecture source;
- public `docs/ARCHITECTURE.md` is the implementation baseline;
- no parallel GhostFleet architecture issue.

### Phase 1 — Core vertical slice

- EnrollmentAttempt state machine;
- HumanGate;
- Evidence contract;
- Node admission;
- Capability Registry metadata;
- Event stream;
- public-safe payload guard.

Acceptance: deterministic Node tests pass.

### Phase 2 — Control Plane

- typed HTTP API;
- serializable store;
- Cloudflare Durable Object reference adapter;
- ambiguous outcome becomes reconcile state.

Acceptance: HTTP contract tests pass and state can be restored from the store snapshot.

### Phase 3 — Console

- one entry point;
- Nodes / Enrollment / Human Gates / Capabilities / Events;
- Tabler UI shell;
- browser never handles provider root credentials.

### Phase 4 — AI surface

- read-only MCP inspection tools;
- mutation remains behind adapter/policy contracts rather than a universal execution primitive in core.

### Phase 5 — Linux live canary

Extract the existing private Fleet Linux capability behind the public adapter contract and prove canonical launch, visible lifecycle, complete evidence, zero-delta repeat, reboot recovery, and a single consistent NodeIdentity across Console/API/MCP.

### Phase 6 — Independent second canary

Use a different machine/rebuild path to prove GhostFleet does not depend on a temporary debug channel or a particular builder node.

### Phase 7 — Windows / Android adapters

Implement platform adapters under the same core contract; do not fork lifecycle semantics.

### Release gates

- tests/CI PASS;
- live Linux canary PASS;
- independent second canary PASS;
- public/private provenance review;
- security review;
- OSS license frozen as AGPL-3.0-only by the owner;
- complete third-party notices.
