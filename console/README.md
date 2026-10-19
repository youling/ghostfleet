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
- 同时需要两项受保护凭据存在、Authority generation 有效；任何缺失、超范围、错误标签或未证明的验证都不得显示 `READY`。
- 仅存储存在而未验证时，显示 `CONFIGURED_UNVERIFIED`，不提供“再提交一次”按钮；由账户所有者通过当前私有记录和原生渠道核验。缺少凭据仍为 `MISSING`。
- 初始私有写入即使返回成功，缺少严格回执时公共 API 返回 `PROVIDER_AUTHORITY_SETUP_UNKNOWN`，不能由浏览器盲目重复提交。

**证据限制：** 上述验证回执是私有服务对**配置时**的 OAuth token response 的安全声明，不是签名证明，更不代表该凭据此刻没有被撤销。签发一次性纳管凭据时仍须由私有服务重新取得当前 Token、独立验证响应和严格限制 tag。此公共产品不存储原始 Token，不把 Access 身份视为 Operator，也不能替代 Fleet 部署账户与节点验收。

Provider `READY` now requires a trusted private-service receipt of the **actual granted OAuth token scope** (exactly `auth_keys`) and the exact requested tag. Presence of credential names or a generation value alone is insufficient. Missing or invalid evidence yields `CONFIGURED_UNVERIFIED` when credentials are present, without a blind-resubmit action; `MISSING` indicates absent configuration. The verification receipt is **configuration-time evidence**, not continuous proof of provider validity: one-time key issuance must independently revalidate current Tailscale authority. A successful-looking private write without that receipt is `PROVIDER_AUTHORITY_SETUP_UNKNOWN`, not a public READY response.
