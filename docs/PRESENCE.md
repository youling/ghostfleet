# 纳管与心跳 / Enrollment and presence

### 现有 Reporter 与正式版 FULLY_MANAGED 的关系（2026-11-22）

本文描述的现有 `join.sh` / Python installer 仍然只负责 GhostFleet reporter、systemd timer 和 heartbeat；它**不会**配置 SSH、Provider、DCR 或 Root helper。这是 ADR004 的既有轻量子能力，不能因 ADR007 的产品决策就误报已经升级。

面板的「注册心跳」遇到签发响应丢失时，可在同一标签页点「核对票据」。首次请求用 UUID 绑定同一节点和原票据。若 Worker 已提交，核对只返回原 UID 和票据元数据。如未看到短码，在原节点行重发。浏览器仅暂存待确认的请求 UUID 和节点名称。

If the initial **Register heartbeat** response is lost, use **Check ticket** in the same tab. A retry with the same request UUID recovers the original node and ticket metadata. If you missed the one-time code, reissue from the original node’s row. The browser temporarily stores the pending request UUID and node label.

Owner 已决定正式版增加独立的 `FULL_MANAGED_LOWER_NODE` profile：一次 Panel ticket/短码 + 目标机一次 root bootstrap，在同一受授权流程内自动完成 Host preflight、复用已有 Tailscale/Cloudflare、原生 SSH、动态 DCR、Root helper/lease 与 ChatGPT 实际验收。该全流程合同见 [ADR007](adr/007-fully-managed-lower-node-enrollment.md)；首个真实 Canary 是搬瓦工 VPS，不使用虚拟机。**当前源码尚未实现这条完整流水线**；直到新 bootstrap/动态 DCR/Root session 的真实 ChatGPT E2E 通过前，现有 reporter-only 安装不能称为 FULLY_MANAGED。

`FULL_MANAGED_LOWER_NODE` 的目标端在可信安装的纳管入口输入域名和短码。`scripts/enroll-managed.py` 通过 `/.well-known/ghostfleet-enrollment` 发现并校验独立 `.managed.sh` 制品，创建配对请求。在 Panel 选择与目标端匹配的请求后手动签发六位短码，有效十分钟，大小写等价。入口把随机配对秘密和短码通过标准输入交给校验过的引导制品，供其在完成预检后调用 `POST /v1/managed-enrollment/claim`。旧 reporter Worker 无法领取该票据。Operator 可对同一 UID 用新配对请求重发，旧 reporter 在新票据领取前继续上报。Panel 只根据各阶段实际证据显示进展。默认构建仍只发布 reporter。Managed 选项要求实例发布独立制品、配置 `GHOSTFLEET_MANAGED_BOOTSTRAP_SHA256` 并绑定 `ASSETS`。

The trusted target enrollment client accepts the domain and short code. `scripts/enroll-managed.py` discovers and verifies a pinned `.managed.sh`, starts a device pairing and prompts for the six-character code manually issued in the Panel. The code is case-insensitive and valid for ten minutes. The verified installer gets the pairing secret and code on standard input and calls `POST /v1/managed-enrollment/claim` after preflight. Older reporter workers cannot consume that ticket. Reissuing for a known UID preserves the existing reporter until the new claim. `ASSETS` and `GHOSTFLEET_MANAGED_BOOTSTRAP_SHA256` enable the managed profile after the managed artifact is released. The default build ships only the reporter installer.

可信客户端包同时安装由 root 拥有的 `/etc/ghostfleet/enrollment-trust.json`，记录允许输入的域名及其对应 Node Origin。面板显示 Node Origin 的域名，实例可将它映射到自身。若也允许输入 Panel 域名，可额外将它映射到同一个 Node Origin。客户端只从映射得到的 Node Origin 读取 `/.well-known/ghostfleet-enrollment`，因此整个 Panel 仍可由 Access 保护。

The trusted client package supplies a root-owned `/etc/ghostfleet/enrollment-trust.json` mapping approved bare domain names to their approved Node Origin names. The Panel displays the Node Origin hostname. Map it to itself and optionally add the Panel hostname as an alias, for example `{"panel.example.invalid":"node.example.invalid","node.example.invalid":"node.example.invalid"}`. The client fetches `/.well-known/ghostfleet-enrollment` from the configured Node Origin, so Access can protect the entire Panel hostname.

