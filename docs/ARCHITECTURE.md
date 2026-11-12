# GhostFleet Architecture — V0 Baseline

status: `V0_IMPLEMENTATION_BASELINE`
architecture_source: [Public canonical packages ADR](adr/001-public-canonical-packages.md)

## 中文版

<!-- topic:reference -->

### 1. 产品边界

GhostFleet 为人工操作员和 AI 代理提供设备舰队生命周期控制面，通过明确的身份、状态、能力、证据与人工确认管理真实设备的准入和操作。

以下总图是 `DERIVED` 导航，语义来源为 [项目规则](../AGENTS.md)、[公共包归属 ADR](adr/001-public-canonical-packages.md) 与 [迁移/实例边界](MIGRATION.md)。图中的接线须由部署方独立配置和验收；存在适配器不等于获得设备执行权限。

~~~mermaid
flowchart TD
    Client["人工操作员 / 标准客户端"] --> Entry["Console / HTTP / 默认只读 MCP"]
    subgraph Public["公开通用机制"]
        Entry --> Core["身份 / 生命周期 / HumanGate / Evidence"]
        Core --> Optional["可选 typed-control / 平台契约"]
    end
    subgraph Private["私有实例与运行证据"]
        Config["私有策略 / 凭据托管"] --> Adapter["已配置的提供方 / 执行适配器"]
        Adapter --> Device["授权范围内的设备"]
    end
    Optional -. "独立接线与授权验收" .-> Adapter
    Adapter -. "回执与证据" .-> Core
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

主路径与恢复路径如下；图是 [现行转换表](../src/core/state-machine.js) 的 `DERIVED` 投影，终止转换见图后说明。审批与执行仍使用各自的契约。

~~~mermaid
stateDiagram-v2
    direction TB
    [*] --> CREATED
    CREATED --> PREPARING
    PREPARING --> WAITING_HUMAN
    PREPARING --> CLAIMED
    WAITING_HUMAN --> CLAIMED
    CLAIMED --> MATERIALIZING
    MATERIALIZING --> ACCEPTED
    CLAIMED --> RECONCILE_REQUIRED
    MATERIALIZING --> RECONCILE_REQUIRED
    RECONCILE_REQUIRED --> CLAIMED
    RECONCILE_REQUIRED --> MATERIALIZING
    ACCEPTED --> [*]
~~~

`CREATED`、`PREPARING`、`WAITING_HUMAN`、`RECONCILE_REQUIRED` 允许转为 `CANCELLED`；这四态以及 `CLAIMED`、`MATERIALIZING` 允许转为 `FAILED`。`ACCEPTED`、`FAILED`、`CANCELLED` 没有后续转换。不能把“尚未终止”概括成任何阶段都可直接取消。

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

参考部署由静态 Console 调用 Worker API，后者使用 Durable Object 保存状态并连接适配器。

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

### Deployment-private enrollment seams

公开 GhostFleet 不保存实例私有默认值或 provider authority。Cloudflare 参考部署允许实例通过非秘密 `GHOSTFLEET_ENROLLMENT_CATALOG_JSON` 增加部署专属模板/overlay/display；未配置时公开模板目录不变，非法、冲突、陈旧或 secret-shaped 输入 fail closed。

一次性 provider material 使用两阶段私有 service binding：Generate ticket 时可先调用 `/v1/prepare`，按 exact `EnrollmentAttempt` 预备并对账私有一次性 authority；只有 READY 后才生成 GhostFleet ticket/short code。节点随后 claim 时调用 `/v1/materialize`，只消费已预备材料。这样 provider mint 不依赖可重试的 public claim callback。公共 Durable Object 仍不保存原始 provider credential，私有 service 的 provider/API/custody 实现属于 deployment owner。

### 生产节点纳管与特权执行

