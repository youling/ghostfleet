# GhostFleet V0 Implementation Plan

status: `IN_PROGRESS`

## 中文版

<!-- topic:reference -->



### Phase 0 — 架构冻结

- `fleet#289` 作为来源；
- 公共仓库 `docs/ARCHITECTURE.md` 作为实现基线；
- 不再开平行 GhostFleet 架构工单。

### Phase 1 — Core vertical slice

- EnrollmentAttempt 状态 machine；
- HumanGate；
- Evidence contract；
- Node 准入；
- Capability Registry 元数据；
- Event stream；
- 公开-safe payload guard。

验收：Node deterministic tests 全部 PASS。

### Phase 2 — Control Plane

- typed HTTP API；
- serializable store；
- Cloudflare Durable Object reference adapter；
- ambiguous outcome → 对账 状态。

验收：HTTP contract tests PASS；控制平面重载后 状态 可由 store snapshot 恢复。

### Phase 3 — Console

- 单入口；
- Nodes / Enrollment / Human Gates / Capabilities / Events；
- Tabler UI shell；
- 浏览器不处理 提供方 root 凭据。

### Phase 4 — AI surface

- 读取-only MCP inspection tools；
- 变更 interface 只定义 adapter/策略 contract，不在 core 内暴露万能执行接口。

### Phase 5 — Linux live canary

把现有私有 Fleet Linux 能力按公共 adapter contract 接入，并使用真实测试节点验证：

- canonical launcher；
- enrollment 状态 全程可见；
- 证据 完整；
- zero-delta repeat；
- reboot 恢复；
- 准入 后 Console/API/MCP 看到同一 NodeIdentity。

### Phase 6 — independent second canary

使用与首个 canary 不同的机器/重建路径证明 GhostFleet 不依赖临时调试通道或某一台 builder。

### Phase 7 — Windows / Android adapters

保持相同 core contract，只实现平台 adapter，不复制生命周期。

### Release gates

- 测试/CI PASS；
- live Linux canary PASS；
- independent second canary PASS；
- 公开/私有 provenance 审阅；
- security 审阅；
- OSS license 已按 Human 选择冻结为 AGPL-3.0-only；
- third-party notices 完整。

---


### 当前 source-preview 与可选模块

Publiccandidate包含typed-control、bootstrap、Pythonplatformruntime与显式authorizationbuildingblocks；具体entry/components/tests见[exportmanifest](export-manifest.json)。默认MCP四只读工具、Console生命周期对象管理不启用设备executionbackend。生产OAuth/Pagehosting/第二independenthardware不由源码搬迁完成。Core/API/permission与标准AIclient无关，不需OpenAI/ChatGPTconfig；专有profile/redirect/actor/scope只optional并保持exactbinding。细节见[操作参考](OPERATIONS.md)、[授权机制](AUTHORIZATION.md)、[迁移](MIGRATION.md)。

## English Version

<!-- topic:reference -->



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


### Current source preview and optional modules

The public candidate includes typed control, bootstrap, Python platform runtimes and explicit authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are standard AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).
