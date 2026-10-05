# Documentation / 文档目录

## 中文

<!-- topic:navigation -->
### 按任务阅读

| 任务 | 文档 |
| --- | --- |
| 新用户安装/本地开发 | [快速开始](GETTING_STARTED.md)、[云端开发](CLOUD_DEVELOPMENT.md)、[控制台](CONSOLE.md) |
| 理解数据、权限与流程 | [架构](ARCHITECTURE.md)、[API](API.md)、[MCP](MCP.md)、[安全模型](SECURITY.md) |
| 插件和设备执行集成 | [插件开发](PLUGIN_DEVELOPMENT.md)、[类型化控制](CONTROL.md)、[平台](PLATFORMS.md)、[Linux 回执](LINUX_ADAPTER.md) |
| 测试、恢复、发布 | [测试](TESTING.md)、[恢复](RECOVERY.md)、[发布清理](PUBLICATION.md)、[部署](DEPLOYMENT.md) |
| 通用代码迁移与归属 | [ADR](adr/001-public-canonical-packages.md)、[迁移](MIGRATION.md)、[来源](PROVENANCE.md)、[导出清单](export-manifest.json) |
| 参与开发和许可 | [贡献](../CONTRIBUTING.md)、[报告安全问题](../SECURITY.md)、[第三方说明](../THIRD_PARTY_NOTICES.md)、[LICENSE](../LICENSE) |

文档同页先中文，后完整英文。主题与链接检查验证结构和链接，独立审阅核对语义等价。

<!-- topic:status -->
### 当前事实与设计草案

当前可执行能力以公开源码、包导出、测试和导出清单为准。[实施计划](IMPLEMENTATION_PLAN.md) 区分已实现机制与正式发布门槛。[愿景](VISION.md)、[架构探索](ARCHITECTURE_BRAINSTORM.md)、[界面复用](UI_REUSE.md) 是设计背景，不能自动授予能力或覆盖当前安全边界。

源码预览已合并到公开 `main`，软件包仍处于源码开发/预览状态。生产 Pages 迁移、正式 OAuth、第二独立硬件/重建、独立调用方切换和旧代码删除仍须分别验收。公开快照可独立构建，不需要访问部署责任方的私有仓库或治理系统。

## English

<!-- topic:navigation -->
### Read by task

| Task | Documentation |
| --- | --- |
| Installation/local development | [Getting started](GETTING_STARTED.md), [Cloud development](CLOUD_DEVELOPMENT.md), [Console](CONSOLE.md) |
| Objects, authority and workflow | [Architecture](ARCHITECTURE.md), [API](API.md), [MCP](MCP.md), [Security model](SECURITY.md) |
| Plugin/device execution integration | [Plugin development](PLUGIN_DEVELOPMENT.md), [Typed control](CONTROL.md), [Platforms](PLATFORMS.md), [Linux receipts](LINUX_ADAPTER.md) |
| Testing, recovery and publication | [Testing](TESTING.md), [Recovery](RECOVERY.md), [Publication](PUBLICATION.md), [Deployment](DEPLOYMENT.md) |
| Extraction and ownership | [ADR](adr/001-public-canonical-packages.md), [Migration](MIGRATION.md), [Provenance](PROVENANCE.md), [Export manifest](export-manifest.json) |
| Contribution/licensing | [Contributing](../CONTRIBUTING.md), [Security reporting](../SECURITY.md), [Third-party notices](../THIRD_PARTY_NOTICES.md), [LICENSE](../LICENSE) |

Each page contains Chinese followed by equivalent English. Topic/link checks validate structure and links; independent review checks semantic equivalence.

<!-- topic:status -->
### Current implementation and design drafts

Executable capabilities are defined by public source, package exports, tests and the export manifest. The [implementation plan](IMPLEMENTATION_PLAN.md) distinguishes implemented mechanisms from formal release gates. [Vision](VISION.md), [architecture brainstorming](ARCHITECTURE_BRAINSTORM.md) and [UI reuse](UI_REUSE.md) are design background, not authority grants or overrides of current security boundaries.

The source preview is merged into public `main`; packages remain source-development/preview artifacts. Production Pages migration, formal OAuth, independent second-device/rebuild evidence, independent consumer cutover and prior-source removal each need separate acceptance. The public snapshot builds independently without access to a deployment owner's private repository or governance system.
