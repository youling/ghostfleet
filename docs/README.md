# Documentation / 文档

- [架构与拓扑图 / Architecture and topology](ARCHITECTURE.md)
- [安装与连接 / Setup and connection](REMOTE_ACCESS.md)
- [实例验收矩阵 / Instance acceptance matrix](ACCEPTANCE.md)
- [迁移与历史出处 / Migration and provenance](MIGRATION.md)
- [公开边界检查 / Publication boundary](PUBLICATION.md)
- [技术调研 / Technical reconnaissance · 2026-11-14](research/TRANSPORT_RECONNAISSANCE_2026-11-14.md)
- [项目规则 / Project rules](../AGENTS.md)、[贡献 / Contributing](../CONTRIBUTING.md)、[安全 / Security](../SECURITY.md)

当前文档描述 [PR #85](https://github.com/youling/ghostfleet/pull/85) 的未合并候选。架构图为 `DERIVED` 关系说明，真实实例验收为 `NOT_RUN`；最终提交、CI 与复审由 PR 记录绑定。

These documents describe PR #85's unmerged candidate. Diagrams are `DERIVED` descriptions and live acceptance is `NOT_RUN`; the PR records the final commit, CI and review evidence.

GhostFleet is transport-only. It connects Cloudflare Tunnel and Tailscale to the same OpenSSH endpoint. It does not provide a monitoring agent, command execution API, command filter, approval system or separate audit service.

GhostFleet 只负责通过 Cloudflare Tunnel 和 Tailscale 连接同一个 OpenSSH 入口，不提供主机监控、远程命令执行 API、命令过滤、逐条审批或独立审计服务。
