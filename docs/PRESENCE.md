# 纳管与心跳 / Enrollment and presence

## 中文

### 开发与验证

服务端开发使用 Node22+；节点需支持 DynamicUser/LoadCredential 的 systemd，首验环境为 Debian13。首次加入前须已有可信 CA bundle、`curl` 或 GNU `wget`、`sha256sum`；它们不可由一个尚未可信下载的脚本自举。POSIX 引导仅在系统 `/usr/bin/python3` 缺失时补装 python3：Debian/Ubuntu 使用 apt-get，Fedora/RHEL 系优先 dnf、没有 dnf 时使用 yum。已有 Python 须为 3.10+，版本过低则失败，不自动替换。节点不需要 Node、npm 或额外 Python 包。原生 SSH 配置沿用 [传输指南](REMOTE_ACCESS.md)。

```sh
npm ci --ignore-scripts --no-audit --no-fund
sh test/join-bootstrap.test.sh
npm test
npm run test:python
npm run build
npm run test:live
# 仅在有 user systemd manager 的 Linux 隔离工作区运行：
python3 test/live-presence.py --with-user-systemd
```

`test:live` 启动仅绑定 loopback 的真实 Workerd/DO，使用合成凭据，验证并发领取、reporter、持久化重启和撤销。附加参数创建独立命名的临时用户 timer/service，验证凭据投递、journald、断网/恢复，最后删除测试状态。不会改 SSH、提供商或系统级 unit；没有 user manager 时附加测试明确失败，不报告为通过。全部测试属于作者/CI证据，不替代独立代码审查。

构建产生 `dist/console`、`dist/installer.json`、`dist/wrangler.json`，同时派生 shell bootstrap 与 Python installer 的固定 SHA-256。面板命令先以已验证的 HTTPS 下载 shell 文件至私有临时目录，拒绝重定向并校验摘要，再执行。引导脚本完成 Linux/TTY/发行版/依赖预检，仅在缺 Python 时安装固定 python3 包，随后下载并核对 Python 安装器的字节数与摘要，再进入原交互领取流程。curl 的 3xx 响应即使返回 0 且正文摘要匹配也拒绝；wget 使用零重定向。短码由 Python getpass 隐藏输入，不进入 argv、URL 或环境变量。具体长期效果边界见 [ADR005](adr/005-pinned-posix-join-bootstrap.md)。

### 实例发布的最短路径

1. 从已审查提交构建。保留真实部署的 Worker 名称、DO绑定/命名空间和既有 `v1` migration；不要重新创建 namespace 或抹掉 snapshot。发布前保留上一 Worker 版本与数据备份。
2. 在私有部署覆盖中把 panel/node 两个 HTTPS origin、域名路由配置到**同一个 Worker**。示例 `example.invalid` 不是可发布地址。Panel 全站 Access；node origin 不套浏览器登录页，但仅允许实现中的机器路由。保持 workers.dev/preview 关闭。
3. 所有者通过原生 secret 配置设置不同的 `GHOSTFLEET_OPERATOR_TOKEN` 和 `GHOSTFLEET_READ_TOKEN`（各至少32字符的高熵随机值）。不要交给聊天、Issue、CI或仓库。Access 登录不自动成为应用 Operator。
4. 私有覆盖应用在生成的 `dist/wrangler.json` 上，保留构建生成的 `GHOSTFLEET_INSTALLER_SHA256` 和 `GHOSTFLEET_BOOTSTRAP_SHA256`。先执行 `wrangler deploy --dry-run --config <private-config>`；正式发布/域名操作由实例 owner 按现行授权完成，不由 CI 自动发布。
5. 先验证匿名 panel 的 Access 拦截、Read 写入拒绝、node origin 管理 API 404、错误/撤销心跳凭据401、正确安装器字节哈希，再做第一台经授权节点的系统级安装。检查普通用户 SSH 与已有 root 公钥入口未改变。

旧 Worker 的 command/MCP/helper/七证据纳管 API 不再挂载，旧 node 数据和 lifecycle 字段保留。若有旧消费者，先确认切换与回滚；不能直接覆盖仍在使用旧 API 的生产实例。需要回退时回退该 Worker 版本并停用本 reporter；不要为回退删除原节点、DO或 SSH 凭据。

