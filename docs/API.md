# GhostFleet V0 HTTP API

## 中文版

V0 API 是 lifecycle/control-plane contract，不是 provider credential API。

Cloudflare 参考宿主另提供 `GET /v0/access`，返回当前已认证 bearer 的 `access: "operator" | "read_only"`，用于 Console 展示权限；无凭据、无效凭据及只读变更仍由服务端拒绝。该响应设置 `Cache-Control: no-store`，不访问设备存储。其他宿主提供 Console 时需实现同样的认证元数据接口；core HTTP handler 自身不推断凭据。

### Read

- `GET /healthz`
- `GET /v0/nodes`
- `GET /v0/enrollment-attempts`
- `GET /v0/enrollment-attempts/:attempt_id`
- `GET /v0/human-gates`
- `GET /v0/events`
- `GET /v0/capabilities`

### Lifecycle mutation

- `POST /v0/enrollment-attempts` — 创建 attempt；
- `POST /v0/enrollment-attempts/:id/prepare`；
- `POST /v0/enrollment-attempts/:id/human-gates`；
- `POST /v0/human-gates/:gate_id/resolve`；
- `POST /v0/enrollment-attempts/:id/claim`；
- `POST /v0/enrollment-attempts/:id/materialize`；
- `POST /v0/enrollment-attempts/:id/evidence`；
- `POST /v0/enrollment-attempts/:id/reconcile-required`；
- `POST /v0/enrollment-attempts/:id/reconcile`；
- `POST /v0/enrollment-attempts/:id/accept`。

`materialize` 可接收 `{ "node_id": "lab-device", "platform": "linux" }`，返回带稳定 `node_uid` 的 attempt；`GET /v0/nodes` 同时暴露 PROVISIONAL 投影。该身份尚未完成验收、没有 operational authority。identity/catalog 证据由 core 生成，`evidence` 拒绝这两类输入及伪造的 `ghostfleet-core` 来源。`accept` 不 mint 新身份；可省略 body，兼容的 node_id/platform 参数只能匹配 materialize 时的值。旧的“accept 时设置身份”调用需迁移到 materialize。

### Capability metadata

- `POST /v0/capabilities` 注册 adapter capability definition。

Capability definition 仅描述 id、R0/R1/R2 风险级别、说明和 adapter contract。V0 Core 不通过这个接口下发 raw credential 或万能远程执行。

### Error semantics

- lifecycle 跳步 → `INVALID_TRANSITION`；
- 证据不足 → `ACCEPTANCE_EVIDENCE_MISSING` + `missing[]`；
- 外部结果不确定 → 显式进入 `RECONCILE_REQUIRED`，而不是客户端 blind retry。

---

## English Version

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

### Capability metadata

- `POST /v0/capabilities` registers an adapter capability definition.

A capability definition contains only id, R0/R1/R2 risk class, description and adapter contract. V0 Core does not use this endpoint to distribute raw credentials or expose a universal remote-execution primitive.

### Error semantics

- lifecycle skip → `INVALID_TRANSITION`;
- incomplete evidence → `ACCEPTANCE_EVIDENCE_MISSING` + `missing[]`;
- ambiguous external outcome → explicit `RECONCILE_REQUIRED` state instead of client-side blind retry.