`npm run build:managed-host-bootstrap -- --output dist/managed-host-review.sh` 生成待审查的 Host/reporter 阶段制品，输出 SHA-256。它复用原版 reporter 安装逻辑。领取前只读核查 Linux root、systemd、安装路径和既有 reporter 的 origin，遇到 OMV 停在专用预检边界。补领时把现有 UID 作为领取条件，领取结果不确定时只报告失败，保留原节点供同 UID 重发。`REPORTER_STARTED` 表示本机 reporter 已启动，完整纳管还需私有 Provider、传输、DCR 和签名 lease 的回执。

同 UID 重新领取时保留现有 reporter 已校验的 systemd 服务观察配置。首次安装使用默认单元名。

`npm run build:managed-host-bootstrap -- --output dist/managed-host-review.sh` creates a digest-pinned host/reporter stage for review. It reuses the reporter installer and checks Linux root, systemd, installation paths and the existing reporter origin before claim. OMV uses the separate owner preflight. An existing UID constrains the claim, and an uncertain claim is sent only once. `REPORTER_STARTED` reports local reporter activation. Private provider, transport, DCR and signed lease receipts are still required for full enrollment.

A same-UID reissue preserves the reporter’s validated systemd unit mapping. A first install uses the default unit names.

私有 broker 可通过 Worker service binding 调用 `ManagedPanelDecisionReader.readManagedEnrollment(node_uid, ticket_id)`，取得同一 UID 最近一次有效领取的 Panel 决定摘要。重发待领取期间，原决定继续可读。替换领取、撤销上报或摘要换代后，旧决定不可读。读取只带 UID、票据、制品摘要和时间，后续私有准入仍须独立验证传输和能力。

The private broker can bind to `ManagedPanelDecisionReader.readManagedEnrollment(node_uid, ticket_id)` for the most recently consumed decision for that UID. An issued replacement keeps the current decision readable until the replacement is claimed. Reporting revocation and bootstrap pin changes invalidate the corresponding readback. The receipt contains identifiers, pins and timestamps. The private broker still verifies its separate authority and reviewed transport evidence.

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
3. 要让面板使用一次 Cloudflare Access 登录，在私有部署覆盖配置 `GHOSTFLEET_PANEL_AUTH_MODE=cloudflare_access`、`GHOSTFLEET_PANEL_ACCESS_ISSUER`（Access 团队的 HTTPS 域名）、`GHOSTFLEET_PANEL_ACCESS_AUD`（对应面板应用的 AUD）和 `GHOSTFLEET_PANEL_ACCESS_OWNER_EMAIL`（允许操作的 Access 用户）。Worker 验签并核对应用和身份；浏览器直接显示面板。写操作要求精确的面板 Origin。节点加入和上报仍走独立入口。原 Bearer 模式可供既有实例使用，需通过原生 secret 配置两个不同的至少 32 字符的令牌 `GHOSTFLEET_OPERATOR_TOKEN`、`GHOSTFLEET_READ_TOKEN`。
4. 从实例当前的 GhostFleet 私有配置生成候选配置，保留 Worker 名称、域名路由、DO 绑定和迁移。构建将两份 LF 制品、摘要和静态资源绑定一并生成，候选只使用隔离的发布资源目录。私有输入和输出置于同一目录，且都在静态资源目录之外。
5. 先验证匿名面板的 Access 拦截、获准身份登录后直接进入面板、错误应用或身份被拒绝、同源写入、Node Origin 管理 API 404、错误或撤销的心跳凭据 401，以及安装器字节哈希。使用 Bearer 模式时也验证 Read 令牌无法写入。随后再做第一台经授权节点的系统级安装。

```sh
npm run build -- --deployment-config dist/wrangler.private.json --output-config dist/wrangler.release.json
npx --no-install wrangler deploy --dry-run --config dist/wrangler.release.json
```

