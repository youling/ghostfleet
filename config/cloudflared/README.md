# Cloudflare 路径 / Cloudflare route

## 中文

复用上游 `cloudflared`；本仓不实现隧道协议或 Worker 代理。参考配置：

| 对象 | 合成示例 / 含义 |
| --- | --- |
| Published hostname | `ssh.example.invalid` |
| Origin service | `ssh://127.0.0.1:22`，同一原生 sshd |
| Access application | 该 hostname 的 self-hosted application |
| Access policy | 所有者指定的连接身份 |

管理端与目标机均安装 cloudflared。OpenSSH 通过 `cloudflared access ssh --hostname %h` 的 ProxyCommand 接入；这个参考流程需要时会打开浏览器登录。它并未证明无交互 AI 客户端已经接通。

远程管理的 Tunnel token 存放在受控本地文件，示例 unit 通过 `--token-file` 读取；核对实际二进制的 `tunnel run --help`，不要仅凭版本名假定参数存在。不要把 token 提交到 Git、命令行历史或对话。服务启动、认证、长连接和撤销另按 [部署指南](../../docs/REMOTE_ACCESS.md) 与 [验收矩阵](../../docs/ACCEPTANCE.md) 实测。

官方说明 `access ssh` 通过 WebSocket 传输，长连接推荐 Client-to-Tunnel。保活或服务重启不保证现有 SSH 会话持续。Access for Infrastructure 与浏览器 SSH 有不同的会话/证书/转发语义，见 [调研](../../docs/research/TRANSPORT_RECONNAISSANCE_2026-11-14.md)，不在本配置中默认启用。

## English

Use upstream cloudflared, without a custom tunnel protocol or Worker proxy. The table defines a reserved public hostname, a loopback origin at the same native sshd, and an Access self-hosted application restricted to the owner's selected connection identity.

Install cloudflared on the client and target. The SSH ProxyCommand uses `cloudflared access ssh --hostname %h`; this reference may require browser login and does not prove unattended AI access. Keep remotely-managed tunnel tokens in a controlled local file, verify `--token-file` in the installed binary's help, and never publish tokens or place them in command history.

Validate startup, authentication, session lifetime and revocation using the linked guide and acceptance matrix. Cloudflare documents WebSocket transport for this path and recommends Client-to-Tunnel for long-lived connections. Keepalives and daemon restarts do not preserve a lost SSH session. Infrastructure and browser SSH modes have different semantics and remain separate choices.

[Official client-side SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/) · [Published protocols](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)
