# Plugin and adapter development / 插件与适配器开发

## 中文

<!-- topic:ownership -->
### 公开 canonical owner

GhostFleet 是后续通用插件、协议、validator 与产品实现的 canonical source。部署私有仓只保存实例 policy、provider/node 配置、secret custody、真实 evidence 与调用 glue，不能复制另一份通用 core 修复。公开 package/contract 通过 revision 与版本引用；具体部署仍由部署 owner 决定接入/升级。

平台插件、provider adapter、AI client adapter 是不同边界。核心 HTTP/MCP、权限和生命周期与 AI 客户端无关。ChatGPT/OpenAI 特有 OAuth、callback、profile、actor/scope 或 SDK 只能放在可选 client adapter；不能成为所有 AI Agent 的安装或认证前提。

<!-- topic:design -->
### 设计一个 adapter

先选择 boundary：读取控制面对象用标准 HTTP/MCP；消费 Linux 证明用 `LinuxReceiptAdapter`；执行受限命令用显式 typed-control backend；平台 runtime 用 Python package。不要把通用 shell、provider root、节点原始日志暴露成便利 API。描述 owner、可用 capability、exact identity、scope、effect fences、deadline、cancel、UNKNOWN/reconcile 与 recovery。

receipt observer 必须独立解析受保护 reference 并做 fresh 身份核验，不能回显 caller 的 PASS/digest/nonce 当成认证。SHA 只证明内容绑定，不证明 signer 或执行 authority。baseline positive/negative fixture 必须全 synthetic，不能用真实历史节点截取数据。

<!-- topic:extension -->
### 实现与协议兼容

采用 injectable system/transport/provider 接口，constructor/import 不做远程 I/O。每次执行前验证 current source 与 target；写入前持久化一次 effect dispatch fence。资源清理由拥有者执行，不删除别人的 state。Linux convergence 只管理自己声明的文件/服务/package，不顺手升级或改变 foreign state。

旧 `fleet-*` protocol markers 和已安装 helper path 是 compatibility ABI，不能为美观改名；新 public namespace 与旧 wire/storage layout 不同。如变更 ABI，提供版本判别、双向兼容测试、consumer cutover与rollback，先收集状态再禁止 blind replay。

<!-- topic:review -->
### 测试、贡献与验收

每个 adapter 提交接口说明、synthetic contract tests、权限负向 tests、timeout/late-result/no-retry、source/target mismatch、恢复与状态污染测试。通过 [Publication](PUBLICATION.md) 的源码/fixture/图像/日志边界与 [Testing](TESTING.md) 的独立构建。维护 [迁移表](MIGRATION.md) 与双语文档，不提交 private credential、endpoint、registry 或 raw receipt。

提交 PR 后由 reviewer 绑定 exact public head 检查；测试通过不是自动合并或生产部署授权。真实设备/第二独立节点/客户端 OAuth 等分别要求相应验收。公开 CI 使用无 secret hosted runner；不要将 fork PR 接到 self-hosted device 或 provider 凭据。

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
