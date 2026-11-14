# 贡献 / Contributing

## 中文

可贡献：上游 Cloudflare/Tailscale/OpenSSH/systemd 的通用配置示例、准确双语文档、兼容性修正和小型验证器。保持当前 transport-only 产品范围；不重新引入自建设备监控、远程命令 API、审批状态机、Helper 或任务/审计服务。

使用隔离工作区和 branch + PR，复查当前 HEAD。配置只是模板，不产生真实主机或 provider 变更授权。提交前运行公开边界检查、OpenSSH 客户端配置检查、`sh test/verify-sshd-admin.test.sh` 和 systemd unit 语法验证。sshd 测试需要 OpenSSH server 与本地临时目录，只检查一次性配置，不启动、重载或停止服务。有效配置检查与真实连接验收分开，后者见 [验收文档](docs/ACCEPTANCE.md)。

## English

GhostFleet is intentionally transport-only.

Accepted changes:
- accurate Cloudflare Tunnel, Tailscale, OpenSSH and systemd configuration examples;
- documentation and compatibility fixes;
- small validation checks for shipped SSH/config examples.

Out of scope:
- device monitoring or inventory agents;
- remote command APIs or command allowlists;
- per-command approval/HumanGate/JIT;
- custom task queues, durable command ledgers or SQLite stores;
- custom privileged helpers or command audit pipelines;
- a custom SSH implementation or tunnel protocol.

Use upstream tools directly. Never commit tunnel tokens, auth keys, SSH private keys, real hostnames or device identifiers. Config changes are examples only; production changes require owner authorization.


Before submitting, run `node scripts/publication-guard.mjs`, `node --test test/publication-guard.test.mjs`, OpenSSH client/server configuration checks and systemd unit verification.
