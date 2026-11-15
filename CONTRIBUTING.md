# 贡献 / Contributing

## 中文

当前范围由 [ADR004](docs/adr/004-lightweight-enrollment-presence.md) 和 [#11](https://github.com/youling/ghostfleet/issues/11) 持有：原生 SSH、轻量注册/状态面板和 systemd oneshot reporter。可贡献上游通用配置、现有 Console/票据/心跳的修复、准确双语文档和小型验证器；不恢复常驻命令 Agent、远程命令 API、审批状态机、Helper 或任务/审计服务。

使用隔离工作区和 branch + PR，复查当前 HEAD。按实际改动运行 [PRESENCE](docs/PRESENCE.md) 的协议、Python、构建/本地集成检查和公开边界扫描；SSH 改动另运行客户端配置检查、`sh test/verify-sshd-admin.test.sh` 和相关 systemd unit 语法验证。sshd 测试需要 OpenSSH server 与本地临时目录，只检查一次性配置，不启动、重载或停止服务。配置模板和测试不产生真实主机或 provider 变更授权；实际交付按 [DELIVERY](docs/DELIVERY.md) 分范围记录。

## English

GhostFleet combines native SSH with a thin enrollment/presence panel and a systemd oneshot reporter. [ADR004](docs/adr/004-lightweight-enrollment-presence.md) and [#11](https://github.com/youling/ghostfleet/issues/11) own the current scope.

Accepted changes:
- accurate Cloudflare Tunnel, Tailscale, OpenSSH and systemd configuration examples;
- documentation and compatibility fixes;
- fixes to the existing Console, one-time tickets and heartbeat-only reporter;
- small validation checks for shipped SSH/config examples.

Out of scope:
- resident command agents or a new telemetry platform;
- remote command APIs or command allowlists;
- per-command approval/HumanGate/JIT;
- custom task queues, durable command ledgers or a second database;
- custom privileged helpers or command audit pipelines;
- a custom SSH implementation or tunnel protocol.

Use upstream tools directly. Never commit tunnel tokens, auth keys, SSH private keys, real hostnames or device identifiers. Config changes are examples only; production changes require owner authorization.


Before submitting, run the checks relevant to the change: the protocol/Python/build/local integration commands in [PRESENCE](docs/PRESENCE.md), publication checks, and OpenSSH/systemd validation for changed transport configuration. The SSH regression checks disposable configuration; it does not start, reload or stop a service. Use [DELIVERY](docs/DELIVERY.md) to distinguish source results from actual deployment and node acceptance.
