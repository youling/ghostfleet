# Getting started / 快速开始

## 中文

<!-- topic:requirements -->
### 环境和权限

需要 Node.js 22+、npm 和 Git。当前交付是源码开发版本，不是已发布到 npm 的插件。HTTP、Console 和 MCP 主流程无需 ChatGPT/OpenAI 账号、API key、真实节点或私仓权限。Python 和类型化控制是可选模块，安装前阅读 [平台与运行时](PLATFORMS.md)。

本地开发默认只监听 loopback。设备、提供方、生产云资源操作及旧实现删除分别需要对应授权和验收；安装本地预览不会授予这些权限。

<!-- topic:startup -->
### 安装并启动无设备预览

源码预览已合并到本仓 `main`。以下命令获取默认分支；审阅指定版本时，另使用审阅要求的精确提交。源码预览和正式稳定发布分别验收。

```sh
git clone https://github.com/youling/ghostfleet.git
cd ghostfleet
npm ci
npm test
npm run check
npm run build:console
npm run dev:init
npm run dev
```

保持启动终端运行，在同一机器打开 `http://127.0.0.1:8791/`。`dev:init` 排他创建本地随机的 read/operator 凭据，已有文件则保留，不打印值、不联系设备、不生成提供方凭据。`.dev.vars` 是忽略提交的本地秘密状态，不能进入演示、日志或仓库。操作系统权限及 Windows ACL 仍由本地责任方核对。连接 Console 使用此控制面的只读令牌，不能输入提供方或 SSH 私钥。

<!-- topic:verify -->
### 验证和会话

在 Linux 的另一个终端执行 `npm run verify:cloud`，在隔离的本地参考环境验证标准 MCP 客户端、API 和持久化。该命令明确要求 Linux。Windows 使用跨平台核心测试和 `npm run verify:ai-client-neutral`，Cloudflare 运行时证明由所选提交的 Linux CI 提供；平台拒绝不是通过。`npm run check:publication` 与 `npm run check:docs` 检查可公开状态及文档结构；它们不是生产部署或真机纳管证明。

Console 默认中文，可切换 English。只读会话不能变更记录；操作员令牌可管理控制面记录、纳管和 HumanGate，但默认没有设备执行能力。合成演示状态不能当作设备在线或准入证据。标准 [HTTP API](API.md) 和 [MCP](MCP.md) 读取同一控制面对象；多客户端独立验证使用 `npm run verify:ai-client-neutral`。

<!-- topic:recovery -->
### 停止、恢复和故障处理

在启动终端使用 Ctrl+C 停止。重新执行 `npm run dev` 复用原本的本地持久化状态；不要删除目录来掩盖身份冲突。重新加载浏览器可能需要重新连接会话。端口被占用时，先核对进程归属，再调整本任务端口，不能终止不属于本任务的进程。

遇到 `401/403`，核对当前令牌、权限范围和请求。Origin 被拒绝时使用同源 Console 或部署明确允许的来源，不用通配符绕过。`RECONCILE_REQUIRED/UNKNOWN` 要求对账，不能盲目重发副作用。见 [测试](TESTING.md)、[部署](DEPLOYMENT.md) 和 [恢复](RECOVERY.md)。

## English

<!-- topic:requirements -->
### Requirements and authority

Use Node.js 22+, npm and Git. This delivery is a source checkout and development version, not a published npm plugin; package manifests determine publishability. The HTTP, Console and MCP paths require no ChatGPT/OpenAI account, API key, real device or private-repository access. Python and typed control are optional; read [Platforms and runtimes](PLATFORMS.md) before installing them.

The source preview is merged into this repository's `main` branch. The commands below obtain the default branch; review a specific version at its requested exact commit. Source-preview acceptance and formal stable release remain separate. Local development listens on loopback. Device/provider operations, production cloud changes and deletion of the previous implementation require separate authority and capability acceptance.

<!-- topic:startup -->
### Install and start a device-free preview

```sh
git clone https://github.com/youling/ghostfleet.git
cd ghostfleet
npm ci
npm test
npm run check
npm run build:console
npm run dev:init
npm run dev
```

Keep the process running and open `http://127.0.0.1:8791/` on the same machine. `dev:init` creates separate random read/operator credentials locally; its script defines the precise output and file handling. It does not contact hardware or create provider credentials. Operating-system permissions and Windows ACLs still need local owner verification. `.dev.vars` is private local state: never commit it or copy it into demonstrations or logs. Use the read credential through your protected local Console session; never enter a provider or SSH private key into the Console.

<!-- topic:verify -->
### Validation and sessions

On Linux, run `npm run verify:cloud` from another terminal to verify the official MCP client, API and persistence in an isolated local reference environment. This command explicitly requires Linux. On Windows, use the cross-platform core tests and `npm run verify:ai-client-neutral`; Cloudflare runtime proof comes from Linux CI for the selected revision, and platform rejection is not a pass. Run `npm run check:publication` and `npm run check:docs` for publication and documentation structure checks; these do not prove production deployment or hardware admission.

The Console defaults to Chinese and supports English. Mutation buttons are disabled in a read-only session. Operators can manage lifecycle/enrollment/HumanGate records, without default device execution. Actual independent MCP client validation uses `npm run verify:ai-client-neutral`. Synthetic preview state does not prove device connectivity or admission. See [API](API.md) for standard HTTP clients and [MCP](MCP.md) for standard MCP clients; both observe the same control-plane objects.

<!-- topic:recovery -->
### Stop, recover and troubleshoot

Stop with Ctrl+C in the terminal that started the process. Restart `npm run dev` to reuse local persisted state; do not delete state to hide identity conflicts. Reloading the browser may require reconnecting the session. Check process ownership before resolving a port conflict or changing this task's port; do not stop unrelated processes.

For `401/403`, check the configured read/operator scope and request. For rejected `Origin`, use the same-origin Console or the deployment's explicit allowed origins; never bypass the boundary with a wildcard. `RECONCILE_REQUIRED/UNKNOWN` requires reconciliation, not blind replay of effects. See [Testing](TESTING.md) and [Recovery](RECOVERY.md) for platform and toolchain issues.
