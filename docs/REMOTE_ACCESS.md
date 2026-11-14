# Remote access deployment

This guide is a template. It does not deploy anything and contains no real hostnames, keys, tokens or account identifiers. Apply it only after the device owner authorizes the exact target and Cloudflare/Tailscale policy changes.

## 1. Install the native services on the target

On Debian/OMV, install and enable:
- OpenSSH server (`openssh-server`, service normally `ssh.service`);
- Tailscale from its official Debian package instructions (`tailscaled.service`);
- cloudflared from Cloudflare's official package instructions.

Do not install a GhostFleet Node Agent. There is no custom GhostFleet daemon.

## 2. Configure OpenSSH for owner-authorized administrator access

The example in [00-ghostfleet-admin.conf.example](../config/sshd/00-ghostfleet-admin.conf.example) allows root public-key login and disables password/keyboard-interactive login. Copy it to `/etc/ssh/sshd_config.d/00-ghostfleet-admin.conf`, add the owner's **public** key to `/root/.ssh/authorized_keys`, then validate before reloading:

```sh
sudo SSH_TEST_CONTEXT='user=root,host=localhost,addr=127.0.0.1' scripts/verify-sshd-admin.sh
```

The verifier runs `sshd -t` and `sshd -T -C` and requires `permitrootlogin prohibit-password` (OpenSSH may print the equivalent `without-password`), `pubkeyauthentication yes`, `passwordauthentication no`, `kbdinteractiveauthentication no` and `authenticationmethods publickey`. Replace the context host/address when Match rules depend on them. A conflict or missing value fails closed; the verifier never reloads sshd. Do not copy the private key to the server, repository or chat.

**OMV/cloud-init boundary:** do not edit a generated main sshd config as the durable source of truth. Inspect Include order, drop-ins and Match rules. OMV/cloud-init may regenerate configuration on Apply/upgrade; after such an operation rerun `sshd -t` and the effective-policy verifier. If a vendor-managed setting wins, reconcile it at its supported source rather than deleting generated files.

**OMV 8 root-session choice:** OMV's own guidance normally recommends a non-privileged user in `_ssh` and `sudo`, and recommends disabling root SSH after installation. This GhostFleet profile intentionally chooses direct root administration with SSH public-key-only authentication. In OMV `Services → SSH`, enable root login, disable password authentication and enable public-key authentication. Preserve the OMV-managed `AllowGroups` rule only if it admits root (the usual `root _ssh` list does); do not add root to `_ssh` just to satisfy a generic rule. If OMV's effective `AuthenticationMethods` is not exactly `publickey`, set it through OMV's supported SSH **Extra options** field, not by editing the generated file. The verifier accepts OMV's `PermitRootLogin yes` only when public-key authentication is enabled, password and keyboard-interactive authentication are disabled, `AuthenticationMethods publickey` is effective, and any `AllowGroups` rule admits root. See [OMV 8 SSH documentation](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html).

Once authenticated as root, the SSH session has root authority. GhostFleet does not add command restrictions or per-command approvals.

## 3. Enroll the SSH host key / 带外登记主机密钥

On the target's trusted local console, obtain the public host-key fingerprint and key:
```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```
Verify the fingerprint through a separate trusted channel. Add the verified public key to the operator's `~/.ssh/known_hosts` using the alias `ghostfleet-node`. The client config uses `StrictHostKeyChecking yes` and refuses an un-enrolled key. Do not trust an unverified ssh-keyscan result.

## 4. Cloudflare path

Use a remotely-managed Cloudflare Tunnel:
1. Create/select a tunnel in Cloudflare Zero Trust.
2. Add a published application route for a hostname such as `ssh.example.invalid` to `ssh://127.0.0.1:22`.
3. Create a Cloudflare Access self-hosted application for that hostname and allow the owner's identity.
4. Install cloudflared on the target and run it as a systemd service. The service example uses a token file; use a cloudflared build whose `tunnel run --help` lists `--token-file` (verified with 2026.11.0):
   ```sh
   # Run these commands from the GhostFleet repository root.
   sudo groupadd --system cloudflared
   sudo useradd --system --gid cloudflared --home-dir /var/lib/cloudflared --create-home --shell /usr/sbin/nologin cloudflared
   sudo install -d -o root -g cloudflared -m 0750 /etc/cloudflared
   sudo install -o root -g cloudflared -m 0640 /dev/null /etc/cloudflared/ssh-tunnel.token
   sudoedit /etc/cloudflared/ssh-tunnel.token
   sudo chown root:cloudflared /etc/cloudflared/ssh-tunnel.token
   sudo chmod 0640 /etc/cloudflared/ssh-tunnel.token
   sudo install -D -m 0644 config/systemd/cloudflared-ssh.service.example /etc/systemd/system/cloudflared-ssh.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared-ssh.service
   ```
   Adjust the binary path in the unit if `command -v cloudflared` is not `/usr/bin/cloudflared`. Do not put the token in Git, shell history or an AI prompt.
