# ADR 001 — Public canonical packages / 公共 canonical 包

## 中文

<!-- topic:decision -->
### 裁决

状态：本次源码迁移的设计与审查基线；生产消费者切换须另行验收。GhostFleet 负责通用产品实现、协议、校验器、插件库及平台运行时。部署方负责实例配置、凭据托管、设备清单、原始回执、生产适配和运行状态。消费者通过公开包、版本或 API 引用通用实现，避免维护第二份核心代码。

采用逐文件审阅和脱敏的源码快照；不导入私仓历史，也不改变私仓可见性。机器可读的导出清单只列公开模块路径、导出接口、状态和测试，不公开私有提交、路径或工单。许可审计的精确来源留在受控记录中；公开许可说明列出可再分发代码的通用来源及第三方许可。

<!-- topic:clients -->
### 客户端无关与可选执行

默认 HTTP、MCP、权限、核心和插件接口不依赖 ChatGPT/OpenAI 账号、回调、令牌、配置或 SDK。标准 MCP/HTTP 客户端均可接入。特定客户端的 OAuth 配置、身份、权限范围和重定向规则属于显式启用的可选适配器；精确匹配不能改成通配符。旧客户端契约须重新验证，不能只改名称。

类型化控制、传输、后台任务、交互会话、受限高权限操作及 Linux/Windows/Android 运行时，可作为可选库源码迁入；导入和构建不连接设备。默认 MCP 保持只读。Console/HTTP 的操作员可管理控制面记录，但没有默认设备执行后端；未配置后端时拒绝执行。新增有副作用的入口必须单独设计并完成安全验收。

<!-- topic:consequences -->
### 后果与验收

外部用户应能仅靠公开克隆完成安装、构建和测试，并获得完整双语文档、合成测试数据、许可、公开 CI 和发布检查。保留旧协议及存储兼容接口，不为改名而修改标记或路径。明确平台运行时、权限、副作用、`UNKNOWN`、恢复流程及私有适配器托管边界。

源码迁移完成、正式发布、生产 Pages、第二台独立硬件验证及 OAuth 集成分别验收。只有逐项能力的消费者兼容性、精确身份、越权拒绝、回滚及归属切换通过后，才另起私仓 PR 删除旧通用代码。保留私有实例数据和访问路径。参见 [迁移](../MIGRATION.md)。

## English

<!-- topic:decision -->
### Decision

Status: design and review baseline for this source extraction, not authority for production cutover. GhostFleet owns generic product implementation, protocols/validators, plugin libraries and platform runtimes. Deployment owners retain instance configuration, credential custody, inventory, raw receipts, production adapters and runtime state. Consumers reference public packages/versions/APIs rather than duplicate the core.

Use a clean curated snapshot, not private history or a private-repository visibility change. The machine export manifest contains public module paths/exports/status/tests only, never private heads/paths/issues. Protected provenance supports licensing audit; public notices describe redistributable generic origin and third-party licensing.

<!-- topic:clients -->
### Client-neutrality and optional execution

Default HTTP/MCP/permission/core/plugin paths require no ChatGPT/OpenAI account, callback, token, configuration or SDK. Standard MCP/HTTP clients can integrate. Proprietary OAuth profiles/actors/scopes/redirects belong only to explicit optional client adapters; exact matching must not become a wildcard. Legacy client-bound contracts need revalidation, not mere renaming.

Mature typed control/transport/jobs/sessions/privileged and Linux/Windows/Android runtime mechanisms may be imported as optional library source; imports/builds contact no device. Default MCP remains read-only; Console/HTTP permit operator-protected control-plane record mutations without a default device-execution backend and unconfigured backends reject execution. New mutation ingress requires separate design and security acceptance.

<!-- topic:consequences -->
### Consequences and acceptance

An external public clone must install/build/test independently with complete bilingual documentation, synthetic fixtures, licensing, public CI and publication guard. Preserve legacy wire/storage ABI without cosmetic marker/path changes. Document platform runtime, privilege/effects/UNKNOWN/recovery and private adapter custody boundaries.

Formal release, production Pages, second-device evidence and OAuth integration remain separate from source completion. Remove previous generic code only through a separate private PR after capability-specific consumer parity, exact identity, negative authority, rollback and ownership cutover acceptance. Preserve private instance data and access paths; see [Migration](../MIGRATION.md).
