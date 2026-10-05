# GhostFleet V0 Implementation Plan

status: `IN_PROGRESS`

## 中文版

<!-- topic:reference -->



### 阶段 0 — 架构冻结

- `fleet#289` 作为来源；
- 公共仓库 `docs/ARCHITECTURE.md` 作为实现基线；
- 不再开平行 GhostFleet 架构工单。

### 阶段 1 — 核心端到端实现

- `EnrollmentAttempt` 状态机；
- 人工审批（`HumanGate`）；
- 证据契约；
- 节点准入；
- 能力目录元数据；
- 事件流；
- 公开载荷安全检查。

验收：Node.js 确定性测试全部通过。

### 阶段 2 — 控制平面

- 类型化 HTTP API；
- 可序列化存储；
- Cloudflare Durable Object 参考适配器；
- 不确定结果进入对账状态。

验收：HTTP 契约测试通过，控制平面重载后可从存储快照恢复状态。

### 阶段 3 — Console

- 单入口；
- 节点、注册、人工审批、能力和事件页面；
- Tabler 界面框架；
- 浏览器不处理提供方根凭据。

### 阶段 4 — AI 接入

- 只读 MCP 检查工具；
- 变更接口通过适配器及策略契约约束，不在核心内暴露万能执行入口。

### 阶段 5 — Linux 真机单节点验证

把现有 Linux 能力按公开适配器契约接入，并使用真实测试节点验证：

- 统一启动入口（canonical launcher）；
- 注册状态全程可见；
- 证据完整；
- 重复执行无额外变更（zero-delta repeat）；
- 重启恢复；
- 准入后 Console、API 和 MCP 看到同一 `NodeIdentity`。

### 阶段 6 — 第二台独立设备验证

使用与首次单节点验证不同的机器及重建路径，证明 GhostFleet 不依赖临时调试通道或某一台构建节点。

### 阶段 7 — Windows / Android 适配器

保持同一核心契约，只实现平台适配器，不复制生命周期语义。

### 发布验收条件

- 测试及 CI 通过；
- Linux 真机单节点验证通过；
- 第二台独立设备验证通过；
- 公开及受控私有来源审查；
- 安全审查；
- 开源许可已按所有者选择冻结为 `AGPL-3.0-only`；
- 第三方说明完整。

---


### 当前公开源码与可选模块

公开源码已合并至默认分支 `main`，包含 `typed-control`、`bootstrap`、Python 平台运行时及显式启用的授权机制；具体入口、组件和测试见 [导出清单](export-manifest.json)。可选包仍处于源码开发阶段，尚未正式发布到 npm 或 PyPI。默认 MCP 的四个只读工具与 Console 生命周期对象管理不启用设备执行后端。生产 OAuth、Pages 托管及第二台独立硬件验证不因源码迁移而完成。核心、API 与权限模型不依赖特定 AI 客户端，不需要 OpenAI 或 ChatGPT 配置；专有客户端的配置档案、重定向地址、调用者与权限范围仅属于可选兼容路径，并保持精确绑定。细节见 [操作参考](OPERATIONS.md)、[授权机制](AUTHORIZATION.md) 与 [迁移](MIGRATION.md)。

核心 `ACTIVE` 状态和七类准入证据只证明本控制面的身份准入及注册目录投影。每个独立消费者仍须复用现有身份，分别验收目录注册与可发现性、鉴权和配置、实际调用路由、正向与越权拒绝、身份回读及回滚。完整端到端验收以节点在该实际消费者中可发现、可使用为准；不能通过新增注册或身份、扩大权限来补目录缺口。

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

Integrate existing Linux capability behind the public adapter contract and prove canonical launch, visible lifecycle, complete evidence, zero-delta repeat, reboot recovery, and a single consistent NodeIdentity across Console/API/MCP.

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


### Current public source and optional modules

Public source is merged into the default `main` branch and includes typed control, bootstrap, Python platform runtimes and explicit authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. Optional packages remain in source development without formal npm or PyPI publication. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).

Core `ACTIVE` status and seven admission evidence types prove identity admission and its enrollment catalog projection in this control plane only. Each independent consumer must still reuse the existing identity and separately accept catalog registration/discoverability, authentication/configuration, actual call routes, positive and negative authority, identity readback and rollback. Complete end-to-end acceptance requires the node to be discoverable and usable in that actual consumer. Do not create parallel enrollment/identity or expand authority to fill a catalog gap.