生成和预演均为本地操作。实例 owner 发布前仍需核对 Cloudflare 的 Custom Domain 与路径路由，确认 Node Origin 和 `/bootstrap/*` 由预期的 GhostFleet Worker 提供。发布后，从已授权的 `/v0/access` 读取两份实际 URL，再核对实际下载大小和字节摘要。根路径返回 404 只能说明该路径没有对应资源。

Build the release candidate from the instance's current GhostFleet configuration using the commands above. Keep the output beside the input and keep both outside the static asset directories. The generated configuration retains the Worker, routes, DO bindings and migrations and includes both LF assets and their pins from an isolated release directory. The instance owner checks the live Custom Domain and path-route ownership before deploying. After deployment, read both advertised URLs from the protected `/v0/access` response and verify the downloaded byte counts and digests.

要发布完全纳管版本，在构建命令末尾加 `--managed-bootstrap /path/to/reviewed-managed.sh --managed-bootstrap-sha256 "$reviewed_sha256"`。使用独立审查确定的摘要。构建将原始字节和摘要写入同一候选，并拒绝沿用缺少制品的旧摘要。发布后在已有两份捕获正文核验参数后加 `--managed-body` 和实际下载的正文路径，三份制品一起核对。

For a managed release, append `--managed-bootstrap /path/to/reviewed-managed.sh --managed-bootstrap-sha256 "$reviewed_sha256"` to the build command. Use the digest from the independent artifact review. The build publishes the exact bytes with the matching pin and refuses an overlay that carries an old managed pin without its artifact. Add `--managed-body` and the downloaded file path to the offline check when comparing all three response bodies.

旧 Worker 的 command/MCP/helper/七证据纳管 API 不再挂载，旧 node 数据和 lifecycle 字段保留。若有旧消费者，先确认切换与回滚；不能直接覆盖仍在使用旧 API 的生产实例。需要回退时回退该 Worker 版本并停用本 reporter；不要为回退删除原节点、DO或 SSH 凭据。

### NAS / appliance 首次安装安全边界

**OMV8 Phase 0 静态候选（尚未接入 bootstrap）**：`scripts/omv8_phase0_readonly.py` 是仅在受权的 NAS 本地使用的只读事实采集器，不是纳管命令。需由 NAS owner 单独授权首次本机 root ceremony 后，在 NAS 本地执行：

```sh
python3 scripts/omv8_phase0_readonly.py --check
```

仅检查 Debian 13 / OMV 8 包与标记、systemd/PID1、本地 root 身份、容器环境标记、sudo/su 工具、`openmediavault-engined`、SSH/Tailscale、Docker/containerd/Podman、SMB/NFS 等固定 systemd unit 的加载与活动状态；只统计 `docker`、`_ssh`、`sudo` 组成员数量，不输出账户名；只汇总挂载文件系统类型与根文件系统类型，并读取 MD RAID 阵列数量、降级/重同步提示。OMV 官方不支持在 LXC 或其它容器环境运行，因此通过 `/proc/1/cgroup`、`systemd-detect-virt --container` 和容器标记识别运行环境；发现容器、无法完成容器识别或 overlay 根文件系统时 fail closed。它不读取共享目录内容、磁盘序列号或设备路径，不导出完整服务配置，不访问网络、不写文件、不启动/停止服务、不领取票据。OMV 官方建议常规远程 SSH 使用 `_ssh` 组中的普通账户并按需 sudo；本 Phase 0 的本地 root ceremony 与远程 root SSH 是两件事，不强制启用 root SSH（见 [OMV 8 SSH 文档](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html)）。返回码 `4` 是结构不兼容或事实未知，`3` 是事实可读但仍须 Owner 核对存储与授权。**不存在表示可安装的退出码 0**：结果固定声明 `installation_permitted=false`、`bootstrap_phase0_wired=false`。普通 CI 仅运行合成事实单元测试，不接触 OMV/NAS；本脚本尚未嵌入 `join.sh`，因此不能作为 Fleet #328 一键 FULLY_MANAGED 的 Phase 0 验收，也不能恢复旧 Helper/JIT 的产品承诺。

