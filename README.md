# GhostFleet — Remote Access Transport

GhostFleet is a thin, owner-authorized remote administration setup. It uses **Cloudflare Tunnel** and **Tailscale** to carry ordinary **OpenSSH** sessions to a machine. It does not run a custom device agent or command-control plane.

## 中文

### 产品定位

GhostFleet 只负责让管理员稳定地通过 Cloudflare Tunnel 或 Tailscale 到达目标机器的 OpenSSH。设备安装并授权后，管理员通过 SSH 获得所选 OS 账户的完整权限；参考配置使用 root 公钥登录。

GhostFleet 本身：

- 不监视主机状态或远程命令；
- 不解析、过滤、改写或拦截命令；
- 不逐条审批操作；
- 不运行自研 Node Agent、任务队列、SQLite 状态库或特权 Helper；
- 不维护第二套命令审计日志。

连接入口仍然需要身份认证：Cloudflare Access 或 Tailscale 网络身份决定谁能建立 SSH 连接；OpenSSH 公钥认证决定登录哪个 OS 账户。这是**会话级认证**，不是命令审批。

### 两条连接路径

| 路径 | 用途 | SSH 目标 |
|---|---|---|
| `omv8-cf` | 通过 Cloudflare Access + Tunnel | 同一台机器的 `sshd:22` |
| `omv8-ts` | 通过 Tailscale/WireGuard 网络 | 同一台机器的 `sshd:22` |

两条路径都进入同一个 OpenSSH 服务，使用同一把管理员 SSH key 和同一个 OS 用户。GhostFleet 不做自研自动切换；CF 路径不可用时，新建会话改用 TS 路径即可。已经建立的 TCP/SSH 会话不能无损迁移到另一条网络。

### 快速使用

复制 [SSH 客户端配置模板](config/ssh/ghostfleet.conf.example)，替换域名、Tailnet MagicDNS 名称和本地私钥路径：

```sh
ssh omv8-cf   # Cloudflare Access + Tunnel
ssh omv8-ts   # Tailscale path
```

完整安装与配置见 [远控部署指南](docs/REMOTE_ACCESS.md)。

## English

### Product scope

GhostFleet only provides stable paths to the target machine's ordinary OpenSSH server through Cloudflare Tunnel and/or Tailscale. After owner-authorized enrollment, an authenticated administrator receives the full authority of the selected OS account; the reference profile uses root public-key login.

GhostFleet itself does not monitor hosts or commands, inspect/filter/rewrite/intercept commands, require per-command approvals, run a custom Node Agent/task queue/SQLite store/privileged Helper, or maintain a parallel command-audit system.

Connection identity is still authenticated at the session boundary: Cloudflare Access or Tailscale identity decides who may reach SSH; OpenSSH public-key authentication decides which OS account is opened. This is session authentication, not command approval.

### Two paths

| Alias | Route | SSH target |
|---|---|---|
| `omv8-cf` | Cloudflare Access + Tunnel | The same machine's `sshd:22` |
| `omv8-ts` | Tailscale/WireGuard | The same machine's `sshd:22` |

Both paths reach the same OpenSSH daemon and use the same administrator SSH key and OS account. There is no custom failover daemon. If one route is unavailable, reconnect using the other alias. An established TCP/SSH session cannot migrate losslessly between paths.

Copy the [SSH client config example](config/ssh/ghostfleet.conf.example), replace the hostnames and local key path, then run `ssh omv8-cf` or `ssh omv8-ts`. See the [deployment guide](docs/REMOTE_ACCESS.md).
