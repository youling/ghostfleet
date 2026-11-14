# GhostFleet 传输架构侦察 / Transport architecture reconnaissance

```yaml
artifact_type: ARCHITECT_RECONNAISSANCE_REPORT
status: RECONCILED_RESEARCH_INPUT
as_of: 2026-11-14
project_stage: FORMING
scope: TRANSPORT_ONLY_NATIVE_OPENSSH_AND_PUBLIC_VALIDATION
reuse_mode: REUSE_COMPONENT_BEHIND_EXISTING_SEAM_AND_REUSE_KNOWLEDGE
external_current_state: DOCUMENTED_CAPABILITY_WITH_RELEASE_AND_LICENSE_CHECKS
reuse_candidates: 18_DISTINCT_PROJECTS_INCLUDING_5_CORE_OR_NEW_AND_13_ALTERNATIVES
external_wheel_admission: not_applicable
dependency_admission: NONE_PERFORMED
architecture_delta: RETIRE_CUSTOM_CONTROL_PLANE_PRESERVE_NATIVE_SSH_TRANSPORT
parallel_track_risk: SECOND_IDENTITY_SESSION_AUTHORITY_OR_COMMAND_CONTROL_PLANE
decisions: [KEEP, REUSE_ARTIFACT, REUSE_KNOWLEDGE_NATIVE_IMPLEMENT, BUILD, DEFER, REJECT]
local_validation: CANDIDATE_FIXES_AND_LOCAL_TESTS_FINAL_EVIDENCE_IN_PR
real_node_transport_tests: NOT_RUN
do_not_build: CUSTOM_AGENT_APPROVAL_EXECUTOR_AUDIT_QUEUE_OR_FAILOVER_DAEMON
open_questions: SEE_SECTION_7
targeted_research_needed: TARGET_VERSION_AND_ENVIRONMENT_ACCEPTANCE_ONLY
first_architecture_direction: COMPLETE_EXISTING_PR_AND_NATIVE_DUAL_PATH_ACCEPTANCE
```

## 1. 结论、范围和证据

**保留 Cloudflare / Tailscale 两种网络入口，进入同一个原生 OpenSSH 服务；继续复用上游组件，不新增第三条生产通道。** 本轮没有发现足以支持立即替换现有路线的目标环境实证。更值得吸收的是有效配置验证、身份分层、无 TUN 接入、凭据撤销和失败恢复经验，以及新版本带来的兼容性变化。

