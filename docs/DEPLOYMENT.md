# Cloudflare reference deployment

## 中文

Cloudflare Worker + Durable Object + 静态 Console 可以承载当前 GhostFleet。`/mcp` 是标准只读 Streamable HTTP 服务；`/v0/*` 是带独立 operator/read-only bearer 的对象 API。Cloudflare 负责控制面持久化和请求处理；ThinkPad 等设备还需真实 adapter/出站连接，不能因 Worker 已部署就认为完成纳管。

### 当前已验证

- Wrangler 4.147.0 CLI 可用。
- 官方 MCP SDK client 能在真实 workerd 中 initialize、listTools、callTool。
- 4 个 inspection 工具读取与 HTTP API 完全相同的节点状态。
- 未认证请求、未声明工具、额外参数和跨 Origin 请求被拒绝。
- 本地 Durable Object 重启后 MCP 与 HTTP 仍能读取同一持久状态。
- Worker deploy dry-run 打包通过；尚未创建线上 Worker URL。

### 授权前提

部署环境需要安全注入 `CLOUDFLARE_API_TOKEN` 和非秘密的 `CLOUDFLARE_ACCOUNT_ID`。Token 使用限制到目标账户的 Cloudflare 官方 Workers 编辑模板，并核对实际权限；不要使用全局 API Key。出站网络需要允许 `api.cloudflare.com`。不把凭据或真实账户 ID 放进开源配置。

检查授权和构建：

```sh
WRANGLER_LOG_PATH=.wrangler/cli.log npx --no-install wrangler whoami
npm ci
npm test
npm run check
npm run build:console
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=.wrangler/cli.log npm run build:worker
npm run verify:cloud
```

配置真实 Worker 的两个独立随机访问凭据，使用 Wrangler 的交互式 secret 输入，禁止把值写在 shell 命令中：

```sh
npx --no-install wrangler secret put GHOSTFLEET_READ_TOKEN
npx --no-install wrangler secret put GHOSTFLEET_OPERATOR_TOKEN
npx --no-install wrangler deploy
```

这是 effectful 部署步骤，必须在指定账户及部署授权已明确后执行。`.dev.vars` 仅用于本地模拟，不会自动成为线上秘密；不能把它作为公共 artifact 或提交。实际部署后再验证公开 HTTPS health、未登录 API 拒绝、Console 资源和持有只读凭据的 MCP 握手；不能把 dry-run 当成部署成功。

OAuth-dependent ChatGPT 连接仍需 OAuth 集成。Codex 等支持 bearer 的 MCP 客户端可连接 `/mcp`。当前工具只读，不能执行 ThinkPad 的安装、远程命令或真实纳管。

## English

The Cloudflare reference deployment hosts the Console, durable object API and a standard read-only Streamable HTTP MCP endpoint. It does not by itself install or control a ThinkPad. Deploy only after the target account and authority are established, use scoped API credentials and separate runtime bearer secrets, and validate the resulting HTTPS endpoint with the official client. Dry-run and local smoke results do not establish online deployment. OAuth-dependent clients need a separate OAuth integration.