### NAS / appliance 首次安装安全边界

**OMV8 Phase 0 静态候选（尚未接入 bootstrap）**：`scripts/omv8_phase0_readonly.py` 是仅在受权的 NAS 本地使用的只读事实采集器，不是纳管命令。需由 NAS owner 单独授权首次本机 root ceremony 后，在 NAS 本地执行：

```sh
python3 scripts/omv8_phase0_readonly.py --check
```

仅检查 Debian 13 / OMV 8 包与标记、systemd/PID1、当前 root 身份、sudo/su 可用性、SSH/Tailscale/Docker unit 的加载与活动状态、Docker socket/组成员数量提示，以及 `/proc/self/mountinfo` 与 `/proc/mdstat` 的计数/危险提示；不输出共享路径、磁盘标识、凭据或完整服务配置，不访问网络、不写文件、不启动/停止服务、不领取票据。返回码 `4` 是结构不兼容或事实未知，`3` 是事实可读但仍须 Owner 核对存储与授权。**不存在表示可安装的退出码 0**：结果固定声明 `installation_permitted=false`、`bootstrap_phase0_wired=false`。普通 CI 仅运行合成事实单元测试，不接触 OMV/NAS；本脚本尚未嵌入 `join.sh`，因此不能作为 Fleet #328 一键 FULLY_MANAGED 的 Phase 0 验收，也不能恢复旧 Helper/JIT 的产品承诺。

GhostFleet 的 Python 安装器是**心跳上报器安装器，不是 NAS/OMV 配置管理器**。一次性 shell 引导增加的唯一系统包效果，是在受支持发行版上按需安装缺失的 python3 及其必需依赖；随后 Python 安装器只安装 GhostFleet 自己的配置、reporter 与两个 systemd unit。两者都不替代 OMV 的本机只读 Phase 0，也不因系统基于 Debian 就推断存储或业务服务安全。

首次引导与安装的本地操作范围：

- shell 引导先检查可信 CA、下载工具、SHA 工具、Linux/TTY 和 Python 版本。仅当 Python 缺失时，APT 执行 update 及 `install --no-install-recommends --no-upgrade python3`；DNF/YUM 仅执行固定 python3 安装。依赖安装失败时不领取票据；安装成功但后续失败时不自动卸载共享系统运行时。

- 交互式检查 Linux、root、TTY、HTTPS origin、票据/短码格式，以及 GhostFleet 自有目标的符号链接/归属/权限边界。
- 在需要时创建 GhostFleet 自有目录：`/etc/ghostfleet`（0700）及 `/usr/local/libexec`（0755）。
- 仅写入 `/etc/ghostfleet/presence.json`（0600）、`/etc/ghostfleet/presence-install.json`（0600）、`/usr/local/libexec/ghostfleet-heartbeat.py`（0755）、`/etc/systemd/system/ghostfleet-heartbeat.service` 和 `ghostfleet-heartbeat.timer`（0644）。
- 仅对自己的 timer/service 执行 `systemctl stop / daemon-reload / enable --now / start`；reporter 对 SSH、cloudflared、tailscaled 只读观察，不修改这些服务。

明确不做：除上述缺失 python3 及其必需依赖外不安装系统软件包，不安装 CA/downloader，不执行系统升级、软件源改写或包删除；不创建或修改 OS 用户/组/sudoers；不修改 sshd/authorized_keys；不安装、迁移或重启 Cloudflare/Tailscale provider；不修改防火墙、路由、DNS；不调用 OMV 配置接口；不访问或修改磁盘、分区、文件系统、RAID、挂载、共享、Docker/业务容器；不重启主机。它也不提供远程命令执行、常驻 Node Agent、Helper 或 JIT 特权审批。

因此，NAS 真机仍由其 owner 在本机执行独立只读 Phase 0，确认设备身份、OS/systemd、当前权限模型、存储/业务服务提示与恢复条件；Phase 0 未通过或事实为 UNKNOWN 时，不进入安装。Phase 0 与 root ceremony 的授权属于实例 owner，不由 GhostFleet 的票据、面板或 CI 自动授予。

