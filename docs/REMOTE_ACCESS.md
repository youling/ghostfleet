# 原生远控部署 / Native remote access

## 中文

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

### Cloudflare 源站连接器诊断（服务器侧）

本节在**运行 cloudflared 的源站机器**执行，不在操作者 Windows 客户端执行。它诊断源站到 Cloudflare Edge 的连接条件；不能替代 hostname DNS、Published Application、Access Policy 或最终 SSH 会话验收。

先记录实际二进制和版本，再执行 Cloudflare 自带的连接预检：

```sh
command -v cloudflared
cloudflared --version
cloudflared tunnel diag
```

从 `cloudflared 2026.5.2` 起，`tunnel diag` 会检查：
- `region1.v2.argotunnel.com` 与 `region2.v2.argotunnel.com` 的 DNS 解析；
- 到 Cloudflare Tunnel Edge 的出站 UDP/7844（QUIC）和 TCP/7844（HTTP/2）；
- 到 `api.cloudflare.com:443` 的管理 API 连通性。

UDP 或 TCP 任一路径可用时，cloudflared 通常可以使用对应传输；强制选择被防火墙阻断的协议会导致连接失败。443 管理 API 检查涉及更新检查、Access JWT 验证等能力，按工具返回的 Pass/Warn/Fail 分别解释；不能把单独的 443 Warn 等同于 Tunnel 数据通道中断。防火墙只需按实际协议放行出站与返回流量，不要因此开放源站入站 7844。

`tunnel diag` 会在当前工作目录生成诊断归档；该命令用于诊断，不会代替配置变更或重启连接器。建议先进入权限受限的临时目录执行，并在本地检查归档内容；日志、主机信息、Tunnel 标识和连接元数据可能属于敏感信息。只把经过筛选、脱敏的摘要写入公开工单；不要上传原始归档、token、凭据或完整私有日志。若当前版本支持，可减少采集范围：

```sh
cloudflared tunnel diag --no-diag-logs --no-diag-metrics --no-diag-system --no-diag-runtime
```

先运行 `cloudflared tunnel diag --help` 确认当前版本支持这些选项。诊断归档只保留在 owner 控制的私有位置；按原件保留要求归档或在完成核对后清理临时副本。

再分别核对**本机进程、systemd 单元、Edge 连接和源站 SSH**。使用实际安装的单元名称与 manager scope；不要把 system manager 和 user manager 混为一谈：

```sh
systemctl status cloudflared-ssh.service --no-pager
journalctl -u cloudflared-ssh.service -b --no-pager -n 100
ss -ltnp
```

如果连接器由 user manager 管理，应改用 `systemctl --user` 与对应的 `journalctl --user`。如产品或本地 unit 另有 readiness URL，可单独读取该端点；**本机 readiness HTTP 200 只证明该本地端点当时响应，不证明 cloudflared 已连接 Edge，也不证明 hostname、Published Application、Access 或 SSH 可用**。需要确认真实 Edge 连接时，结合 cloudflared 当前日志、Tunnel 状态/Connections API 或 Dashboard 读回连接数量与状态；不要只凭进程存在作结论。

推荐按以下层次判定，避免把不同故障混在一起：

1. **进程与本机就绪**：实际 unit 是否 active，进程是否持续运行，本地 readiness（若存在）是否响应。
2. **源站到 Edge 的网络条件**：`tunnel diag` 中两组 DNS、UDP/7844、TCP/7844 的结果；根据实际使用的 QUIC/HTTP2 协议判定。历史 journal 超时不能覆盖新的成功诊断，反之亦然。
3. **当前 Edge 连接**：读取 Tunnel 当前 status / connections；预检通过不等于已建立连接，进程 active 也不等于 Edge healthy。
4. **应用发布与准入**：独立核对正确 Tunnel 的 ingress hostname/service、权威 DNS record、Access Application/Policy。
5. **端到端 SSH**：从真实管理客户端用新会话、关闭连接复用，验证 host key、预期 OS 用户、显式 exec 与必要的 PTY shell；再按授权执行拒绝身份/来源负测。

