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

`Provider READY` 不等于“Cloudflare Service Binding 存在”或“Client ID/Secret 名称存在”。公共 `/v0/providers/setup` 只有收到私有可信服务的如下**严格回执**，才显示 `READY`：

- `authority.scope === "auth_keys"`，`authority.tag === "tag:fleet-ssh-target"`。
- `authority.verification = { type: "tailscale-oauth-token-scope/v1", status: "VERIFIED", granted_scope: "auth_keys", requested_tag: "tag:fleet-ssh-target", verified_at: "<ISO UTC>" }`。
- `verification` 必须由私有服务真实调用 Tailscale OAuth token endpoint、核对**实际返回的**单一 scope 和该次固定 tag 请求后生成；**禁止**从预期常量拼出“已验证”对象。
- GET `/readiness` 的核验数据位于 `authority.verification`；POST `/v1/provider/tailscale/setup` 的成功响应沿用顶层 `scope`、`tag`，并新增顶层 `verification` 同形回执。缺少任一字段时，公共 API 不会返回 `READY`。
- 同时需要两项受保护凭据存在、`authority.provider === "tailscale"`、Authority generation 非 `MISSING` 且满足 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；任何缺失、超范围、错误标签或未证明的验证都不得显示 `READY`。
- 两项密文均存在但 scope / generation / provider / verification 任一项无效时，显示 `CONFIGURED_UNVERIFIED`，不提供“再提交一次”按钮；由账户所有者通过当前私有记录和原生渠道核验。缺少凭据时为 `MISSING`。
- 私有 POST 仅在 `HTTP 200`、`ok:true`、正确 Provider / 合同 Generation / scope / tag / verification 全部匹配时返回成功。畸形 2xx、未知 4xx、408、5xx、无法解析的响应都统一返回 `503 PROVIDER_AUTHORITY_SETUP_UNKNOWN`；仅保留明确的 400 输入错误和 409 `PROVIDER_CREDENTIAL_REJECTED`，绝不原样转发私有错误文本或秘密内容。由于密文可能已写入，浏览器不得盲目重试。

**证据限制：** 上述验证回执是私有服务对**配置时**的 OAuth token response 的安全声明，不是签名证明，更不代表该凭据此刻没有被撤销。签发一次性纳管凭据时仍须由私有服务重新取得当前 Token、独立验证响应和严格限制 tag。此公共产品不存储原始 Token，不把 Access 身份视为 Operator，也不能替代 Fleet 部署账户与节点验收。

Provider `READY` now requires a trusted private-service receipt of the **actual granted OAuth token scope** (exactly `auth_keys`) and the exact requested tag. Presence of credential names or a generation value alone is insufficient. Missing or invalid evidence yields `CONFIGURED_UNVERIFIED` when credentials are present, without a blind-resubmit action; `MISSING` indicates absent configuration. The verification receipt is **configuration-time evidence**, not continuous proof of provider validity: one-time key issuance must independently revalidate current Tailscale authority. The private GET readiness response carries `authority.verification`; the private POST setup response carries matching top-level `scope`, `tag` and `verification`. A narrowed access token also **does not prove** the OAuth client's maximum configured grants are narrow; the account owner must check authorized client scopes/tags in the native Tailscale account. A successful-looking private write without that receipt is `PROVIDER_AUTHORITY_SETUP_UNKNOWN`, not a public READY response.


### 时效与跨仓发行门 / Freshness and release dependency

`verification.verified_at` 使用标准 UTC ISO 格式（含毫秒及 `Z`），只能在**过去 24 小时内**且不得超过当前时间未来 60 秒。超过窗口即 `CONFIGURED_UNVERIFIED`；这只是控制台回执的显示时效，**不代表现在的 OAuth 权限仍有效或客户端最大授权范围已收窄**。配置时核验可能在下一天失效，账户所有者需要通过私有服务的只读核验流程取得新回执，不得反复提交 Client Secret 作为“刷新”。跨 generation/credential 的证明绑定及长期状态演化，仍须 Fleet owner 单独设计、评审。

**发布门禁顺序：** 先在 `youling/ai-hub#297/#298` 实现并独立审核真正的 Tailscale OAuth token scope 校验、持久化实际测得的 `authority.verification`、readiness 与 POST 回执，证明没有常量伪证和 scope 过宽；再将本公共 PR 作为新的 accepted public source pin 集成、独立检查 Access/Worker/绑定/回滚并按 Fleet 权限部署。仅合并本 PR 不会自动令现有私有 adapter 兼容；否则配置后的 Provider 将安全地停留在 `CONFIGURED_UNVERIFIED`。旧 `workers.dev`/Preview 绕行及 private readiness CI blocker 仍由 Fleet 负责。

The proof is presentation-fresh for at most 24 hours and at most 60 seconds into the future; it is **not** continuous OAuth validity evidence or an account-wide scope guarantee. The private adapter must implement and independently test the real-scope verification contract **before public production activation**. A private-service mismatch must fail closed, not prompt renewed credential submission; Fleet owns source pin, deployment guards, Access, rollback, and native-account checks.
