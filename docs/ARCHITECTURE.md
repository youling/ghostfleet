# GhostFleet Architecture — V0 Baseline

status: `V0_IMPLEMENTATION_BASELINE`
architecture_source: `the deployment-origin implementation#289`

## 中文版

<!-- topic:reference -->



### 1. 产品边界

GhostFleet 是面向 AI Agent 与 Human 的设备舰队生命周期控制平面。核心不是“远程执行命令”，而是让真实设备以明确身份、状态、能力、证据和人工门禁进入可管理生命周期。

~~~text
Human / AI
   |
Console / MCP / API
   |
GhostFleet Control Plane
   |
Provider / Device adapters
   |
Real devices
~~~

### 2. 单入口，多 Domain

Enrollment 和日常管理共享一个 Console 和产品入口，不拆成两个站点。隔离发生在内部 授权/domain 边界：

- Enrollment Domain：新设备入列、临时身份、HumanGate、resume/对账；
- Fleet Domain：NodeIdentity、生命周期、目录投影；
- Capability Domain：能力定义、风险级别、授权引用；
- Event Domain：状态变化、证据和需要人工处理的事件。

UI 不持有 提供方 root 凭据，也不因为“同一个入口”而获得所有内部 授权。

### 3. 一等对象

- `EnrollmentAttempt`：未知物理设备到 durable node 身份 之间的生命周期对象；
- `HumanGate`：人工确认不是聊天上下文，而是持久化状态；
- `Evidence`：每次关键状态迁移的可验证依据；
- `NodeIdentity`：在 MATERIALIZING 建立的稳定 PROVISIONAL 身份，验收后以同一 `node_uid` 晋升 ACTIVE；
- `CapabilityDefinition`：节点或 adapter 能提供什么，而不是 raw 凭据；
- `Event`：控制循环的唤醒和审计事实。

### 4. EnrollmentAttempt 状态机

~~~text
CREATED
  -> PREPARING
  -> WAITING_HUMAN -> CLAIMED
  -> MATERIALIZING
  -> ACCEPTED

CLAIMED / MATERIALIZING
  -> RECONCILE_REQUIRED
  -> CLAIMED or MATERIALIZING

non-terminal
  -> FAILED / CANCELLED
~~~

Lost response 或外部 提供方 结果不确定时进入 `RECONCILE_REQUIRED`，而不是盲目重试或重新 mint。

### 5. 证据驱动 准入

V0 使用 提供方-neutral 证据 类型：

- `transport.ready`
- `bootstrap.report`
- `identity.materialized`
- `catalog.admitted`
- `control.canary`
- `convergence.zero_delta`
- `reboot.recovered`

具体 提供方 事实由 adapter 映射到这些公共 证据 类型。例如某个网络 提供方 的 Running/IP/外部可见性属于 传输 证据，不进入 core 协议成为硬编码依赖。

`materialize` 在控制面创建 PROVISIONAL NodeIdentity 和 enrollment catalog 投影，再从实际存储状态生成 core-owned `identity.materialized` / `catalog.admitted`。目录登记只允许纳管期间观察，不授权日常设备操作。客户端不能提交或覆盖这两项证据；其余五项必须由真实 adapter 观察提供，合成测试不证明真机。`accept` 验证全部证据后晋升同一身份，不能重新 mint。重复 materialize、durable reload 和 对账 保留同一身份；重复 materialize 不产生 material delta。

### 6. Capability 模型

Capability 是“受控能力声明”，不是 凭据。定义至少包含：

- 能力 id；
- 风险级别 R0/R1/R2；
- adapter contract；
- 可选 策略 元数据。

高权限设备动作不在 core 内直接实现。Core 负责 能力 discovery、授权 contract、HumanGate 和 回执/证据；Linux/Windows/Android 等 adapter 才负责平台实现。

### 7. AI 接口

V0 MCP surface 先提供观察/检查工具：节点、EnrollmentAttempt、Capability Registry。这样模型先看到“对象与状态”，而不是拿到一个万能 Shell。

后续 变更 tool 必须在 server-side 策略、node 身份、能力 权限范围 和 HumanGate 之下，不依赖 tool description 作为安全边界。

### 8. Event-driven 控制

典型事件：

- EnrollmentAttemptChanged
- HumanGateRequired
- HumanGateResolved
- EvidenceUpdated
- CapabilityAvailable
- NodeAdmitted
- ProjectionStale
- ReconcileRequired

AI/Chat 不应承担高频 polling daemon。持久运行 executor/runner 可以消费事件，但 runner 不可用不等于 Fleet 不可用。

### 9. 部署抽象

Core 是 提供方-neutral。V0 同时给出 Cloudflare reference adapter：

~~~text
Static Console
 -> Worker API
 -> Durable Object state
 -> adapters
~~~

Cloudflare 只是参考实现。其他部署可以实现同一 store/API/adapter contract。

### 10. Console

官方 Console 使用成熟开源 UI 基础。V0 选 Tabler 作为视觉与组件壳，GhostFleet 只实现领域页面和 view model：Nodes、Enrollment、Human Gates、Capabilities、Events。

### 11. 平台路线

- Linux：首个 live canary；
- Windows：复用相同 能力/生命周期 contract；
- Android：复用相同 contract，设备 UI 能力由 adapter 表达；
- Apple/macOS/iOS：先保留 adapter 边界，V0 不作为实施 gate。

### 12. Open-源代码 boundary

公共仓库包括通用 schema、状态 machine、UI、API、adapter contracts、合成 tests 和 reference deployment。

公共仓库不包括：真实账号 ID、私有 node inventory、live 服务端点、长期 凭据、个人 策略、私有恢复坐标、内部多 Agent 治理。

