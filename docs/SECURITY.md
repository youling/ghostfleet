# GhostFleet Security Model — V0

status: `DRAFT_IMPLEMENTED_BOUNDARIES`

## 中文版

### 核心原则

1. **Bootstrap identity 不等于 operational authority。** 新节点获得入列所需最小能力，不自动获得更高权限。
2. **UI 不持有 provider root credential。** Console 只处理 public-safe object、HumanGate 和 reference。
3. **节点获得 capability/reference，而不是 fleet-wide credential。**
4. **不确定结果必须 reconcile。** 可能已发生副作用的操作不得 blind retry。
5. **HumanGate 是 durable state。** 敏感批准不依赖聊天记忆。
6. **Evidence collection 不等于 universal audit gate。** 对 fresh/rebuildable 节点优先幂等 convergence + verification。
7. **临时 first-contact transport 不是 durable identity。** 调试路径不能变成产品依赖。

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

Core 对 evidence/metadata 做 secret-bearing field guard。允许 `*_ref` / `*_id`，拒绝 raw secret/token/password/private-key/credential 字段进入公共状态。

这不是完整 DLP，也不替代 adapter 层 secret custody；它是“不要把 raw secret 变成生命周期对象字段”的第二道防线。

### HumanGate

V0 HumanGate 至少包含：gate_id、gate_type、subject、state、prompt、expires_at、resumable。

短码属于对应 enrollment ceremony/attempt，不属于 durable NodeIdentity。

### Evidence

状态迁移和 evidence 同时保存。每个 required evidence 类型的最新观测必须显式为 `data.status = PASS`；新的 FAIL/UNKNOWN 使旧 PASS 失效。Command exit=0、包已安装、服务 active、网络可达等单独事实都不能自动推导“纳管成功”。真实 adapter 仍需校验 evidence 来源、subject 和权限；合成证据不证明真实设备。

### Known V0 limits

- 尚未完成真实 provider/device adapter security review；
- Cloudflare 参考 API 已有 fail-closed 的 read-only/operator bearer 边界；尚未完成生产级多用户 authentication/RBAC；
- Cloudflare reference adapter 是结构证明，不代表已部署生产 authority；
- MCP V0 仅开放 inspection surface；
- 正式 release 前必须完成 live canary 和 threat-model review。

---

## English Version

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

### Known V0 limits

- real provider/device adapter security review is not complete;
- the Cloudflare API now has a fail-closed read-only/operator bearer boundary; production multi-user authentication/RBAC is not complete;
- the Cloudflare reference adapter demonstrates structure, not deployed production authority;
- V0 MCP is inspection-only;
- live canaries and threat-model review are release gates.