首台 Linux 消费者的真实特权远控闭环已在一个私有部署中验收；它不等于首次纳管或第二节点通过。跨层契约、预检矩阵、`UNKNOWN` 对账、第二节点与 NAS 首次使用的区别见[生产节点纳管与特权金丝雀 runbook](architecture/PRODUCTION_NODE_ONBOARDING_AND_ADMIN_CANARY_V1.md)。图中的 Worker/DO/Tunnel 是参考部署组件，不是核心强制依赖。ChatGPT 对话内人工审批的可选交互、OAuth 身份边界与 Web/Mobile 能力门见[对话内人工审批 v1](architecture/IN_CHAT_HUMAN_APPROVAL_V1.md)。 公网/边缘节点的 `MANAGED_ONLY` 来源拒绝由独立的 [#64 / PR #65](https://github.com/youling/ghostfleet/pull/65) typed-origin tranche 承担；该 PR 当前仍未合并/部署，私有拓扑策略和网络层无中继验收也未完成。

### 工程证据与产品验收

下图回答“一个方案何时能支持哪种结论”，是 `DERIVED` 导航。来源为[测试分层](TESTING.md)、[消费者验收](CONSUMER_ACCEPTANCE.md)与[当前架构治理入口 #3](https://github.com/youling/ghostfleet/issues/3)；核验窗口为 2026-11-12，源码基线 `60f441f235b14e1334b672066d71e4200bd96a59`。本图不保存实时 PR 状态，不创建新的审批层。

~~~mermaid
flowchart TD
    Spec["候选契约"] -. "实现为可执行场景" .-> Cases["行为与反例测试"]
    Source["精确版本源码"] --> Cases
    Source --> Structure["结构与文档检查"]
    Cases --> Review["同一版本的证据与审查"]
    Structure --> Review
    Review --> Accepted["已接受的源码"]
    Accepted -. "实例接线与现场证明" .-> Consumer["独立消费者验收"]
~~~

测试与审查按变更范围适用；本图不要求仅修改文档时重跑无关的设备行为测试。结构检查只能证明结构约束；已执行的合成/隔离测试只能证明所测范围。源码接受后，实例仍须证明目录、鉴权、调用路由、允许/拒绝路径、身份回读和回滚。`NOT_RUN`、查询失败和结果不明不能压成 PASS 或零差异。公开源码更新也不自动改变部署版本或设备状态。

例如，版本化纳管的 [PR #78](https://github.com/youling/ghostfleet/pull/78) 在上述窗口仍是候选合同，24 个 VE 场景未执行；文件传输 [PR #67](https://github.com/youling/ghostfleet/pull/67) 仍是计划层候选。它们的绿色结构/源码检查不证明升级或传输已经可用。当前分支与 gate 必须回读原 PR；阶段视图见[实施计划](IMPLEMENTATION_PLAN.md)，外部机制取舍见[同类项目勘察](research/REUSE_RECONNAISSANCE_2026-11-12.md)。

### 当前源码预览与可选模块

公开 `main` 包含类型化控制、bootstrap、Python 平台运行时和显式可选的授权基础模块。[导出清单](export-manifest.json) 列出入口、组件和测试。默认 MCP 四个只读工具与 Console 的生命周期对象管理没有设备执行后端。生产 OAuth、Pages 托管和第二台独立硬件分别验收。核心、API、权限与标准 AI 客户端无关，无需 OpenAI/ChatGPT 配置；特定客户端的配置、重定向、身份和权限范围通过可选适配器精确绑定。详见 [操作](OPERATIONS.md)、[授权](AUTHORIZATION.md) 和 [迁移](MIGRATION.md)。

## English Version

<!-- topic:reference -->



### 1. Product boundary

GhostFleet is a lifecycle control plane for AI agents and humans managing real device fleets. Its core abstraction is not remote command execution; it is explicit identity, state, capability, evidence, and human authority around real machines.

This overview is `DERIVED` navigation from the [project rules](../AGENTS.md), [public package ownership ADR](adr/001-public-canonical-packages.md) and [migration/deployment boundary](MIGRATION.md). Deployment wiring needs independent configuration and acceptance; an available adapter does not grant device-execution authority.

~~~mermaid
flowchart TD
    Client["Human operators / standard clients"] --> Entry["Console / HTTP / default read-only MCP"]
    subgraph Public["Public reusable mechanisms"]
        Entry --> Core["Identity / lifecycle / HumanGate / Evidence"]
        Core --> Optional["Optional typed control / platform contracts"]
    end
    subgraph Private["Private deployment and runtime evidence"]
        Config["Private policy / secret custody"] --> Adapter["Configured provider / execution adapters"]
        Adapter --> Device["Devices within authorized scope"]
    end
    Optional -. "Separate wiring and authority acceptance" .-> Adapter
    Adapter -. "Receipts and evidence" .-> Core
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

The main and reconciliation paths below are a `DERIVED` projection of the [current transition table](../src/core/state-machine.js); terminal transitions are specified immediately after the diagram. Approval and execution retain their separate contracts.

~~~mermaid
stateDiagram-v2
    direction TB
    [*] --> CREATED
    CREATED --> PREPARING
    PREPARING --> WAITING_HUMAN
    PREPARING --> CLAIMED
    WAITING_HUMAN --> CLAIMED
    CLAIMED --> MATERIALIZING
    MATERIALIZING --> ACCEPTED
    CLAIMED --> RECONCILE_REQUIRED
    MATERIALIZING --> RECONCILE_REQUIRED
    RECONCILE_REQUIRED --> CLAIMED
    RECONCILE_REQUIRED --> MATERIALIZING
    ACCEPTED --> [*]
~~~

`CREATED`, `PREPARING`, `WAITING_HUMAN` and `RECONCILE_REQUIRED` may transition to `CANCELLED`. Those four states plus `CLAIMED` and `MATERIALIZING` may transition to `FAILED`. `ACCEPTED`, `FAILED` and `CANCELLED` have no outgoing transitions. Being nonterminal does not imply cancellation is allowed at every stage.

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

### 6.1 Account isolation inside one authorized ceremony

Three accounts are involved in a Linux first-root ceremony and none of them is interchangeable:

- the **dedicated run account** (`control_account`) owns the managed user unit and Linger, so every process the managed runtime starts inherits exactly its rights. It is created inside the same authorized ceremony when absent (`useradd --create-home --user-group --shell /usr/sbin/nologin`, locked password, no sudo, no supplementary group) and recorded as created-by-the-courier the moment it exists;
- the **privileged operations account** (`privileged_account`, additive selection field, rendered by the deployment from the reviewed installer) holds the bounded NOPASSWD `fleet-privctl` rule and the forced-command SSH entry;
- the **ordinary Human account** is only the helper's admission user.

The rule is negative and testable: the run account must not be able to invoke `sudo -n fleet-privctl`. The same criteria — ordinary UID, nologin shell, locked password, existing home and same-name group, no sudo grant, no root-equivalent group — are proved for an account this courier creates and for one it adopts, and they are proved **three times**: in the apply stage before anything is installed (the rendered channel reaches it after the local preflight; the claim channel only after the claim and the identity join, because that is the earliest point at which the selection exists), again on the zero-delta path, and once more **after the reviewed installer has run as root**, because that artifact can change groups or sudoers. Only a run that still passes after the installer may install the unit, enable Linger or write state; `control_account == privileged_account` is refused before any installation effect. A lane left inside the privileged account by a v1 selection is detected before the schema gate and fails closed with decommission steps; it is removed only when this node's own recorded selection claims that account as the unit owner **and** the old service is proved stopped first — stopped in that account's own session, `is-active` reporting `inactive`/`failed`, and no process of its `ExecStart` binary left — with the record deleted last and nothing deleted when the stop cannot be proved. Because the boundary is closed inside the single root ceremony, no second manual root command and no new Human-visible privilege tier appears. Rollback removes only what that run created — the ownership flag is recorded at creation, so a half-created account is still removed — while a pre-existing account is never deleted or modified. The synthetic tests prove the refusals, the post-installer drift and the rollback, and a disposable root job proves the negative with real `sudo` against the installed helper, the post-installer drift, the stale-lane refusal, and that the privileged account still reaches the helper.

### 7. AI interface

The V0 MCP surface begins with observation and inspection: nodes, EnrollmentAttempts and the Capability Registry. The model sees objects and lifecycle state before it ever sees mutation authority.

Future mutation tools must remain behind server-side policy, exact node identity, capability scope and HumanGate enforcement. Tool descriptions are not a security boundary.

### 8. Event-driven control

Representative events include EnrollmentAttemptChanged, HumanGateRequired, HumanGateResolved, EvidenceUpdated, CapabilityAvailable, NodeAdmitted, ProjectionStale and ReconcileRequired.

Chat/AI is not a high-frequency polling daemon. Persistent executors may consume events, but runner availability is not fleet availability.

### 9. Deployment abstraction

The core is provider neutral. V0 includes a Cloudflare reference adapter:

The reference deployment uses a static Console calling the Worker API, which persists state in a Durable Object and connects the adapters.

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


### Deployment-private enrollment seams

Public GhostFleet stores neither instance-private defaults nor provider authority. The Cloudflare reference deployment may add deployment-specific templates/overlays/display through the non-secret `GHOSTFLEET_ENROLLMENT_CATALOG_JSON`; without it the public catalog is unchanged, and malformed, colliding, stale or secret-shaped input fails closed.

One-time provider material uses a two-phase private service binding. Ticket generation may first call `/v1/prepare` keyed to the exact `EnrollmentAttempt` so private one-time authority is prepared/reconciled before GhostFleet creates an unrecoverable short code. Node claim later calls `/v1/materialize` only to consume already-prepared material. Provider mint therefore never depends on retrying the public claim callback. Raw provider credentials remain outside the public Durable Object; provider/API/custody implementation belongs to the deployment owner.

### Production node onboarding and approved-admin execution

The first Linux consumer's live approved-admin path has passed in one private deployment; this does not mean first-use enrollment or a second node has passed. Cross-layer contracts, preflight, `UNKNOWN` reconciliation and the distinction between second-node acceptance and NAS first use are documented in the [production node onboarding and admin canary runbook](architecture/PRODUCTION_NODE_ONBOARDING_AND_ADMIN_CANARY_V1.md). Worker/DO/Tunnel in its diagrams are reference-deployment components, not mandatory core dependencies. The optional in-chat Human approval interaction, OAuth principal boundary and Web/Mobile platform gates are documented in [In-chat Human approval v1](architecture/IN_CHAT_HUMAN_APPROVAL_V1.md). The `MANAGED_ONLY` origin denial for public/edge nodes is owned by the separate [#64 / PR #65](https://github.com/youling/ghostfleet/pull/65) typed-origin tranche; that PR remains unmerged/undeployed, and private topology policy plus network no-relay acceptance remain outstanding.

### Engineering evidence and product acceptance

This `DERIVED` view answers which evidence supports which conclusion. Its sources are [testing layers](TESTING.md), [consumer acceptance](CONSUMER_ACCEPTANCE.md) and the [current architecture anchor #3](https://github.com/youling/ghostfleet/issues/3); it was checked on 2026-11-12 against source baseline `60f441f235b14e1334b672066d71e4200bd96a59`. It stores no live PR state and adds no approval tier.

~~~mermaid
flowchart TD
    Spec["Candidate contract"] -. "Implement executable scenarios" .-> Cases["Behavior and counterexample tests"]
    Source["Exact source revision"] --> Cases
    Source --> Structure["Structure and documentation checks"]
    Cases --> Review["Evidence and review for that revision"]
    Structure --> Review
    Review --> Accepted["Accepted source"]
    Accepted -. "Deployment wiring and field evidence" .-> Consumer["Independent consumer acceptance"]
~~~

Tests and review apply according to the change scope; this view does not require unrelated device-behavior tests for documentation-only changes. Structural checks establish structural constraints; executed synthetic/disposable tests establish only their tested scope. Accepted source still requires deployment evidence for catalog/authentication/call routes, permitted and denied operations, identity readback and rollback. `NOT_RUN`, failed queries and uncertain results must not collapse into PASS or zero delta. A public source update does not change deployed versions or device state automatically.

For example, in this observation window versioned enrollment [PR #78](https://github.com/youling/ghostfleet/pull/78) remained a candidate contract with 24 unexecuted VE scenarios, while file transfer [PR #67](https://github.com/youling/ghostfleet/pull/67) remained a planning-layer candidate. Green structural/source checks do not establish usable updates or transfers. Re-read the original PR for current branches and gates. See the [implementation plan](IMPLEMENTATION_PLAN.md) for stage navigation and [related-project reconnaissance](research/REUSE_RECONNAISSANCE_2026-11-12.md) for external mechanisms and reuse decisions.

### Current source preview and optional modules

The public source preview on `main` includes typed control, bootstrap, Python platform runtimes and explicit authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are standard AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).
