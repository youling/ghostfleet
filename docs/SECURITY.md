# GhostFleet Security Model — V0

status: `DRAFT_IMPLEMENTED_BOUNDARIES`

## 中文版

<!-- topic:reference -->



### 核心原则

1. **初始纳管身份不等于操作授权。** 新节点仅获得入列所需的最小能力，不自动获得更高权限。
2. **界面不持有提供方的根凭据。** 控制台只处理可安全公开的对象、HumanGate 和引用。
3. **节点获得限定能力或引用，不获得整个设备集群的凭据。**
4. **不确定结果必须对账。** 可能已发生副作用的操作不得盲目重试。
5. **HumanGate 是持久化状态。** 敏感批准不依赖聊天记忆。
6. **收集证据不等于建立统一审计门槛。** 新建或可重建节点优先采用幂等收敛和验证。
7. **临时首次连接不构成持久化身份。** 调试路径不能成为产品依赖。

### 信任边界

~~~text
Browser / AI client
    | public-safe API
    v
Control Plane
    | bounded adapter contract
    v
Provider / Device adapter
    | exact scoped authority
    v
Node / provider
~~~

### 可安全公开的状态契约

核心对证据和元数据执行秘密字段检查：允许 `*_ref` 和 `*_id` 引用字段，拒绝原始秘密、令牌、密码、私钥和凭据字段进入公共状态。

这不是完整的数据泄漏防护（DLP），也不替代适配器的秘密托管；它是防止原始凭据成为生命周期状态的第二道防线。

### HumanGate

V0 HumanGate 至少包含 `gate_id`、`gate_type`、`subject`、状态、`prompt`、`expires_at` 和可恢复语义。

短码属于对应的纳管交互和尝试，不属于持久化的 NodeIdentity。

### 证据

状态迁移和证据同时保存。每个必需证据类型的最新观测必须显式为 `data.status = PASS`；新的 `FAIL` 或 `UNKNOWN` 使该类型的旧 `PASS` 失效。命令退出码为 0、包已安装、服务运行或网络可达等单独事实都不能自动推导纳管成功。真实适配器还须校验证据来源、对象（`subject`）和权限；合成证据不证明真实设备。

核心拥有的身份和目录证据只能从已存储的 NodeIdentity 和投影生成，公共证据写入口不能伪造。`PROVISIONAL` 仅用于纳管观察，完整验收后才晋升 `ACTIVE`。核心投影证据不替代真实设备与适配器的绑定，也不替代传输、控制、收敛和重启证据。`ACTIVE` 和七项证据仅证明本控制面的准入；独立调用方仍须分别验收目录发现、认证配置、调用路由、正负权限、同一身份回读和回滚。

### 私有目录与 provider preparation 边界

- 部署专属模板目录只能通过非秘密 catalog extension 进入；公开默认模板不能被同 ID 覆盖，secret-shaped plaintext、未知 provider option 和陈旧 generation 继续拒绝。
- provider preparation 发生在 ticket/short code 生成之前。结果为 `BLOCKED` 或 `UNKNOWN` 时不创建 GhostFleet ticket；同一 `attempt_id` 的重试必须由私有 preparer 自行对账，不能盲目再 mint。
- claim-time materializer 只消费已经预备的一次性材料；不得把 public claim retry 当作 provider mutation retry。
- 私有 service binding 的响应只允许把 public-safe 状态/期限返回核心；raw provider credential 只在最终成功 claim 的瞬态响应中经过既有 secret-safe 边界，不能进入 Durable Object snapshot、event 或公开日志。

### 已知 V0 限制

- 尚未完成真实提供方或设备适配器的安全审阅；
- Cloudflare 参考 API 已有缺失配置时拒绝访问的只读/操作员令牌边界，尚未完成生产级多用户认证与 RBAC；
- Cloudflare 参考适配器证明结构可用，不代表已部署生产授权；
- MCP V0 仅开放观察接口；
- 正式发布前必须完成真实环境试验和威胁模型审阅。

---


### 当前源码预览与可选模块

