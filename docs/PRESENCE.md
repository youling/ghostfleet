# Enrollment and presence / 纳管与心跳

## 中文

### 开发与验证

服务端开发使用 Node22+；节点客户端使用 Python3.10+ 和支持 DynamicUser/LoadCredential 的 systemd，首验环境为 Debian13。原生 SSH 配置沿用 [传输指南](REMOTE_ACCESS.md)。不需要在节点安装 Node、npm、curl 或额外 Python 包。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:python
npm run build
npm run test:live
# 仅在有 user systemd manager 的 Linux 隔离工作区运行：
python3 test/live-presence.py --with-user-systemd
```

`test:live` 启动仅绑定 loopback 的真实 Workerd/DO，使用合成凭据，验证并发领取、reporter、持久化重启和撤销。附加参数创建独立命名的临时用户 timer/service，验证凭据投递、journald、断网/恢复，最后删除测试状态。不会改 SSH、提供商或系统级 unit；没有 user manager 时附加测试明确失败，不报告为通过。全部测试属于作者/CI证据，不替代独立代码审查。

构建产生 `dist/console`、`dist/installer.json`、`dist/wrangler.json`。安装器为单个 SHA-256 固定 Python 文件；面板下载命令先验哈希，再在目标机执行。短码通过终端隐藏输入，不写入命令、URL或服务器持久明文。Root 初次授权只用于安装自身配置和 unit。

### 实例发布的最短路径

1. 从已审查提交构建。保留真实部署的 Worker 名称、DO绑定/命名空间和既有 `v1` migration；不要重新创建 namespace 或抹掉 snapshot。发布前保留上一 Worker 版本与数据备份。
2. 在私有部署覆盖中把 panel/node 两个 HTTPS origin、域名路由配置到**同一个 Worker**。示例 `example.invalid` 不是可发布地址。Panel 全站 Access；node origin 不套浏览器登录页，但仅允许实现中的机器路由。保持 workers.dev/preview 关闭。
3. 所有者通过原生 secret 配置设置不同的 `GHOSTFLEET_OPERATOR_TOKEN` 和 `GHOSTFLEET_READ_TOKEN`（各至少32字符的高熵随机值）。不要交给聊天、Issue、CI或仓库。Access 登录不自动成为应用 Operator。
4. 私有覆盖应用在生成的 `dist/wrangler.json` 上，保留构建生成的 `GHOSTFLEET_INSTALLER_SHA256`。先执行 `wrangler deploy --dry-run --config <private-config>`；正式发布/域名操作由实例 owner 按现行授权完成，不由 CI 自动发布。
5. 先验证匿名 panel 的 Access 拦截、Read 写入拒绝、node origin 管理 API 404、错误/撤销心跳凭据401、正确安装器字节哈希，再做第一台经授权节点的系统级安装。检查普通用户 SSH 与已有 root 公钥入口未改变。

旧 Worker 的 command/MCP/helper/七证据纳管 API 不再挂载，旧 node 数据和 lifecycle 字段保留。若有旧消费者，先确认切换与回滚；不能直接覆盖仍在使用旧 API 的生产实例。需要回退时回退该 Worker 版本并停用本 reporter；不要为回退删除原节点、DO或 SSH 凭据。

### 日常使用与修复

Operator 登录面板，输入节点名称，创建票据；在目标机可信终端运行面板给出的哈希固定命令并输入短码。已是 root 时去掉 `sudo`。客户端默认观察 `ssh.service`、`cloudflared-ssh.service`、`tailscaled.service`；实际 unit 名称不同，通过安装器 `--ssh-unit` / `--cloudflared-unit` / `--tailscaled-unit` 指定。不存在的服务显示“未安装/未找到”，不要伪装成活动。

**服务观察的管理器范围：** reporter 使用 `systemctl --system show`，因此 `--ssh-unit` / `--cloudflared-unit` / `--tailscaled-unit` 只选择 system manager 中要查询的 unit 名称，不会切换到 `systemctl --user`。如果某服务只存在于某个用户的 systemd user manager，即使该 user unit 正在运行，system-level probe 仍会报告 `not_found`。这是观测范围不匹配，不代表服务或隧道已停止。不要为了让面板徽标变绿而擅自迁移/重建现有 provider unit。若确需 system-level unit 或 user-manager 原生观测，应作为单独的 owner-authorized 变更，保留原有执行用户、环境、凭据和回退路径，并先验证原生连接不中断。

```sh
systemctl status ghostfleet-heartbeat.timer
journalctl -u ghostfleet-heartbeat.service --no-pager
# 凭据已经保存、后续本地安装/启用失败：
sudo /usr/bin/python3 -I /usr/local/libexec/ghostfleet-heartbeat.py repair
# 明确移除本功能；遇到文件本地改动先核查，不强行覆盖：
sudo /usr/bin/python3 -I /usr/local/libexec/ghostfleet-heartbeat.py remove
```

Claim 响应丢失：先在面板找到原 node_uid，点击该节点“重发票据”；不要创建第二个节点。已有安装重新绑定使用同节点票据和 `--replace`。重发会立即使旧上报凭据失效。若本机配置文件已经存在且有效、只是本地文件或 unit 安装/启用不完整，使用 `repair`；`repair` 不是版本升级。

### 更新已安装的 reporter（不要把 repair 当作升级）

**repair** 只会用当前正在执行的本地脚本（Path(__file__).read_bytes()）重写 GhostFleet 自己的文件与 systemd unit，并重新启用 timer；它不下载新安装器、不领取票据，也不轮换 reporting token。因此，旧版本执行 repair 仍会恢复旧版本，不能用它升级到新版本。

升级已有节点时，按以下顺序操作：

1. 先由实例 owner 发布包含新 console/app.js 和新安装器的 Worker 版本，更新 GHOSTFLEET_INSTALLER_SHA256；核对 Panel 提供的安装器 SHA-256 与规范 LF 构建产物一致。
2. 在受保护 Panel 中找到**原节点**并点击“重发票据（Reissue）”。这是同一 node_uid 的重新绑定，不创建第二个节点。面板为已有节点生成的安装命令会自动带 --replace。
3. 只有当目标机可信终端已准备好、操作者能够立即完成安装时才点击重发：服务端签发同节点票据时会立即撤销旧的待处理票据，并清空旧 reporting digest / 最近心跳投影；旧 reporter 凭据随即不能再上报。该操作不修改 SSH、OS 账户或 provider 权限。
4. 在同一台节点的可信终端运行面板生成的命令，并在提示时输入新短码。新安装器先校验固定 SHA，再以 expected_node_uid 领取同节点票据；成功后停止旧 timer/service、写入新 config/reporter/unit、daemon-reload、启用 timer 并立即触发上报。
5. 验证安装器字节/SHA、timer 与 service 状态、journal 和 Panel 新心跳。确认原生 SSH 仍可用。

若领取结果不确定或领取成功后本地替换中断，不要盲目重复旧命令或创建新节点。回到 Panel 核对原 node_uid，再次对**同一节点**重发票据并使用新命令/短码。由于旧凭据在重发时已失效，升级失败期间心跳可能暂时中断；这不应影响原生 SSH。repair 适用于本地安装步骤未完成、且当前保存的 config/token 仍有效的恢复场景；它不能代替上述版本升级流程。

## English — Updating an installed reporter (repair is not upgrade)

**repair** rewrites GhostFleet-owned files and systemd units from the locally executing script (Path(__file__).read_bytes()), then re-enables the timer. It does not download a newer installer, claim a ticket or rotate the reporting token. Running repair from an old installation therefore restores that old version; it is not a software update.

To update an existing node:

1. The instance owner first deploys the Worker assets containing the new console/app.js and installer, updates GHOSTFLEET_INSTALLER_SHA256, and verifies the Panel pinned installer digest against the canonical LF build.
2. In the protected Panel, locate the **existing node** and click **Reissue**. This rebinds the same node_uid; it does not create a second node. The Panel-generated command for an existing node automatically includes --replace.
3. Reissue only when the target trusted terminal is ready and the operator can complete the update. Issuing a same-node ticket immediately revokes older outstanding tickets and clears the prior reporting digest / last-heartbeat projection, so the old reporter credential stops working at that point. SSH, OS accounts and provider permissions are unchanged.
4. Run the generated command on that same node and enter the new short code when prompted. The installer verifies the pinned SHA, claims the ticket with expected_node_uid, then stops the old timer/service, writes the new config/reporter/units, reloads systemd, enables the timer and triggers an immediate report.
5. Verify installer bytes/SHA, timer and service state, journal output, the new Panel heartbeat, and continued native SSH access.

If the claim outcome is uncertain or local replacement is interrupted after claim, do not blindly repeat the old command or create a new node. Reconcile the original node_uid in the Panel, issue another ticket for that same node, and use its fresh command and code. Because the old credential is invalidated at reissue, heartbeat reporting may be temporarily unavailable during a failed update; native SSH remains independent. Use repair only when the saved config/token is still valid and the local installation needs recovery; it cannot perform this version-upgrade flow.

节点端写域仅为 `/etc/ghostfleet/presence.json`、`presence-install.json`、`/usr/local/libexec/ghostfleet-heartbeat.py` 和两个 `ghostfleet-heartbeat` systemd unit。config0600，凭据由 LoadCredential 送入临时身份。单次 HTTP 有超时和响应上限，不跟随重定向、不盲重试、不使用调用方代理环境。Timer 每次完成后约60秒再触发，开机首次约30秒；失败下轮重试上报，绝不重放纳管。

“撤销上报”只阻止 heartbeat；SSH/network 权限仍按原生工具撤销。面板离线不影响已经建立的原生 SSH。心跳新鲜度不是主机存活或入站可达性的独立证明。UI/API 当前只显示最后一次上报，不提供全量历史图表。

### 验收分层

确定性测试覆盖协议、凭据隔离、失效与错误路径；真实本地 Workerd/DO 覆盖事务与重启；临时 user-unit 覆盖调度/凭据/journal。生产 root system-unit + DynamicUser 安装、真实 Access/DNS、真实浏览器受保护登录与公网/内网完整路径仍须单独验收。不得把临时用户服务称为已在生产安装。

## English

Develop with Node22+, install the reporter with Python3.10+ and systemd supporting DynamicUser/LoadCredential. Debian13 is the first validated Linux environment. The node requires no Node/npm/curl or Python packages. Native transport installation is documented separately in [REMOTE_ACCESS](REMOTE_ACCESS.md).

Run the commands above: locked dependency install, Node/Python tests, deterministic build, then the real loopback Workerd/DO fixture. `--with-user-systemd` additionally exercises temporary user units, network outage/recovery and journald, and cleans up. This is not a production root system-unit test.

The build emits static assets, an installer digest and the generated Wrangler configuration. The owner supplies two HTTPS origins routed to one Worker, protects the entire panel with Access, and keeps the node origin limited to authenticated machine endpoints plus the public pinned installer. Configure distinct high-entropy Operator/Read application tokens through native secret tooling. Never commit them or send them to chat/CI. Preserve the existing DO namespace, class, snapshot key and node_uid values; back up before rollout. Do not silently replace a live legacy API used by old consumers. Source/CI success grants no production release authority.

The panel-generated command verifies the installer SHA-256 and prompts for the separate short code locally. The installer touches only its own files and two units, not SSH, provider policy or user authentication. Custom service-unit names are explicit options; absent units remain not_found. Config is0600 and passed with LoadCredential to a DynamicUser service. The reporter has bounded timeouts/responses, refuses redirects and uses no inherited HTTP proxy.

**Service-observation manager scope:** the reporter invokes `systemctl --system show`. The `--ssh-unit`, `--cloudflared-unit` and `--tailscaled-unit` options select unit names within the system manager; they do not switch to `systemctl --user`. A service that exists only in a user's systemd manager will therefore be reported as `not_found` even while that user unit is active. This is an observation-scope mismatch, not proof that the service or tunnel is down. Do not migrate or recreate an existing provider unit merely to improve a Panel badge. A system-unit migration or explicit user-manager probe is a separate owner-authorized change and must preserve the existing execution user, environment, credentials and rollback path while proving native connectivity remains intact.

For an uncertain claim, reissue a ticket for the same node_uid, invalidating its former reporting credential. Do not create another node. Use `repair` only when a saved local credential exists but the local files or units need repair; it is not a software update. Use an explicit same-node reissue with `--replace` to install a newer reporter. Removal validates its manifest and refuses locally modified files. Panel reporting revocation and local uninstall are separate actions, neither revokes SSH. A panel outage does not terminate native SSH.

Presence uses server receipt time and only the latest local process observation. It is not NodeLifecycle.ACTIVE, external tunnel reachability or proof of inbound administration. Production domain/Access policy, protected-browser first use and root system-service installation remain separate live acceptance.
