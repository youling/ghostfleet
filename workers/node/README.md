# ghostfleet-node-plane (node agent ingress bridge)

**中文**

承载节点 Agent 凭据的公开入口。只转发三条 POST（ADR `docs/architecture/NODE_AGENT_V0.md` §5.2/§5.4）：

- `POST /v0/nodes/{node_uid}/heartbeat`
- `POST /v0/nodes/{node_uid}/tasks/poll`
- `POST /v0/nodes/{node_uid}/tasks/{task_id}/result`

其余路径/方法（含任何 query string）一律 **404**，不返回 405，因此不确认路由是否存在。桥本身不认证：节点 token 的摘要、node 作用域、时钟、重放窗口与限流都由私有控制面在单个持久对象内校验。控制面只经 Service Binding 调用，**不对公网暴露**。

## 配置面契约（私有部署只需写这些）

| 名称 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `GHOSTFLEET_CONTROL_PLANE` | service binding | **是** | 指向私有控制面 Worker；缺失时桥返回 503 `NODE_PLANE_NOT_CONFIGURED`，绝不回退到任何公网地址 |
| `NODE_PLANE_RATE_LIMITER` | rate-limiting binding（`limit({key}) -> {success}`） | 否 | 按 node_uid 的**派生摘要**限流；辅助维度，失败即放行 |

- **路由**：只有上述三条，且 node_uid / task_id 必须是 `[a-z0-9][a-z0-9_-]{0,63}`；大写、百分号编码或其它字符都不匹配。host/custom domain/route 由部署方注入；`workers_dev: false`、`preview_urls: false` 已写死。
- **Content-Type（强校验）**：必须是 `application/json`；允许 `; charset=...` 等参数与大小写差异（只比较媒体类型）。缺失或不匹配直接 **415 `UNSUPPORTED_CONTENT_TYPE`**，发生在读取 body 与触碰 Service Binding 之前。
- **body 上限**（代码常量，不可配置，与 §5.1 一致）：heartbeat **16384 B**、poll **4096 B**、result **65536 B**。超限直接 **413 `NODE_BODY_TOO_LARGE`**，且在触碰 Service Binding 之前返回；控制面会以同一错误码再判一次。
- **转发头白名单**（其余全部丢弃，包含 `cookie`、`cf-access-jwt-assertion`、`cf-connecting-ip`、`x-forwarded-for`）：`authorization`、`content-type`、`x-ghostfleet-node-uid`、`x-ghostfleet-agent-version`。
- **响应**：只透传上游的 `content-type` 与 `retry-after`，并固定加 `cache-control: no-store` 与 `x-content-type-options: nosniff`；上游状态码与 JSON 原样返回。
- **错误码清单**：`NOT_FOUND`(404)、`NODE_BODY_TOO_LARGE`(413)、`UNSUPPORTED_CONTENT_TYPE`(415)、`NODE_RATE_LIMITED`(429，`retry_after_seconds: 10`)、`NODE_PLANE_NOT_CONFIGURED`(503)、`NODE_PLANE_UNAVAILABLE`(503)。
- **限流语义是"辅助"**：binding 缺失、抛错、WebCrypto 不可用、返回非法结构一律 **fail-open**；限流通过**绝不等于授权**，节点请求仍须在控制面通过 token 校验。key 只发送 `node:` + SHA-256 前 32 hex。
- **vendor 规则**：`src/index.js` 与本仓逐字节一致；私有仓只允许 `wrangler` 覆盖（routes/bindings），不得改代码。

## English

The public surface that carries the node credential. It forwards exactly three
POST routes (heartbeat, tasks/poll and tasks/{task_id}/result, §5.2/§5.4); every
other path or method — including any query string — is a flat 404, so the bridge
never confirms which routes exist. It does not authenticate: the control plane
verifies the token digest, node scope, clock, replay window and rate limit inside
its single durable object, and is reached only through the service binding.

**Configuration contract:** `GHOSTFLEET_CONTROL_PLANE` (required service binding;
503 `NODE_PLANE_NOT_CONFIGURED` without it, never a public fallback) and
`NODE_PLANE_RATE_LIMITER` (optional advisory binding keyed by a digest of the
node uid). Only the three routes exist, with node_uid/task_id restricted to
`[a-z0-9][a-z0-9_-]{0,63}`; `workers_dev`/`preview_urls` are off. The media type
must be `application/json` (parameters accepted), else 415 before the body read
and the binding. Body limits are code constants matching §5.1: 16 KiB heartbeat,
4 KiB poll, 64 KiB result, else 413 `NODE_BODY_TOO_LARGE` before the binding. Only
`authorization`, `content-type`, `x-ghostfleet-node-uid` and
`x-ghostfleet-agent-version` are forwarded; everything else (`cookie`,
`cf-access-jwt-assertion`, `cf-connecting-ip`, `x-forwarded-for`) is dropped. The
response passes only `content-type` and `retry-after` plus fixed
`cache-control: no-store` and `x-content-type-options: nosniff`. Error codes:
`NOT_FOUND`, `NODE_BODY_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`,
`NODE_RATE_LIMITED` (429 with `retry_after_seconds: 10`),
`NODE_PLANE_NOT_CONFIGURED`, `NODE_PLANE_UNAVAILABLE`. A limiter success is never
authorization. `src/index.js` is vendored byte for byte.
