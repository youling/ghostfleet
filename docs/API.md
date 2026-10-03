# GhostFleet V0 HTTP API

## 中文版

V0 API 是 lifecycle/control-plane contract，不是 provider credential API。

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

### Capability metadata

- `POST /v0/capabilities` registers an adapter capability definition.

A capability definition contains only id, R0/R1/R2 risk class, description and adapter contract. V0 Core does not use this endpoint to distribute raw credentials or expose a universal remote-execution primitive.

### Error semantics

- lifecycle skip → `INVALID_TRANSITION`;
- incomplete evidence → `ACCEPTANCE_EVIDENCE_MISSING` + `missing[]`;
- ambiguous external outcome → explicit `RECONCILE_REQUIRED` state instead of client-side blind retry.
