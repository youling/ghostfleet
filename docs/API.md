# GhostFleet V0 HTTP API

## 中文版

<!-- topic:reference -->



V0 API 定义生命周期和控制面契约，不是提供方凭据接口。

Cloudflare 参考宿主另提供 `GET /v0/access`，返回当前已认证访问令牌的 `access: "operator" | "read_only"`，供控制台显示权限；服务端仍拒绝无凭据、无效凭据和只读身份变更。响应设置 `Cache-Control: no-store`，不访问设备存储。其他宿主若提供控制台，也须实现同样的认证元数据接口；核心 HTTP 处理器自身不推断凭据。

### 读取

- `GET /healthz`
- `GET /v0/nodes`
- `GET /v0/enrollment-attempts`
- `GET /v0/enrollment-attempts/:attempt_id`
- `GET /v0/human-gates`
- `GET /v0/events`
- `GET /v0/capabilities`

### 生命周期变更

- `POST /v0/enrollment-attempts` — 创建纳管尝试；
- `POST /v0/enrollment-attempts/:id/prepare`；
- `POST /v0/enrollment-attempts/:id/human-gates`；
- `POST /v0/human-gates/:gate_id/resolve`；
- `POST /v0/enrollment-attempts/:id/claim`；
- `POST /v0/enrollment-attempts/:id/materialize`；
- `POST /v0/enrollment-attempts/:id/evidence`；
- `POST /v0/enrollment-attempts/:id/reconcile-required`；
- `POST /v0/enrollment-attempts/:id/reconcile`；
- `POST /v0/enrollment-attempts/:id/accept`。

`materialize` 可接收 `{ "node_id": "lab-device", "platform": "linux" }`，返回带稳定 `node_uid` 的尝试；`GET /v0/nodes` 包含 `PROVISIONAL` 纳管投影。该身份尚未完成验收，也没有操作授权。身份和目录证据由核心生成，`evidence` 拒绝这两类输入及伪造的 `ghostfleet-core` 来源。`accept` 不创建新身份，请求体可省略；兼容的 `node_id/platform` 参数只能匹配 materialize 时的值。旧的“accept 时设置身份”调用须将这些字段移至 materialize。

`ACTIVE` 与七项证据仅证明本控制面准入，不证明独立调用方已经切换目录、认证配置、调用路由、权限或回滚。每个调用方须复用既有身份，分别验收其可发现性、实际调用、正负权限、身份回读和回滚；不能通过新建身份或扩大权限来弥补目录缺口。

### 能力元数据

- `POST /v0/capabilities` 注册适配器能力定义。

能力定义仅包含 ID、R0/R1/R2 风险级别、说明和适配器契约。V0 核心不通过该接口分发原始凭据，也不提供通用远程执行能力。

### 错误语义

- 生命周期跳步 → `INVALID_TRANSITION`；
- 证据不足 → `ACCEPTANCE_EVIDENCE_MISSING` + `missing[]`；
- 外部结果不确定 → 显式进入 `RECONCILE_REQUIRED`，客户端须对账，不能盲目重试。

---


### 当前源码预览与可选模块

公开 `main` 已包含源码预览：类型化控制、初始纳管、Python 平台运行时和显式可选授权基础模块；具体入口、组件和测试见 [导出清单](export-manifest.json)。默认四个只读 MCP 工具和控制台生命周期对象管理不启用设备执行后端。源码迁入不完成生产 OAuth、Pages 托管或第二独立硬件验收。核心、API 与权限机制独立于标准 AI 客户端，不要求 OpenAI/ChatGPT 配置；专有客户端的配置、重定向、调用主体和权限范围兼容仅为可选模块，并保持精确绑定。详见 [操作参考](OPERATIONS.md)、[授权机制](AUTHORIZATION.md)、[迁移](MIGRATION.md)。

## English Version

<!-- topic:reference -->



The V0 API is a lifecycle/control-plane contract, not a provider-credential API.

The Cloudflare reference host also provides authenticated `GET /v0/access`, returning `access: "operator" | "read_only"` for Console permission display. The server still rejects missing/invalid credentials and read-only mutations. This metadata response uses `Cache-Control: no-store` and does not access device storage. Other Console hosts must implement this authenticated metadata interface; the core HTTP handler does not infer credentials.

### Read

- `GET /healthz`
- `GET /v0/nodes`
- `GET /v0/enrollment-attempts`
- `GET /v0/enrollment-attempts/:attempt_id`
- `GET /v0/human-gates`
- `GET /v0/events`
- `GET /v0/capabilities`

### Lifecycle mutation

- `POST /v0/enrollment-attempts`
- `POST /v0/enrollment-attempts/:id/prepare`
- `POST /v0/enrollment-attempts/:id/human-gates`
- `POST /v0/human-gates/:gate_id/resolve`
- `POST /v0/enrollment-attempts/:id/claim`
- `POST /v0/enrollment-attempts/:id/materialize`
- `POST /v0/enrollment-attempts/:id/evidence`
- `POST /v0/enrollment-attempts/:id/reconcile-required`
- `POST /v0/enrollment-attempts/:id/reconcile`
- `POST /v0/enrollment-attempts/:id/accept`

`materialize` accepts optional `{ "node_id": "lab-device", "platform": "linux" }` and returns an attempt with its stable `node_uid`; `GET /v0/nodes` includes PROVISIONAL enrollment projections. This identity is not accepted and has no operational authority. Core generates identity/catalog proofs; `evidence` rejects those types and forged `ghostfleet-core` sources. `accept` never mints an identity. Its body may be omitted; compatibility node_id/platform arguments must match materialization. Callers that previously assigned identity at acceptance must move those fields to materialize.

`ACTIVE` and seven evidence types establish admission in this control plane only, not independent consumer catalog/authentication/configuration/call-route/permission/rollback cutover. Each consumer must reuse the existing identity and separately validate discoverability, real calls, positive/negative permissions, identity readback and rollback. Do not create another identity or widen authority to fill a catalog gap.

### Capability metadata

- `POST /v0/capabilities` registers an adapter capability definition.

A capability definition contains only id, R0/R1/R2 risk class, description and adapter contract. V0 Core does not use this endpoint to distribute raw credentials or expose a universal remote-execution primitive.

### Error semantics

- lifecycle skip → `INVALID_TRANSITION`;
- incomplete evidence → `ACCEPTANCE_EVIDENCE_MISSING` + `missing[]`;
- ambiguous external outcome → explicit `RECONCILE_REQUIRED` state instead of client-side blind retry.


### Current source preview and optional modules

Public `main` contains the source preview: typed control, bootstrap, Python platform runtimes and explicit optional authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are standard AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).