本报告依照 [ai-use ARCH-0 规程](https://github.com/youling/ai-use/blob/main/docs/ARCHITECT_RECONNAISSANCE.md) 组织，受 [当前产品范围](https://github.com/youling/ghostfleet/pull/85#issuecomment-6875500332) 和 [主工单执行口径](https://github.com/youling/ghostfleet/issues/11#issuecomment-6875523241) 约束。项目为 `FORMING`：主要接口已收敛为配置、原生 SSH 和小型验证器；运行、身份、恢复尽量交给现有组件。外部资料提供证据，不产生依赖准入、合并、生产部署或凭据操作权限。

| 证据等级 | 本文能证明什么 | 不能推导什么 |
| --- | --- | --- |
| `DOCUMENTED_CAPABILITY` | 官方文档、上游源码、发行说明记录的能力及条件 | 不证明某个账户、版本、节点或当前云环境已可用 |
| `OBSERVED_AVAILABLE` / `MEASURED`，限本地合成验证 | 本轮已复现验证器问题，完成候选修复并运行本地测试；具体范围和最终证据由 PR 承接 | 不证明真实双路连接、部署、权限撤销、长会话、吞吐或故障恢复通过 |
| `ARCHITECTURAL_INFERENCE` | 从产品边界与上游机制推导的 KEEP / REUSE / DEFER 判断 | 不把功能更多、包更小或上游 benchmark 当成本项目收益 |
| `UNKNOWN` / `NOT_RUN` | 尚未获取的目标版本或现场证据 | 不写成“支持”“不支持”或 PASS |

本轮三组验证器问题分别涉及：完整 `AuthenticationMethods` 值、root 准入列表/模式判定、公开发布边界扫描。**本轮候选落实，最终证据见 [PR #85](https://github.com/youling/ghostfleet/pull/85)**；最终 HEAD、测试数量、CI 与独立复审结果未在此冻结。研究没有执行真实设备连接、provider 配置修改、部署或候选性能对比。

## 2. 历史地图、去重口径与当前五个底座/新项目

### 2.1 复用历史地图，不继承已失效裁决

[2026-11-12 历史报告的固定基线](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md) 统计的是 **42 个主要上游仓库，不是 42 个独立项目**：管理面 15 仓库、传输与分发面 27 仓库。本轮把它作为候选地图复用，没有宣称重新核验全部 42 仓库。

| 历史地图部分 | 本轮保留的知识 | 当前不再继承的内容 |
| --- | --- | --- |
| 身份、设备管理与执行 | 网络身份、SSH 主机身份、OS 账户权限分层；凭据生命周期；实际行为与声明分开 | 自建 NodeIdentity / EnrollmentAttempt / HumanGate / Helper / command audit 的默认保留裁决 |
| 传输与网络 | 标准 SSH、上游 NAT/relay、connector 冗余、故障与重连模型 | 自建 adaptive router、自动跨入口迁移既有 SSH 会话、命令重派 |
| 文件、安装与恢复 | 标准 SFTP/rsync 兼容；本地文件与云挂载语义差异；版本及恢复证据 | 自建 intent/receipt/job/store、发布签名服务、统一生命周期控制面 |

本轮定向核验 **18 个独立项目**：五个核心/新项目为 **OpenSSH、cloudflared、Tailscale、systemd、Tailcat**；另有 **13 个备选项目**，见第 5 节。Cloudflare 的四种 SSH 路线、Access 功能和 Tailscale PAM 不重复计为独立项目；RustDesk 客户端与 OSS server 合计一个项目。历史 42 仓库与本轮 18 项有重叠，**不得相加成 60 个新项目或 60 项重新验证**。

### 2.2 五个核心/新项目

| 项目 | 版本、维护与许可的可核范围 | 当前决定 |
| --- | --- | --- |
| OpenSSH | [官方发行说明](https://www.openssh.org/releasenotes.html) 本轮顶部为 10.6p2，2026-11-05；源码按组成文件采用 BSD/宽松条款，见 [portable LICENSE](https://github.com/openssh/openssh-portable/blob/master/LICENCE)。发行版包与补丁状态另核对。 | `KEEP / REUSE_ARTIFACT`：唯一 SSH 协议、主机身份与 OS 账户认证实现；不自写 SSH server。 |
| cloudflared / Cloudflare Tunnel | [2026.11.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0)，2026-11-12，GitHub latest 返回的非 prerelease；[客户端源码 Apache-2.0](https://github.com/cloudflare/cloudflared/blob/master/LICENSE)，不代表托管服务条款。 | `KEEP / REUSE_ARTIFACT`：传输和网络准入；Access 产品模式分开判断。 |
| Tailscale | 本轮复核当前网络、SSH、userspace 与 CLI 文档，未固定“最新稳定版本”；[客户端源码 BSD-3-Clause](https://github.com/tailscale/tailscale/blob/main/LICENSE)，托管服务另计。 | `KEEP / REUSE_ARTIFACT`：只复用 tailnet 网络；原生 sshd 路线需避免开启 Tailscale SSH 接管 22 端口。 |
| systemd | 复核 [服务语义](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) 与 [unit 验证](https://www.freedesktop.org/software/systemd/man/latest/systemd-analyze.html)；当前滚动手册标 262，不据此声明部署版或发行版支持。源码许可按 [官方 README](https://github.com/systemd/systemd/blob/main/README) 与文件标头核对，不将单个许可证泛化为全部组成。 | `KEEP / REUSE_ARTIFACT`：启动、进程恢复与原生日志，不增加自制健康守护 Agent。 |
| Tailcat | [v0.7.0](https://github.com/tailscale/tailcat/releases/tag/v0.7.0)，2026-09-20，latest 返回的非 prerelease；[上游仓库](https://github.com/tailscale/tailcat) 为 BSD-3-Clause。开发分支能力不自动归到该 release。 | `DEFER`：可做单独 userspace 端口实验，不列为第三生产通道。 |

版本是本次证据窗口的观察，未来日期只记计划，不写成已上线。“未归档”、近期 push、GitHub latest 与持续安全维护承诺分别记录；本轮不把其中任一项等同于生产适用性。源码许可、发行物条款和具体使用方式也必须分开，不在此给出法律兼容性结论。

## 3. 能直接采用的传输与身份机制


| 主题 | 已核对的官方事实 | 对 GhostFleet 的判断与落点 |
| --- | --- | --- |
| 服务端有效配置 | `sshd -T -C` 会应用给定连接上下文下的 `Match`；参数包括 user、addr、host、laddr、lport、rdomain。（[OpenBSD sshd(8)](https://man.openbsd.org/sshd.8)） | **KEEP / 完善验收**：不能只检查 drop-in 文本。以实际 CF origin 地址与 tailnet 来源分别验证；如果 `localhost` 可能解析到 IPv6，则覆盖该实际地址族。测试上下文不能替代真实连接。 |
| Include 与 Match | `Include` 的 glob 按词法顺序处理；多个命中的 Match 对同一选项取先出现者。`PermitRootLogin prohibit-password` 禁止 root 密码和键盘交互认证。（[OpenBSD sshd_config(5)](https://man.openbsd.org/sshd_config)） | **KEEP**：`00-` 命名只是减小覆盖概率，验证实际结果才是证据。对 root 密钥认证、AuthenticationMethods、ForceCommand 等承诺检查有效值；OMV/cloud-init 重新生成配置后复验。 |
| 双路主机身份 | `HostKeyAlias` 是 host-key 数据库查询与证书验证所用别名；`ControlPath` 支持复用已有连接；保活只负责发现失联。（[OpenBSD ssh_config(5)](https://man.openbsd.org/ssh_config)） | **KEEP**：每台机器一个稳定别名，CF/TS 共用；不同机器不能照抄同一别名。验证每一路时设 `ControlPath none`，避免复用另一路的存活连接造成假阳性。保活超时不等于命令没执行。 |
| 首次信任 | `ssh-keyscan` 不能认证采集到的主机公钥，官方要求带外验证或可信网络条件。（[OpenBSD ssh-keyscan(1)](https://man.openbsd.org/ssh-keyscan.1)） | **KEEP**：先从可信现场/已验证通道核对指纹，再建立 known_hosts。不要将自动抓取公钥直接当作身份验证。 |
| SSH 证书 | OpenSSH 原生支持 user 与 host 两种证书、principal 和有效期；两类证书承担不同认证方向。（[OpenBSD ssh-keygen(1)](https://man.openbsd.org/ssh-keygen.1)） | **DEFER 可选增强**：将来机器/操作员数量增多时，可用原生 CA 减少分发成本。当前无需为证书新建后台，更不能把 user CA 与 host CA 混为一项信任。 |
| CF 原生终端入口 | 官方 `cloudflared access ssh --hostname` 通过 ProxyCommand 接入，标准用户流程会打开浏览器完成 Access 登录。（[CF client-side cloudflared SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)） | **KEEP**：交互式使用路径清楚；机器自动化需要独立的 Service Auth 验收，不能把浏览器登录方案写成无人值守已可用。 |
| CF 长连接 | published SSH/TCP 走 WebSocket，官方对长连接建议 Client-to-Tunnel。（[CF published protocols](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)） | **文档明确**：现有路线可保留；长任务不承诺永久在线。若实际长连接证据表明不足，再试 self-managed SSH keys + One Client，不为此先重写调度器。 |
| CF 私网原生密钥 | self-managed SSH keys 路线使用 One Client/Gateway 网络策略，继续由目标 SSH server 管理密钥。（[CF self-managed SSH keys](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-device-client/)） | **候选**：比 Access for Infrastructure 更贴合同一 sshd/原生密钥的边界，但客户端运行权限、路由接线和持续可用性要在目标环境独立验证。 |
| Tailscale SSH | 开启 Tailscale SSH 会截获 tailnet 地址的 22 端口并进入 Tailscale 自己的 SSH server；不再由原生 sshd 的公钥认证承担同一流程。（[Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)） | **当前不采用其 SSH 层**：新产品只复用 tailnet 网络，明确 `tailscale set --ssh=false` 的预期状态。切换该选项会影响已有会话，应由真实部署 owner 在其范围内处理。 |
| Tailscale 数据面 | 当前连接类型包括 direct、peer relay、DERP；官方提供 `tailscale status/ping` 辨别路径。（[Tailscale connection types](https://tailscale.com/docs/reference/connection-types)） | **REUSE**：让上游负责 NAT 穿透与网络内 fallback，不重新造一层 Adaptive Routing。吞吐与时延只有现场测量后才能陈述。 |
| 无 TUN 云环境 | Tailscale userspace 模式支持 SOCKS5/HTTP 代理，避免依赖 `/dev/net/tun`；应用必须明确使用代理。（[Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking)） | **候选，较成熟**：云端没有 TUN 不等于不能进入 tailnet。普通 OpenSSH 用 `tailscale nc` 或明确的 SOCKS ProxyCommand 接入，并保持 host-key 验证；不假定环境变量会让 ssh 自动走 SOCKS。 |

“两路独立”应精确表述为**两种可分别验证的网络入口**。两路仍共享目标硬件、sshd、账户/密钥与可能的本地网络、电源，不能宣称消除了这些共同故障。Cloudflare 的网络准入身份不会自动成为 sshd 的 OS 用户；CF connector 本地接入时，sshd 看到的来源也未必是原始操作者地址。这些是架构推论，应通过实际连接事实确认。

## 4. 本次查到的近期变化

### 4.1 Cloudflare service-token 语义更新

官方文档已记录：2026-08-26 起，新 Client Secret 使用 `cfast_` 前缀及 48 个后续字符；旧 64 位十六进制形式继续有效。2026-10-05 起创建的新 Zero Trust 组织默认启用 strict service-token authentication：只认 Service Auth 策略，失败返回 401/403，不依赖登录重定向或 cookie fallback。（[CF service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)）

进一步查到 **2026-11-11 官方 changelog** 给出精确检测表达式 `cfast_[A-Za-z0-9]{40}[a-f0-9]{8}`，明确末尾 8 字符为十六进制 checksum。匹配只证明形状，不验证 checksum 或 token 活性。该公告同时说明 GitHub 公开仓 secret scanning 会向 Cloudflare 报告泄漏，Cloudflare 禁用该 token；恢复前必须轮换，泄漏 secret 不支持 grace period。（[CF 2026-11-11 secret scanning changelog](https://developers.cloudflare.com/changelog/post/2026-11-11-leaked-service-token-recovery/)） 不扫描泛化的所有 base64 字符串；单段 Tunnel token 的精确检测仍需单独上游格式证据。

**可落实的增量：** publication guard 覆盖新 secret 形状；非交互验收同时测新 token、过期/禁用/错误 secret、错误 application audience，并确认不会卡在浏览器登录。本轮已将这一精确规则纳入候选修复；最终实现与验证证据见 [PR #85](https://github.com/youling/ghostfleet/pull/85)，本报告不绑定尚在变化的 HEAD 或测试数量。测试样本应运行时拼接，避免将完整仿真 secret 固定放进仓库。

`cloudflared@2026.11.0` 的 `cmd/cloudflared/access/cmd.go` 明确保留 `TUNNEL_SERVICE_TOKEN_ID` 与 `TUNNEL_SERVICE_TOKEN_SECRET`，并将其放入相应请求头。（[cloudflared v2026.11.0 access/cmd.go](https://github.com/cloudflare/cloudflared/blob/2026.11.0/cmd/cloudflared/access/cmd.go)） 这证明接口存在，不能替代端到端无人值守成功；上游公开 issue #1674 有针对 2026.6.0 的用户回归报告，描述 HTTP 成功但 SSH 流仍进入浏览器流程。（[cloudflared #1674](https://github.com/cloudflare/cloudflared/issues/1674)） 该报告只用来确定需要测试的反例，不能推断当前版本仍坏，也不能直接推荐降级。

### 4.2 upstream 版本与升级语义

- **cloudflared：** GitHub latest release API 与 release 页面均为 `2026.11.0`，发布时间 `2026-11-12T12:23:45Z`，非 prerelease。同期官方 changelog 提到 URL normalization 对分号路径的处理变化；默认开启日期是未来的 2027-02-08，应写为计划变更，不是当前已默认启用。（[cloudflared 2026.11.0 release](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0)；[CF Tunnel SASE changelog](https://developers.cloudflare.com/changelog/product/cloudflare-tunnel-sase/)）
- **OpenSSH：** 官方 release notes 顶部为 `10.6p2`，2026-11-05 发布，包含 musl Linux 且 PAM disabled 场景的安全 workaround。（[OpenSSH release notes](https://www.openssh.org/releasenotes.html)） 不能从上游版本号推断 Debian/OMV 包是否受影响或已回补；部署清单应记录实际包版本及发行版公告。
- **cloudflared token file：** 官方 `--token-file` 需要 2025.4.0+；`grace-period` 默认 30 秒，只等待已有请求结束。debug 日志可能记录请求/响应头。（[CF run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/)） 因此固定版本、使用 token 文件、受控日志等级均应写进配置说明；token-file 并不自动约束文件权限。
- **token 撤销：** Tunnel token 轮换阻止旧 token 新建连接，但既有 connector 仍可能持续至重启；泄漏处置文档还要求断开已有连接。（[CF tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)） 隧道服务身份、Access service token、SSH 账户密钥是三种独立凭据，轮换其一不等于撤销全部权限。

### 4.3 Tailcat：与极简路线很相近的新选项

Tailscale 于 2026-08-31 公布 Tailcat：将 WireGuard、NAT 穿透和 DERP 字节通道拆成 userspace CLI/Go 库，无账号、无 tailnet 控制面，也不需要 TUN 或 root，官方用 AI sandbox 访问测试机解释用途。（[Tailcat 发布文章](https://tailscale.com/blog/tailcat)） 产品页明确提醒地址具有访问能力，应视为秘密；默认托管 relay 有速率限制并保存连接元数据。（[Tailcat 产品与 FAQ](https://tailscale.com/tailcat)）

GitHub `releases/latest` 本轮返回 `v0.7.0`（非 prerelease，发布于 `2026-09-20T00:37:32Z`）；当时读取的 `main` 快照为 `e00cdde6ff787f801361ff85ed085775c775d4c5`。（[Tailcat v0.7.0 release](https://github.com/tailscale/tailcat/releases/tag/v0.7.0)） [v0.7.0 README](https://github.com/tailscale/tailcat/blob/v0.7.0/README.md) 展示了端口转发、公钥 allowlist、固定服务器身份，也提供自带 SSH/exec 服务；自带服务不是原生 OpenSSH。同一 README 明确没有 API、CLI 或 wire-format 稳定性承诺，公共 relay 也没有 uptime SLA；非 prerelease 标记不改变这些限制。

**架构建议：`DEFER / isolated experiment`。** 它值得进入候选目录，尤其适合短命云沙箱，但当前不应自动加入 PR #85 第三条生产路径。若做后续实验，优先只转发原生 sshd 的单个端口，保留原来的 SSH host-key 与用户认证；不采用 `no-auth-ssh` 或自带 exec 服务来改变产品边界。需要证明 allowlist 拒绝、固定身份重启、地址轮换、断线重连、relay 可达与网络出口条件。其免 root 特性不会让受平台限制的云环境自动获得允许的网络出口。

### 4.4 两种上游托管权限层

Cloudflare Access for Infrastructure 能提供短期 SSH 证书、逐目标/用户策略和命令日志；其文档同时列出不支持 ProxyJump、端口/agent/X11 forwarding，默认 24 小时的可配置应用会话时长，并说明 Gateway 连接 10 小时保证期限。（[CF Access for Infrastructure](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-infrastructure-access/)） Tailscale PAM 当前仍标 beta，有独立 connector 和会话管理层。（[Tailscale PAM](https://tailscale.com/docs/privileged-access-management)）

两者都可以作为将来有人明确需要集中审计时的参考，**当前 `DEFER`**。新 GhostFleet 的目标是原生 root 通道；不应因“上游有更多功能”又引入第二套账户、命令代理和审批域。

Cloudflare 的几条路线需要在文档中分开称呼，不能把“都有 Cloudflare Tunnel”视作同一种身份与客户端模型：

| 官方路线 | 客户端与身份 | GhostFleet 定位 |
| --- | --- | --- |
| SSH with client-side cloudflared | 本机 OpenSSH + `cloudflared access ssh`；Access 网络准入后仍由目标 sshd 接受用户密钥 | 当前基线；WebSocket 长连接与非交互 token 流程分别验收。（[CF client-side cloudflared SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)；[CF published protocols](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)） |
| Self-managed SSH keys / Client-to-Tunnel | One Client（WARP 产品系）进入私网，Gateway 做网络策略，目标继续管理 SSH 密钥 | 长连接候选；需要目标客户端可运行、路由及 DNS 合理，不意味着增加 SSH 代理认证。（[CF self-managed SSH keys](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-device-client/)） |
| Access for Infrastructure | One Client + Access 基础设施策略、托管短期 SSH 用户证书与会话日志 | 当前延后；改变会话与功能约束，不是单纯更换网络入口。（[CF Access for Infrastructure](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-infrastructure-access/)） |
| Browser-rendered SSH | 浏览器访问 public hostname，使用 Access 身份；可复用同一 Tunnel，无需安装 One Client | 人工临时维护候选，不是无人值守 agent 的 stdio 传输；复用 Tunnel 时也不是独立故障入口。（[CF Browser-rendered SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-browser-rendering/)） |

命名注意：当前官方目录仍将 `SSH with client-side cloudflared` 列为正式路线；其标为 legacy 的是另一些 private-network applications 与 short-lived certificates 功能。将 `access ssh` 称为“已有路线”比直接写成“已弃用 legacy”更准确，除非另有明确弃用证据。（[CF client-side cloudflared SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)；[CF Browser-rendered SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-browser-rendering/)）

### 4.5 云沙箱可使用的明确入口

| 入口 | 已证实接口 | 前提与证据边界 |
| --- | --- | --- |
| CF client-side cloudflared | `ProxyCommand cloudflared access ssh --hostname %h` | 本地普通进程可运行；交互 Access 或 Service Auth 需有效配置。宿主不必先提供 TUN；本轮研究环境出口到该域名能否建立 WebSocket 未测试。 |
| Tailscale userspace + 原生 OpenSSH | `ProxyCommand tailscale nc %h %p` | CLI 文档明确提供 `nc`；上游代码通过 `localClient.DialTCP` 发流，而非要求内核直接路由。（[Tailscale CLI nc](https://tailscale.com/docs/reference/tailscale-cli#nc)；[Tailscale nc 实现](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/nc.go)） 先有本地可访问的 userspace tailscaled socket、已获准 tailnet 身份与目标端口权限。 |
| Tailscale userspace SOCKS5 + OpenSSH | `ProxyCommand nc -X 5 -x 127.0.0.1:1055 %h %p` | 此命令要求 OpenBSD netcat 语义，不能假定所有同名 nc 相同。（[OpenBSD nc(1)](https://man.openbsd.org/nc.1)） ssh 仍负责 host key 与账户公钥认证。 |
| Tailcat 端口传输实验 | 原生端口模式 `tailcat serve <port>`；客户端 `tailcat <address> <port>` 提供 stdio，`tailcat forward` 提供本地端口入口 | 不需 tailnet/TUN，但需要其 rendezvous/relay 或直连出口；地址、PSK、可选 client-key allowlist 与原生 SSH 身份需分别管理。 |

上述均未在本轮研究环境实测，也不能绕过平台网络允许列表。`tailscale ssh` 文档会自动验证 Tailscale 分发的 SSH host key，属于其 SSH 集成；此处为保持原生 sshd 的信任来源，明确选普通 `ssh` + `tailscale nc` 或 SOCKS5。


### 4.6 OpenSSH 的兼容性与修补不能只看版本号

[OpenSSH 10.6p2 官方说明](https://www.openssh.org/releasenotes.html) 记录了针对 Linux / musl 且 PAM disabled 场景的密码认证绕过 workaround，以及将 `ssh-mldsa44-ed25519` 纳入允许的 CA 签名算法等修复。是否影响目标应按实际 libc、构建选项和发行版修补说明判断；不能把“参考 profile 为公钥”当作整个发行版无需跟踪修补的证据，也不能仅因版本号较小就断言未修复。

同一说明从 10.6 起对 `scp -R` 发出弃用警告：该远端到远端优化仍可工作，未来才计划忽略此选项。它依赖远端凭据与 shell 行为，与 [#36](https://github.com/youling/ghostfleet/issues/36) 的跨平台文件传输、[#64](https://github.com/youling/ghostfleet/issues/64) 的横向凭据边界有关。当前优先按实际客户端验证标准 SFTP/scp/rsync 路线，不能把新格式、旧算法兼容或证书新能力写成全平台承诺；原生 SSH CA 仍是有规模需求再评估的可选增强。

### 4.7 原生服务恢复与会话恢复分开

[systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) 的 `Restart=` 管理进程退出、信号及超时后的重启，并受启动频率限制影响；正常退出、故障退出与显式停止的行为不同。它不解释 SSH 远端命令，也不恢复已有 TCP 会话。[systemd-analyze verify](https://www.freedesktop.org/software/systemd/man/latest/systemd-analyze.html) 能查 unit 指令、依赖与可执行文件问题，不能证明服务已连上 provider 或目标已可用。实际启动、重启后新连接和长任务状态仍属于部署验收。

## 5. 十三个备选项目：机制、维护与采用条件

以下均为定向比较，架构适配列为推断。版本依据官方 release、维护状态依据上游仓库与明确公告；autossh 使用作者官网及 Debian 原始版权材料。RustDesk 两个仓库合计一项。没有安装或对比这些候选在目标网络中的表现，也没有批量引入依赖。

### 5.1 轻量反向通道

| 项目 | 当前可核维护/发行与许可 | 协议、客户端及部署责任 | 对原生sshd/命令的影响 | 当前裁决与重开条件 |
|---|---|---|---|---|
| **frp** | [v0.72.0，2026-11-04](https://github.com/fatedier/frp/releases/tag/v0.72.0)；仓库Apache-2.0。新版本增加系统CA验证，修复重连配置丢失、复用连接关闭/高CPU等。 | 常规frps公网服务+目标frpc；TCP/UDP、WebSocket/WSS、QUIC等。STCP还需访问端visitor。可选[SSH Tunnel Gateway](https://gofrp.org/en/docs/features/common/ssh/)允许目标用原生`ssh -R`，不装frpc。 | 转发TCP22时目标仍是OpenSSH；frps的SSH Gateway是建隧道的SSH端点，并不是目标机器sshd。还需自管公网服务器、访问规则及隧道凭据。 | **DEFER**。如果必须自托管中继、CF受真实网络/服务条件阻断，先小样本比较frp与纯OpenSSH reverse forward；现无替代收益实测。Gateway最小例子默认不验client，不能照抄为生产profile。 |
| **rathole** | [稳定v0.5.0，2023-10-01](https://github.com/rathole-org/rathole/releases/tag/v0.5.0)；[dev-latest，2026-08-22，prerelease](https://github.com/rathole-org/rathole/releases/tag/dev-latest)；Apache-2.0。不应称停更，也不把main/dev能力算进0.5.0制品。 | 公网server+目标client；service token；TCP/UDP服务，可选TLS/Noise，当前README还有WebSocket配置。默认transport示例为tcp，[具体配置](https://github.com/rathole-org/rathole/blob/main/README.md)。 | 可透明转发目标SSH，不提供目标OS账户授权。token证明接隧道者，不替代SSH用户/host-key验证。 | **DEFER**。设备内存/包体预算被测量证明是约束时再考察；上游“高吞吐/低内存”自测不能推成当前网络优势。先确认选定release真的包含所需功能。 |
| **chisel** | [稳定v1.12.0，2026-08-29](https://github.com/jpillora/chisel/releases/tag/v1.12.0)；[v1.13.0，2026-10-11为prerelease](https://github.com/jpillora/chisel/releases/tag/v1.13.0)，不能把SOCKS5 UDP新能力称stable。MIT。 | HTTP/WebSocket外层+SSH加密内层，server/client单二进制；支持反向端口及SOCKS；需要自管出口server、认证和指纹。 | 内层SSH保护隧道，不等于替代目标sshd；透明转发22可保留原生SSH。SOCKS扩大网络用途，不是本轮必需。 | **DEFER**。只允许HTTP/WebSocket出口且已授权自托管时可做候选。吸收1.12对dead connection、TCP half-close、无效auth fail-fast、完整fingerprint的修复经验。 |
| **bore** | [v0.6.0，2025-06-09](https://github.com/ekzhang/bore/releases/tag/v0.6.0)；2026-02仍有repo push；MIT。 | 极小TCP反向代理，目标client+公网server；控制连接通知后每条数据流单独建TCP。[README](https://github.com/ekzhang/bore)明确secret为可选challenge/HMAC认证，数据默认不再加密。 | 转发SSH时SSH自身仍可提供端到端加密；不能由此说bore对任意服务提供加密。它不提供完整身份/访问策略。 | **DEFER**。可用作隔离网络实验，当前无理由引入更薄但额外的公网broker；公共演示server不作为私有部署依据。 |
| **autossh** | [作者官网](https://www.harding.motd.ca/autossh/)仍列1.4g，页面日期2019-01-09；[Debian trixie提供1.4g](https://packages.debian.org/trixie/autossh)。不是通过某个同名GitHub镜像判维护。作者为宽松自定义autossh许可，部分文件另有ISC等，[Debian copyright](https://sources.debian.org/src/autossh/1.4g-1/debian/copyright/)；不简化成全包统一MIT/BSD。 | 包装原生ssh，监测失联后重启，可配`ssh -R`到自管bastion；需要原生SSH客户端及可达server，没有自己的VPN/身份服务器。 | 不解释远端命令，管理本地SSH进程。重连建立新连接，不恢复丢失的远端shell状态。 | **REUSE_KNOWLEDGE / DEFER_DEPENDENCY**。当前cloudflared/tailscaled已有自己的重连和systemd；再叠autossh没有必要。若未来选纯reverse SSH，先比原生keepalive+systemd与autossh的具体故障差异。 |

#### 两个容易误读的细节

- [frp TLS文档](https://gofrp.org/en/docs/features/common/network/network-tls/)明确“启用TLS”与“校验server身份”不同。v0.72增加系统CA路径不等于所有默认配置已验证对端。SSH Gateway也有独立authorizedKeysFile/服务token设置，不能用“SSH协议”四字替代认证检查。
- [autossh作者README](https://www.harding.motd.ca/autossh/README.txt)直接建议考虑OpenSSH的ServerAliveInterval/ServerAliveCountMax；`-M 0`关闭autossh探测后只对ssh退出重启。它还解释ExitOnForwardFailure和正常退出/故障退出的区别。这些知识可以写进运维验收，无需安装autossh。

### 5.2 替代 overlay

| 项目 | 当前可核维护/许可 | 协议和客户端责任 | 命令/SSH边界 | 当前裁决 |
|---|---|---|---|---|
| **Headscale** | [v0.29.7，2026-10-30](https://github.com/juanfont/headscale/releases/tag/v0.29.7)，BSD-3-Clause；近期repo push。 | 自托管Tailscale控制服务器，继续使用Tailscale客户端；官方[FAQ](https://headscale.net/stable/about/faq/)定位单tailnet、自托管/实验室，需承担控制服务、数据库、升级及relay配置。 | 可继续IP网络上的原生OpenSSH；替换的是Tailscale控制面，不是删掉目标tailscaled客户端。官方[client文档](https://github.com/juanfont/headscale/blob/main/docs/about/clients.md)有兼容窗口与平台配置。 | **DEFER**。只有明确要掌握控制面且愿意接管运维时才最接近现有迁移；不因开源自托管就认为更省事。 |
| **NetBird** | [v0.83.1，2026-11-13](https://github.com/netbirdio/netbird/releases/tag/v0.83.1)。[根LICENSE](https://github.com/netbirdio/netbird/blob/main/LICENSE)：通常BSD-3-Clause，management/signal/relay/combined为AGPLv3。 | WireGuard overlay，ICE/STUN发现与signal协调，失败走relay；需NetBird客户端及托管或自托管management/signal/relay。 | 单纯overlay可承载系统sshd；但**NetBird SSH是独立内置SSH server**，默认关闭，启用后将SSH流接到client22022并使用JWT/OS-user映射，不等于同一个原生sshd。[官方SSH文档](https://docs.netbird.io/manage/peers/ssh)。 | **DEFER**。可作将来自托管SSO网络候选；新身份/客户端迁移暂无实证收益。新鲜功能多不等于符合“同sshd双路径”。 |
| **Nebula** | [v1.12.0，2026-10-29](https://github.com/slackhq/nebula/releases/tag/v1.12.0)，MIT；近期repo push。 | 基于Noise的互认证P2P网络，证书含IP/名称/组；lighthouse发现、UDP打洞、可选relay；需要Nebula客户端、自管CA、证书、lighthouse。[README](https://github.com/slackhq/nebula/blob/master/README.md)。 | 网络层，不需要接管SSH命令；但带来一套独立设备证书发行/撤销与防火墙策略。 | **DEFER**。对要求独立PKI、纯自托管网络的部署有意义；当前简单SSH目标不抵消CA/节点迁移成本。 |
| **ZeroTier** | [1.16.2，2026-05-28](https://github.com/zerotier/ZeroTierOne/releases/tag/1.16.2)；[root license](https://github.com/zerotier/ZeroTierOne/blob/dev/LICENSE.txt)区分MPL-2.0 agent与[nonfree controller条款](https://github.com/zerotier/ZeroTierOne/blob/dev/nonfree/LICENSE.md)，后者商业用途另需许可。 | [VL1 P2P+VL2虚拟以太网](https://docs.zerotier.com/protocol/)，endpoint agent、controller及root discovery；对L2/广播/多网络需求有价值。 | 可承载原生SSH；网络成员认证仍不是OS账户授权。L2能力是额外网络域，不是TCP22必需。 | **DEFER**。除非发现明确L2依赖；不为SSH把网络、controller许可和运维面一起换掉。 |

NetBird当前文档的native OpenSSH示例含`ssh -L`，同页limitations又写native client不支持port forwarding；这是一处文档冲突，**只可记录UNKNOWN，不能据此承诺等价性**。若将来实选，按精确客户端/server版本验证。该冲突没有必要阻塞当前未采用NetBird的工作。

### 5.3 较重的访问/远控系统

| 项目 | 当前可核维护/许可 | 部署与客户端 | 对命令会话的介入 | 当前裁决 |
|---|---|---|---|---|
| **Teleport** | repo未归档、近期push；GitHub latest endpoint选到[v18.10.0，2026-07-09](https://github.com/gravitational/teleport/releases/tag/v18.10.0)。源码AGPLv3；[CE二进制是有适用限制的商业许可](https://goteleport.com/docs/feature-matrix/)，不能拿源码许可代替发行物条款。 | Auth/Proxy等集群与CA，常用tsh/tctl及server组件；支持agentless OpenSSH。 | [官方agentless手册](https://goteleport.com/docs/enroll-resources/server-access/openssh/openssh-manual-install/)写明Proxy为记录/授权而终止客户端SSH，再向sshd建连接；并配置信任Teleport CA。**Agentless不等于透明TCP**。 | **DEFER**。未来确需集中证书、RBAC、会话记录时重新评估；现范围明确不做这些，导入会改变信任/数据路径。吸收证书和网络身份分层知识即可。 |
| **Boundary CE** | [官方弃用公告](https://discuss.hashicorp.com/t/deprecation-of-boundary-community-edition/77828)发布于2026-10-09；repo API archived=true；[README](https://github.com/hashicorp/boundary)记载归档日期为2026-10-08，并明确不计划CE发行/维护/漏洞修复/安全补丁。公告日与README归档日分别保留。末次latest为[v0.21.3，2026-04-30](https://github.com/hashicorp/boundary/releases/tag/v0.21.3)，[BSL1.1](https://github.com/hashicorp/boundary/blob/main/LICENSE)。 | controller权限/资源目录、workers session代理、客户端/集群；HCP/Enterprise不受CE弃用结论覆盖。 | 可代理TCP，但引入独立session授权与控制面；不是两个原生SSH别名的替代配置。 | **REJECT_NEW_CE_DEPENDENCY**。controller/worker职责分离仅作知识；不能建议新装已明确停止维护的CE。商业版是另一项产品决策。 |
| **MeshCentral** | [1.3.1，2026-10-23](https://github.com/Ylianst/MeshCentral/releases/tag/1.3.1)，Apache-2.0；repo未归档。 | [server+MeshAgent+web app](https://docs.meshcentral.com/design/)，终端/桌面/文件、可选IntelAMT；浏览器操作，但目标需其agent或对应硬件路径。 | MeshAgent参与执行和远控，独立设备/权限/会话管理；不只是向同sshd转发TCP。 | **DEFER_TO_SEPARATE_DESKTOP_RMM_NEED**。若将来真实要求浏览器桌面或AMT，再独立比较；当前导入会恢复刚删除的agent/control-plane责任。 |
| **RustDesk** | [client1.5.3，2026-11-09](https://github.com/rustdesk/rustdesk/releases/tag/1.5.3)；[OSS server1.1.16，2026-07-20](https://github.com/rustdesk/rustdesk-server/releases/tag/1.1.16)；两仓AGPLv3，Pro另算。 | RustDesk目标/操作者客户端；自托管hbbs rendezvous和hbbr relay。[官方OSS/Pro说明](https://rustdesk.com/docs/en/self-host/)区分基础signal/relay与Pro管理/SSO等。 | 桌面/输入/文件会话协议，不以系统sshd作为主要入口。 | **DEFER_TO_DESKTOP_NEED**。吸收signaling/relay分离与直连失败降级经验；不为shell任务附加远程桌面系统。 |


## 6. 收敛决策、知识吸收与现有工单映射

| 决策 | 本轮落点 | 承接与验收边界 |
| --- | --- | --- |
| `KEEP / REUSE_ARTIFACT` | cloudflared、tailscaled、OpenSSH、systemd；两路进入同一 sshd/root 公钥 profile | [#11 首次连接与验收](https://github.com/youling/ghostfleet/issues/11)：实际新建连接、同主机身份/账户、服务恢复、撤销与重连。配置存在和源代码测试不替代真实连接。 |
| `BUILD`，限小型验证器 | 完整 SSH 有效值、root 准入检查、公开发布扫描和必要的合成负测 | [PR #85](https://github.com/youling/ghostfleet/pull/85)：本轮候选落实，最终证据见 PR。验证器未实现的 OpenSSH pattern 应明确边界或拒绝作出自动通过结论，不复制一套认证引擎。 |
| `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` | 首次 host-key 核对、ControlPath 复用反例、会话/进程/命令恢复分层、版本化来源记录 | [#11](https://github.com/youling/ghostfleet/issues/11)：服务活着、隧道通、SSH 登录、OS 效果分别记录；不构造新的任务库或监控服务。 |
| `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` | SFTP/scp/rsync 的具体版本、断连与完整性、源/目标权限、云挂载与本地文件语义 | [#36 文件传输](https://github.com/youling/ghostfleet/issues/36)：保留标准工具需求，旧自建 transfer intent/receipt 实现不再扩展。仅 SSH 可登录不证明大文件、中断恢复、跨平台或云存储语义。 |
| `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` | 网络准入、用户公钥、host-key、agent forwarding 与凭据保管分层；新连接拒绝和既有会话终止分别验收 | [#64 拓扑与权限边界](https://github.com/youling/ghostfleet/issues/64)：由 CF Access、Tailscale 原生策略及 OpenSSH 密钥配置承接；禁止把“网络可达”当作授权或把边缘机自动变成横向管理源。 |
| `DEFER` | One Client 长连接方案、原生 SSH CA、Tailcat、frp/rathole/chisel/bore、自托管 overlay | 仅在已观察到客户端/网络/管理需求缺口时做小范围对照；不新增必须部署的第三入口。 |
| `DEFER` | Access for Infrastructure、Tailscale PAM、Teleport、MeshCentral、RustDesk | 需要明确独立的集中审计/证书/桌面需求时再评估。当前不导入另一个 session、身份或控制面。 |
| `REJECT`，限新依赖选择 | Boundary CE 新 runtime | 官方明确停止 CE 维护；知识可参考，商业版是另一项产品判断。 |
| `SUPERSEDED` | 旧自建 Node Agent、Helper、HumanGate/JIT、队列、SQLite/job/lease、命令过滤及平行审计 | 历史源码与研究保留在 Git；本报告不恢复这些产品职责。 |

### 可直接带走的失败经验

1. **鉴别通道和目标身份。** frp/rathole 的隧道凭据、overlay 成员身份不替代 SSH host-key 或 OS 公钥认证；“兼容 OpenSSH 客户端”也可能连接到另一种 server。证据见第 3、5 节的官方机制来源。
2. **验证真实拒绝行为。** `AuthenticationMethods` 空格分隔项是备选认证路径，不能仅取第一项；Allow/Deny 可能有重复项和 OpenSSH patterns。原生 effective config 是依据，验证器不能自称覆盖未实现语义。[sshd_config](https://man.openbsd.org/sshd_config)
3. **区分存活、可连接和可用。** frp/chisel 的重连、复用、half-close 修复可以变成现有通道的验收反例；没有必要为此新增自制 daemon。固定版本才能准确映射修复与行为。[frp v0.72.0](https://github.com/fatedier/frp/releases/tag/v0.72.0)、[chisel v1.12.0](https://github.com/jpillora/chisel/releases/tag/v1.12.0)
4. **撤销范围明确。** 改 policy、轮换隧道 token、撤销 SSH key 和结束已建立会话不是同一个动作。新连接与存量连接分开记录，不通过第二套命令审计库解决。[Cloudflare tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)
5. **重连不重放命令。** autossh 能重启本地 SSH 进程，不证明先前命令未执行；原会话断开后，操作者先确认远端状态。原生工具的正常退出也不能一律当故障。[autossh README](https://www.harding.motd.ca/autossh/README.txt)
6. **记录制品和许可范围。** main、dev、prerelease 与稳定发行物可能不同；源码许可不能替代 CE 二进制、商业功能或 controller 条款。第 5 节每项链接用于核对所选制品，不自动成为许可准入结论。

## 7. Open questions：下一步只补会改变决策的证据

| 尚缺证据 | 当前状态 | 最小后续与归属 |
| --- | --- | --- |
| 实际 CF/TS 两路使用同一 sshd、主机身份和 OS 账户 | `NOT_RUN` | #11 关闭连接复用，各建新连接，核对来源上下文和 host key；单路故障时验证另一入口的新连接。 |
| Service Auth 在选定 cloudflared/组织配置下无人值守完成 SSH | `NOT_RUN` | #11 / #64 验证有效 token、错误/禁用 token、错误应用；不得将 HTTP 成功当 SSH 握手成功。 |
| userspace `tailscale nc` 在受限 AI 环境的 daemon/socket、DNS 与网络出口可用性 | `DOCUMENTED_CAPABILITY / NOT_RUN` | #11 按实际运行环境做最小连接实验；不绕过平台出口限制，不启用另一 SSH server。 |
| 长会话、connector 更新、网络切换与进程重启的效果 | `NOT_RUN` | #11 分开记录新连接恢复和远端任务结果；如 WS 路线不足，再比较 One Client，而非先写自动路由器。 |
| 实际包的 OpenSSH 安全修补和跨平台文件行为 | `UNKNOWN` | #11/#36 按发行版包、构建条件、精确客户端/服务器版本查证；不只比较上游版本号。 |
| 原生策略的来源/目的地限制、撤销效果与横向凭据隔离 | `NOT_RUN` | #64 由实例 owner 给出正负例；不复制真实拓扑或凭据到公共仓。 |
| Tailcat allowlist、固定身份、地址轮换与出口/relay行为 | `DOCUMENTED_CAPABILITY / NOT_RUN` | 保留为隔离实验候选；只有明确需求才开启，不作为当前完成的依赖。 |
| 单段 Cloudflare Tunnel token 的可靠公开扫描形状 | `UNKNOWN` | 先取得上游编码/结构证据，再决定是否加入窄规则；不使用泛 base64 扫描制造误报。 |
| NetBird native client 的 forwarding 文档冲突 | `UNKNOWN` | 只有重新考虑该候选时才按精确版本验证，不阻塞当前路线。 |

这些问题不形成新的统一审批流程或“全测完才能写文档”的门槛。当前第一方向是完成现有 PR 的源码、文档及精确候选验证，再由原工单落实真实环境验收。没有测量吞吐、NAT 穿透率、恢复时间或资源占用；没有把上游自测当作用户网络结果。研究覆盖当前决策相关机制，不声称穷尽互联网。

## 8. English summary

**Keep Cloudflare and Tailscale as alternative network paths to the same native OpenSSH service.** The reference profile uses root public-key authentication. Network admission, SSH host identity, user authentication and OS authority remain distinct. This report adds no custom agent, command filtering/approval, execution queue, audit control plane, automatic command replay or third production path.

The project is `FORMING`. Reuse maintained upstream components behind the existing transport boundary, and reuse failure models and validation techniques without importing parallel identity or session systems. The historical report covered **42 upstream repositories, not 42 independent projects**. This pass revisited **18 distinct projects**: OpenSSH, cloudflared, Tailscale, systemd and Tailcat, plus 13 alternatives. Cloudflare modes are not separate projects; RustDesk client and server count together. The historical and current counts overlap and must not be added.

Key findings:

- **OpenSSH:** validate effective configuration with the actual connection context; preserve the full authentication-method value and repeated admission rules. Use one host-key alias per real machine and disable connection reuse when testing each route. The 10.6p2 release includes a musl/PAM-disabled security workaround; distribution backports require separate verification. The `scp -R` change is a deprecation warning from 10.6, not an already removed feature. [Release notes](https://www.openssh.org/releasenotes.html), [sshd_config](https://man.openbsd.org/sshd_config), [ssh_config](https://man.openbsd.org/ssh_config)
- **Cloudflare:** client-side `access ssh`, self-managed keys with One Client, Access for Infrastructure and browser-rendered SSH have different client, identity and session models. WebSocket SSH is not a promise of indefinite sessions; official guidance recommends Client-to-Tunnel for long-lived connections. Client-side cloudflared is still documented; do not label it deprecated without explicit evidence. [SSH routes](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/), [Protocols](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)
- **Service secrets:** the November 11 official detection pattern is `cfast_[A-Za-z0-9]{40}[a-f0-9]{8}`. A match indicates shape, not checksum or live validity. Apply a narrow publication rule; do not generalize it to every base64 string. New organizations also have strict Service Auth behavior that must be tested end to end. [Official secret-scanning change](https://developers.cloudflare.com/changelog/post/2026-11-11-leaked-service-token-recovery/), [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- **Tailscale:** use the network with native sshd; Tailscale SSH intercepts tailnet port 22 with its own server. A no-TUN environment can use ordinary OpenSSH with `ProxyCommand tailscale nc %h %p` or an explicitly configured SOCKS proxy, subject to daemon, identity, policy and egress availability. This is documented, not tested in the target environment. [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh), [Userspace networking](https://tailscale.com/docs/concepts/userspace-networking), [CLI nc](https://tailscale.com/docs/reference/tailscale-cli#nc)
- **Tailcat:** a promising rootless userspace experiment, with no account or tailnet control plane requirement. Its address is sensitive, hosted relay behavior has limits, and its built-in SSH/exec modes are not the current native-sshd boundary. Defer it as an isolated raw-port experiment, not a third required transport. [Announcement](https://tailscale.com/blog/tailcat), [Product and FAQ](https://tailscale.com/tailcat)
- **Alternatives:** none has demonstrated superior fit in the actual target environment. Keep lightweight tunnels and new overlays as conditional candidates; defer centralized access or desktop stacks until an independent requirement exists. Boundary CE is explicitly discontinued and is not a new runtime choice. Release status, source licenses and binary terms remain separate observations. [Boundary CE notice](https://discuss.hashicorp.com/t/deprecation-of-boundary-community-edition/77828)

This round reproduced three validator problem groups, implemented candidate fixes and ran local tests. **Candidate changes are in progress; final evidence belongs to [PR #85](https://github.com/youling/ghostfleet/pull/85).** This report intentionally freezes neither the final HEAD nor test counts, CI status or review outcome. It makes no real-node connectivity, deployment, performance or recovery claim.

Existing work remains the destination: [#11](https://github.com/youling/ghostfleet/issues/11) for native dual-path connection and recovery, [#36](https://github.com/youling/ghostfleet/issues/36) for standard SSH/SFTP/rsync compatibility, and [#64](https://github.com/youling/ghostfleet/issues/64) for native network policy and key-custody boundaries. No new product track follows from this research.