版本升级是独立维护变更：先读 `cloudflared --version` 和官方 release notes，按原安装来源升级，保留回退制品/包版本，并在受控节点验证连接器重新建立 Edge 连接。不要把升级、DNS/route 变更、token 轮换和 SSH 验收合并成一个不可区分的动作；不要在没有恢复通道时同时重启唯一连接器。

官方依据：[Connectivity pre-checks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/) · [Tunnel firewall / outbound 7844](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/) · [2026-05-27 cloudflared pre-check changelog](https://developers.cloudflare.com/changelog/post/2026-05-27-cloudflared-connectivity-prechecks/)

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

### Cloudflare 客户端 SSH 前置条件与分层排障

本指南使用 Cloudflare Published Application 的 **SSH 路由**：服务类型选择 SSH，源站通常填写 `ssh://127.0.0.1:22`。原生 SSH 客户端通过 `ProxyCommand` 启动客户端侧的 `cloudflared access ssh --hostname %h`。Cloudflare 要求服务器侧（Tunnel connector）和操作者客户端都安装 `cloudflared`。客户端只需要可执行文件，**不需要再创建一套 Tunnel 服务，也不需要服务器侧 Tunnel token**。

不要混淆两种 Published Application 服务类型：

- **SSH / `ssh://…:22`** → SSH `ProxyCommand … access ssh --hostname %h`。`ssh node-cf` 测试的就是这条路径。
- **TCP / `tcp://…`** → 启动 `cloudflared access tcp --hostname <hostname> --url 127.0.0.1:<local-port>`，再让 TCP 客户端连接本地转发端口。这是另一种本地转发流程。执行 `access tcp` 不能验证 SSH 类型 Published Application，也不能验证 SSH `ProxyCommand`。

#### DNS 权威区与 Published Route 必须分开核验

`NXDOMAIN` 只证明被查询的 DNS 视图中没有该名称；它本身不能证明 Tunnel connector 故障，也不能单独证明 Published Application route 不存在。先确认域名的权威 NS、Cloudflare zone 是否为 **Full Setup**（Cloudflare 托管权威 DNS）还是 **Partial Setup**（权威 DNS 在其他服务商），再检查 hostname、route 与 DNS record 的对应关系：

- **Full Setup：** 在 Cloudflare Dashboard 为 Tunnel 添加 Published Application route 时，Cloudflare 会自动创建指向该 Tunnel 子域名（`<UUID>.cfargotunnel.com`）的 DNS record。若看到 NXDOMAIN，应回读确切 zone、hostname、route 和自动生成的 record 是否存在、名称是否一致；不要先重复创建 route。
- **Partial Setup：** Cloudflare 不托管该域名的权威 DNS。每个 Published Application hostname 还需要在当前权威 DNS 服务商单独创建 CNAME/ALIAS；Cloudflare 当前 FAQ 给出的 partial-CNAME 目标格式为 `<hostname>.cdn.cloudflare.net`。只在确认 zone 模式与目标格式后修改对应 DNS owner，不能照搬 Full Setup 的自动创建假设。
- **Route readback：** 在正确账户/zone 的 Tunnels 页面读取目标 Tunnel 的 Published Application 列表，核对完整 hostname、服务类型（SSH 或 TCP）和 Service URL。SSH route 应为 `ssh://127.0.0.1:22`（或经 owner 确认的实际源站）；TCP route 应为 `tcp://…`。再独立核对 Access Application/Policy 覆盖该 hostname。
- **不要混为一个对象：** Tunnel connector `Healthy/Ready`、Published Application route、权威 DNS record、Access Application/Policy 是不同层。只有逐项读回，才能判断 NXDOMAIN 是 zone/delegation、record 缺失/错名，还是 route/Access 另有问题。

在已授权客户端可使用以下只读 DNS 检查（将示例域名替换为实例 hostname；输出留私有记录）：

```sh
dig +trace ssh.example.invalid
dig NS example.invalid +short
dig CNAME ssh.example.invalid +short
dig A ssh.example.invalid +short
dig AAAA ssh.example.invalid +short
```

Windows PowerShell 可用 `Resolve-DnsName example.invalid -Type NS` 与 `Resolve-DnsName ssh.example.invalid -Type CNAME`。如果是 Partial Setup，应对实际权威 DNS provider 查询，而不只查询 Cloudflare Dashboard。任何 DNS/route 写操作都应等到 owner 回读当前对象、确认最小差异和回退方式后再按原授权执行。

官方依据：[Cloudflare Tunnel Routing（Published Application 与自动 DNS record）](https://developers.cloudflare.com/tunnel/concepts/routing/) · [Tunnels FAQ（Full/Partial DNS）](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)。

测试前先明确实际使用哪台客户端。Windows PowerShell 可这样检查客户端二进制和版本：

```
$cf = Get-Command cloudflared.exe -ErrorAction Stop
$cf.Source
& $cf.Source --version
Resolve-DnsName ssh.example.invalid
Test-NetConnection ssh.example.invalid -Port 443
```

如果 `Get-Command` 失败，说明客户端 PATH 中找不到该程序；从 [Cloudflare 官方下载页](https://developers.cloudflare.com/tunnel/downloads/) 安装或定位 Windows 客户端，再使用核实过的绝对路径。Linux/macOS 客户端执行：

```
command -v cloudflared
cloudflared --version
getent ahosts ssh.example.invalid
```

如果二进制不在 PATH 中，应在 SSH 配置里填写核实过的绝对路径。例如 Windows OpenSSH 配置可以写成：

```
Host node-cf
    HostName ssh.example.invalid
    ProxyCommand "C:/Program Files/Cloudflare/cloudflared.exe" access ssh --hostname %h
```

保留原有 SSH 密钥、每台机器唯一的 `HostKeyAlias` 和严格主机密钥校验。不要把服务器 Tunnel token 复制到客户端，也不要为了取得客户端程序就在操作者电脑上执行 `cloudflared service install`。

连接前先检查 SSH 实际生效配置，确认 `proxycommand` 指向预期的本地二进制，并调用 `access ssh`：

```
ssh -G node-cf
ssh -vvv -o ControlPath=none -o ControlMaster=no node-cf
```

按故障所在层定位，不要把所有 exit code 1 都当成 Tunnel 故障：

1. **客户端本地启动：** 二进制不存在、PATH/引号错误或 ProxyCommand 无法启动 → 先修复所选客户端的二进制路径。
2. **DNS / 边缘连通：** 域名解析失败，或客户端无法向 Cloudflare edge 建立出站 HTTPS → 检查客户端 DNS、出站网络和主机名。TCP/443 检查成功只证明能到边缘，不证明 Access、Tunnel 或 SSH 正常。
3. **Access 身份 / 策略：** 本地代理已启动，但浏览器认证未完成或 Access 拒绝身份 → 检查该主机名对应的 Access 应用和策略。
4. **Tunnel / Published Route / 源站：** Access 已通过，但 Cloudflare 报告 connector、route 或 origin 不可用 → 检查所选 Tunnel 的 Published Route、connector 健康状态和 SSH 源站地址。不要用 reporter 心跳推断这条路径。
5. **原生 OpenSSH 认证：** 如果代理已经到达源站，而 SSH 返回 `Permission denied (publickey)`，说明网络路径已经到达 sshd；接着检查目标 OS 用户、密钥和实际 `sshd -T -C` 上下文。

完整 `ssh -vvv` 输出和 provider 日志留在私有记录中；公开记录只写脱敏后的错误类别、客户端 OS、客户端 `cloudflared` 版本、route 服务类型和测试时间。新 SSH 会话正测通过后，再执行获授权的拒绝身份/来源负测。服务器侧 `cloudflared` unit 处于 active、出站 heartbeat 成功，或仅做了 TCP 探测，都不等于 SSH 端到端验收通过。

上游资料：[Cloudflare 客户端 SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)、[Published Application 协议类型](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)、[任意 TCP 客户端流程](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/)。

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

## English

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

### Origin-side cloudflared diagnostics

Run this section **on the host that runs cloudflared**, not on the operator's Windows client. It checks origin-to-Cloudflare Edge connectivity prerequisites; it does not replace hostname DNS, Published Application, Access Policy or a real SSH-session acceptance test.

Record the actual binary and version, then run Cloudflare's built-in connectivity diagnostics:

```sh
command -v cloudflared
cloudflared --version
cloudflared tunnel diag
```

Starting with `cloudflared 2026.5.2`, `tunnel diag` checks:
- DNS resolution for `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com`;
- outbound UDP/7844 (QUIC) and TCP/7844 (HTTP/2) to Cloudflare Tunnel Edge;
- management API connectivity to `api.cloudflare.com:443`.

If either UDP or TCP is available, cloudflared can generally use the corresponding transport. Forcing a protocol blocked by the firewall will prevent that transport from connecting. The 443 management API check covers capabilities such as software update checks and Access JWT validation; interpret Pass/Warn/Fail according to the tool output. A standalone 443 warning does not mean the Tunnel data path is down. Allow the required outbound and return traffic for the protocol in use; do not open inbound port 7844 on the origin.

`tunnel diag` creates a diagnostic archive in the current working directory. It is a diagnostic command, not a configuration change or connector restart. Run it from a restricted temporary directory and inspect the archive locally. Logs, host details, Tunnel identifiers and connection metadata may be sensitive. Publish only filtered, sanitized summaries; never upload the raw archive, tokens, credentials or complete private logs. If supported by the installed version, reduce the collected scope:

```sh
cloudflared tunnel diag --no-diag-logs --no-diag-metrics --no-diag-system --no-diag-runtime
```

Check `cloudflared tunnel diag --help` first to confirm that the installed version supports these options. Keep diagnostic archives only in an owner-controlled private location; retain or remove temporary copies according to the owner's evidence-retention requirements.

Then inspect the **local process, systemd unit, Edge connections and origin SSH** separately. Use the actual installed unit name and manager scope; do not confuse the system manager with a user manager:

```sh
systemctl status cloudflared-ssh.service --no-pager
journalctl -u cloudflared-ssh.service -b --no-pager -n 100
ss -ltnp
```

If the connector is managed by a user manager, use `systemctl --user` and the corresponding `journalctl --user` commands. If the product or local unit exposes a readiness URL, query it separately. **A local readiness HTTP 200 proves only that the local endpoint responded at that time; it does not prove cloudflared is connected to Edge, nor that hostname DNS, Published Application, Access or SSH works.** To establish current Edge connectivity, combine current cloudflared logs with Tunnel status/Connections API or Dashboard readback. Do not infer health solely from the process being present.

Classify failures by layer:

1. **Process and local readiness:** Is the actual unit active? Is the process running? Does the local readiness endpoint respond, if one exists?
2. **Origin-to-Edge network prerequisites:** Check both DNS regions and UDP/7844 and TCP/7844 results in `tunnel diag`. Interpret them against the QUIC/HTTP2 protocol actually in use. Historical journal timeouts do not override a newer successful diagnostic, and vice versa.
3. **Current Edge connections:** Read the Tunnel's current status/connections. Passing pre-checks does not prove a live connection; an active process does not prove Edge health.
4. **Published route and access:** Independently read the correct Tunnel's ingress hostname/service, authoritative DNS record and Access Application/Policy.
5. **End-to-end SSH:** From the real operator client, use a fresh session with connection reuse disabled. Verify host key, expected OS user, explicit exec and any required PTY shell; then run authorized denied-identity/source tests.

Treat upgrades as a separate maintenance change. First record `cloudflared --version` and read the official release notes; upgrade through the same installation source, preserve a rollback package/binary, and verify that the connector reconnects to Edge on a controlled node. Do not combine a software upgrade, DNS/route change, token rotation and SSH acceptance into one indistinguishable operation. Do not restart the only connector without a recovery path.

Official references: [Connectivity pre-checks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/) · [Tunnel firewall / outbound 7844](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/) · [2026-05-27 cloudflared pre-check changelog](https://developers.cloudflare.com/changelog/post/2026-05-27-cloudflared-connectivity-prechecks/)

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

### Cloudflare client-side SSH prerequisites and failure isolation

For this profile the Published Application route is an **SSH** route: its service type is SSH and its origin is typically `ssh://127.0.0.1:22`. The native SSH client launches the client-side `cloudflared access ssh --hostname %h` process through `ProxyCommand`. Cloudflare requires `cloudflared` on both the server side (the Tunnel connector) and the operator's client. The client needs the executable; it does **not** need a second Tunnel service or a server-side token.

Do not confuse the two published service types:

- **SSH / `ssh://…:22`** → SSH `ProxyCommand … access ssh --hostname %h`. This is the route tested by `ssh node-cf`.
- **TCP / `tcp://…`** → start `cloudflared access tcp --hostname <hostname> --url 127.0.0.1:<local-port>`, then point the TCP client at that local port. This is a different local-forwarding flow. Running `access tcp` does not test an SSH-type Published Application route or the SSH `ProxyCommand`.

#### DNS authority and Published Route must be checked separately

`NXDOMAIN` proves only that the queried DNS view has no such name. It does not prove that the Tunnel connector is down, and it does not by itself prove that a Published Application route is absent. First identify the domain's authoritative nameservers and whether the Cloudflare zone uses **Full Setup** (Cloudflare hosts authoritative DNS) or **Partial Setup** (another provider hosts authoritative DNS). Then reconcile the hostname, route and DNS record:

- **Full Setup:** when you add a Published Application route to a Tunnel in the Cloudflare dashboard, Cloudflare automatically creates a DNS record pointing the hostname to the Tunnel subdomain (`<UUID>.cfargotunnel.com`). If the hostname returns NXDOMAIN, read back the exact zone, hostname, route and generated record; do not blindly create a duplicate route.
- **Partial Setup:** Cloudflare does not host authoritative DNS for the domain. Each Published Application hostname also needs a CNAME/ALIAS at the current authoritative DNS provider. Cloudflare's current FAQ gives `<hostname>.cdn.cloudflare.net` as the partial-CNAME target format. Confirm the zone mode and target format before changing the DNS owner; do not assume Full Setup's automatic record creation applies.
- **Route readback:** in the correct account/zone, inspect the target Tunnel's Published Application list and verify the exact hostname, service type (SSH or TCP) and Service URL. An SSH route should use `ssh://127.0.0.1:22` (or the owner-confirmed origin); a TCP route should use `tcp://…`. Separately verify the Access Application/Policy covers that hostname.
- **Do not collapse the objects:** Tunnel connector `Healthy/Ready`, Published Application route, authoritative DNS record, and Access Application/Policy are distinct layers. Read each one before deciding whether NXDOMAIN is caused by zone/delegation, a missing/misnamed record, or a separate route/Access problem.

The following read-only DNS checks can be run from the authorized client (replace the example with the instance hostname; keep outputs in the private record):

```sh
dig +trace ssh.example.invalid
dig NS example.invalid +short
dig CNAME ssh.example.invalid +short
dig A ssh.example.invalid +short
dig AAAA ssh.example.invalid +short
```

On Windows PowerShell use `Resolve-DnsName example.invalid -Type NS` and `Resolve-DnsName ssh.example.invalid -Type CNAME`. For Partial Setup, query the actual authoritative DNS provider, not only the Cloudflare dashboard. Do not write DNS or route configuration until the owner has read back the current objects, identified the minimum difference and recorded a rollback path.

Official references: [Cloudflare Tunnel Routing (Published Applications and automatic DNS records)](https://developers.cloudflare.com/tunnel/concepts/routing/) · [Tunnels FAQ (Full/Partial DNS)](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/).

Choose the actual client machine before testing. On Windows PowerShell, verify the client executable and version:

```
$cf = Get-Command cloudflared.exe -ErrorAction Stop
$cf.Source
& $cf.Source --version
Resolve-DnsName ssh.example.invalid
Test-NetConnection ssh.example.invalid -Port 443
```

If `Get-Command` fails, the client executable is absent from PATH; install/locate the official Windows client from [Cloudflare downloads](https://developers.cloudflare.com/tunnel/downloads/), then use its absolute path. On Linux/macOS:

```
command -v cloudflared
cloudflared --version
getent ahosts ssh.example.invalid
```

If the binary is not on PATH, use its verified absolute path in the SSH configuration. For example, a Windows OpenSSH host block may use:

```
Host node-cf
    HostName ssh.example.invalid
    ProxyCommand "C:/Program Files/Cloudflare/cloudflared.exe" access ssh --hostname %h
```

Keep the existing key, unique per-node `HostKeyAlias` and strict host-key verification. Do not copy a server Tunnel token to the client, and do not run `cloudflared service install` on the operator workstation just to obtain the client executable.

Before connecting, inspect the effective SSH configuration and confirm that `proxycommand` resolves to the intended local binary and uses `access ssh`:

```
ssh -G node-cf
ssh -vvv -o ControlPath=none -o ControlMaster=no node-cf
```

Use the output to isolate the failing layer instead of treating every exit code 1 as a Tunnel failure:

1. **Local client launch:** executable missing, PATH/quoting error, or ProxyCommand cannot start → fix the selected client's binary path first.
2. **DNS / edge reachability:** hostname resolution fails, or the client cannot establish outbound HTTPS to the Cloudflare edge → investigate the client DNS/egress/hostname layer. A successful TCP/443 check proves only edge reachability, not Access, Tunnel or SSH.
3. **Access identity / policy:** the local proxy starts but browser authentication is not completed or Access denies the identity → inspect the Access application and policy for the selected hostname.
4. **Tunnel / published route / origin:** Access succeeds but Cloudflare reports the connector/route/origin unavailable → inspect the selected Tunnel's published route, connector health and configured SSH origin. Do not infer this from the reporter's heartbeat.
5. **Native OpenSSH authentication:** if the proxy reaches the origin and SSH returns `Permission denied (publickey)`, the network path has reached sshd; inspect the intended OS user, key and the effective `sshd -T -C` context.

Retain full `ssh -vvv` output and provider logs privately; publish only sanitized error class, client OS, client `cloudflared` version, route service type and test time. After a positive fresh SSH session, run the authorized denied-identity/source negative test. An active server-side `cloudflared` unit, a successful outbound heartbeat, or a TCP-only probe is not end-to-end SSH acceptance.

Upstream: [Cloudflare client-side SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/), [published application protocol types](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/), [arbitrary TCP client flow](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/).

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

## 上游资料 / Upstream references

- Cloudflare SSH/Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/
- Cloudflare client-side SSH: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/
- Cloudflare published application protocol types (SSH vs TCP): https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
- Cloudflare arbitrary TCP client flow: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/
- Cloudflare Tunnel token-file run parameter: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/
- Tailscale Linux install: https://tailscale.com/docs/install/linux
- Tailscale network access policy: https://tailscale.com/docs/features/access-control
- OpenMediaVault 8 SSH behavior: https://docs.openmediavault.org/en/8.x/administration/services/ssh.html
