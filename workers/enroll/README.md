# ghostfleet-enroll (one-time enrollment bridge)

**中文**

唯一不需要 Access 登录的公开入口，只转发两条 POST：

- `POST /v1/enrollment-tickets/{ticket-id}/claim`
- `POST /v1/enroll/complete`

其余路径/方法一律 404/405。桥本身不认证、不签发、不保存任何材料：短码与 resume session 由私有控制面校验。控制面只经 Service Binding 调用，**不对公网暴露**。

## 配置面契约（私有部署只需写这些）

| 名称 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `GHOSTFLEET_CONTROL_PLANE` | service binding | **是** | 指向私有控制面 Worker；缺失时桥返回 503，绝不回退到任何公网地址 |
| `RATE_LIMITER_IP` | rate-limiting binding（`limit({key}) -> {success}`） | 否 | 按 `cf-connecting-ip` 的**派生摘要**限流；辅助维度 |
| `RATE_LIMITER_TICKET` | 同上 | 否 | 按 claim 路径里的 ticket id **派生摘要**限流；辅助维度 |

- **路由前缀**：只上述两条；host/custom domain/route 由部署方注入。`workers_dev: false`、`preview_urls: false` 已写死。
- **body 上限**（代码常量，不可配置）：claim **1024 B**、complete **262144 B**。超限直接 413，且在触碰 Service Binding 之前返回。
- **转发头白名单**（其余全部丢弃，包含 `cookie`/`authorization`/`cf-access-jwt-assertion`/`cf-connecting-ip`）：`content-type`、`x-ghostfleet-preflight-digest`、`x-fleet-os-family`、`x-fleet-os-id`。
- **错误码清单**：`NOT_FOUND`(404)、`METHOD_NOT_ALLOWED`(405)、`REQUEST_BODY_TOO_LARGE`(413)、`ENROLLMENT_RATE_LIMITED`(429，`retry_after_seconds: 30`)、`ENROLLMENT_BRIDGE_UNAVAILABLE`(503)；控制面的状态码与 JSON 原样透传。
- **限流语义是"辅助"**：binding 缺失、抛错、返回非法结构一律 **fail-open**（不能因为限流不可用就让合法首用挂掉）；限流通过**绝不等于授权**，票据仍须在控制面 claim 成功。key 只发送 `ip:`/`ticket:` + SHA-256 前 32 hex，地址与 ticket id 不落日志。
- **vendor 规则**：`src/index.js` 与本仓逐字节一致；私有仓只允许 `wrangler` 覆盖（routes/bindings/Access），不得改代码。

## English

The only public surface that needs no Access login. It forwards exactly two POST
routes (`.../claim` and `/v1/enroll/complete`); every other path or method is
404/405. The bridge does not authenticate, mint or store material — the private
control plane verifies the short code and resume session and is reached only
through the service binding.

**Configuration contract (all a deployment provides):** `GHOSTFLEET_CONTROL_PLANE`
(required service binding; 503 without it, never a public fallback);
`RATE_LIMITER_IP` and `RATE_LIMITER_TICKET` (optional rate-limiting bindings, both
advisory); only the two routes (host/route injected by the deployment;
`workers_dev`/`preview_urls` off); body limits are code constants (1 KiB claim,
256 KiB complete) and 413 happens before the binding; the forwarded-header
allowlist is the four names above; error codes are `NOT_FOUND`, `METHOD_NOT_ALLOWED`,
`REQUEST_BODY_TOO_LARGE`, `ENROLLMENT_RATE_LIMITED` (429, `retry_after_seconds: 30`)
and `ENROLLMENT_BRIDGE_UNAVAILABLE`; upstream status and JSON pass through.

Rate limiting is advisory only: a missing, failing or malformed limiter fails
open, and a limiter success is never authorization. Keys are `ip:`/`ticket:` plus
the first 32 hex of a SHA-256 digest; neither the address nor the ticket id is
logged. `src/index.js` is vendored byte for byte; a private repo may only overlay
`wrangler` configuration.
