# 安全模型 / Security model

## 中文

设备所有者决定接入机器与通道；Cloudflare Access / Tailscale 网络策略决定谁能连接；OpenSSH 验证主机密钥与 OS 账户。登录后账户保留正常系统权限，参考配置为 root 公钥登录，意味着该账户能够执行磁盘/文件系统等高影响操作。GhostFleet 不在会话中解析或审批命令。

管理员私钥留在管理端受控凭据存储；目标只保管相应公钥和本机 Tunnel 凭据。不能将真实端点、私钥或 token 放进公开源码。host key 首次带外核验，同节点两路共用身份，不同节点使用不同 HostKeyAlias；客户端示例关闭 agent forwarding，避免无意把本地 agent 暴露给目标机。

撤销网络身份、SSH 公钥及结束既有会话是不同动作。删除 authorized_keys 的公钥不会自动关闭已认证 Shell；分别验收新连接与既有连接行为。系统原生日志记录服务/认证事件，不保证记录每条命令，也不新建独立命令审计系统。

有效配置验证器只支持声明的静态检查；真实登录还受账户/PAM、密钥选项、forced command、网络等影响，见 [验收矩阵](docs/ACCEPTANCE.md)。公开源码扫描只是已列形状的检查，不是秘密永不泄漏的保证。

轻量面板与传输独立。生产 panel origin 由实例 owner 配置全站 Access。启用 Cloudflare Access 登录模式时，应用验证签名、固定 issuer、应用 AUD、有效期和明确配置的操作员身份，写入还需要精确的面板 Origin。原 Bearer 模式分别校验 Operator 和 Read 凭据。node origin 只提供票据、上报和固定哈希安装器所需的路由。心跳凭据只授予同一节点的上报权限。

服务器只保存上报凭据摘要；节点配置以 0600 保存，由 LoadCredential 投递给 DynamicUser oneshot 服务。短码在可信终端隐藏输入，不进入安装命令、URL 或日志。重发沿同一 node_uid 废止旧上报凭据；撤销 reporting 不撤销 SSH，心跳新鲜度不证明入站可达或 NodeLifecycle.ACTIVE。完整操作与恢复边界见 [PRESENCE](docs/PRESENCE.md) 和 [ADR004](docs/adr/004-lightweight-enrollment-presence.md)。

若本仓启用了 GitHub private vulnerability reporting，使用 Security 页的私密报告入口；未启用时，通过已有私密渠道联系仓库所有者，不在公开 Issue 发布敏感细节。

## English

GhostFleet combines native transport with a thin enrollment/presence panel. It does not implement a command execution service, command monitor, command filter, approval engine or custom audit store.

## Panel and reporting boundary

The instance owner protects the production panel origin with whole-site Access. Cloudflare Access sign-in mode verifies the assertion signature, pinned issuer, application audience, lifetime and explicitly configured operator identity. Writes also require the exact panel Origin. Legacy Bearer mode authenticates Operator and Read credentials separately. The node origin exposes the ticket, reporting and pinned installer routes. A reporting credential is scoped to that node's heartbeat.

The server stores only reporting-credential digests. Local configuration is mode 0600 and reaches the DynamicUser oneshot service through LoadCredential. The separate short code is entered through a hidden local prompt, never embedded in the installer command, URL or logs. Reissue keeps the same node_uid and invalidates the former reporting credential. Reporting revocation does not revoke SSH; fresh presence does not establish inbound reachability or NodeLifecycle.ACTIVE. See [PRESENCE](docs/PRESENCE.md) and [ADR004](docs/adr/004-lightweight-enrollment-presence.md) for operational and recovery boundaries.

## Authority model

1. The device owner authorizes the machine to be reachable through the chosen network path.
2. Cloudflare Access and/or Tailscale identity policy authenticate the remote session/network connection.
3. OpenSSH authenticates the OS account using an owner-managed SSH key.
4. Once the session is authenticated, the selected OS account has its normal operating-system authority. The reference profile uses root public-key authentication. GhostFleet does not intercept or approve individual commands.

This means an authorized administrator can perform any operation permitted to that OS account, including destructive disk/filesystem operations. The transport layer will not prevent them.

## Credentials

- Never commit tunnel tokens, Tailscale auth keys, SSH private keys or real endpoint identifiers.
- Keep the private SSH key on the operator/AI execution host in an owner-controlled credential store.
- Keep Cloudflare tunnel credentials in a root-controlled local file readable only by the cloudflared service account.
- Revoke access at the relevant boundary: Cloudflare Access policy/tunnel, Tailscale network policy/device, and OpenSSH `authorized_keys`. Test new and existing connections separately: deleting a key does not terminate an already authenticated shell.

## Logging

GhostFleet creates no parallel command log. OpenSSH records authentication/session events according to the OS configuration; systemd/journald and the cloudflared/tailscaled services expose their own service logs. **OpenSSH/journald do not necessarily record every shell command.** Do not claim command-level auditing unless the owner separately enables an OS-native audit/session-recording facility.

## Network exposure

- Do not publish an unauthenticated public root SSH listener.
- Do not open router port-forwarding for TCP/22.
- Use Cloudflare Access or Tailscale network identity to control who can establish a session.
- Keep SSH host-key verification enabled and enroll host keys out of band before first connection.
- A tunnel is transport, not OS authentication or privilege by itself.

If GitHub private vulnerability reporting is enabled for this repository, use its Security tab to submit a private report. If it is unavailable, contact the repository owner through an existing private channel; do not publish exploit details in a public issue.
