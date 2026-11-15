# Remote access deployment

This guide is a template. It does not deploy anything and contains no real hostnames, keys, tokens or account identifiers. Apply it only after the device owner authorizes the exact target and Cloudflare/Tailscale policy changes.

## 1. Install the native services on the target

On Debian/OMV, install and enable:
- OpenSSH server (`openssh-server`, service normally `ssh.service`);
- Tailscale from its official Debian package instructions (`tailscaled.service`);
- cloudflared from Cloudflare's official package instructions.

Do not install a GhostFleet Node Agent. There is no custom GhostFleet daemon.

## 2. Configure OpenSSH for owner-authorized administrator access

The example in [00-ghostfleet-admin.conf.example](../config/sshd/00-ghostfleet-admin.conf.example) enforces public-key-only authentication for root inside `Match User root`. It does not set global password or keyboard-interactive policy; non-root accounts retain the effective authentication settings supplied by the OS. Copy it to `/etc/ssh/sshd_config.d/00-ghostfleet-admin.conf`, add the owner's **public** key to `/root/.ssh/authorized_keys`, then validate before reloading:

```sh
sudo SSH_TEST_CONTEXT='user=root,host=localhost,addr=127.0.0.1' scripts/verify-sshd-admin.sh
```

The verifier runs `sshd -t` and `sshd -T -C` in a root context and requires enabled root login (`prohibit-password`, its normalized `without-password` alias, or OMV-managed `yes`), `pubkeyauthentication yes`, `passwordauthentication no`, `kbdinteractiveauthentication no`, and the complete `AuthenticationMethods` value to be exactly `publickey`. These are effective values for root, not global requirements. Replace the context host/address when Match rules depend on them. A conflict or missing value fails closed; the verifier never reloads sshd. Non-root policy is not asserted or changed by this verifier. Do not copy the private key to the server, repository or chat.

**OMV/cloud-init boundary:** do not edit a generated main sshd config as the durable source of truth. Inspect Include order, drop-ins and Match rules. OMV/cloud-init may regenerate configuration on Apply/upgrade; after such an operation rerun `sshd -t` and the effective-policy verifier. If a vendor-managed setting wins, reconcile it at its supported source rather than deleting generated files.

**OMV 8 root-session choice:** OMV's own guidance normally recommends a non-privileged user in `_ssh` and `sudo`, and recommends disabling root SSH after installation. This GhostFleet profile intentionally chooses direct root administration with SSH public-key-only authentication. In OMV `Services → SSH`, enable root login and public-key authentication. Do not disable password authentication globally just to satisfy GhostFleet; preserve the OS/OMV-wide policy for non-root users. Put the root-only restrictions in OMV's supported SSH **Extra options** field as a `Match User root` block, not in a global toggle or generated file. Preserve the OMV-managed `AllowGroups` rule only if it admits root (the usual `root _ssh` list does); do not add root to `_ssh` just to satisfy a generic rule. The verifier accepts OMV's `PermitRootLogin yes` only when root's effective public-key authentication is enabled, password and keyboard-interactive authentication are disabled, `AuthenticationMethods publickey` is effective, and the supported static admission checks pass. See [OMV 8 SSH documentation](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html).

**Static-check boundary:** all repeated Allow/Deny entries are read. Exact user/group names and a standalone `*` are supported; patterns such as `user@host`, partial wildcards or negation return `UNKNOWN` and a nonzero exit. Do not weaken a valid complex policy to satisfy this small checker. Inspect it through OpenSSH and record real login evidence. A successful result still does not prove `authorized_keys`, PAM/account state, forced-command options, SFTP or a live login. The test context must contain exactly one `user=root`; evaluate both the Cloudflare-origin and Tailscale connection contexts.

After an authorized configuration change, keep the existing session or local console available. On ordinary Debian, once syntax and supported effective checks pass, use the platform's SSH reload (`sudo systemctl reload ssh` where that is the installed unit). On OMV, Apply through its supported configuration source and rerun the checks. Open a separate new connection, confirm the intended account and normal session behavior, then close the old session. If checks fail or login remains unknown, retain the recovery path. See the [acceptance matrix](ACCEPTANCE.md).

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

The two aliases for one machine share one `HostKeyAlias`, so either route checks the same server host key. Choose a different stable alias for every other machine; do not reuse `ghostfleet-node` for the whole fleet. During route acceptance, disable connection reuse with `-o ControlPath=none -o ControlMaster=no`.

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

Revocation must be verified with a fresh connection through each path. Removing an SSH authorized key prevents new authentication with that key; it does not terminate an already authenticated shell. Network-policy propagation and existing-session termination depend on the selected provider and configuration. Test and record them separately; stop existing sessions explicitly only when that action is authorized.

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

使用 [00-ghostfleet-admin.conf.example](../config/sshd/00-ghostfleet-admin.conf.example) 作为配置模板。它通过 `Match User root` 强制 root 仅使用公钥认证，不设置全局密码或键盘交互认证策略；普通账户继续遵循操作系统原有的有效配置。

将模板复制到 `/etc/ssh/sshd_config.d/00-ghostfleet-admin.conf`，把管理员的**公钥**加入 `/root/.ssh/authorized_keys`。然后在仓库根目录执行：

