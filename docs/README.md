# Documentation / 文档

- [Remote access architecture / 远控架构](ARCHITECTURE.md)
- [Deployment guide / 远控部署指南](REMOTE_ACCESS.md)

GhostFleet is transport-only. It connects Cloudflare Tunnel and Tailscale to the same OpenSSH endpoint. It does not provide a monitoring agent, command execution API, command filter, approval system or separate audit service.

GhostFleet 只负责通过 Cloudflare Tunnel 和 Tailscale 连接同一个 OpenSSH 入口，不提供主机监控、远程命令执行 API、命令过滤、逐条审批或独立审计服务。
