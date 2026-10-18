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

打开现有 Control Panel 时，浏览器对已有 `GET /v0/access` 进行一次**无 Bearer、只读**状态查询。只有服务端返回严格的 `503 AUTH_NOT_CONFIGURED`，才显示“控制平面尚未初始化”；若返回 `401 UNAUTHORIZED`，显示需提供 GhostFleet Operator/Read 令牌。Cloudflare Access 登录/跳转、HTML、超时、异常 JSON 和其它状态均显示“未核实”，绝不伪造 `PANEL_PROTECTED`、认证成功或 Provider READY。界面不收集 Cloudflare 部署凭据，不允许初始化根密钥，也不自动重试外部写入；初始生产根凭据须经实例所有者独立原生安全流程。

On first load, the existing Console makes **one anonymous GET** to the existing `/v0/access` endpoint, with no bearer token. Only an exact `503 AUTH_NOT_CONFIGURED` response classifies the service as `NOT_INITIALIZED`; an exact `401 UNAUTHORIZED` means a GhostFleet Operator/Read token is required. Login redirects, HTML, timeouts, malformed bodies and other responses are `UNKNOWN`, never proof of Cloudflare Access protection, authentication or provider readiness. The Console neither accepts nor creates deployment root credentials; those belong to a separately authorized owner-native setup.