5. Install cloudflared on the client and connect using the `node-cf` SSH alias. The client-side `cloudflared access ssh` flow prompts for Cloudflare Access login when needed.

Use a normal Access self-hosted application. Access authenticates the connection; it does not inspect or filter SSH commands. Do not use Access for Infrastructure if the deployment goal is a plain unrestricted SSH session without per-target command policy or command recording.

## 5. Tailscale path

1. Install Tailscale from its official Linux package instructions.
2. Run `sudo tailscale up` and complete the owner-controlled browser authentication.
3. Ensure the tailnet's existing policy permits the authorized administrator/device to reach this node on TCP/22.
4. Leave Tailscale SSH disabled (`tailscale set --ssh=false`) so the connection uses the same OpenSSH daemon as the Cloudflare path.
5. Connect using the `node-ts` alias and the same OpenSSH key.

Tailscale is the network path; OpenSSH remains the SSH server and OS login authority. No custom Tailscale controller or GhostFleet ACL engine is installed.

## 6. Client configuration

Copy [ghostfleet.conf.example](../config/ssh/ghostfleet.conf.example) into the operator's SSH config or include it from `~/.ssh/config`. Replace:
- `ssh.example.invalid` with the Cloudflare Access hostname;
- `node.tailnet-name.example.invalid` with the target's Tailscale MagicDNS name;
- `~/.ssh/ghostfleet_admin` with the owner's local private-key path.

Connect:
```sh
ssh node-cf
ssh node-ts
```

The two aliases share one `HostKeyAlias`, so the same server host key is checked on either route.

## 7. Logs and recovery

Use the OS's native logs:
```sh
journalctl -u ssh --since today
journalctl -u cloudflared-ssh --since today
journalctl -u tailscaled --since today
systemctl status ssh cloudflared-ssh tailscaled
```

These logs show service and connection/authentication events. They do not necessarily record every shell command. GhostFleet does not add command logging or monitoring.

If Cloudflare is unavailable, create a new SSH session with `ssh node-ts`. If Tailscale is unavailable, use `ssh node-cf`. Existing TCP sessions require reconnecting; no custom session migration is promised.

## 8. Revocation

- Remove the operator from the Cloudflare Access allow policy or disable the tunnel route.
- Remove the operator/device from the Tailscale network policy or revoke the node.
- Remove the corresponding public key from `/root/.ssh/authorized_keys`.
- Disable the relevant service if the route itself must be taken offline.

Revocation at the network layer blocks new sessions. Removing the SSH key blocks OS authentication regardless of route.

## Boundaries

This is a remote-access transport profile, not a complete device-management agent. It does not monitor disks, RAID, processes or services; it does not filter commands; it does not ask for per-command approval; it does not promise command-level audit records. It also does not modify storage, RAID, shares, packages or application services automatically.



---

# 远控部署指南（中文版）

本指南只是安装模板，不会自动部署。只有设备所有者明确授权目标机器及 Cloudflare/Tailscale 配置变更后，才执行相应步骤。

## 1. 安装系统原生服务

在 Debian / OpenMediaVault 上安装：
- OpenSSH Server（通常为 `ssh.service`）；
- Tailscale（`tailscaled.service`）；
- Cloudflare 官方 `cloudflared`。

**不需要安装 GhostFleet Node Agent。GhostFleet 没有自定义常驻守护进程。**

## 2. 配置 OpenSSH 管理员登录

使用 [00-ghostfleet-admin.conf.example](../config/sshd/00-ghostfleet-admin.conf.example) 作为配置模板。它允许 root 使用公钥登录，并关闭密码和键盘交互认证。