**未来 bootstrap 消费合同（尚未实现）**：OMV8 分支必须在首次 root ceremony 后、任何持久包/账户/配置/服务/Provider/NodeIdentity/ticket materialization 之前运行本机 Phase0。可为交付已校验的 probe 使用权限受限、短时临时文件，但不能先 apt 安装 Python、先写 GhostFleet 文件或先 claim ticket 再补 Phase0。OMV8 的系统 Python 若不存在、版本不满足或事实不可读，必须在包管理器运行前 fail closed；不能用“先装 Python”绕过 Phase0 顺序。集成时必须将 probe 作为同一 release 的固定摘要 artifact，先校验字节数与 SHA-256，再执行。退出码 4 表示 BLOCKED；退出码 3 仅表示事实可读，不表示安装授权，仍需独立 Owner 存储/恢复 attestation 与对应 Human authority。不得把 exit 3 改写成 success=0，也不得从 CI/静态报告推导 NAS READY。任何 Human 确认若需要，应属于同一受控 bootstrap ceremony，不要求第二条手工修复命令。**本合同只约束未来 consumer；当前 PR #119 尚未接入 join.sh。**

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

It checks Debian 13/OMV8 package and marker, systemd/PID 1, local root identity, container markers, sudo/su tools, and load/active state for fixed `openmediavault-engined`, SSH/Tailscale, Docker/containerd/Podman, SMB and NFS units. It reports only counts for `docker`, `_ssh` and `sudo` group members (never account names), aggregate mounted filesystem types/root filesystem type, and MD RAID array/degraded/resync signals. OMV does not support LXC or other container deployments, so container detection uses `/proc/1/cgroup`, `systemd-detect-virt --container` and marker files; a detected container, unavailable detection or overlay root filesystem fails closed. It does not read share contents, disk serials/device paths or full service configuration; it makes no network calls, writes no files, starts/stops no services and claims no ticket. OMV's documented normal SSH model uses a non-root user in `_ssh` and sudo as needed; the local root ceremony here is distinct from remote root SSH, and Phase 0 does not require root SSH to be enabled (see [OMV 8 SSH documentation](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html)). Exit `4` means incompatibility or unknown required facts; exit `3` means read-only facts were collected but Owner storage review and authorization remain outstanding. **Exit 0 is never an install authorization:** the report always states `installation_permitted=false` and `bootstrap_phase0_wired=false`. CI uses synthetic fact fixtures only, not a real OMV/NAS. The probe is not yet integrated into `join.sh`; it does not satisfy Fleet #328's one-click FULLY_MANAGED Phase 0 gate or revive the old Helper/JIT product.

**Future bootstrap consumer contract (not implemented):** the OMV8 path must run the local Phase0 after the first root ceremony but before any persistent package/account/config/service/provider/NodeIdentity/ticket materialization. A permission-restricted short-lived temporary file may deliver the verified probe, but the consumer must not install Python with apt, write GhostFleet files or claim a ticket before Phase0. If OMV8 system Python is missing/unsupported or required facts are unreadable, fail closed before invoking a package manager; do not install Python first and then claim Phase0 preceded materialization. Integration must ship the probe as a hash-pinned artifact in the same release and verify exact bytes/SHA-256 before execution. Exit 4 means BLOCKED; exit 3 means facts were readable only and is **not** install authorization—separate Owner storage/recovery attestation and the corresponding Human authority remain required. Do not rewrite exit 3 as success=0 or infer NAS READY from CI/static output. Any Human confirmation belongs inside the same controlled bootstrap ceremony, not a second manual repair command. **This contract describes a future consumer; PR #119 is not yet wired into join.sh.**

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

**发布摘要核对（新增只读工具）**：如果源码已包含 PR #110 的服务快照预探针，但生产 Panel 仍提供旧 bootstrap，旧节点会继续安装不带 `ExecStartPre` 的服务单元，出现心跳在线但服务状态 `unknown`。这通常是**线上发行包固定 SHA 尚未更新**，不应仅凭 GitHub main 或 `repair` 判断部署已升级。实例 owner 可在本地构建当前候选，并通过原有受保护 `GET /v0/access` 读取发布元数据，保存为仅限本机读取的 JSON，执行：

