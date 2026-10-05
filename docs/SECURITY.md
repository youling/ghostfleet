# GhostFleet Security Model — V0

status: `DRAFT_IMPLEMENTED_BOUNDARIES`

## 中文版

<!-- topic:reference -->



### 核心原则

1. **Bootstrap 身份 不等于 operational 授权。** 新节点获得入列所需最小能力，不自动获得更高权限。
2. **UI 不持有 提供方 root 凭据。** Console 只处理 公开-safe object、HumanGate 和 reference。
3. **节点获得 能力/reference，而不是 fleet-wide 凭据。**
4. **不确定结果必须 对账。** 可能已发生副作用的操作不得 blind retry。
5. **HumanGate 是 durable 状态。** 敏感批准不依赖聊天记忆。
6. **Evidence collection 不等于 universal audit gate。** 对 fresh/rebuildable 节点优先幂等 收敛 + verification。
7. **临时 first-contact 传输 不是 durable 身份。** 调试路径不能变成产品依赖。

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

Core 对 证据/元数据 做 秘密-bearing field guard。允许 `*_ref` / `*_id`，拒绝 raw 秘密/token/password/私有-key/凭据 字段进入公共状态。

这不是完整 DLP，也不替代 adapter 层 秘密 托管；它是“不要把 raw 秘密 变成生命周期对象字段”的第二道防线。

### HumanGate

V0 HumanGate 至少包含：gate_id、gate_type、subject、状态、prompt、expires_at、resumable。

短码属于对应 enrollment ceremony/attempt，不属于 durable NodeIdentity。

### Evidence

状态迁移和 证据 同时保存。每个 required 证据 类型的最新观测必须显式为 `data.status = PASS`；新的 FAIL/UNKNOWN 使旧 PASS 失效。Command exit=0、包已安装、服务 active、网络可达等单独事实都不能自动推导“纳管成功”。真实 adapter 仍需校验 证据 来源、subject 和权限；合成证据不证明真实设备。

Core-owned 身份/catalog 证据只能从已存储的 NodeIdentity/projection 生成，公共 证据 写入口不能伪造。PROVISIONAL 仅用于 enrollment 观察；完整验收后才晋升 ACTIVE。Core projection 证明不替代真实设备与 adapter 的绑定，也不替代 传输/control/收敛/reboot 证明。

### Known V0 limits

- 尚未完成真实 提供方/device adapter security 审阅；
- Cloudflare 参考 API 已有 fail-closed 的 读取-only/操作员 bearer 边界；尚未完成生产级多用户 authentication/RBAC；
- Cloudflare reference adapter 是结构证明，不代表已部署生产 授权；
- MCP V0 仅开放 inspection surface；
- 正式 release 前必须完成 live canary 和 threat-model 审阅。

---


### 当前 source-preview 与可选模块

Publiccandidate包含typed-control、bootstrap、Pythonplatformruntime与显式authorizationbuildingblocks；具体entry/components/tests见[exportmanifest](export-manifest.json)。默认MCP四只读工具、Console生命周期对象管理不启用设备executionbackend。生产OAuth/Pagehosting/第二independenthardware不由源码搬迁完成。Core/API/permission与标准AIclient无关，不需OpenAI/ChatGPTconfig；专有profile/redirect/actor/scope只optional并保持exactbinding。细节见[操作参考](OPERATIONS.md)、[授权机制](AUTHORIZATION.md)、[迁移](MIGRATION.md)。

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

State transitions and evidence are stored together. A command exit code, installed package, active service or reachable transport alone never proves successful admission.

Core-owned identity/catalog proofs derive only from stored NodeIdentity/projection and cannot be forged through the public evidence endpoint. PROVISIONAL supports enrollment inspection only; full acceptance promotes it to ACTIVE. Core projection evidence does not replace binding to a real device/adapter or transport/control/convergence/reboot proofs.

### Known V0 limits

- real provider/device adapter security review is not complete;
- the Cloudflare API now has a fail-closed read-only/operator bearer boundary; production multi-user authentication/RBAC is not complete;
- the Cloudflare reference adapter demonstrates structure, not deployed production authority;
- V0 MCP is inspection-only;
- live canaries and threat-model review are release gates.


### Current source preview and optional modules

The public candidate includes typed control, bootstrap, Python platform runtimes and explicit authorization building blocks. See the [export manifest](export-manifest.json) for entries/components/tests. The default four read-only MCP tools and Console lifecycle-object management enable no device-execution backend. Source extraction does not complete production OAuth/Pages or independent second-device acceptance. Core/API/authority are standard AI-client-neutral without OpenAI/ChatGPT configuration; proprietary profile/redirect/actor/scope compatibility is optional and keeps exact binding. See [Operations](OPERATIONS.md), [Authorization](AUTHORIZATION.md) and [Migration](MIGRATION.md).
