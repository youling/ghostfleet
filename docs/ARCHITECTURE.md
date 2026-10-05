# GhostFleet Architecture — V0 Baseline

status: `V0_IMPLEMENTATION_BASELINE`
architecture_source: [Public canonical packages ADR](adr/001-public-canonical-packages.md)

## 中文版

<!-- topic:reference -->

### 1. 产品边界

GhostFleet 为人工操作员和 AI 代理提供设备舰队生命周期控制面，通过明确的身份、状态、能力、证据与人工确认管理真实设备的准入和操作。

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

### 2. 单入口，多个领域

纳管与日常管理共用 Console 和产品入口，内部按领域与权限隔离：

- 纳管领域：准入尝试、临时身份、人工确认、恢复与对账；
- 设备领域：`NodeIdentity`、生命周期与目录投影；
- 能力领域：能力定义、风险等级与授权引用；
- 事件领域：状态变化、证据和需要操作员处理的事件。

浏览器不持有提供方的根凭据，共享入口也不授予全部内部权限。

### 3. 一等对象

- `EnrollmentAttempt`：从未知物理设备到持久节点身份的生命周期对象；
- `HumanGate`：持久化的人工确认状态，不依赖聊天记忆；
- `Evidence`：关键状态变化的可验证依据；
- `NodeIdentity`：在 `MATERIALIZING` 阶段创建稳定的 `PROVISIONAL` 身份，验收后以同一 `node_uid` 晋升 `ACTIVE`；
- `CapabilityDefinition`：适配器可安全提供的能力声明，不携带原始凭据；
- `Event`：驱动控制循环的持久事实。

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

响应丢失或提供方结果不确定时进入 `RECONCILE_REQUIRED`，先对账，不能盲目重试或重新生成身份。

### 5. 证据驱动的准入

V0 使用与提供方无关的证据类型：

- `transport.ready`
- `bootstrap.report`
- `identity.materialized`
- `catalog.admitted`
- `control.canary`
- `convergence.zero_delta`
- `reboot.recovered`

适配器将提供方事实映射为公共证据；网络状态、地址和外部可见性等事实不成为核心协议的硬编码依赖。

`materialize` 创建 `PROVISIONAL` 身份和纳管目录投影，从实际存储生成核心拥有的 `identity.materialized` 与 `catalog.admitted` 证据。目录登记只允许纳管观察，不授权日常设备操作。客户端不能提交或覆盖这两项证明；另外五项须由真实适配器观察提供，合成测试不证明真机验收。`accept` 验证全部证据后晋升同一身份。重复物化、持久化恢复与对账保留身份，重复物化不产生实质变更。

身份准入和纳管目录投影属于本控制面。独立消费者仍须完成目录、鉴权、配置和调用路由接线，验证允许与越权调用、身份回读及回滚。单独的 canary 或 `ACTIVE` 状态不证明用户实际使用的消费者已完成端到端纳管。详见 [迁移](MIGRATION.md)。

### 6. 能力模型

能力是受控声明，不是凭据。定义至少包含能力 ID、R0/R1/R2 风险级别、适配器契约和可选策略元数据。

核心负责能力发现、授权契约、人工确认和回执/证据。Linux、Windows、Android 等适配器提供平台执行，高权限设备动作不直接实现在核心中。

### 7. AI 接口

V0 MCP 提供节点、纳管尝试和能力目录的观察与检查工具。模型先获得对象和状态；以后新增变更工具时，须在服务端强制执行策略、精确身份、能力权限及人工确认。工具说明不是安全边界。

### 8. 事件驱动的控制

典型事件包括 `EnrollmentAttemptChanged`、`HumanGateRequired`、`HumanGateResolved`、`EvidenceUpdated`、`CapabilityAvailable`、`NodeAdmitted`、`ProjectionStale` 和 `ReconcileRequired`。

聊天和 AI 不承担高频轮询守护进程。持久执行器可以消费事件；某个执行器不可用，不等于设备舰队整体不可用。

### 9. 部署抽象

核心与提供方无关。V0 提供 Cloudflare 参考适配器：

~~~text
Static Console
 -> Worker API
 -> Durable Object state
 -> adapters
~~~

其他部署可实现相同的存储、API 与适配器契约。

### 10. Console

官方 Console 使用成熟开源 UI 基础。V0 采用 Tabler 作为视觉和组件基础，GhostFleet 实现节点、纳管、人工确认、能力和事件等领域页面与视图模型。

### 11. 平台路线

- Linux：首个真实 canary 集成；
- Windows：复用生命周期与能力契约；
- Android：复用契约，由适配器表达设备 UI 能力；
- Apple/macOS/iOS：保留适配器边界，不作为 V0 实施前置。

### 12. 开源边界

公开仓包含通用 schema、状态机、UI、API、适配器契约、合成测试和参考部署。真实账号、私有设备清单、实际端点、长期凭据、个人策略、私有恢复坐标和内部代理治理留在部署方。

### 当前源码预览与可选模块

公开 `main` 包含类型化控制、bootstrap、Python 平台运行时和显式可选的授权基础模块。[导出清单](export-manifest.json) 列出入口、组件和测试。默认 MCP 四个只读工具与 Console 的生命周期对象管理没有设备执行后端。生产 OAuth、Pages 托管和第二台独立硬件分别验收。核心、API、权限与标准 AI 客户端无关，无需 OpenAI/ChatGPT 配置；特定客户端的配置、重定向、身份和权限范围通过可选适配器精确绑定。详见 [操作](OPERATIONS.md)、[授权](AUTHORIZATION.md) 和 [迁移](MIGRATION.md)。

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

Identity admission and the enrollment catalog projection are local to this control plane. An independent consumer still requires catalog/authentication/configuration/call-route integration, permitted and unauthorized-call tests, identity readback and rollback acceptance. A canary or ACTIVE state alone does not establish end-to-end admission through that consumer; see [Migration](MIGRATION.md).

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

The public source preview on `main` includes typed control, bootstrap, Python platform runtimes and explicit authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are standard AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).