`repair` 只用本地当前脚本与仍有效的已保存配置恢复 GhostFleet 自有文件/unit；`remove` 只在安装 manifest 和文件摘要匹配时移除 GhostFleet 自有文件/unit。移除后仍须在面板单独撤销 reporter 凭据。两者都不清理或更改任何 SSH/provider/OMV/存储配置。

### NAS / appliance first-install safety boundary

**OMV8 Phase 0 source-only candidate (not wired into bootstrap):** `scripts/omv8_phase0_readonly.py` is a local read-only fact collector, **not** an enrollment command. Only after the NAS owner separately authorizes the one-time local root ceremony may it be executed **on the NAS itself**:

```sh
python3 scripts/omv8_phase0_readonly.py --check
```

It checks Debian 13/OMV8 package and marker, systemd/PID 1, effective root identity, sudo/su availability, SSH/Tailscale/Docker unit load and active states, Docker socket/group-member-count warnings and aggregate `/proc/self/mountinfo` / `/proc/mdstat` storage signals. It does not emit share paths, device IDs, credentials or raw service configuration, contact the network, write files, start/stop services or claim tickets. Exit `4` means incompatibility or unknown required facts; exit `3` means read-only facts were collected but Owner storage review and authorization remain outstanding. **Exit 0 is never an install authorization:** the report always states `installation_permitted=false` and `bootstrap_phase0_wired=false`. CI uses synthetic fact fixtures only, not a real OMV/NAS. The probe is not yet integrated into `join.sh`; it does not satisfy Fleet #328's one-click FULLY_MANAGED Phase 0 gate or revive the old Helper/JIT product.

The Python installer is a **presence-reporter installer, not a NAS/OMV configuration manager**. The one-time POSIX bootstrap may install missing system python3 and its required dependencies on supported distributions. The Python installer then writes only GhostFleet-owned configuration, reporter and two systemd units. It does not replace OMV's local read-only Phase 0, and it must not infer that disks, RAID, mounts or business services are safe merely because the host is Debian-based.

The bootstrap and installer's local effect scope is limited to:

- Requiring trusted CA certificates, a downloader and SHA-256 tooling before download; checking Linux, TTY and Python version. Only missing Python triggers APT index refresh plus `install --no-install-recommends --no-upgrade python3`, or a fixed DNF/YUM python3 install. Dependency failure precedes ticket claim. Installed system Python is retained if later enrollment fails.

- Checking Linux, root, an interactive TTY, HTTPS origin, ticket/short-code shape, and symlink/ownership/permission boundaries for GhostFleet-owned targets.
- Creating GhostFleet-owned directories when absent: `/etc/ghostfleet` (0700) and `/usr/local/libexec` (0755).
- Writing only `/etc/ghostfleet/presence.json` (0600), `/etc/ghostfleet/presence-install.json` (0600), `/usr/local/libexec/ghostfleet-heartbeat.py` (0755), `/etc/systemd/system/ghostfleet-heartbeat.service` and `ghostfleet-heartbeat.timer` (0644).
- Running `systemctl stop / daemon-reload / enable --now / start` only for its own timer/service. SSH, cloudflared and tailscaled are observed read-only, never modified.

Apart from missing python3 and its required dependencies, it does **not** install packages, CA bundles or downloaders; upgrade the system; modify repositories; remove packages; create or modify OS users/groups/sudoers; change sshd/authorized_keys; install, migrate or restart Cloudflare/Tailscale providers; change firewall/routes/DNS; call OMV configuration APIs; inspect or mutate disks, partitions, filesystems, RAID, mounts, shares, Docker/business containers; or reboot the host. It provides no remote command execution, resident Node Agent, privileged Helper or JIT approval.

A real NAS must still pass its owner-run local read-only Phase 0 for device identity, OS/systemd, current privilege model, storage/business-service hints and recovery conditions. If Phase 0 fails or a material fact is UNKNOWN, installation does not proceed. Phase 0 and the root ceremony are instance-owner authority; a GhostFleet ticket, panel or CI does not grant them.

