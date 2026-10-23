# GhostFleet 控制面板 / Control Panel

## 中文

`console/` 是 GhostFleet 面向 Human 的 canonical Control Panel 产品目录。

```text
console/
  index.html              # 页面入口
  app.js                  # 当前装配/编排入口
  shared/                 # 复用展示基础
  enrollment/             # 纳管 UX 与管理模板
  nodes/                  # 节点列表与详情
  capabilities/           # 能力目录
  privilege/              # JIT 提权审批与租约
  recovery/               # 恢复与 break-glass
  settings/               # 控制面板设置
```

这些产品域目录先冻结 ownership 与未来落点，不代表对应功能已经实现。它们不得建立第二套 lifecycle、authority、secret vault 或 backend。服务端事实仍由 `src/core`、`src/control-plane`、adapters 与 integrations 持有。

后续 Control Panel 功能应进入最窄的 owning domain，避免继续把所有逻辑堆进 `app.js`。

## English

`console/` is the canonical Human-facing GhostFleet Control Panel product surface. The domain directories reserve ownership and future placement only; they do not create a second lifecycle, authority store, secret vault, or backend. Server-side truth remains under `src/core`, `src/control-plane`, adapters and integrations.

New Control Panel features should land in the narrowest owning domain rather than growing `app.js` indefinitely.

## 首次使用状态 / First-use status

打开现有 Control Panel 时，浏览器对已有 `GET /v0/access` 进行一次**无 Bearer、只读**状态查询。只有服务端返回严格的 `503 AUTH_NOT_CONFIGURED`，才显示“控制平面尚未初始化”；若返回 `401 UNAUTHORIZED`，显示需提供 GhostFleet Operator/Read 令牌。Cloudflare Access 登录/跳转、HTML、超时、异常 JSON 和其它状态均显示“未核实”，绝不伪造 `PANEL_PROTECTED`、认证成功或 Provider READY。界面的访问令牌字段只用于现有 GhostFleet Operator/Read 登录，不接受 Cloudflare/Tailscale 管理凭据，也不创建任何初始根令牌，也不自动重试外部写入；初始生产根凭据须经实例所有者独立原生安全流程。

On first load, the existing Console makes **one anonymous GET** to the existing `/v0/access` endpoint, with no bearer token. Only an exact `503 AUTH_NOT_CONFIGURED` response classifies the service as `NOT_INITIALIZED`; an exact `401 UNAUTHORIZED` means a GhostFleet Operator/Read token is required. Login redirects, HTML, timeouts, malformed bodies and other responses are `UNKNOWN`, never proof of Cloudflare Access protection, authentication or provider readiness. The Console's token field accepts existing GhostFleet Operator/Read login tokens only. It neither accepts Cloudflare/Tailscale deployment-admin credentials nor creates initial root tokens; those belong to a separately authorized owner-native setup.


## Provider 授权核验 / Provider authority verification

`Provider READY` 必须有私有可信服务的**真实 OAuth token 响应核验回执**，不能由 Service Binding、Client ID/Secret 的存在或固定常量推导。

- 一次性纳管密钥操作要求访问令牌**包含** `auth_keys` 和当前选定的 `tag:<deployment-chosen>`。Client 可有其他组织已批准的 scope，不能因它们存在而拒绝；不得把某次 token scope 子集冒充 Client 的最大授权范围。
- 私有 GET `/readiness` 返回 `authority.scope`、`authority.tag` 和 `authority.verification = { type: "tailscale-oauth-token-scope/v1", status: "VERIFIED", granted_scope: "auth_keys devices", requested_tag: "tag:example-enroll", verified_at: "<ISO UTC>" }`（示意，不是固定值）。scope 必须是实际观察到的 token scope，且与回执集合一致；tag 与本次请求/可选部署选定标签一致。公有侧绝不填造 scope、tag 或 proof。
- 凭据均明确不存在才是 `MISSING`；存在凭据但回执无效是 `CONFIGURED_UNVERIFIED`；服务不可用、返回畸形数据或无法判断凭据是否存在时是 `SERVICE_UNKNOWN`，**均不得误给再次提交按钮**。显示的实际 scope 仅来自已核验回执。
- Authority generation 必须满足 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。一次性签发时仍须复验当前操作的 scope/tag/主体、策略与防重放；配置时的 `READY` 不是当前可任意执行的授权。
- 私有 POST `/v1/provider/tailscale/setup` 的 `HTTP 200`、`ok:true`、正确 Provider/Generation/实际 scope/tag/验证回执必须同时成立才返回 `READY`。未证明的成功、畸形 2xx、未知 4xx、408、5xx 和解析失败全部 `503 PROVIDER_AUTHORITY_SETUP_UNKNOWN`；仅固定确定性输入拒绝可以原码传回，绝不回显秘密或任意私有错误。
- 不在公共代码硬编码组织特定标签；部署可通过 `GHOSTFLEET_ENROLL_TAG` 明确要求当前标签，或由私有已核验回执表达本次选定标签。无当前可信配置/回执即不授予执行。

**Evidence limit:** Scope proof describes the *actual access token observed at setup*, not the OAuth client's maximum possible grants, an active authorization forever, or production credential custody. The private adapter must revalidate the current token's scope, selected tag and authority before every real key mint. A broader organization OAuth scope is allowed when it still proves `auth_keys` for this operation. Tokens and secrets never enter public lifecycle state. Service unavailability is `SERVICE_UNKNOWN`, not `MISSING`; do not blindly resubmit credentials.

### 时效与跨仓发行门 / Freshness and release dependency

`verification.verified_at` 使用标准 UTC ISO 格式（含毫秒及 `Z`），只能在**过去 24 小时内**且不得超过当前时间未来 60 秒。超过窗口即 `CONFIGURED_UNVERIFIED`；这只是控制台回执的显示时效，**不代表现在的 OAuth 权限仍有效或客户端最大授权范围已收窄**。配置时核验可能在下一天失效，账户所有者需要通过私有服务的只读核验流程取得新回执，不得反复提交 Client Secret 作为“刷新”。跨 generation/credential 的证明绑定及长期状态演化，仍须 Fleet owner 单独设计、评审。

**发布门禁顺序：** 先在 `youling/ai-hub#297/#298` 实现并独立审核真正的 Tailscale OAuth token scope 校验、持久化实际测得的 `authority.verification`、readiness 与 POST 回执，证明没有常量伪证、真实 scope 集合可信且当前操作需要的能力已获授权；再将本公共 PR 作为新的 accepted public source pin 集成、独立检查 Access/Worker/绑定/回滚并按 Fleet 权限部署。仅合并本 PR 不会自动令现有私有 adapter 兼容；否则配置后的 Provider 将安全地停留在 `CONFIGURED_UNVERIFIED`。旧 `workers.dev`/Preview 绕行及 private readiness CI blocker 仍由 Fleet 负责。

The proof is presentation-fresh for at most 24 hours and at most 60 seconds into the future; it is **not** continuous OAuth validity evidence or an account-wide scope guarantee. The private adapter must implement and independently test the real-scope verification contract **before public production activation**. A private-service mismatch must fail closed, not prompt renewed credential submission; Fleet owns source pin, deployment guards, Access, rollback, and native-account checks.