```sh
npm run build
node scripts/check-presence-release.mjs \
  --build-json dist/installer.json \
  --access-json /private/access-readback.json
```

仅核对元数据时，`MATCHED_BUILD_PINS` 表示两个摘要都相符。另存两份 URL 的响应体后，可追加 `--installer-body <本地 .py> --bootstrap-body <本地 .sh>`，用 `MATCHED_BUILD_PINS_AND_CAPTURED_BODIES` 确认字节数和摘要。两种匹配均返回 `0`。退出码 `3` 表示不匹配或线上未配置，`4` 表示输入不合规。核验器离线运行，不读取凭据。已安装节点的版本需另外核对 `presence-install.json`、脚本和 unit 摘要及实际 timer 回执。

升级已有节点时，按以下顺序操作：

1. 先由实例 owner 发布包含新 console/app.js 和新安装器的 Worker 版本，更新构建生成的 GHOSTFLEET_INSTALLER_SHA256 与 GHOSTFLEET_BOOTSTRAP_SHA256；核对 Panel 提供的安装器 SHA-256 与规范 LF 构建产物一致。
2. 在受保护 Panel 中找到**原节点**并点击“重发票据（Reissue）”。这是同一 node_uid 的重新绑定，不创建第二个节点。面板为已有节点生成的安装命令会自动带 --replace。
3. 只有当目标机可信终端已准备好、操作者能够立即完成安装时才点击重发：服务端签发同节点票据时会立即撤销旧的待处理票据，并清空旧 reporting digest / 最近心跳投影；旧 reporter 凭据随即不能再上报。该操作不修改 SSH、OS 账户或 provider 权限。
4. 在同一台节点的可信终端运行面板生成的命令，并在提示时输入新短码。新安装器先校验固定 SHA，再以 expected_node_uid 领取同节点票据；成功后停止旧 timer/service、写入新 config/reporter/unit、daemon-reload、启用 timer 并立即触发上报。
5. 验证安装器字节/SHA、timer 与 service 状态、journal 和 Panel 新心跳。确认原生 SSH 仍可用。

若领取结果不确定或领取成功后本地替换中断，不要盲目重复旧命令或创建新节点。回到 Panel 核对原 node_uid，再次对**同一节点**重发票据并使用新命令/短码。由于旧凭据在重发时已失效，升级失败期间心跳可能暂时中断；这不应影响原生 SSH。repair 适用于本地安装步骤未完成、且当前保存的 config/token 仍有效的恢复场景；它不能代替上述版本升级流程。

## English — Updating an installed reporter (repair is not upgrade)

**repair** rewrites GhostFleet-owned files and systemd units from the locally executing script (Path(__file__).read_bytes()), then re-enables the timer. It does not download a newer installer, claim a ticket or rotate the reporting token. Running repair from an old installation therefore restores that old version; it is not a software update.

**Read-only release-pin currentness check:** If source already contains the PR #110 systemd snapshot pre-probe but the production Panel still serves an old bootstrap, an enrolled node can keep installing a unit without `ExecStartPre`, yielding a fresh heartbeat with `unknown` service states. This is usually **deployment artifact pin drift**; a newer GitHub main or a local `repair` does not prove the Worker distribution has been updated. The instance owner can build the reviewed candidate and save an authorized, protected `GET /v0/access` metadata response locally, then run:

```sh
npm run build
node scripts/check-presence-release.mjs \
  --build-json dist/installer.json \
  --access-json /private/access-readback.json
```

`MATCHED_BUILD_PINS` confirms that the supplied metadata matches both build pins. To check the actual bytes as well, save both response bodies and append `--installer-body <local .py> --bootstrap-body <local .sh>`. The status `MATCHED_BUILD_PINS_AND_CAPTURED_BODIES` confirms both sizes and digests. Both match statuses exit `0`. Exit `3` indicates a mismatch or unconfigured metadata. Exit `4` indicates invalid input. The checker runs offline and reads no credentials. Verify installed-node currentness separately using `presence-install.json`, the installed source and unit hashes, and real timer receipts.

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

