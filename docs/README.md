# Documentation / 文档

- [产品范围 / Product](../PRODUCT.md)
- [当前架构导航 / Architecture](ARCHITECTURE.md)
- [轻量纳管与心跳 ADR004 / Decision and diagram](adr/004-lightweight-enrollment-presence.md)
- [阶段交付与依赖图 / Staged delivery and dependencies](DELIVERY.md)
- [面板、安装与修复 / Presence deployment and recovery](PRESENCE.md)
- [原生 SSH 安装与连接 / Native transport setup](REMOTE_ACCESS.md)
- [原生传输验收矩阵 / Transport acceptance matrix](ACCEPTANCE.md)
- [当前迁移映射与历史出处 / Current migration and provenance](MIGRATION.md)
- [公开边界检查 / Publication boundary](PUBLICATION.md)
- [传输技术研究 / Transport reconnaissance · 2026-11-14](research/TRANSPORT_RECONNAISSANCE_2026-11-14.md)
- [项目规则 / Rules](../AGENTS.md) · [安全 / Security](../SECURITY.md)

2026-11-15 新方向允许薄面板与无常驻心跳；ADR004 supersedes 早期文档中“完全不提供控制面/主机状态”的表述。旧命令 Agent、任务队列、Helper/JIT 仍不恢复。ACCEPTANCE 的 A01–A14 是原生传输验收，不把本版 oneshot reporter 错认成被淘汰的命令 Agent。具体提交、CI、实例与审查状态回到对应 PR/#11，不从文档推断已发布。

The current scope permits a thin panel and one-shot presence reporter. ADR004 supersedes older documents' blanket exclusion of every panel/status feature, without restoring the old command agent, queue or Helper/JIT. A01–A14 remains the native transport matrix; its removal checks refer to superseded execution components, not this reporter. Exact source/CI/review and instance status live in the PR/#11 records, not this index.