将模板复制到 `/etc/ssh/sshd_config.d/00-ghostfleet-admin.conf`，把管理员的**公钥**加入 `/root/.ssh/authorized_keys`。然后在仓库根目录执行：

```sh
sudo SSH_TEST_CONTEXT='user=root,host=localhost,addr=127.0.0.1' scripts/verify-sshd-admin.sh
```

验证脚本会执行 `sshd -t` 和带连接上下文的 `sshd -T -C`，并检查最终生效值：
- `permitrootlogin prohibit-password`（OpenSSH 也可能规范化输出为等价的 `without-password`）；
- `pubkeyauthentication yes`；
- `passwordauthentication no`；
- `kbdinteractiveauthentication no`；
- `authenticationmethods publickey`。

如果存在更早加载的配置或 `Match` 规则覆盖了这些值，脚本会失败退出。它不会修改配置文件，也不会重载或重启 sshd。若 `Match` 依赖实际主机名或客户端地址，应通过 `SSH_TEST_CONTEXT` 设置真实测试上下文。

**OMV / cloud-init 配置边界：** Debian 通常在主配置的 `Include /etc/ssh/sshd_config.d/*.conf` 位置按文件名字典序加载 drop-in；OpenSSH 对大多数配置采用 first-obtained-value 规则。因此 `00-` 前缀只是提高优先级，不保证一定胜出。不要盲目修改 OMV 或云镜像生成的主配置；先检查 Include 顺序、已有 drop-in 和 Match 规则。OMV Apply、系统升级或 cloud-init 可能重新生成配置，之后必须重新执行上述验证。若厂商配置仍然优先，应在其支持的配置来源中调整，而不是删除生成文件。

**OMV 8 的 root 会话选择：** OMV 官方通常建议使用加入 `_ssh` 组的普通用户，再通过 `sudo` 提权，并建议安装后关闭 root SSH。本 GhostFleet 配置按所有者的产品决定，选择直接 root 管理，但只允许 SSH 公钥认证。在 OMV 的 `Services → SSH` 中启用 root 登录、关闭密码认证、启用公钥认证。OMV 管理的 `AllowGroups` 必须允许 root（常见的 `root _ssh` 列表满足要求）；不要为了满足通用规则而把 root 加入 `_ssh`。如果生效的 `AuthenticationMethods` 不是严格的 `publickey`，应通过 OMV 支持的 SSH **Extra options** 字段设置，不要编辑生成文件。验证脚本只有在公钥认证开启、密码和键盘交互认证关闭、`AuthenticationMethods publickey` 生效且 `AllowGroups` 允许 root 时，才接受 OMV 的 `PermitRootLogin yes`。参见 [OMV 8 SSH 官方文档](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html)。

认证成功后，SSH 会话拥有 root 的正常系统权限。GhostFleet 不会限制、检查或逐条审批命令。

## 3. 带外登记 SSH 主机密钥

在目标机器可信的本地控制台读取主机公钥指纹：

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```

通过独立可信渠道核对指纹，再把已核验的公钥加入管理端的 `~/.ssh/known_hosts`，主机别名使用 `ghostfleet-node`。客户端设置 `StrictHostKeyChecking yes`，不会接受未登记的主机密钥。不要把未经核验的 `ssh-keyscan` 结果当作信任依据。

## 4. Cloudflare 连接路径

使用 Cloudflare Zero Trust 中的 Remote-managed Tunnel：
1. 创建或选择一个 Tunnel。
2. 添加 Published Application Route，例如 `ssh.example.invalid`，源站服务指向 `ssh://127.0.0.1:22`。
3. 为该主机名创建 Cloudflare Access Self-hosted Application，并只允许所有者指定的身份。
4. 在目标机安装 `cloudflared`，并以 systemd 服务运行。示例服务使用 token file（要求 cloudflared 支持 `--token-file`）：

