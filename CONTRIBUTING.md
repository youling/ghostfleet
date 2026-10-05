# Contributing / 参与贡献

## 中文

<!-- topic:scope -->
### 贡献边界

通用插件、核心、API、MCP、Console、校验器和可选运行时都在本仓维护。实例账号、设备目录、提供方端点、密钥、凭据引用、原始设备证据与生产操作手册不属于公开贡献。主流程保持与 AI 客户端无关；可以增加显式启用的可选客户端适配器，但不能让 ChatGPT 或 OpenAI 成为必需依赖，也不能放宽客户端重定向地址、配置档案或权限范围的精确匹配。

新的执行能力必须保留身份、授权与当前状态校验、防重复派发记录、超时，以及 `UNKNOWN` 结果的对账机制，不能以“方便 AI”为由绕过策略。先读 [插件开发](docs/PLUGIN_DEVELOPMENT.md)、[安全](docs/SECURITY.md) 和 [公开边界](docs/PUBLICATION.md)。

<!-- topic:workflow -->
### 实现和 Pull Request

在功能分支提交可审查的源码、测试和文档，不直接修改受保护的 `main`。PR 描述具体问题、行为变化、风险与验证结果。同步更新各篇中英文对应主题、公开导出清单、迁移对照表和许可说明。只提交经过审查的合成证据，不粘贴真实日志或完整环境输出。

执行 `npm ci`、根项目与相关可选包检查、公开边界及文档检查、Console 构建、Worker 构建预演和本地验证。新模块不得依赖私有克隆、真实设备或默认 OAuth 客户端。审查绑定精确提交；范围或提交变化后须重新核验，不能用旧 CI 或模型自述替代验收。

<!-- topic:license -->
### 许可、依赖与安全报告

项目采用 `AGPL-3.0-only`，保留 `LICENSE`、版权和第三方说明。迁入源码需核对来源许可及可重新分发权，不能仅改命名空间就抹去来源。新增依赖须尽量少、锁定版本，并审查许可与公开审计结果；公开 Actions 固定精确版本，来自外部分叉的 PR 不接收秘密。

安全问题遵循 [SECURITY.md](SECURITY.md)。公开工单只提供脱敏后的影响和复现步骤，不附凭据、真实定位信息或原始载荷。合并不自动授权生产部署、正式发布、删除旧代码或设备操作。

## English

<!-- topic:scope -->
### Contribution scope

Generic plugins, core/API/MCP/Console, validators and optional runtimes are maintained here. Instance accounts, registries, provider endpoints, keys, credential references, raw device evidence and production runbooks are not public contributions. Keep the primary flow AI-client-neutral. Explicit optional client adapters are welcome; ChatGPT/OpenAI must not become mandatory or weaken exact client redirects/profiles/scopes.

New execution capabilities preserve identity/authority/currentness, effect fences, deadlines and UNKNOWN reconciliation. Convenience for AI cannot bypass policy. Read [Plugin development](docs/PLUGIN_DEVELOPMENT.md), [Security](docs/SECURITY.md) and [Publication](docs/PUBLICATION.md) first.

<!-- topic:workflow -->
### Implementation and pull requests

Submit reviewable source/tests/documentation on a feature branch, not directly to protected main. PR descriptions explain the concrete problem, behavioral change, risk and validation. Update equivalent Chinese/English topics, public export/migration matrices and licensing. Include reviewed synthetic evidence only; never paste live logs or full environment output.

Run `npm ci`, relevant root/optional package checks, publication/docs checks, Console/Worker dry-run and local verification. New modules cannot depend on a private clone, real device or default OAuth client. Review binds the exact head; scope/head changes require renewed review rather than old CI or model self-reports.

<!-- topic:license -->
### License, dependencies and security reporting

The project is AGPL-3.0-only; retain LICENSE, copyright and third-party notices. Verify source licensing and redistribution rights for imports; a namespace change must not erase origin. Minimize dependencies, lock versions, review licenses and public audits. Public actions pin exact revisions and fork PRs receive no secrets.

Follow [SECURITY.md](SECURITY.md) for security issues. Public issues contain only sanitized impact/reproduction, never credentials, real locators or raw payloads. Merge does not automatically authorize production deployment, release, prior-code deletion or device operations.
