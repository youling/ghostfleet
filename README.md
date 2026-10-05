# GhostFleet

## 中文

<!-- topic:product -->
### 产品与支持边界

GhostFleet 是开源设备管理控制面，与 AI 客户端无关。人工操作员和标准 HTTP/MCP 客户端共享生命周期、能力、权限、人工确认和证据对象。通用实现由公开仓维护；具体部署保留自己的配置、凭据和真实设备事实。许可证为 **AGPL-3.0-only**。

当前源码包含可运行的核心、Console、HTTP API、只读 MCP、Linux 回执校验器，以及可选的类型化控制、bootstrap 和 Python 运行时包。默认界面不会安装、重启或控制设备；高权限操作必须由部署集成者明确配置并验收。目前是源码开发版本，不宣称已经发布 npm/PyPI 插件或正式生产服务。

<!-- topic:startup -->
### 开始开发

需要 Node.js 22+。源码预览已进入本仓 `main`；从默认分支开始开发。审阅特定版本时，使用该版本的精确提交。

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

在同一机器打开 `http://127.0.0.1:8791/`。初始化不打印凭据、不连接设备。详见 [快速开始](docs/GETTING_STARTED.md)、[文档目录](docs/README.md) 和 [可选平台运行时](docs/PLATFORMS.md)。只有选择 Python 模块时才需要 Python。主流程无需 ChatGPT/OpenAI 配置、回调、API key 或任何私仓权限。

<!-- topic:capabilities -->
### 能力矩阵

| 层 | 公开实现 | 默认权限 |
| --- | --- | --- |
| 核心/API/Console | 纳管记录、人工确认、证据、节点、能力、事件与 DO 持久化 | 读取对象，或按操作员权限管理控制面记录；不执行设备命令 |
| MCP | 标准 Streamable HTTP，四个观察工具 | 只读；不变更设备 |
| Linux 回执适配器 | 严格回执、独立观察器、有效期、零差异与重启绑定 | 只消费证明，不执行加入网络、重启或准入 |
| 类型化控制 | 操作、策略、精确目标、截止时间、任务/会话及可选本地/Cloudflare 后端 | 未配置后端时拒绝；不注册默认工具 |
| Bootstrap/Python | 载荷生成、校验器、Linux 收敛器、辅助程序、Windows/Android 运行时 | 显式选择；真实安装/执行另需授权 |

一次受保护的 Linux 单机集成已通过真实 canary 验证。设备在本控制面成为 `ACTIVE`，只表示满足本控制面的准入要求；独立消费者的设备目录、鉴权配置、调用路由和操作权限仍须接线并验收。用户实际使用的插件能够发现该身份、完成其授权范围内的调用并通过权限负测后，才算该消费者的端到端纳管或切换完成。单机证据也不代表第二台独立设备、生产 Pages、所有平台或 OAuth 客户端都已通过。正式发布仍需独立硬件/重建证据和安全复审，见 [测试](docs/TESTING.md) 和 [迁移](docs/MIGRATION.md)。

<!-- topic:development -->
### 贡献与验收

后续通用插件开发以本仓为准。[贡献](CONTRIBUTING.md)、[插件开发](docs/PLUGIN_DEVELOPMENT.md)、[架构](docs/ARCHITECTURE.md)、[API](docs/API.md)、[MCP](docs/MCP.md) 和 [安全](docs/SECURITY.md) 提供实现方法与边界。公开 CI 不需要私有凭据或设备。

```sh
npm run check:publication
npm run check:docs
npm run build:worker
npm run verify:cloud
```

`verify:cloud` 需要 Linux。Windows 可运行跨平台核心测试和 `npm run verify:ai-client-neutral`；Cloudflare 运行时证明等待 Linux CI，不把 Windows 的拒绝结果当作通过。

源码检查、合成测试、预览、真机验收、部署和正式发布分别记录证据。删除旧通用代码必须等调用方切换和回滚验收，不能由搬文件直接触发。

## English

<!-- topic:product -->
### Product and support boundary

GhostFleet is an open-source, AI-client-neutral device fleet control plane. Humans and standard HTTP/MCP clients share lifecycle, capability, permission, HumanGate and evidence objects. The public implementation owns generic mechanisms; deployments own configuration, credentials and real device facts. Licensed under **AGPL-3.0-only**.

The source includes a runnable core/Console/HTTP/read-only MCP surface, Linux receipt validation and explicit optional typed-control/bootstrap/Python runtime packages. The default UI neither installs nor reboots nor controls hardware. Deployment integrators must explicitly configure and validate high-authority operations. This is a source-development version, not a claim of published npm/PyPI plugins or a formal production service.

<!-- topic:startup -->
### Start development

Use Node.js 22+. The source preview is available on this repository's `main` branch. Start from the default branch; use an exact commit when reviewing a specific revision.

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

Open `http://127.0.0.1:8791/` on the same machine. Local initialization prints no credentials and contacts no hardware. See [Getting started](docs/GETTING_STARTED.md), the [documentation index](docs/README.md) and [optional platform runtimes](docs/PLATFORMS.md). Python is required only by selected optional modules. No ChatGPT/OpenAI configuration, callbacks, API key or private-repository access is required.

<!-- topic:capabilities -->
### Capability matrix

| Layer | Public implementation | Default authority |
| --- | --- | --- |
| Core/API/Console | Attempts, gates, evidence, Nodes, capabilities, events and DO persistence | Scoped read/operator lifecycle object management |
| MCP | Standard Streamable HTTP and four inspection tools | Read-only; no device mutation |
| Linux receipt adapter | Strict receipts, independent observer, freshness, zero-delta and reboot binding | Proof consumption only; no join/reboot/admission |
| Typed control | Optional typed operations, target/policy/currentness, job/session, native/Cloudflare backend boundaries | Rejects unconfigured backend; registers no default tools |
| Bootstrap/Python | Optional payload generation, validators, Linux converger, helpers, Windows/Android runtimes | Opt-in; real installation/execution needs separate authority |

One protected Linux integration passed a real canary. `ACTIVE` establishes admission under this control plane's requirements only; independent consumers still need catalog registration, authentication configuration, call routing and operational permission acceptance. End-to-end admission or cutover through a user's actual plugin requires discovery of the accepted identity, permitted calls and unauthorized-operation rejection in that consumer. Single-node evidence also does not establish an independent second device, production Pages, every platform or OAuth client. Formal release retains independent hardware/rebuild and security-review gates; see [Testing](docs/TESTING.md) and [Migration](docs/MIGRATION.md).

<!-- topic:development -->
### Contribution and acceptance

This repository is the canonical home for generic plugin development. [Contributing](CONTRIBUTING.md), [Plugin development](docs/PLUGIN_DEVELOPMENT.md), [Architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [MCP](docs/MCP.md) and [Security](docs/SECURITY.md) define implementation and boundaries. Public CI needs no private credentials or devices.

```sh
npm run check:publication
npm run check:docs
npm run build:worker
npm run verify:cloud
```

`verify:cloud` requires Linux. On Windows, run the cross-platform core tests and `npm run verify:ai-client-neutral`; Cloudflare runtime proof is provided by Linux CI. A Windows platform rejection does not count as passing that proof.

Source checks, synthetic tests, previews, hardware acceptance, deployment and formal release each have distinct evidence. Removing previous generic code requires consumer cutover and rollback acceptance; moving files alone does not trigger deletion.