The build emits static assets, pinned shell/Python artifacts, both digests and the generated Wrangler configuration. Route two HTTPS origins to one Worker and protect the entire panel origin with Access. Keep the node origin limited to its machine endpoints and pinned installer. For a single Cloudflare Access sign-in, set `GHOSTFLEET_PANEL_AUTH_MODE=cloudflare_access`, the team's HTTPS `GHOSTFLEET_PANEL_ACCESS_ISSUER`, the panel application's `GHOSTFLEET_PANEL_ACCESS_AUD` and its operator's `GHOSTFLEET_PANEL_ACCESS_OWNER_EMAIL` in the private deployment overlay. The Worker verifies the signed application assertion and the operator identity, and requires the exact panel Origin on writes. Existing Bearer deployments can continue using distinct Operator and Read credentials through native secret tooling. Preserve the existing DO namespace, class, snapshot key and node UID values. Back up before rollout.

The panel-generated command uses verified HTTPS, rejects redirects, verifies the shell digest before execution, then verifies the Python installer digest and byte count. curl requires HTTP 200 even if a 3xx body matches the pinned digest; GNU wget allows zero redirects. Download-tool configuration files cannot enable redirects or disable TLS checks. Only the one-time shim may install missing python3; the Python installer touches its own files and units, not SSH, provider policy or user authentication. The separate short code stays in the hidden local prompt. See ADR005 for the package boundary and failure recovery. Custom service-unit names are explicit options; absent units remain not_found. Config is0600 and passed with LoadCredential to a DynamicUser service. The reporter has bounded timeouts/responses, refuses redirects and uses no inherited HTTP proxy.

**Service-observation manager scope:** the reporter invokes `systemctl --system show`. The `--ssh-unit`, `--cloudflared-unit` and `--tailscaled-unit` options select unit names within the system manager; they do not switch to `systemctl --user`. A service that exists only in a user's systemd manager will therefore be reported as `not_found` even while that user unit is active. This is an observation-scope mismatch, not proof that the service or tunnel is down. Do not migrate or recreate an existing provider unit merely to improve a Panel badge. A system-unit migration or explicit user-manager probe is a separate owner-authorized change and must preserve the existing execution user, environment, credentials and rollback path while proving native connectivity remains intact.

**DynamicUser and system-bus compatibility:** Some `dbus-daemon` versions cannot resolve a transient UID allocated by systemd's `DynamicUser`, causing an unprivileged `systemctl` system-bus query to fail with `Transport endpoint is not connected`. The reporter remains `DynamicUser=yes`. Each run first invokes one fixed local read-only probe through `ExecStartPre=!`; it uses UID 0 only to call `systemctl --system show` for the three configured allowlisted units. systemd's `!` prefix bypasses only `User=/Group=` credential switching; it does not bypass the empty `CapabilityBoundingSet=`, `NoNewPrivileges=yes`, or filesystem sandbox. The systemd manager opens `/run/ghostfleet-heartbeat-services.json` as root. The probe writes only credential-free JSON through its inherited stdout file descriptor and sets the file mode to 0644; the unit adds ReadWritePaths for this exact file only. The reporter uses `os.dup2(2, 1)` to replace the underlying stdout descriptor with the existing journald stderr stream before reading the root-owned snapshot as DynamicUser. Closing the Python stdout object alone does not close its underlying descriptor. Each probe truncates any previous snapshot and writes a monotonic timestamp; snapshots older than 30 seconds are treated as `unknown`. If the snapshot is missing or fails validation, service states fall back to `unknown` while heartbeat reporting continues. The probe has no shell, remote-command or service-control path.

For an uncertain claim, reissue a ticket for the same node_uid, invalidating its former reporting credential. Do not create another node. Use `repair` only when a saved local credential exists but the local files or units need repair; it is not a software update. Use an explicit same-node reissue with `--replace` to install a newer reporter. Removal validates its manifest and refuses locally modified files. Panel reporting revocation and local uninstall are separate actions, neither revokes SSH. A panel outage does not terminate native SSH.

Presence uses server receipt time and only the latest local process observation. It is not NodeLifecycle.ACTIVE, external tunnel reachability or proof of inbound administration. Production domain/Access policy, protected-browser first use and root system-service installation remain separate live acceptance.