`repair` restores GhostFleet-owned files/units from the local script and still-valid saved config. `remove` removes GhostFleet-owned files/units only when the install manifest and file digests match. Reporter credentials must still be revoked separately in the Panel after removal. Neither operation cleans up or changes SSH/provider/OMV/storage configuration.

### 日常使用与修复

Operator 登录面板，输入节点名称，创建票据；在目标机可信交互终端运行面板生成的一行命令。命令先验证下载的 shell，引导按需请求 sudo、检查并补齐缺失 Python，最后验证并运行 Python 安装器。已是 root 时不再调用 sudo；独立短码仍在隐藏终端提示中输入。客户端默认观察 `ssh.service`、`cloudflared-ssh.service`、`tailscaled.service`；实际 unit 名称不同，通过安装器 `--ssh-unit` / `--cloudflared-unit` / `--tailscaled-unit` 指定。不存在的服务显示“未安装/未找到”，不要伪装成活动。

**服务观察的管理器范围：** reporter 使用 `systemctl --system show`，因此 `--ssh-unit` / `--cloudflared-unit` / `--tailscaled-unit` 只选择 system manager 中要查询的 unit 名称，不会切换到 `systemctl --user`。如果某服务只存在于某个用户的 systemd user manager，即使该 user unit 正在运行，system-level probe 仍会报告 `not_found`。这是观测范围不匹配，不代表服务或隧道已停止。不要为了让面板徽标变绿而擅自迁移/重建现有 provider unit。若确需 system-level unit 或 user-manager 原生观测，应作为单独的 owner-authorized 变更，保留原有执行用户、环境、凭据和回退路径，并先验证原生连接不中断。

**DynamicUser 与 system bus 兼容性：** 某些 `dbus-daemon` 版本无法解析 systemd 临时分配的 DynamicUser UID，导致非 root 的 `systemctl` 经 system bus 返回 `Transport endpoint is not connected`。reporter 仍保留 `DynamicUser=yes`；每次运行只在 `ExecStartPre=!` 中启动一个固定的本地只读探针，以 root UID 调用 `systemctl --system show` 查询配置中的三个 allowlist unit。systemd 的 `!` 前缀只绕过 `User=/Group=` 身份切换，不绕过空的 `CapabilityBoundingSet=`、`NoNewPrivileges=yes` 或文件系统沙箱。systemd manager 以 root 打开 `/run/ghostfleet-heartbeat-services.json`；探针只通过继承的标准输出文件描述符写入不含凭据的 JSON，并将文件设为 0644。unit 只为这个固定文件增加 `ReadWritePaths`。reporter 先用 `os.dup2(2, 1)` 将底层 stdout 文件描述符重定向到已有 journald stderr，撤销继承的快照写句柄，再以 DynamicUser 身份只读 root-owned 快照；仅关闭 Python stdout 对象不会关闭其底层 fd。每次探针先截断旧内容，并写入单调时钟时间戳，超过 30 秒的快照一律视为 `unknown`。快照缺失或校验失败时服务状态回退为 `unknown`，但心跳仍继续上报。探针没有 shell、远端命令或服务控制路径。

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

1. 先由实例 owner 发布包含新 console/app.js 和新安装器的 Worker 版本，更新构建生成的 GHOSTFLEET_INSTALLER_SHA256 与 GHOSTFLEET_BOOTSTRAP_SHA256；核对 Panel 提供的安装器 SHA-256 与规范 LF 构建产物一致。
2. 在受保护 Panel 中找到**原节点**并点击“重发票据（Reissue）”。这是同一 node_uid 的重新绑定，不创建第二个节点。面板为已有节点生成的安装命令会自动带 --replace。
3. 只有当目标机可信终端已准备好、操作者能够立即完成安装时才点击重发：服务端签发同节点票据时会立即撤销旧的待处理票据，并清空旧 reporting digest / 最近心跳投影；旧 reporter 凭据随即不能再上报。该操作不修改 SSH、OS 账户或 provider 权限。
4. 在同一台节点的可信终端运行面板生成的命令，并在提示时输入新短码。新安装器先校验固定 SHA，再以 expected_node_uid 领取同节点票据；成功后停止旧 timer/service、写入新 config/reporter/unit、daemon-reload、启用 timer 并立即触发上报。
5. 验证安装器字节/SHA、timer 与 service 状态、journal 和 Panel 新心跳。确认原生 SSH 仍可用。