---


### 当前 source-preview 与可选模块

Publiccandidate包含typed-control、bootstrap、Pythonplatformruntime与显式authorizationbuildingblocks；具体entry/components/tests见[exportmanifest](export-manifest.json)。默认MCP四只读工具、Console生命周期对象管理不启用设备executionbackend。生产OAuth/Pagehosting/第二independenthardware不由源码搬迁完成。Core/API/permission与标准AIclient无关，不需OpenAI/ChatGPTconfig；专有profile/redirect/actor/scope只optional并保持exactbinding。细节见[操作参考](OPERATIONS.md)、[授权机制](AUTHORIZATION.md)、[迁移](MIGRATION.md)。

## English Version

<!-- topic:reference -->



### 1. Product boundary

GhostFleet is a lifecycle control plane for AI agents and humans managing real device fleets. Its core abstraction is not remote command execution; it is explicit identity, state, capability, evidence, and human authority around real machines.

~~~text
Human / AI
   |
Console / MCP / API
   |
GhostFleet Control Plane
   |
Provider / Device adapters
   |
Real devices
~~~

### 2. Single entry point, multiple domains

Enrollment and daily management share one Console and product entry point. Separation happens at internal authority/domain boundaries:

- Enrollment Domain: admission attempts, provisional identity, Human Gates, resume/reconcile;
- Fleet Domain: NodeIdentity, lifecycle and catalog projection;
- Capability Domain: capability definitions, risk classes and authority references;
- Event Domain: state transitions, evidence and operator-relevant events.

Sharing one UX entry point never means the browser receives provider root authority.

### 3. First-class objects

- `EnrollmentAttempt`: lifecycle object between an unknown physical asset and durable node identity;
- `HumanGate`: durable human approval state rather than chat memory;
- `Evidence`: verifiable facts attached to important transitions;
- `NodeIdentity`: stable PROVISIONAL identity created during MATERIALIZING and promoted to ACTIVE with the same node_uid after acceptance;
- `CapabilityDefinition`: what an adapter can safely expose, not a raw credential;
- `Event`: durable facts used to drive the control loop.

### 4. EnrollmentAttempt state machine

~~~text
CREATED
  -> PREPARING
  -> WAITING_HUMAN -> CLAIMED
  -> MATERIALIZING
  -> ACCEPTED

CLAIMED / MATERIALIZING
  -> RECONCILE_REQUIRED
  -> CLAIMED or MATERIALIZING

non-terminal
  -> FAILED / CANCELLED
~~~

A lost response or ambiguous provider outcome becomes `RECONCILE_REQUIRED`; it must not trigger blind retry or blind remint.

### 5. Evidence-driven admission

V0 uses provider-neutral evidence types:

- `transport.ready`
- `bootstrap.report`
- `identity.materialized`
- `catalog.admitted`
- `control.canary`
- `convergence.zero_delta`
- `reboot.recovered`

Provider-specific facts are mapped by adapters into these public evidence types instead of becoming hard-coded core dependencies.

`materialize` creates a PROVISIONAL NodeIdentity and enrollment catalog projection, then derives core-owned `identity.materialized` and `catalog.admitted` evidence from stored state. Catalog registration permits enrollment inspection only, never operational authority. Clients cannot submit or overwrite those two proofs; the remaining five need real adapter observations, and synthetic tests do not prove hardware acceptance. `accept` promotes the same identity only after all proofs pass. Repeated materialization, durable reload and reconcile retain the identity; repeated materialization has zero material delta.

### 6. Capability model

A Capability is a bounded ability declaration, not a credential. A definition includes at least an id, R0/R1/R2 risk class, adapter contract, and optional policy metadata.

High-authority device actions are not implemented directly inside the core. The core owns discovery, authority contracts, Human Gates and receipts/evidence; Linux, Windows and Android adapters own platform execution.

### 7. AI interface

The V0 MCP surface begins with observation and inspection: nodes, EnrollmentAttempts and the Capability Registry. The model sees objects and lifecycle state before it ever sees mutation authority.

Future mutation tools must remain behind server-side policy, exact node identity, capability scope and HumanGate enforcement. Tool descriptions are not a security boundary.

### 8. Event-driven control

Representative events include EnrollmentAttemptChanged, HumanGateRequired, HumanGateResolved, EvidenceUpdated, CapabilityAvailable, NodeAdmitted, ProjectionStale and ReconcileRequired.

Chat/AI is not a high-frequency polling daemon. Persistent executors may consume events, but runner availability is not fleet availability.

### 9. Deployment abstraction

The core is provider neutral. V0 includes a Cloudflare reference adapter:

~~~text
Static Console
 -> Worker API
 -> Durable Object state
 -> adapters
~~~

Other deployments can implement the same store/API/adapter contracts.

### 10. Console

The official Console reuses a mature open-source UI foundation. V0 selects Tabler as the visual/component shell while GhostFleet implements only domain pages and view models: Nodes, Enrollment, Human Gates, Capabilities and Events.

### 11. Platform roadmap

- Linux: first live canary;
- Windows: same lifecycle/capability contract;
- Android: same contract with device-UI abilities expressed by an adapter;
- Apple/macOS/iOS: adapter boundary reserved, not a V0 implementation gate.

### 12. Open-source boundary

The public repository contains reusable schemas, state machine, UI, API, adapter contracts, synthetic tests and reference deployment.

It excludes real account IDs, private node inventory, live endpoints, long-lived credentials, user-specific policy, private recovery coordinates and internal multi-agent governance.


### Current source preview and optional modules

The public candidate includes typed control, bootstrap, Python platform runtimes and explicit authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are standard AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).
