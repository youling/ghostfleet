# Plugin and adapter development / 插件与适配器开发

## 中文

<!-- topic:ownership -->
### 通用实现的公开权威来源

GhostFleet 是后续通用插件、协议、校验器和产品实现的权威源码来源。部署私有仓库只保存实例策略、提供方/节点配置、秘密托管、真实证据和调用衔接代码，不能维护另一份通用核心实现。通过源码版本和包版本引用公开包与契约；具体接入和升级仍由部署责任方决定。

平台插件、提供方适配器和 AI 客户端适配器属于不同边界。核心 HTTP/MCP、权限与生命周期独立于 AI 客户端。ChatGPT/OpenAI 特有的 OAuth、回调、配置、调用主体/权限范围或 SDK 只能放在可选客户端适配器中，不能成为所有 AI Agent 的安装或认证前提。

<!-- topic:design -->
### 设计适配器

先选择边界：读取控制面对象使用标准 HTTP/MCP；消费 Linux 证据使用 `LinuxReceiptAdapter`；执行受限命令使用显式注入的类型化控制后端；平台运行时使用 Python 包。不要将任意 shell、提供方根权限或节点原始日志暴露为便利 API。说明责任方、可用能力、精确身份、权限范围、防重复派发记录、截止时间、取消、`UNKNOWN` 对账与恢复。

回执观察器必须独立解析受保护引用，并核验当前身份；不能回显调用方的 PASS、摘要或 nonce 后便当作认证。SHA 只证明内容绑定，不证明签名者或执行授权。基线正负样本必须全部合成，不能截取真实历史节点数据。

<!-- topic:extension -->
### 实现与协议兼容

采用可注入的系统、传输和提供方接口，构造或导入时不进行远程 I/O。每次执行前验证当前源码与目标，变更前持久化一次防重复派发记录。责任方只清理自己拥有的资源，不删除他人状态。Linux 收敛只管理已声明的文件、服务和包，不顺手升级软件包或改变外部状态。

旧 `fleet-*` 协议标记和已安装的辅助程序路径属于兼容 ABI，不能为美观改名；公开命名空间不同于旧传输协议和存储布局。ABI 变更须提供版本判别、双向兼容测试、调用方切换与回滚；先对账当前状态，再依据契约决定是否重放，不能盲目重试。

<!-- topic:review -->
### 测试、贡献与验收

每个适配器提交接口说明、合成契约测试、权限负向测试，以及超时、迟到结果、不重试、源码/目标不匹配、恢复和状态污染测试。满足 [公开边界](PUBLICATION.md) 对源码、样本、图像和日志的要求，并按 [测试](TESTING.md) 独立构建。维护 [迁移表](MIGRATION.md) 和双语文档，不提交私有凭据、端点、实例清单或原始回执。

提交 PR 后由审阅者绑定精确公开提交检查，测试通过不自动授予合并或生产部署授权。真实设备、第二独立节点和客户端 OAuth 分别验收。公开 CI 使用无秘密的托管运行器，不能让 fork PR 访问自托管设备或提供方凭据。

## English

<!-- topic:ownership -->
### Public canonical owner

GhostFleet is the canonical source for future generic plugins, protocols, validators and product implementations. Deployment-private repositories keep instance policy, provider/node configuration, secret custody, real evidence and integration glue; they must not maintain a second generic core implementation. Reference public packages/contracts by revision and version; each deployment owner controls integration and upgrades.

Platform plugins, provider adapters and AI client adapters are separate boundaries. Core HTTP/MCP, authority and lifecycle are AI-client-neutral. ChatGPT/OpenAI-specific OAuth, callbacks, profiles, actor/scopes or SDKs belong only in optional client adapters, never prerequisites for every AI agent's installation or authentication.

<!-- topic:design -->
### Design an adapter

Choose the boundary first: standard HTTP/MCP for object reads, `LinuxReceiptAdapter` for Linux proof consumption, an explicitly injected typed-control backend for bounded execution, and the Python package for platform runtimes. Do not expose arbitrary shells, provider roots or raw node logs as convenience APIs. Define owner, capability, exact identity, scope, effect fences, deadlines, cancellation, UNKNOWN/reconciliation and recovery.

A receipt observer independently resolves a protected reference and freshly verifies identity; echoing a caller's PASS/digest/nonce is not authentication. SHA binds content, not signer or execution authority. All positive/negative baseline fixtures must be synthetic, not excerpts from historical live nodes.

<!-- topic:extension -->
### Implementation and compatibility

Use injectable system/transport/provider interfaces and perform no remote I/O on constructor/import. Validate current source and target before each operation and persist a one-time effect fence before mutation. Owners clean up their own resources, not another task's state. Linux convergence manages only its declared files/services/packages; it must not silently upgrade packages or modify foreign state.

Legacy `fleet-*` protocol markers and installed helper paths are compatibility ABI and must not be renamed cosmetically. The public namespace differs from the legacy wire/storage layout. ABI changes need version discrimination, compatibility tests, consumer cutover and rollback; reconcile current state before any replay decision.

<!-- topic:review -->
### Testing, contribution and acceptance

Every adapter contributes interface documentation, synthetic contract tests, negative authority, timeout/late-result/no-retry, source/target mismatch, recovery and state-contamination tests. Pass [Publication](PUBLICATION.md) boundaries for source, fixtures, images and logs and [Testing](TESTING.md) for standalone builds. Maintain the [migration matrix](MIGRATION.md) and bilingual documentation. Never contribute private credentials, endpoints, registries or raw receipts.

Reviewers bind acceptance to the exact public PR head. Passing tests does not automatically authorize merge or production deployment. Real hardware, an independent second device and client OAuth need separate acceptance. Public CI uses secret-free hosted runners; never expose self-hosted devices or provider credentials to fork PRs.