若领取结果不确定或领取成功后本地替换中断，不要盲目重复旧命令或创建新节点。回到 Panel 核对原 node_uid，再次对**同一节点**重发票据并使用新命令/短码。由于旧凭据在重发时已失效，升级失败期间心跳可能暂时中断；这不应影响原生 SSH。repair 适用于本地安装步骤未完成、且当前保存的 config/token 仍有效的恢复场景；它不能代替上述版本升级流程。

## English — Updating an installed reporter (repair is not upgrade)

**repair** rewrites GhostFleet-owned files and systemd units from the locally executing script (Path(__file__).read_bytes()), then re-enables the timer. It does not download a newer installer, claim a ticket or rotate the reporting token. Running repair from an old installation therefore restores that old version; it is not a software update.

To update an existing node:

1. The instance owner first deploys the Worker assets containing the new console/app.js and installer, retains both build-generated GHOSTFLEET_INSTALLER_SHA256 and GHOSTFLEET_BOOTSTRAP_SHA256, and verifies the Panel pinned installer digest against the canonical LF build.
2. In the protected Panel, locate the **existing node** and click **Reissue**. This rebinds the same node_uid; it does not create a second node. The Panel-generated command for an existing node automatically includes --replace.
3. Reissue only when the target trusted terminal is ready and the operator can complete the update. Issuing a same-node ticket immediately revokes older outstanding tickets and clears the prior reporting digest / last-heartbeat projection, so the old reporter credential stops working at that point. SSH, OS accounts and provider permissions are unchanged.
4. Run the generated command on that same node and enter the new short code when prompted. The installer verifies the pinned SHA, claims the ticket with expected_node_uid, then stops the old timer/service, writes the new config/reporter/units, reloads systemd, enables the timer and triggers an immediate report.
5. Verify installer bytes/SHA, timer and service state, journal output, the new Panel heartbeat, and continued native SSH access.

If the claim outcome is uncertain or local replacement is interrupted after claim, do not blindly repeat the old command or create a new node. Reconcile the original node_uid in the Panel, issue another ticket for that same node, and use its fresh command and code. Because the old credential is invalidated at reissue, heartbeat reporting may be temporarily unavailable during a failed update; native SSH remains independent. Use repair only when the saved config/token is still valid and the local installation needs recovery; it cannot perform this version-upgrade flow.

节点端持久写域仅为 `/etc/ghostfleet/presence.json`、`presence-install.json`、`/usr/local/libexec/ghostfleet-heartbeat.py` 和两个 `ghostfleet-heartbeat` systemd unit。运行时另有上文的固定 `/run/ghostfleet-heartbeat-services.json` 服务观测快照。config0600，凭据由 LoadCredential 送入临时身份。单次 HTTP 有超时和响应上限，不跟随重定向、不盲重试、不使用调用方代理环境。Timer 每次完成后约60秒再触发，开机首次约30秒；失败下轮重试上报，绝不重放纳管。

“撤销上报”只阻止 heartbeat；SSH/network 权限仍按原生工具撤销。面板离线不影响已经建立的原生 SSH。心跳新鲜度不是主机存活或入站可达性的独立证明。UI/API 当前只显示最后一次上报，不提供全量历史图表。

### 验收分层

确定性测试覆盖协议、凭据隔离、失效与错误路径；真实本地 Workerd/DO 覆盖事务与重启；临时 user-unit 覆盖调度/凭据/journal。生产 root system-unit + DynamicUser 安装、真实 Access/DNS、真实浏览器受保护登录与公网/内网完整路径仍须单独验收。不得把临时用户服务称为已在生产安装。

## English

Develop with Node22+; the node needs systemd supporting DynamicUser/LoadCredential. Debian13 is the first validated Linux environment. Trusted CA certificates, curl or GNU wget, and sha256sum must already be available. The one-time shim installs only missing system python3 via apt-get or dnf/yum. Existing Python must be 3.10+; an older version is refused without replacement. The node requires no Node/npm or extra Python packages. Native transport installation is documented separately in [REMOTE_ACCESS](REMOTE_ACCESS.md).

