# 文档 / Documentation

- [当前 RC3 恢复入口、版本关系与现场缺口 / RC3 recovery and release lineage](DELIVERY.md)
- [RC3 统一安装、更新与修复手册 / Pinned RC3 operations](https://github.com/youling/ghostfleet/blob/4b2a039dc6bce169d8b00ecd34736017df1732db/docs/nextgen/OPERATIONS.md)
- [RC3 版本化安装 profile schema](https://github.com/youling/ghostfleet/blob/4b2a039dc6bce169d8b00ecd34736017df1732db/nextgen/install-profile.schema.json)
- [产品范围 / Product](../PRODUCT.md)
- [当前架构导航 / Architecture](ARCHITECTURE.md)
- [轻量纳管与心跳 ADR004 / Decision and diagram](adr/004-lightweight-enrollment-presence.md)
- [固定摘要的 POSIX 首次引导 ADR005 / Pinned bootstrap decision](adr/005-pinned-posix-join-bootstrap.md)
- [节点身份、服务端点与被动连通证据 ADR006（仅源码候选）](adr/006-node-connectivity-evidence.md)
- [Tailscale × Cloudflare 原生能力复用地图 / Provider-first observability research · 2026-11-21](research/TS_CF_PROVIDER_REUSE_2026-11-21.md)
- [全自动下位机纳管 ADR007（历史实例安排；现行范围见 DELIVERY）](adr/007-fully-managed-lower-node-enrollment.md)
- [阶段交付与依赖图 / Staged delivery and dependencies](DELIVERY.md)
- [面板、安装与修复 / Presence deployment and recovery](PRESENCE.md)
- [原生 SSH 安装与连接 / Native transport setup](REMOTE_ACCESS.md)
- [A03 Cloudflare Access SSH 加固、灰度与回滚（设计候选）](CLOUDFLARE_ACCESS_A03.md)
- [原生传输验收矩阵 / Transport acceptance matrix](ACCEPTANCE.md)
- [当前迁移映射与历史出处 / Current migration and provenance](MIGRATION.md)
- [公开边界检查 / Publication boundary](PUBLICATION.md)
- [纳管体验、Access SSO 与远控就绪研究 · 2026-11-18](research/ONBOARDING_RECONNAISSANCE_2026-11-18.md)
- [Access 身份与会话研究细节](research/ACCESS_SSO_RECON_2026-11-18.md)
- [一次性加入与原生 SSH 就绪研究细节](research/JOIN_REMOTE_READY_RESEARCH_2026-11-18.md)
- [传输技术研究 / Transport reconnaissance · 2026-11-14](research/TRANSPORT_RECONNAISSANCE_2026-11-14.md)
- [M3 现场验证增量与同类机制映射 / M3 field validation delta · 2026-11-17](research/M3_FIELD_VALIDATION_DELTA_2026-11-17.md)
- [外部机制复用侦察（历史基线 2026-11-12） / External reuse reconnaissance](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md)
- [项目规则 / Rules](../AGENTS.md) · [安全 / Security](../SECURITY.md)

中文说明与当前架构/交付图放在前面；英文运维说明继续保留。研究文档中的候选不等于功能已实现，具体采用范围回到 #11 与对应 PR。

2026-11-28 核对：主干 v1 与未合入的 RC3 分开导航。候选目录通过固定 SHA 访问，避免 main 下不存在的相对链接。RC3 内旧 CURRENT 是 R0–R6/RC1 的历史恢复说明，当前恢复从 DELIVERY/#11 开始；安装手册和 schema 保持候选原字节。多 Controller、既有节点迁移和隔离 VM 按后发裁决解释，不从旧 ADR 推导当前主机权限。

2026-11-15 新方向允许薄面板与无常驻心跳；ADR004 supersedes 早期文档中“完全不提供控制面/主机状态”的表述。旧命令 Agent、任务队列、Helper/JIT 仍不恢复。ACCEPTANCE 的 A01–A14 是原生传输验收，不把本版 oneshot reporter 错认成被淘汰的命令 Agent。具体提交、CI、实例与审查状态回到对应 PR/#11，不从文档推断已发布。

The current scope permits a thin panel and one-shot presence reporter. ADR004 supersedes older documents' blanket exclusion of every panel/status feature, without restoring the old command agent, queue or Helper/JIT. A01–A14 remains the native transport matrix; its removal checks refer to superseded execution components, not this reporter. Exact source/CI/review and instance status live in the PR/#11 records, not this index.

As checked on 2026-11-28, main's v1 documentation and the unmerged RC3 candidate have separate entry points. Use the exact candidate links above and resume from DELIVERY/#11. The candidate's old CURRENT page is historical; no frozen release bytes were changed by this navigation update.