公开 `main` 已包含源码预览：类型化控制、初始纳管、Python 平台运行时和显式可选的授权基础模块；具体入口、组件和测试见 [导出清单](export-manifest.json)。默认四个只读 MCP 工具和控制台生命周期对象管理不启用设备执行后端。源码迁入不完成生产 OAuth、Pages 托管或第二独立硬件验收。核心、API 与权限机制独立于标准 AI 客户端，不要求 OpenAI/ChatGPT 配置；专有客户端的配置、重定向、调用主体和权限范围兼容仅为可选模块，并保持精确绑定。详见 [操作参考](OPERATIONS.md)、[授权机制](AUTHORIZATION.md)、[迁移](MIGRATION.md)。

## English Version

<!-- topic:reference -->



### Core principles

1. **Bootstrap identity is not operational authority.** A new node receives only the minimum authority required for admission.
2. **The UI never holds provider root credentials.** The Console handles public-safe objects, Human Gates and references.
3. **Nodes receive bounded capabilities/references, not fleet-wide credentials.**
4. **Ambiguous outcomes require reconciliation.** Operations that may have produced side effects must not be blindly retried.
5. **HumanGate is durable state.** Sensitive approval does not depend on chat memory.
6. **Evidence collection is not a universal audit gate.** Fresh/rebuildable nodes prefer idempotent convergence plus verification.
7. **Temporary first-contact transport is not durable identity.** Debug paths must not become product dependencies.

### Trust boundaries

~~~text
Browser / AI client
    | public-safe API
    v
Control Plane
    | bounded adapter contract
    v
Provider / Device adapter
    | exact scoped authority
    v
Node / provider
~~~

### Public-safe contract

Core evidence/metadata rejects raw secret-bearing fields while allowing reference/id fields. This is not full DLP and does not replace adapter-side secret custody; it is a second line of defense against turning raw credentials into lifecycle state.

### HumanGate

V0 HumanGate includes at least gate_id, gate_type, subject, state, prompt, expires_at and resumable semantics.

Human-facing pairing codes belong to their enrollment ceremony/attempt, not the durable NodeIdentity.

### Evidence

State transitions and evidence are stored together. For each required evidence type, the latest observation must explicitly have `data.status = PASS`; a newer `FAIL` or `UNKNOWN` invalidates that type's older `PASS`. A command exit code of 0, installed package, active service or reachable transport alone never proves successful admission. Real adapters must also validate evidence source, subject and authority; synthetic evidence does not establish real-device acceptance.

Core-owned identity/catalog proofs derive only from stored NodeIdentity/projection and cannot be forged through the public evidence endpoint. PROVISIONAL supports enrollment inspection only; full acceptance promotes it to ACTIVE. Core projection evidence does not replace binding to a real device/adapter or transport/control/convergence/reboot proofs. `ACTIVE` and seven evidence types establish admission in this control plane only. Independent consumers still need separate acceptance for catalog discovery, authentication/configuration, call routes, positive/negative permissions, same-identity readback and rollback.

### Private catalog and provider-preparation boundary

- Deployment-specific templates enter only through a non-secret catalog extension. Public template IDs cannot be shadowed; secret-shaped plaintext, unknown provider options and stale generations remain rejected.
- Provider preparation happens before any GhostFleet ticket/short code is created. A `BLOCKED` or `UNKNOWN` result creates no ticket; retries on the same `attempt_id` must be reconciled by the private preparer rather than blindly minting again.
- The claim-time materializer only consumes already-prepared one-time material. Public claim retry must never become provider-mutation retry.
- The private service binding may return only public-safe preparation state/expiry to core. Raw provider material may cross only the existing transient successful-claim boundary and must never enter the Durable Object snapshot, event stream or public logs.

### Known V0 limits

- real provider/device adapter security review is not complete;
- the Cloudflare API now has a fail-closed read-only/operator bearer boundary; production multi-user authentication/RBAC is not complete;
- the Cloudflare reference adapter demonstrates structure, not deployed production authority;
- V0 MCP is inspection-only;
- live canaries and threat-model review are release gates.


### Current source preview and optional modules

Public `main` contains the source preview: typed control, bootstrap, Python platform runtimes and explicit optional authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are standard AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).