```sh
# 以下命令从 GhostFleet 仓库根目录执行
sudo groupadd --system cloudflared
sudo useradd --system --gid cloudflared --home-dir /var/lib/cloudflared --create-home --shell /usr/sbin/nologin cloudflared
sudo install -d -o root -g cloudflared -m 0750 /etc/cloudflared
sudo install -o root -g cloudflared -m 0640 /dev/null /etc/cloudflared/ssh-tunnel.token
sudoedit /etc/cloudflared/ssh-tunnel.token
sudo chown root:cloudflared /etc/cloudflared/ssh-tunnel.token
sudo chmod 0640 /etc/cloudflared/ssh-tunnel.token
sudo install -D -m 0644 config/systemd/cloudflared-ssh.service.example /etc/systemd/system/cloudflared-ssh.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-ssh.service
```

如果 `command -v cloudflared` 不在 `/usr/bin/cloudflared`，需要相应调整 unit 的二进制路径。Tunnel token 只能放在目标机受控文件中，不能提交到 Git、写进 shell 历史或发送到 AI 对话。

5. 在管理端安装 cloudflared，使用 `ssh node-cf` 连接。客户端的 `cloudflared access ssh` 会在需要时引导完成 Cloudflare Access 登录。

使用普通 Access Self-hosted Application 即可。Access 负责认证连接，不会检查或过滤 SSH 命令。若目标是普通、不受命令策略限制的 SSH 会话，不要选用会引入逐目标命令策略或命令录制的 Access for Infrastructure 模式。

## 5. Tailscale 连接路径

1. 按官方 Linux 安装说明安装 Tailscale。
2. 执行 `sudo tailscale up`，通过所有者控制的浏览器身份完成设备加入。
3. 确认现有 tailnet policy 允许获授权的管理端访问目标 TCP/22。
4. 保持 Tailscale SSH 关闭（`sudo tailscale set --ssh=false`），让连接进入与 Cloudflare 路径相同的 OpenSSH 服务。
5. 使用 `ssh node-ts` 和同一把 OpenSSH 密钥连接。

Tailscale 只负责网络连通，OpenSSH 仍然负责 OS 登录身份和权限。无需 GhostFleet 自己实现 Tailscale 控制器或 ACL 引擎。

## 6. 客户端配置

将 [ghostfleet.conf.example](../config/ssh/ghostfleet.conf.example) 复制到管理端的 `~/.ssh/config`，或通过 `Include` 引入。替换：
- `ssh.example.invalid`：Cloudflare Access 主机名；
- `node.tailnet-name.example.invalid`：目标机器的 Tailscale MagicDNS 名称；
- `~/.ssh/ghostfleet_admin`：管理端本地私钥路径。

连接命令：

```sh
ssh node-cf
ssh node-ts
```

两个别名共用一个 `HostKeyAlias`，因此两条路径都会校验同一台服务器的主机密钥。

## 7. 日志与故障恢复

使用操作系统原生日志：

```sh
journalctl -u ssh --since today
journalctl -u cloudflared-ssh --since today
journalctl -u tailscaled --since today
systemctl status ssh cloudflared-ssh tailscaled
```

这些日志记录服务和连接认证事件，但不保证记录每一条 Shell 命令。GhostFleet 不另建命令日志或监控系统。

如果 Cloudflare 不可用，新建会话时使用 `ssh node-ts`；如果 Tailscale 不可用，使用 `ssh node-cf`。已经建立的 TCP 会话需要重新连接，不能在两条路径之间无损迁移。

## 8. 撤销访问

- 从 Cloudflare Access 允许策略中移除管理身份，或关闭对应 Tunnel route；
- 从 Tailscale policy 中移除身份/设备，或撤销该节点；
- 从 `/root/.ssh/authorized_keys` 删除对应公钥；
- 如需关闭整条路径，再停止对应服务。

网络层撤销会阻止新连接；移除 SSH 公钥则会同时阻止两条路径的 OS 登录。

## 边界

本方案是远程访问传输层，不是完整设备管理 Agent。它不会监控硬盘、RAID、进程或服务，不会过滤命令，不会逐条审批操作，也不承诺命令级审计。它不会自动修改存储、RAID、共享目录、软件包或业务服务。

## Upstream references

- Cloudflare SSH/Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/
- Cloudflare client-side SSH: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/
- Cloudflare Tunnel token-file run parameter: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/
- Tailscale Linux install: https://tailscale.com/docs/install/linux
- Tailscale network access policy: https://tailscale.com/docs/features/access-control
- OpenMediaVault 8 SSH behavior: https://docs.openmediavault.org/en/8.x/administration/services/ssh.html