Run the commands above: locked dependency install, Node/Python tests, deterministic build, then the real loopback Workerd/DO fixture. `--with-user-systemd` additionally exercises temporary user units, network outage/recovery and journald, and cleans up. This is not a production root system-unit test.

The build emits static assets, pinned shell/Python artifacts, both digests and the generated Wrangler configuration. The owner supplies two HTTPS origins routed to one Worker, protects the entire panel with Access, and keeps the node origin limited to authenticated machine endpoints plus the public pinned installer. Configure distinct high-entropy Operator/Read application tokens through native secret tooling. Never commit them or send them to chat/CI. Preserve the existing DO namespace, class, snapshot key and node_uid values; back up before rollout. Do not silently replace a live legacy API used by old consumers. Source/CI success grants no production release authority.

The panel-generated command uses verified HTTPS, rejects redirects, verifies the shell digest before execution, then verifies the Python installer digest and byte count. curl requires HTTP 200 even if a 3xx body matches the pinned digest; GNU wget allows zero redirects. Download-tool configuration files cannot enable redirects or disable TLS checks. Only the one-time shim may install missing python3; the Python installer touches its own files and units, not SSH, provider policy or user authentication. The separate short code stays in the hidden local prompt. See ADR005 for the package boundary and failure recovery. Custom service-unit names are explicit options; absent units remain not_found. Config is0600 and passed with LoadCredential to a DynamicUser service. The reporter has bounded timeouts/responses, refuses redirects and uses no inherited HTTP proxy.

**Service-observation manager scope:** the reporter invokes `systemctl --system show`. The `--ssh-unit`, `--cloudflared-unit` and `--tailscaled-unit` options select unit names within the system manager; they do not switch to `systemctl --user`. A service that exists only in a user's systemd manager will therefore be reported as `not_found` even while that user unit is active. This is an observation-scope mismatch, not proof that the service or tunnel is down. Do not migrate or recreate an existing provider unit merely to improve a Panel badge. A system-unit migration or explicit user-manager probe is a separate owner-authorized change and must preserve the existing execution user, environment, credentials and rollback path while proving native connectivity remains intact.

**DynamicUser and system-bus compatibility:** Some `dbus-daemon` versions cannot resolve a transient UID allocated by systemd's `DynamicUser`, causing an unprivileged `systemctl` system-bus query to fail with `Transport endpoint is not connected`. The reporter remains `DynamicUser=yes`. Each run first invokes one fixed local read-only probe through `ExecStartPre=!`; it uses UID 0 only to call `systemctl --system show` for the three configured allowlisted units. systemd's `!` prefix bypasses only `User=/Group=` credential switching; it does not bypass the empty `CapabilityBoundingSet=`, `NoNewPrivileges=yes`, or filesystem sandbox. The systemd manager opens `/run/ghostfleet-heartbeat-services.json` as root. The probe writes only credential-free JSON through its inherited stdout file descriptor and sets the file mode to 0644; the unit adds ReadWritePaths for this exact file only. The reporter uses `os.dup2(2, 1)` to replace the underlying stdout descriptor with the existing journald stderr stream before reading the root-owned snapshot as DynamicUser. Closing the Python stdout object alone does not close its underlying descriptor. Each probe truncates any previous snapshot and writes a monotonic timestamp; snapshots older than 30 seconds are treated as `unknown`. If the snapshot is missing or fails validation, service states fall back to `unknown` while heartbeat reporting continues. The probe has no shell, remote-command or service-control path.

For an uncertain claim, reissue a ticket for the same node_uid, invalidating its former reporting credential. Do not create another node. Use `repair` only when a saved local credential exists but the local files or units need repair; it is not a software update. Use an explicit same-node reissue with `--replace` to install a newer reporter. Removal validates its manifest and refuses locally modified files. Panel reporting revocation and local uninstall are separate actions, neither revokes SSH. A panel outage does not terminate native SSH.

Presence uses server receipt time and only the latest local process observation. It is not NodeLifecycle.ACTIVE, external tunnel reachability or proof of inbound administration. Production domain/Access policy, protected-browser first use and root system-service installation remain separate live acceptance.