```sh
sudo SSH_TEST_CONTEXT='user=root,host=localhost,addr=127.0.0.1' scripts/verify-sshd-admin.sh
```

验证脚本会执行 `sshd -t` 和 root 连接上下文的 `sshd -T -C`，并检查 root 最终生效值：
- root 登录已启用：`prohibit-password` / 等价的 `without-password`，或配合下列全部公钥约束的 OMV `yes`；
- `pubkeyauthentication yes`；
- `passwordauthentication no`；
- `kbdinteractiveauthentication no`；
- `authenticationmethods publickey`。

如果存在更早加载的配置或 `Match` 规则覆盖了 root 的这些值，脚本会失败退出。它不要求全局关闭普通用户的密码认证，也不会检查或改变非 root 用户的认证策略。脚本不会修改配置文件，也不会重载或重启 sshd。若 `Match` 依赖实际主机名或客户端地址，应通过 `SSH_TEST_CONTEXT` 设置真实测试上下文。

**OMV / cloud-init 配置边界：** Debian 通常在主配置的 `Include /etc/ssh/sshd_config.d/*.conf` 位置按文件名字典序加载 drop-in；OpenSSH 对大多数配置采用 first-obtained-value 规则。因此 `00-` 前缀只是提高优先级，不保证一定胜出。不要盲目修改 OMV 或云镜像生成的主配置；先检查 Include 顺序、已有 drop-in 和 Match 规则。OMV Apply、系统升级或 cloud-init 可能重新生成配置，之后必须重新执行上述验证。若厂商配置仍然优先，应在其支持的配置来源中调整，而不是删除生成文件。

**OMV 8 的 root 会话选择：** OMV 官方通常建议使用加入 `_ssh` 组的普通用户，再通过 `sudo` 提权，并建议安装后关闭 root SSH。本 GhostFleet 配置按所有者的产品决定，选择直接 root 管理，但只允许 SSH 公钥认证。在 OMV 的 `Services → SSH` 中启用 root 登录和公钥认证。不要仅为满足 GhostFleet 而全局关闭密码认证；普通账户应继续遵循 OS/OMV 原有策略。通过 OMV 支持的 SSH **Extra options** 字段加入 `Match User root` 专用限制，不要编辑生成文件。OMV 管理的 `AllowGroups` 必须允许 root（常见的 `root _ssh` 列表满足要求）；不要为了满足通用规则而把 root 加入 `_ssh`。验证脚本只有在 root 上下文的公钥认证开启、密码和键盘交互认证关闭、`AuthenticationMethods publickey` 生效且受支持的静态准入检查通过时，才接受 OMV 的 `PermitRootLogin yes`。参见 [OMV 8 SSH 官方文档](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html)。

**静态验证范围：** 脚本读取所有重复的 Allow/Deny 项，支持准确的用户/组名和单独的 `*`。`user@host`、部分通配符、否定模式等返回 `UNKNOWN` 并非零退出，不冒充 OpenSSH 的完整匹配引擎。不要为了通过小型验证器而放宽原本有效的复杂策略；应由 OpenSSH 与真实登录证据判断。静态成功仍不证明 `authorized_keys`、PAM/账户状态、forced-command 选项、SFTP 或真实登录可用。上下文必须且只能包含一个 `user=root`；分别检查 CF 源站路径和 Tailscale 路径的真实上下文。

获授权修改配置后，保留已有会话或本地控制台。普通 Debian 在语法与受支持的有效配置检查通过后，使用系统支持的重载方式（安装单元为 `ssh` 时执行 `sudo systemctl reload ssh`）；OMV 通过支持的配置来源 Apply，再回查有效配置。随后另开新连接，确认 OS 账户及正常会话能力，再关闭旧会话。检查失败或登录仍不确定时保留恢复入口，详见 [验收矩阵](ACCEPTANCE.md)。

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

同一机器的两个别名共用一个 `HostKeyAlias`，两路校验同一主机密钥；每台其他机器必须使用自己的稳定别名，不能全舰队照抄 `ghostfleet-node`。路径验收时使用 `-o ControlPath=none -o ControlMaster=no`，避免复用已有连接而误判另一条路径可用。

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

撤销效果须通过两路新连接验证。删除 authorized_keys 中的公钥会阻止该密钥的新认证，不会自动终止已经认证的 Shell。网络策略传播与已有连接终止取决于具体 provider 和配置，应分别实测；只有获授权时才主动终止已有会话。

## 边界

本方案是远程访问传输层，不是完整设备管理 Agent。它不会监控硬盘、RAID、进程或服务，不会过滤命令，不会逐条审批操作，也不承诺命令级审计。它不会自动修改存储、RAID、共享目录、软件包或业务服务。

## Upstream references

- Cloudflare SSH/Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/
- Cloudflare client-side SSH: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/
- Cloudflare Tunnel token-file run parameter: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/
- Tailscale Linux install: https://tailscale.com/docs/install/linux
- Tailscale network access policy: https://tailscale.com/docs/features/access-control
- OpenMediaVault 8 SSH behavior: https://docs.openmediavault.org/en/8.x/administration/services/ssh.html
