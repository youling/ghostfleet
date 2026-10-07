# Reference deployment / 参考部署

## 中文

<!-- topic:architecture -->
### Worker / DO / Console 一体化宿主

GhostFleet 的 canonical Cloudflare 部署形态是 **一个 Worker deployment 同时承载静态 Console、API/MCP 与 SQLite Durable Object lifecycle state**。根 `wrangler.jsonc` 已通过 Static Assets binding 从 `dist/console` 提供控制台构建产物；API、MCP、bootstrap 与 Console 因而可以使用同一 HTTPS origin、同一发布版本和同一回滚坐标。

生产部署不以 GitHub Pages 作为 canonical Control Panel 宿主。Pages 可用于文档、公开演示或独立静态预览，但把生产 Console 拆到 Pages 会额外引入前端/API 版本漂移、跨域/CORS、两套发布与回滚坐标，而不会减少 Worker/DO 的必要性。

部署方可以通过非秘密 deployment config 扩展模板目录，并通过私有 Service Binding 接入 provider-specific authority/materializer。公共 GhostFleet 源码仍保持 provider-neutral；真实 service 名称、私有 catalog、账号坐标与 secret custody 属于 deployment owner。

宿主部署成功本身不安装设备、不授予执行权限，也不证明真实节点验收。

<!-- topic:build -->
### 本地验证与 dry-run

使用 Node.js 22+ 和 Python 3.10+；先选定本次使用的 Python 环境，再安装测试扩展。以下命令中的 `python` 必须指向同一环境。

```sh
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
npm run build:console
npm run build:typed
npm run build:worker
npm run verify:ai-client-neutral
```

仅在 Linux 上再运行 `npm run verify:cloud`。Windows 使用上面的 `verify:ai-client-neutral` 检查标准客户端路径；Linux 专用检查的结果须另行核对对应提交的 Linux CI，不能计为 Windows 本机通过。

`build:worker` 仅通过 Wrangler dry-run 打包；本地验证使用隔离的 workerd、Durable Object 和合成样本。CLI 可用、软件包构建、本地重启或静态预览均不构成生产验收。公开 CI 不部署，也不需要提供方或账户秘密。

<!-- topic:secrets -->
### 授权与配置

在已授权的目标账户中，通过 Cloudflare 原生流程配置限定权限的 API 凭据；不使用全局 API 密钥，不将账户 ID 或秘密提交到公开配置。部署操作员须核对实际的 Workers、Durable Object、静态资源和迁移权限。用 Wrangler 交互式秘密输入配置两个独立随机的控制面访问令牌：

```sh
npx --no-install wrangler secret put GHOSTFLEET_READ_TOKEN
npx --no-install wrangler secret put GHOSTFLEET_OPERATOR_TOKEN
npx --no-install wrangler deploy
```

这些步骤会产生实际变更，只有目标账户、部署授权与审阅条件均已满足时才执行，不属于公开 CI。`.dev.vars` 仅用于本地，不会自动成为生产秘密。令牌不得放入命令行参数或静态资源；提供方和设备凭据须单独托管。

<!-- topic:acceptance -->
### 线上验收和回滚

部署后验证 HTTPS 健康检查、未登录请求拒绝、只读身份变更拒绝、同源控制台、官方标准 MCP 客户端的 initialize/list/call，以及 Durable Object 重启后身份与当前提交一致。多客户端、RBAC/OAuth、回执注入与可信写入方、凭据托管与撤销、日志和产物审查须分别验收；访问令牌原型不证明生产身份体系完整。

记录当前 Worker 版本、Durable Object schema/迁移和控制台构建版本。回滚前确认状态兼容，先停止副作用派发，再只读对账，保留原身份及访问路径。第二独立硬件/重建和独立调用方切换仍须各自验收，Pages 或宿主上线不能替代设备试验。控制面 `ACTIVE` 与七项证据仅证明本控制面的准入；每个独立调用方还须验证同一身份在其目录中可发现、认证配置和调用路由可用、正负权限及回滚通过。

## English

<!-- topic:architecture -->
### Integrated Worker / DO / Console hosting

The canonical Cloudflare deployment is **one Worker deployment serving static Console assets, API/MCP and the SQLite Durable Object lifecycle state together**. The root `wrangler.jsonc` already serves `dist/console` through a Static Assets binding, so Console, API, MCP and bootstrap can share one HTTPS origin, one source revision and one rollback coordinate.

GitHub Pages is not the canonical production Control Panel host. It remains suitable for documentation, public demos or isolated static previews. Splitting the production Console onto Pages would add frontend/API version drift, CORS/origin policy and a second deployment/rollback coordinate while the Worker/DO would still be required.

Deployment owners may supply non-secret catalog extensions and attach provider-specific authority/materializers through private Service Bindings. Public GhostFleet remains provider-neutral; concrete service names, private catalogs, account coordinates and secret custody belong to the deployment owner.

A successful host deployment still does not install a device, grant execution authority or prove real-node acceptance.

<!-- topic:build -->
### Local validation and dry-run

Use Node.js 22+ and Python 3.10+. Select the Python environment before installing the test extra; every `python` command below must use that same environment.

```sh
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
npm run build:console
npm run build:typed
npm run build:worker
npm run verify:ai-client-neutral
```

Run `npm run verify:cloud` additionally on Linux only. Windows uses the standard-client check above; verify Linux-only results separately against Linux CI for the corresponding commit, never as a local Windows pass.

`build:worker` is Wrangler dry-run packaging only; local verification uses isolated workerd/DO and synthetic fixtures. CLI availability, package builds, local restarts and static previews are not production acceptance. Public CI neither deploys nor requires provider/account secrets.

<!-- topic:secrets -->
### Authority and configuration

Configure scoped API credentials in the authorized target account through Cloudflare-native flows, not a global API key, and never commit account IDs/secrets into public configuration. Deployment operators verify actual Workers/DO/asset/migration permissions. Configure two independent random control-plane bearers with interactive Wrangler secret input:

```sh
npx --no-install wrangler secret put GHOSTFLEET_READ_TOKEN
npx --no-install wrangler secret put GHOSTFLEET_OPERATOR_TOKEN
npx --no-install wrangler deploy
```

These effectful steps require a specified account, deployment authority and completed review; they are not public CI steps. `.dev.vars` is local-only and does not become production secrets automatically. Tokens never belong in shell arguments or static assets; provider/device credentials have separate custody.

<!-- topic:acceptance -->
### Online acceptance and rollback

After deployment, verify HTTPS health, unauthenticated rejection, read-only mutation rejection, same-origin Console, official generic MCP initialize/list/call, persistent identity across DO restart and the current head. List multi-client/RBAC/OAuth, receipt injection/trusted writers, custody/revocation and log/artifact review separately; a bearer prototype does not establish complete production identity.

Record Worker revision, DO schema/migration and Console build. Rollback requires compatible state: stop effect dispatch, reconcile read-only and preserve identity/access paths. Independent second-device/rebuild evidence and independent consumer cutover still need their own acceptance; Pages/hosting cannot substitute for hardware canaries. Control-plane `ACTIVE` and seven evidence types establish admission in this control plane only. Each independent consumer must also validate discovery of the same identity in its catalog, authentication/configuration, usable call routes, positive/negative permissions and rollback.
