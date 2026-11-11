# GhostFleet 外部机制复用侦察 / External mechanism reuse reconnaissance

```yaml
artifact_type: ARCHITECT_RECONNAISSANCE_REPORT
status: ARCHITECT_RECONCILED_RESEARCH_INPUT
as_of: 2026-11-12 Asia/Shanghai
source_baseline: 60f441f235b14e1334b672066d71e4200bd96a59
project_stage: FORMING
reuse_mode: COMPONENTS_BEHIND_EXISTING_SEAMS_AND_KNOWLEDGE_FOR_STABLE_CORE
external_current_state: DOCUMENTED_CAPABILITIES_WITH_MAINTENANCE_AND_LICENSE_DELTAS
reuse_candidates: SEE_LANDSCAPE_AND_DECISIONS
external_wheel_admission: not_applicable
dependency_admission: NONE_PERFORMED
architecture_delta: PRESERVE_STABLE_CORE_REFINE_EXISTING_SEAMS_AND_COUNTEREXAMPLES
decisions: [KEEP, REUSE_ARTIFACT, ADAPT_BEHIND_SEAM, REUSE_KNOWLEDGE_NATIVE_IMPLEMENT, DEFER]
candidate_tests: NOT_RUN
scope: MANAGEMENT_IDENTITY_EXECUTION_TRANSPORT_ARTIFACTS_RECOVERY
parallel_track_risk: SECOND_IDENTITY_AUTHORITY_LIFECYCLE_OR_STATE_OWNER
do_not_build: SECOND_IDENTITY_AUTHORITY_LIFECYCLE_OR_JOB_STORE
open_questions: SEE_UNKNOWN_AND_TARGETED_FOLLOW_UP
targeted_research_needed: CONSUMER_SPECIFIC_RUNTIME_VALIDATION_ONLY
first_architecture_direction: RESOLVE_EXISTING_BOOTSTRAP_ACCOUNT_ARTIFACT_BLOCKERS
```

## 中文

<!-- topic:methods -->

### 1. 方法、证据与判断边界

架构师已接受本报告的现状对齐、保留边界和知识复用方向。具体组件仍是候选，反例仍是待选测试输入；是否采用由原工单按实际 consumer 需要评估。

本报告为根架构师提供路线取舍输入；外部实现、研究结论和候选测试均不授予执行、合并、设备或依赖准入权限。研究以 [ai-use 架构侦察规程](https://github.com/youling/ai-use/blob/main/docs/ARCHITECT_RECONNAISSANCE.md) 和 [本轮 dispatch](https://github.com/youling/ghostfleet/issues/3#issuecomment-6809330694) 为边界。GhostFleet 整体处于 `FORMING`；已形成的 identity、authority、lifecycle 与 core evidence 边界，仍以知识复用为主。优先吸收不同机制和失败经验，不以产品数、仓库数或 stars 代替适配判断。

**覆盖口径：** 管理面 14 个项目、15 个上游仓库，Headwind 的旧、新后台合计一个项目；传输与云存储面 27 个仓库，按 11 组机制深入比较。两份候选目录没有重复仓库，合计 **42 个主要上游仓库**，不能称作 42 个独立项目：同一生态的控制器/agent、两种 TUF 实现、配合使用的 rsync/OpenSSH 都已分组。MCP 是现有依赖复核，额外规范/文档仓库仅作来源，不计入候选总数。研究覆盖能改变当前取舍的主要机制，没有宣称可证明地穷尽互联网。

全文区分三类证据：**事实**是官方文档、上游仓库或本地基线明确记录的内容；**推断**是这些机制与 GhostFleet seam 的适配判断；**UNKNOWN** 是尚未实测或材料不足。文档声称支持只算 `DOCUMENTED_CAPABILITY`。维护状态按本轮证据窗口读取：仓库未归档、近期有 push 不等于持续发行或安全维护承诺。许可按源码目录、API、发行二进制及商业功能分别记录；未复制上游实现代码。

本地对齐 [main 基线](https://github.com/youling/ghostfleet/tree/60f441f235b14e1334b672066d71e4200bd96a59)。当前公共默认 MCP 的四个只读工具、core admission 与 consumer acceptance 的区分仍有效。**#79/#80 本轮审查存在 blocker；本报告不宣称其已合并或完整可用。** 本轮未安装候选、未做设备试验、未接受新依赖；所有下述反例均为 **NOT_RUN**。也未产生新设备目录、任务数据库或审批链。

<!-- topic:landscape -->

### 2. 候选地图

以下“建议”均为研究推断，最终选择由根架构师收敛。全量产品引入通常会同时带入另一套身份、策略、任务与生命周期；成熟度不能自动消除这种冲突。

#### 2.1 管理、身份与执行：14 个项目

| 项目 | 已确认的机制 | 交付物许可与维护要点 | 建议 |
| --- | --- | --- | --- |
| FleetDM | GitOps 的资源所有权例外明确区分 UI 与 YAML writer；策略脚本有触发、重试和连续自动化语义。[M01] | 通常代码 MIT；`ee/` 独立许可，文档 CC BY-SA 4.0。[L01] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`：单 writer、版本化计划；全后台 `DEFER`。 |
| osquery | 远程 enrollment/node key 与查询、差分/快照分开。[M02] | Apache-2.0 OR GPL-2.0-only。[L02] | `ADAPT_BEHIND_SEAM` 候选：只读 inventory/evidence，core 继续持有身份与准入。 |
| MeshCentral | agent 出站控制与远控数据会话分开；agent 信任不包含管理其他 agent 的权限。[M03] | Apache-2.0。[L03] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`；完整远控平台仅作为将来独立 provider 候选。 |
| Tactical RMM | client/site 权限与全局 reporting 边界并不相同；server terminal/script 继承安装账户能力。[M04] | 自定义 source-available 许可，明确非开源；EE 另计。[L04] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`：权限旁路和结果可见性；代码/runtime `DEFER`。 |
| RustDesk | rendezvous/signaling 与 relay 分责；集中管理及身份集成有 OSS/Pro 边界。[M05] | 已核对客户端 AGPL-3.0；OSS server、Pro 不能混为同一交付物。[L05] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`；未来桌面 provider 可另作 seam 评估。 |
| Teleport | 短期身份、Auth/Proxy/target 分责；请求访问与实际授予范围分开。[M06] | 源码 AGPL-3.0、`api/` Apache-2.0、官方 CE build 为 modified Apache；完整 JIT 有 Enterprise 边界。[L06] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`，映射既有 HumanGate/lease，不引入另一审批体系。 |
| Boundary | controller 管权限，worker 承载 session；worker 注册不同于 session 授权。[M07] | BSL 1.1；**CE 已归档并停止开发**，官方未计划继续 CE 维护/修补。HCP/Enterprise 不属此结论。[M08,L07] | 机制 `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`；归档 CE 不作为新 runtime 候选。 |
| SPIFFE/SPIRE | node 与 workload attestation 分层；进程身份以 OS/调度器证据校验。[M09] | Apache-2.0。[L08] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`；新增 SPIRE daemon `DEFER`。 |
| step-ca | 签发、续期、吊销与 provisioner 能力分别表达；续期包含 jitter。[M10] | Apache-2.0。[L09] | 将来确有 CA 需求时 `ADAPT_BEHIND_SEAM`；现在复用失败模型。 |
| AWX | Execution Environment 与 job/credential 隔离；执行环境不等于宿主授权。[M11] | Apache-2.0；**发行因重构暂停，官方 README 记上次发行 2024-07-02**，近期源码推送不能改写这一事实。[M12,L10] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`；完整 AWX `DEFER`，窄 executor 可另评估。 |
| Salt | job ID、结果和可清理的 job cache 分离；`cmd.run` 非天然幂等。[M13] | Apache-2.0。[L11] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`：probe/apply/reconcile；完整 master/minion `DEFER`。 |
| Rudder | Audit 报告偏差，Enforce 才修复。[M14] | 主组件 GPLv3 与 linking exception。[L12] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`，保留观察与 effect 的权限边界。 |
| Cockpit | 管理能力来自真实 OS 用户和 sudo/Polkit，UI 显示提权状态。[M15] | LGPL-2.1+。[L13] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`：两层 OS 体验；不照搬记忆提权为 AI 自动 ADMIN。 |
| Headwind MDM | 普通 application mode 与 DPC provisioning 不同；QR 路线要求新机/恢复出厂。[M16] | 旧、新 v7 server 均 Apache-2.0；两仓归为一个项目。[L14] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`：平台能力分档；完整 MDM `DEFER`。 |

除 Boundary 外，上述核验仓库在证据窗口均未归档；这是仓库状态，不是支持承诺。具体 API 适配、目标平台成本、离线行为与发行物许可兼容性仍为 **UNKNOWN**。

#### 2.2 传输与分发

| 机制组 / 仓库数 | 候选及已确认差异 | 许可与适配建议 |
| --- | --- | --- |
| Overlay 路径 / 4 | **Tailscale、Headscale、NetBird、Netmaker**。Tailscale 已有 direct、peer-relay、DERP；Headscale 聚焦自托管单 tailnet；NetBird 将 NAT/relay 与独立指标分开；Netmaker 统一 gateway 角色。[T01] | Tailscale/Headscale BSD-3-Clause；NetBird 根 BSD，但 management/signal/relay/combined 为 AGPLv3；Netmaker `pro/` 外 Apache-2.0。既有 provider `KEEP`，观测可适配；新控制面 `DEFER`。[R01] |
| 发现、转发、成员 / 2 | **Nebula、ZeroTier**。发现、relay 与网络授权分别有 owner；网络成员身份不等于 fleet actor/action 授权。[T02] | Nebula MIT；ZeroTier agent MPL-2.0，nonfree controller 等有商业使用限制。知识复用，新 overlay/PKI `DEFER`。[R02] |
| 资源与方向性授权 / 4 | **Pangolin、Newt、OpenZiti、zrok**。Pangolin public raw TCP/UDP 不承接相同 HTTP 登录规则；Newt 向 Pangolin CLI 过渡，旧部署继续工作；OpenZiti Dial/Bind 分权；zrok 区分公开/私有及临时/保留分享。[T03] | Pangolin 默认 AGPL、商业标头文件例外；Newt AGPL/商业双许可；OpenZiti/zrok Apache-2.0。知识复用，整栈及新 Newt 依赖 `DEFER`；不是本轮迁移命令。[R03] |
| 出站隧道与冗余 / 3 | **cloudflared、frp、rathole**。Cloudflare 多 connector 增强连接可用性，Access 是另一层；frp STCP/XTCP 与 rathole service token 有不同连接合同。[T04] | 三个客户端/服务仓均 Apache-2.0，不代表托管服务条款。既有 cloudflared adapter `KEEP`；替代隧道 `DEFER`。[R04] |
| 一次受控文件交付 / 2 | **rsync、OpenSSH portable**。认证通道、受限 receiver、字节传输、独立验证及 no-replace 发布不能合并成一个“复制成功”。rrsync 参数/启动 shell 约束已被 #67 覆盖。[T05,G03] | rsync GPLv3 系列及附加链接条款；OpenSSH 按组成文件采用 BSD/宽松条款。底层 `REUSE_ARTIFACT`，receiver `ADAPT_BEHIND_SEAM`，#67 `KEEP`。[R05] |
| 临时交接与持续同步 / 3 | **croc、Magic Wormhole、Syncthing**。前两者用临时凭据/PAKE；Wormhole 控制与 bulk 通道分开；Syncthing 用索引、扫描和 block hash，持续同步不等于不可变发布或完整备份。[T06] | croc/Wormhole MIT，Syncthing MPL-2.0。扫描与校验知识复用；短码替代 fleet 身份、持续同步状态库 `DEFER`。[R06] |
| 发布信任与逐设备目标 / 3 | **python-tuf、tuf-js、Uptane standard**。TUF 验证签名 metadata、版本、过期与信任轮换；Uptane 区分合法发布物与特定设备目标。[T07] | python-tuf Apache-2.0 OR MIT、当前 Python≥3.11；tuf-js MIT，Worker/Node 适配 UNKNOWN；Uptane 为规范许可，非代码许可。验证库 `ADAPT_BEHIND_SEAM` 候选，不新建发布控制面。[R07] |
| 安装、健康与 commit / 2 | **Mender、RAUC**。安装、重启、验证、commit/rollback 与 mark-good 有独立条件，不能承诺任意副作用原子回滚。[T08] | Mender client Apache-2.0（文件例外另计），新 Orchestrator 为 Enterprise；RAUC LGPL-2.1 系列。恢复模式知识复用，完整 OTA/rootfs 迁移 `DEFER`。[R08] |
| 排队目标与 actual / 1 | **balena meta-balena**。OS、supervisor 与应用有各自升级边界；排队 desired release 不会改写已运行 actual。[T09] | layer 含 Apache-2.0，整个 OS 汇集多种 package 许可。知识复用，全 OS/agent 替换 `DEFER`。[R09] |
| 应用部署差异与回滚 / 2 | **Komodo、Coolify**。资源 diff/preview 与过程编排可借鉴；Coolify 回退旧 image 仍用当前 runtime config，不等于数据/配置整体回退。[T10] | Komodo GPL-3.0 系列；Coolify Apache-2.0。知识复用，完整 PaaS/lifecycle owner `DEFER`。[R10] |
| 云对象传输与挂载 / 1 | **rclone**。VFS 缓存关闭文件后可延迟上传；S3 ETag 不能统一视为 SHA256；`copy` 可更新同名对象，`sync` 还可删除目的端额外对象。[T11] | MIT；`ADAPT_BEHIND_SEAM` 云适配候选。保持本地 POSIX landing 与云发布分别验收，不把 mount 直接当已验证的 #67 接收端。[R11] |

这 27 仓在窗口内均未归档，但所选版本、二进制来源、安全状态与实际环境仍须分别验证。三项容易过时的判断须明确保留：**Tailscale peer relay 是现有上游能力；Newt→Pangolin CLI 是当前维护方向；rrsync 限制是 #67 已处理的边界**，均不能被扩写成新依赖准入或本轮设备迁移。

#### 2.3 现有 MCP 债复核

[基线 package.json](https://github.com/youling/ghostfleet/blob/60f441f235b14e1334b672066d71e4200bd96a59/package.json) 将 `@modelcontextprotocol/sdk` 固定为 `1.32.0`。官方 TypeScript SDK 已将 v2 列为稳定线，支持 2026-07-28 协议；迁移文档仍提供 legacy 路径及 `legacy: 'stateless'` 兼容，同时说明无会话 legacy HTTP 不能承载需要服务端反向请求的交互。[P01,P02] 因此“v2 未稳定”的旧印象需要更新，但“上游稳定”不等于本项目已经迁移或每个客户端都兼容。这是 **10/5 已有债的证据更新**；本轮没有新升级要求，没有新增批准链，也没有接受新依赖。

<!-- topic:lessons -->

### 3. 十个机制与最小反例

**本节是待选验证输入，所有测试状态均为 `NOT_RUN`，没有通过结论。** 外部事实与本地建议分别标明；每项只保留能改变当前设计判断的最小反例。

1. **稳定身份与证明分层。** 事实：MeshCentral 使用 agent 公钥摘要识别 agent；SPIRE 区分节点与进程证明。[M03,M09] 推断：GhostFleet 保留 `node_uid`，地址、传输账户、credential 可变化；不能让外部平台 ID 接管 core。反例：同 UID 换地址后仍为同节点；两机克隆同一 credential 同时报到时，不能静默互相覆盖。落点：#11/#79。

2. **OS 账户隔离必须证明实际可达能力。** 事实：Cockpit 基于 OS 权限，Tactical 文档暴露安装账户带来的文件与 sudo 能力。[M04,M15] 推断：runtime/ops 分离需覆盖 sudoers、组、socket、文件所有权、旧 Helper 和凭据；配置声明不足以证明隔离。反例：普通 runtime 直调旧 Helper 或借共享 socket 不得升权；既有批准后的 ADMIN 正常完成授权动作。回滚只撤销本次创建项。落点：#11/#63/#69/#79，且 #79 仍有 blocker。

3. **观测完整性不同于空结果。** 事实：osquery 区分差分和快照，Rudder 分 Audit/Enforce。[M02,M14] 推断：adapter 必须表达 source、时间、身份、完整性；core-owned admission 不能靠 observer 自报。反例：首次无基线、截断、平台不支持均不能变成空集/PASS；Audit 发现偏差不调用修复。落点：现有 evidence/consumer acceptance、#78 候选。

4. **单 writer、明确 revision 与不明结果的 reconcile。** 事实：Fleet 管 writer ownership/触发，Salt cache 会清理且任意命令不保证幂等；balena 区分排队目标与运行状态。[M01,M13,T09] 推断：不要照搬 YAML 缺项即删除；超时先区分 effect 失败与 receipt 丢失；resolve/pin 一次后不能偷偷追 latest。反例：目标完成、回执丢失时不二次执行；cache 清理无证据则 UNKNOWN；离线期间 channel B→C，原 pin B 的 operation 不自行换 C，过期 ADMIN 不补执行。落点：#78 及现有 intent/receipt。

5. **scope 覆盖所有读写、协议和产物出口。** 事实：Tactical reporting 可为全局；Pangolin raw TCP/UDP 与 HTTP 登录规则不同；OpenZiti 区分 Dial/Bind。[M04,T03] 推断：target/origin 边界须贯穿 list/detail/status/report/download/relay，按具体 resource/protocol 验证。反例：可读 A 的主体猜 B 的 ID，任何出口均不泄露 B；同站 HTTP 已认证，raw TCP 不继承该结论；managed-only/仅 Bind 不能因此主动控制 peer。落点：#64/#36。

6. **控制、数据与路径选择分开。** 事实：Boundary/RustDesk 区分控制与数据职责；Tailscale 路径可变；Cloudflare connector 冗余与应用 Access 不同层。[M05,M07,T01,T04] 推断：#36 保留 provider 原始路径、时间和证据，不能把三种 Tailscale 路径扩成核心权限枚举；自动评分/切换仍 HOLD。反例：DERP→peer-relay→direct 不改 target/lease/deadline；外部 effect 已发送、换 connector 后仍是同一 operation，`MAY_HAVE_EXECUTED/UNKNOWN` 先 reconcile，不重派。落点：#36。[G02]

7. **受限传输不等于任意文件系统权限。** 事实：rrsync 对 `-no-overwrite` 与 partial-dir/delay-updates、protect-args 和 shell 启动有明确约束；Syncthing 的 watcher 仍配合扫描。[T05,T06] 推断：#67 已有受限 profile、私有 staging、独立完整 manifest/SHA256、可信 receiver 与原子 no-replace，应保持；不把 rsync exit 0 当发布证明。反例：验证后有人抢建目的树，发布须拒绝替换；父目录被换成 symlink/reparse 不越界；发布成功但 receipt 丢失先对账。同一限制不再开返修，真实 receiver/断电矩阵仍待原 workstream。落点：#67。[G03]

   云适配补充：rclone 的 `--checksum` 在没有可用 hash 时可以退化为大小比较；VFS close 也不证明上传完成。故本地 manifest SHA256、云端独立回读与 receipt 仍须分开。最小反例为“close 后尚未上传即断电”和“目的端已有同名或额外对象”；两项均 `NOT_RUN`，不扩大为清理或覆盖授权。[T11]

8. **credential 生命周期覆盖离线与撤销。** 事实：step-ca 续期能力依 provisioner 而异，过期续期是显式选择；持旧私钥可能续期，吊销有独立意义。[M10] 推断：稳定 UID 不随证书 TTL 变化；混合设备不能照抄云服务的在线假设或固定 24h。反例：撤销凭据不能靠旧 renewal receipt 延权；过期离线设备恢复进入明确 recovery；批量重连不绕过授权期限。落点：现有 identity/enrollment seam。

9. **平台能力来自 probe，provisioning 另有 effect。** 事实：Headwind 区分 ordinary app 与需新机/恢复出厂的 DPC 路线。[M16] 推断：Android/NAS/桌面支持均须按实际能力表达；“纳管”不能隐含 reset、root 或安装特权。反例：普通 app 授权不触发清空设备，也不伪报 device-owner；升级后旧 capability receipt 不能替代当前 probe。落点：#11/#80 平台交付，#80 仍有 blocker。

10. **发布真实性、设备授权与完成验收分层。** 事实：TUF 保护 metadata 的信任/新鲜性，Uptane 区分发布物与逐设备目标；RAUC mark-good、Mender commit 和 Coolify 回滚有不同边界。[T07,T08,T10] 推断：#78 已有 manifest/digest/独立签名 trust root、精确兼容 tuple 与 checkpoint；不能误写为“当前没有签名”。未来可把成熟 verifier 放在 artifact seam 后，安装/启动/consumer accepted 分开。反例：合法旧签名重放拒绝，但新获准高 generation 指向旧 digest 不应被一概禁止；agent 活着但 consumer 不兼容不得完成；外部注册成功后 checkpoint 前断电，恢复同 operation；旧 image 配当前坏 schema 不报整体恢复。保持 #78 原 24 个 VE case 的 `NOT_RUN` 与编号，不另造一套。[G04]

<!-- topic:decisions -->

### 4. 建议取舍与现有 Work 落点

| 建议 | 原因与边界 | 现有承接 |
| --- | --- | --- |
| `KEEP` | NodeIdentity、EnrollmentAttempt、HumanGate、Evidence、core admission/consumer acceptance 持续唯一；不能因发现产品就分叉 lifecycle/authority。 | 现有公共 contract 与架构基线。 |
| `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` | 将上节机制映射到现有 seam；这是 FORMING 项目中已稳定核心的默认。 | #11、#63/#69、#64、#36、#78 候选；不是批量新派单。 |
| `REUSE_ARTIFACT` | rsync/OpenSSH 属既有传输方向；密码学/PAKE/差量算法优先成熟实现，不自行重写。 | #67 合同 `KEEP`，运行能力按原接收端矩阵验证；这不是本轮新依赖批准。 |
| `ADAPT_BEHIND_SEAM` 候选 | osquery observer、TUF verifier、必要时 CA/executor/desktop provider；不得带入第二目录、权限中心或任务状态机。 | #36 adapter 观测、#67 receiver、#78 artifact；未来组件仅在真实 consumer 需要时收敛，本轮未准入。 |
| `DEFER` | 全套 RMM/MDM/AWX/Salt/新 overlay 控制面；成本和迁移收益未证明。归档 Boundary CE 不作新 runtime 引入。 | 无新增安装、替换或强制前置。 |

**当前优先方向**是完成现有 bootstrap/账户/资产交付的 blocker 修正与各自验收，再吸收能减少现有失败模式的窄 delta。#79/#80 不借本报告取得合并或运行通过结论。#78 的版本化 reconcile 研究仍是候选。#67 已覆盖 rrsync 限制的既有修正，不能因本报告再开同一返修。

**UNKNOWN 与定点后续研究：** 实际 API/平台成本、NAT/吞吐、Cloudflare Access/replica 配置、receiver ACL/no-replace/断电及 native Windows sshd、TUF runtime/root 分发/离线 expiry、Mender entitlement、NAS 分区适用性、二进制供应链与完整许可均未实测。MCP 未来验证须覆盖当前客户端、modern 与 legacy/stateless，而不能把认证失败当降级放权理由。只有具体 consumer 差异会改变选择时才做定点验证；无需新建搜索数据库、固定扫描周期或每产品一工单。

<!-- topic:sources -->

### 5. 来源

两种语言共同使用文末 [Sources](#sources)。所有机制来源为官方文档或上游仓库；版本化页面只证明所引机制，不代表当前最新版。公共链接不包含真实实例 locator、设备名或凭据。候选测试仍为 `NOT_RUN`。

## English

<!-- topic:methods -->

### 1. Method, evidence, and decision boundaries

The architect has accepted the current-state alignment, retained boundaries, and knowledge-reuse direction. Components remain candidates and counterexamples remain proposed test inputs; original work items evaluate adoption against a concrete consumer need.

This report is input to the root architect’s reconciliation. External implementations, findings, and proposed tests do not grant execution, merge, device, or dependency-admission authority. Its scope follows the [ai-use reconnaissance procedure](https://github.com/youling/ai-use/blob/main/docs/ARCHITECT_RECONNAISSANCE.md) and [this dispatch](https://github.com/youling/ghostfleet/issues/3#issuecomment-6809330694). GhostFleet is `FORMING`; its established identity, authority, lifecycle, and core-evidence boundaries still favor knowledge reuse. Distinct mechanisms and failure models drive coverage, rather than product counts, repository counts, or stars.

**Coverage:** management comprises 14 projects represented by 15 repositories, with Headwind’s old and new servers counted as one project. Transport and cloud storage comprise 27 repositories compared in 11 mechanism groups. The two candidate inventories have no duplicate repositories: **42 primary upstream repositories** in total, not 42 independent projects. Controller/agent pairs, the two TUF implementations, and complementary rsync/OpenSSH components are grouped. MCP is an existing-dependency review; additional specification/documentation repositories are sources, not extra candidates. Coverage follows mechanisms that could affect the decision, without claiming provable Internet-wide exhaustiveness.

The report distinguishes **facts** documented by upstream or the local baseline, **inferences** about fit behind GhostFleet seams, and **UNKNOWN** matters not tested or sufficiently evidenced. Documented support is only `DOCUMENTED_CAPABILITY`. Maintenance was checked within this evidence window; recent pushes and an unarchived repository do not establish continuous releases or a security-support commitment. Licenses are considered separately for source paths, APIs, released binaries, and commercial capabilities. No upstream implementation code was copied.

Local alignment uses [main baseline](https://github.com/youling/ghostfleet/tree/60f441f235b14e1334b672066d71e4200bd96a59). The four default read-only MCP tools and the distinction between core admission and consumer acceptance remain intact. **#79/#80 have review blockers in this tranche; this report does not claim either is merged or fully usable.** No candidate was installed, no device test was performed, and no new dependency was admitted. Every proposed counterexample below is **NOT_RUN**. No second device directory, job database, or approval chain was created.

<!-- topic:landscape -->

### 2. Candidate landscape

Recommendations are research inferences for the root architect to reconcile. Importing an entire product usually also imports identity, policy, jobs, and lifecycle. Upstream maturity does not eliminate those conflicts.

#### 2.1 Management, identity, and execution: 14 projects

| Project | Confirmed mechanism | Deliverable license and maintenance qualification | Recommendation |
| --- | --- | --- | --- |
| FleetDM | GitOps resource exceptions establish UI/YAML writer ownership; policy scripts define triggers, retries, and continuous automation.[M01] | Ordinary source is MIT; `ee/` has separate terms and docs use CC BY-SA 4.0.[L01] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` for writer ownership and versioned plans; `DEFER` the full backend. |
| osquery | Remote enrollment/node keys are distinct from queries and differential/snapshot outputs.[M02] | Apache-2.0 OR GPL-2.0-only.[L02] | `ADAPT_BEHIND_SEAM` candidate for read-only inventory/evidence; core retains identity and admission. |
| MeshCentral | Outbound agent control and remote-session data are separated; agent trust grants no peer-management authority.[M03] | Apache-2.0.[L03] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`; a full remote-desktop service is only a possible future provider. |
| Tactical RMM | Client/site scopes differ from global reporting; server terminals/scripts inherit the installer account’s powers.[M04] | Custom source-available terms explicitly are not an open-source license; EE is separate.[L04] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` for bypass and result-visibility lessons; `DEFER` code/runtime import. |
| RustDesk | Rendezvous/signaling and relay have separate roles; centralized management and identity integrations have OSS/Pro boundaries.[M05] | Verified client license: AGPL-3.0. OSS server and Pro are separate deliverables.[L05] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`; a future desktop provider requires its own seam assessment. |
| Teleport | Short-lived identities and Auth/Proxy/target separation; an access request is distinct from granted scope.[M06] | Source AGPL-3.0, `api/` Apache-2.0, official CE builds modified Apache; full JIT has Enterprise boundaries.[L06] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` within existing HumanGate/leases, without a second approval system. |
| Boundary | Controllers own authorization; workers carry sessions. Worker registration differs from session authorization.[M07] | BSL 1.1. **CE is archived and development ended**; further CE maintenance/patches are not planned. This does not describe HCP/Enterprise.[M08,L07] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`; do not introduce archived CE as a new runtime. |
| SPIFFE/SPIRE | Node and workload attestation are separate; workload identity is checked against OS/orchestrator evidence.[M09] | Apache-2.0.[L08] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`; `DEFER` a new SPIRE daemon. |
| step-ca | Issuance, renewal, revocation, and provisioner powers differ; renewal uses jitter.[M10] | Apache-2.0.[L09] | Future `ADAPT_BEHIND_SEAM` if a real CA need emerges; reuse failure models now. |
| AWX | Execution Environments and job/credential isolation; an execution image is not host authorization.[M11] | Apache-2.0. **Releases are paused for refactoring; the official README dates the last release to 2024-07-02.** Recent source pushes do not change that.[M12,L10] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT`; `DEFER` full AWX. A narrow executor may be assessed separately. |
| Salt | Job IDs, results, and a prunable job cache are distinct; `cmd.run` is not inherently idempotent.[M13] | Apache-2.0.[L11] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` for probe/apply/reconcile; `DEFER` a full master/minion system. |
| Rudder | Audit reports drift; Enforce applies repairs.[M14] | Main components: GPLv3 with a linking exception.[L12] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` while retaining the observation/effect authority boundary. |
| Cockpit | Real OS users and sudo/Polkit provide authority; the UI exposes privilege state.[M15] | LGPL-2.1+.[L13] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` for two-level OS UX; remembered elevation must not become automatic AI ADMIN. |
| Headwind MDM | Ordinary application mode differs from DPC provisioning; the QR route needs a new/factory-reset device.[M16] | Both old and v7 servers are Apache-2.0; together they count as one project.[L14] | `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` for capability tiers; `DEFER` the complete MDM. |

Except Boundary, all checked repositories above were unarchived within the evidence window. This is repository status, not a support promise. API fit, target-platform cost, offline behavior, and distribution-license compatibility remain **UNKNOWN**.

#### 2.2 Transport and distribution

| Mechanism group / repositories | Candidates and confirmed distinctions | License and fit recommendation |
| --- | --- | --- |
| Overlay paths / 4 | **Tailscale, Headscale, NetBird, Netmaker**. Tailscale has direct, peer-relay, and DERP paths. Headscale targets self-hosted single-tailnet use. NetBird separates NAT/relay behavior and relay metrics. Netmaker consolidates gateway roles.[T01] | Tailscale/Headscale BSD-3-Clause; NetBird root BSD with AGPLv3 management/signal/relay/combined; Netmaker Apache-2.0 outside `pro/`. `KEEP` existing providers and adapt observations; `DEFER` a new control plane.[R01] |
| Discovery, relay, membership / 2 | **Nebula, ZeroTier**. Discovery, relay, and network membership authorization have separate owners. Membership is not fleet actor/action authority.[T02] | Nebula MIT. ZeroTier agent MPL-2.0; nonfree controller components restrict commercial use. Reuse knowledge; `DEFER` new overlay/PKI.[R02] |
| Resource and directional authority / 4 | **Pangolin, Newt, OpenZiti, zrok**. Public raw TCP/UDP does not inherit Pangolin HTTP login rules. Newt is moving toward Pangolin CLI; existing deployments continue. OpenZiti separates Dial/Bind. zrok distinguishes public/private and temporary/reserved shares.[T03] | Pangolin defaults to AGPL with commercial-header exceptions; Newt AGPL/commercial terms; OpenZiti/zrok Apache-2.0. Reuse knowledge; `DEFER` whole stacks and new Newt dependencies. This is not a migration instruction.[R03] |
| Outbound tunnels and redundancy / 3 | **cloudflared, frp, rathole**. Cloudflare connector replicas improve connection availability; Access is separate. frp STCP/XTCP and rathole service tokens represent different connection contracts.[T04] | All three repositories Apache-2.0, not a statement about hosted services. `KEEP` the existing cloudflared adapter; `DEFER` alternatives.[R04] |
| One authorized file delivery / 2 | **rsync, OpenSSH portable**. Authenticated channels, restricted receivers, byte transfer, independent verification, and no-replace publication are separate proofs. #67 already covers rrsync parameter/startup-shell constraints.[T05,G03] | rsync GPLv3 family plus linking permissions; OpenSSH has component-specific BSD/permissive terms. `REUSE_ARTIFACT` beneath the seam, adapt the receiver, and `KEEP` #67.[R05] |
| Temporary handoff and continuous sync / 3 | **croc, Magic Wormhole, Syncthing**. Temporary credentials/PAKE support handoff; Wormhole separates control from bulk transit. Syncthing uses indexes, scans, and block hashes; synchronization is neither immutable release delivery nor a complete backup.[T06] | croc/Wormhole MIT; Syncthing MPL-2.0. Reuse scan/integrity knowledge; `DEFER` short-code fleet identity and another continuous-sync state owner.[R06] |
| Release trust and device targeting / 3 | **python-tuf, tuf-js, Uptane standard**. TUF validates signed metadata, versions, expiry, and trust rotation; Uptane distinguishes legitimate images from per-device targets.[T07] | python-tuf Apache-2.0 OR MIT, currently Python≥3.11; tuf-js MIT with Worker/Node fit UNKNOWN; Uptane’s specification license is not a code license. Verifiers are `ADAPT_BEHIND_SEAM` candidates, not a new release control plane.[R07] |
| Installation, health, commit / 2 | **Mender, RAUC**. Install, reboot, verify, commit/rollback, and mark-good have separate conditions; arbitrary effects cannot be promised atomic rollback.[T08] | Mender client Apache-2.0 subject to file exceptions; new Orchestrator Enterprise. RAUC LGPL-2.1 family. Reuse recovery patterns; `DEFER` full OTA/rootfs migration.[R08] |
| Queued target versus actual / 1 | **balena meta-balena**. OS, supervisor, and applications have separate update boundaries; queued desired release does not rewrite running actual state.[T09] | The layer includes Apache-2.0; the complete OS aggregates many package licenses. Reuse knowledge; `DEFER` OS/agent replacement.[R09] |
| Application diff and rollback / 2 | **Komodo, Coolify**. Resource diffs/previews and procedures are useful patterns. Coolify rolls back the image while retaining current runtime configuration, not all configuration/data.[T10] | Komodo GPL-3.0 family; Coolify Apache-2.0. Reuse knowledge; `DEFER` a full PaaS/lifecycle owner.[R10] |
| Cloud objects and mounts / 1 | **rclone**. VFS writeback may continue after close. S3 ETags are not universally SHA256; `copy` can update same-name objects and `sync` can also delete extra destination objects.[T11] | MIT; `ADAPT_BEHIND_SEAM` cloud-adapter candidate. Accept local POSIX landing and cloud publication separately; a mount is not a proven #67 receiver.[R11] |

All 27 repositories were unarchived in the observation window. Chosen versions, binary provenance, security, and local fit still require separate evidence. Preserve three current qualifications: **Tailscale peer relay already exists upstream; Newt→Pangolin CLI is the current maintenance direction; #67 already addresses the rrsync restrictions**. None constitutes new dependency admission or device-migration authority.

#### 2.3 Existing MCP debt revalidation

The [baseline package.json](https://github.com/youling/ghostfleet/blob/60f441f235b14e1334b672066d71e4200bd96a59/package.json) pins `@modelcontextprotocol/sdk` to `1.32.0`. Upstream now identifies v2 as stable with protocol 2026-07-28 support. Its migration guidance retains legacy hosting and `legacy: 'stateless'`, while explaining that stateless legacy HTTP cannot support interactions requiring server-to-client requests.[P01,P02] An old assumption that v2 is unstable therefore needs correction; upstream stability proves neither a local migration nor every client’s compatibility. This is an **evidence update to existing October 5 debt**. It adds no upgrade requirement, approval chain, or admitted dependency in this tranche.

<!-- topic:lessons -->

### 3. Ten mechanisms and minimal counterexamples

**These are candidate validation inputs. Every test is `NOT_RUN`; none is a passing result.** External facts and local inferences are separated. Each item retains only counterexamples that could change the current design judgment.

1. **Separate stable identity from identity proofs.** Fact: MeshCentral identifies agents by public-key digest; SPIRE separates node and workload attestation.[M03,M09] Inference: retain GhostFleet `node_uid` across changes to addresses, transport accounts, and credentials; an external product ID must not replace core identity. Counterexamples: an address change preserves the same node; two cloned credentials reporting concurrently must not silently overwrite each other. Mapping: #11/#79.

2. **Prove OS isolation through reachable powers.** Fact: Cockpit uses OS authority; Tactical documents installer-account filesystem and sudo access.[M04,M15] Inference: runtime/ops separation must cover sudoers, groups, sockets, ownership, legacy Helpers, and credentials. A configuration assertion is insufficient. Counterexamples: direct legacy-Helper calls or shared sockets cannot elevate runtime; an ADMIN operation authorized through the existing path still succeeds. Rollback removes only objects created by that attempt. Mapping: #11/#63/#69/#79; #79 still has blockers.

3. **Observation completeness is not an empty result.** Fact: osquery distinguishes differentials from snapshots, and Rudder separates Audit from Enforce.[M02,M14] Inference: adapters must convey source, time, identity, and completeness; observer assertions cannot manufacture core-owned admission. Counterexamples: missing baseline, truncation, and unsupported platforms cannot become an empty PASS; Audit drift does not invoke repair. Mapping: existing evidence/consumer acceptance and the #78 candidate.

4. **Use one writer, explicit revisions, and reconciliation after uncertain completion.** Fact: Fleet defines writer/trigger control; Salt caches expire and arbitrary commands need not be idempotent; balena separates queued targets from actual state.[M01,M13,T09] Inference: do not copy deletion-on-YAML-omission. Distinguish failed effects from lost receipts; resolve/pin once without silently following latest. Counterexamples: a completed effect with a lost receipt is not executed twice; evicted caches without durable evidence mean UNKNOWN; channel B→C while offline does not change an operation pinned to B, and expired ADMIN work is not replayed on reconnection. Mapping: #78 and existing intent/receipt contracts.

5. **Apply scope to every read, write, protocol, and artifact exit.** Fact: Tactical reporting can be global; Pangolin raw TCP/UDP differs from HTTP login rules; OpenZiti separates Dial/Bind.[M04,T03] Inference: target/origin scope must cover list/detail/status/report/download/relay and each resource/protocol. Counterexamples: guessing B’s ID while authorized for A reveals nothing; authenticated HTTP does not establish raw TCP authorization; managed-only/Bind-only authority does not grant active peer control. Mapping: #64/#36.

6. **Separate control, data, and path selection.** Fact: Boundary/RustDesk separate control/data, Tailscale paths change, and Cloudflare connector redundancy differs from application Access.[M05,M07,T01,T04] Inference: #36 retains raw provider path/time/evidence; Tailscale’s three categories must not become core authority enums. Automatic scoring/switching remains HOLD. Counterexamples: DERP→peer-relay→direct preserves target/lease/deadline; after possible effect dispatch, another connector resumes the same operation. `MAY_HAVE_EXECUTED/UNKNOWN` requires reconciliation before another dispatch. Mapping: #36.[G02]

7. **Restricted transfer is not arbitrary filesystem authority.** Fact: rrsync constrains `-no-overwrite` with partial-dir/delay-updates, protect-args, and shell startup; Syncthing pairs watchers with scans.[T05,T06] Inference: retain #67’s restricted profile, private staging, complete independent manifest/SHA256 check, trusted receiver, and atomic no-replace publication. rsync exit 0 is not publication proof. Counterexamples: a racing actor creates the final destination and publication refuses replacement; symlink/reparse substitution cannot escape confinement; lost receipts after publication trigger reconciliation. Do not reopen the same restriction repair; actual receiver/power-loss evidence belongs to the original workstream. Mapping: #67.[G03]

   Cloud-adapter qualification: rclone `--checksum` may fall back to size when a usable hash is unavailable, and VFS close does not prove upload completion. Keep the local manifest SHA256, independent cloud readback, and receipt separate. Minimal counterexamples are power loss after close but before upload, and existing same-name or extra destination objects. Both are `NOT_RUN`; neither grants cleanup or overwrite authority.[T11]

8. **Credential lifecycle must include offline recovery and revocation.** Fact: step-ca provisioners differ; renewal after expiry is explicit, and possession of an old private key can make renewal possible, so revocation matters separately.[M10] Inference: stable UID does not follow certificate TTL; mixed devices cannot inherit always-online cloud assumptions or a universal 24-hour rule. Counterexamples: a revoked credential cannot extend authority using an old renewal receipt; an expired offline device enters explicit recovery; mass reconnection does not bypass authorization expiry. Mapping: existing identity/enrollment seams.

9. **Probe platform capabilities; provisioning has its own effects.** Fact: Headwind separates ordinary application mode from DPC provisioning that requires a new/factory-reset device.[M16] Inference: Android/NAS/desktop support must reflect actual capabilities. Enrollment cannot imply reset, root, or privileged installation. Counterexamples: ordinary app authorization neither erases the device nor falsely reports device-owner status; a pre-upgrade capability receipt cannot replace a current probe. Mapping: #11/#80 platform delivery; #80 still has blockers.

10. **Separate release authenticity, device authority, and acceptance.** Fact: TUF protects metadata trust/freshness; Uptane separates images from device targets; RAUC mark-good, Mender commit, and Coolify rollback have distinct boundaries.[T07,T08,T10] Inference: #78 already includes manifests/digests, independent signing trust roots, exact compatibility tuples, and checkpoints; do not claim signatures are missing. A mature verifier may later sit behind the artifact seam. Installed, running, and consumer-accepted are different states. Counterexamples: reject replayed old signed metadata, but do not automatically reject a newly authorized higher generation pointing to an older digest; a live agent with an incompatible consumer is incomplete; after registration succeeds but checkpointing loses power, recover the same operation; an old image with a broken current schema is not full recovery. Preserve #78’s existing 24 VE IDs and `NOT_RUN` status.[G04]

<!-- topic:decisions -->

### 4. Proposed decisions and existing Work

| Proposal | Reason and boundary | Existing destination |
| --- | --- | --- |
| `KEEP` | NodeIdentity, EnrollmentAttempt, HumanGate, Evidence, and core admission/consumer acceptance remain singular. Discovering another product does not justify forking lifecycle or authority. | Existing public contracts and architecture baseline. |
| `REUSE_KNOWLEDGE_NATIVE_IMPLEMENT` | Map mechanisms into existing seams; this is the default for the stable core within a FORMING project. | #11, #63/#69, #64, #36, and the #78 candidate; no bulk creation of new Work. |
| `REUSE_ARTIFACT` | rsync/OpenSSH follow the existing transport direction. Prefer mature cryptography, PAKE, and delta-transfer implementations over rewriting them. | `KEEP` #67; runtime capability follows its original receiver matrix. This is not new dependency approval. |
| `ADAPT_BEHIND_SEAM` candidate | osquery observer, TUF verifier, or a needed CA/executor/desktop provider; no second directory, authority center, or job state machine. | #36 observations, #67 receiver, #78 artifacts; future components require a concrete consumer need. No admission occurred here. |
| `DEFER` | Whole RMM/MDM/AWX/Salt or a new overlay control plane lacks demonstrated migration benefit. Archived Boundary CE is not a new runtime choice. | No installation, replacement, or mandatory prerequisite added. |

**First direction:** resolve existing bootstrap/account/artifact-delivery blockers and their own acceptance, then incorporate narrow changes that address an existing failure mode. This report gives #79/#80 neither merge approval nor a runtime PASS. The #78 versioned-reconciliation study remains a candidate. #67 already covers the existing rrsync restriction correction; this report must not reopen the same repair.

**UNKNOWN and targeted follow-up:** actual API/platform costs, NAT/throughput, Cloudflare Access/replica configuration, receiver ACL/no-replace/power-loss/native Windows sshd, TUF runtime/root distribution/offline expiry, Mender entitlement, NAS partition suitability, binary provenance, and full licenses remain untested. Future MCP validation should include current clients, modern, and legacy/stateless without treating authentication failure as a reason to weaken authority. Validate narrowly when a concrete consumer distinction could change the choice; no search database, fixed cadence, or issue per product is needed.

<!-- topic:sources -->

### 5. Sources

Both language sections use the shared [Sources](#sources) below. Mechanism evidence comes only from official documentation or upstream repositories. Versioned documentation supports the cited behavior, not a claim about the newest release. Public links contain no real instance locators, device names, or credentials. Candidate tests remain `NOT_RUN`.

## Sources

Shared source index / 共同来源索引。URLs below are upstream sources observed in the evidence window; moving branches are not immutable release claims. / 下列可变分支链接代表本轮观察，不构成固定发行版本声明。

### Local contracts / 本地合同

| ID | Official repository evidence / 官方仓库证据 |
| --- | --- |
| G01 | [Architecture at 60f441f](https://github.com/youling/ghostfleet/blob/60f441f235b14e1334b672066d71e4200bd96a59/docs/ARCHITECTURE.md) · [package.json at the same baseline](https://github.com/youling/ghostfleet/blob/60f441f235b14e1334b672066d71e4200bd96a59/package.json) |
| G02 | [#36 transport phase 3 candidate at 60f441f](https://github.com/youling/ghostfleet/blob/60f441f235b14e1334b672066d71e4200bd96a59/docs/research/TRANSPORT_NAMESPACE_PHASE3_CONTRACT_CANDIDATE_2026-10-07.md) |
| G03 | [#67 file-transfer contract at 99ceca6](https://github.com/youling/ghostfleet/blob/99ceca622e1cab9e791aefa7eaed0a3c58cc19b5/docs/FILE_TRANSFER.md) |
| G04 | [#78 versioned enrollment candidate at 43e355b](https://github.com/youling/ghostfleet/blob/43e355b607be2e445be10270915b4f960bfbd563/docs/architecture/VERSIONED_ENROLLMENT_RECONCILE_V1.md) |

### Management mechanisms / 管理机制

| ID | Primary sources / 一手来源 |
| --- | --- |
| M01 | Fleet [GitOps ownership](https://fleetdm.com/guides/gitops-mode) · [policy script automation](https://fleetdm.com/guides/policy-automation-run-script) |
| M02 | osquery [remote enrollment, versioned reference](https://osquery.readthedocs.io/en/5.37.0/deployment/remote/) · [logging](https://osquery.readthedocs.io/en/stable/deployment/logging/) |
| M03 | MeshCentral [design and identity/session protocols](https://docs.meshcentral.com/design/) |
| M04 | Tactical RMM [architecture](https://docs.tacticalrmm.com/howitallworks/) · [permissions](https://docs.tacticalrmm.com/functions/permissions/) · [file browser](https://docs.tacticalrmm.com/functions/file_browser/) |
| M05 | RustDesk [self-hosted OSS/Pro boundary](https://rustdesk.com/docs/en/self-host/) |
| M06 | Teleport [architecture](https://goteleport.com/docs/reference/architecture/) · [authorization](https://goteleport.com/docs/reference/architecture/authorization/) · [machine identity](https://goteleport.com/docs/machine-id/introduction/index.html) |
| M07 | Boundary [worker concepts](https://developer.hashicorp.com/boundary/docs/concepts/workers) · [registration/resources](https://developer.hashicorp.com/boundary/docs/domain-model/workers) |
| M08 | Boundary [archived upstream](https://github.com/hashicorp/boundary) · [official CE deprecation announcement](https://discuss.hashicorp.com/t/deprecation-of-boundary-community-edition/77828) |
| M09 | SPIRE [concepts/attestation](https://spiffe.io/docs/latest/spire-about/spire-concepts/) · [registration](https://spiffe.io/docs/latest/deploying/registering/) · [agent selectors](https://spiffe.io/docs/latest/deploying/spire_agent/) |
| M10 | step-ca [renewal](https://smallstep.com/docs/step-ca/renewal/) · [provisioners](https://smallstep.com/docs/step-ca/provisioners/) |
| M11 | AWX [execution environments](https://github.com/ansible/awx/blob/devel/docs/execution_environments.md) · [24.6.1 isolation/security reference](https://docs.ansible.com/projects/awx/en/24.6.1/userguide/security.html) |
| M12 | AWX [README release pause](https://github.com/ansible/awx/blob/devel/README.md) · [release history](https://github.com/ansible/awx/releases) |
| M13 | Salt [execution framework](https://docs.saltproject.io/salt/user-guide/en/latest/topics/execution-framework.html) · [job cache](https://docs.saltproject.io/en/latest/topics/jobs/job_cache.html) · [idempotence glossary](https://docs.saltproject.io/en/master/glossary.html) |
| M14 | Rudder [Audit and Enforce](https://docs.rudder.io/get-started/current/configuration-policies/policy-mode.html) |
| M15 | Cockpit [privileges](https://docs.cockpit-project.org/cockpit-guide/main/guide/privileges.html) |
| M16 | Headwind [provisioning](https://h-mdm.com/quick-start/) · [old server/application mode](https://github.com/h-mdm/hmdm-server/blob/master/README.md) · [v7 server](https://github.com/h-mdm/hmdm-server-v7/blob/main/README.md) |

### Management licenses and repositories / 管理许可与仓库

These 14 rows represent 15 candidate repositories; L14 contains two. / 本表 14 行对应 15 个候选仓库，L14 含两个。

| ID | Upstream license evidence / 上游许可证据 |
| --- | --- |
| L01 | [fleetdm/fleet LICENSE and path exceptions](https://raw.githubusercontent.com/fleetdm/fleet/main/LICENSE) |
| L02 | [osquery/osquery LICENSE](https://github.com/osquery/osquery/blob/master/LICENSE) |
| L03 | [Ylianst/MeshCentral LICENSE](https://github.com/Ylianst/MeshCentral/blob/master/LICENSE) |
| L04 | [amidaware/tacticalrmm LICENSE](https://github.com/amidaware/tacticalrmm/blob/develop/LICENSE.md) · [EE LICENSE](https://github.com/amidaware/tacticalrmm/blob/develop/api/tacticalrmm/ee/LICENSE.md) |
| L05 | [rustdesk/rustdesk client LICENCE](https://github.com/rustdesk/rustdesk/blob/master/LICENCE) |
| L06 | [gravitational/teleport source/build terms](https://github.com/gravitational/teleport) · [API LICENSE](https://github.com/gravitational/teleport/blob/master/api/LICENSE) |
| L07 | [hashicorp/boundary LICENSE](https://github.com/hashicorp/boundary/blob/main/LICENSE) |
| L08 | [spiffe/spire LICENSE](https://github.com/spiffe/spire/blob/main/LICENSE) |
| L09 | [smallstep/certificates LICENSE](https://github.com/smallstep/certificates/blob/master/LICENSE) |
| L10 | [ansible/awx LICENSE](https://github.com/ansible/awx/blob/devel/LICENSE.md) |
| L11 | [saltstack/salt LICENSE](https://github.com/saltstack/salt/blob/master/LICENSE) |
| L12 | [Rudder license description](https://docs.rudder.io/reference/9.2/reference/contribute.html) · [Normation/rudder linking exception](https://github.com/Normation/rudder/blob/master/LICENSE_EXCEPTION) |
| L13 | [Cockpit official license footer](https://docs.cockpit-project.org/cockpit-guide/main/guide/privileges.html) · [cockpit-project/cockpit](https://github.com/cockpit-project/cockpit) |
| L14 | [h-mdm/hmdm-server LICENSE](https://github.com/h-mdm/hmdm-server/blob/master/LICENSE) · [h-mdm/hmdm-server-v7 LICENSE](https://github.com/h-mdm/hmdm-server-v7/blob/main/LICENSE) |

### Transport, distribution, and recovery mechanisms / 传输、分发与恢复机制

| ID | Primary sources / 一手来源 |
| --- | --- |
| T01 | Tailscale [connection types](https://tailscale.com/docs/reference/connection-types) · [peer relay](https://tailscale.com/docs/features/peer-relay) · Headscale [FAQ](https://headscale.net/stable/about/faq/) · NetBird [NAT/connectivity](https://docs.netbird.io/about-netbird/understanding-nat-and-connectivity) · [relay metrics](https://docs.netbird.io/selfhosted/observability/relay) · Netmaker [gateways](https://docs.netmaker.io/docs/features/gateways) |
| T02 | Nebula [README](https://github.com/slackhq/nebula/blob/master/README.md) · [relay](https://nebula.defined.net/docs/config/relay/) · ZeroTier [protocol](https://docs.zerotier.com/protocol/) · [controller](https://docs.zerotier.com/what-is-a-controller/) |
| T03 | Pangolin [resource types](https://docs.pangolin.net/manage/resources/understanding-resources) · [architecture](https://docs.pangolin.net/about/how-pangolin-works) · Newt [README transition](https://github.com/fosrl/newt/blob/main/README.md) · [current site installation](https://docs.pangolin.net/manage/sites/install-newt) · OpenZiti [Dial/Bind policies](https://netfoundry.io/docs/openziti/active/learn/core-concepts/security/authorization/policies/overview/) · zrok [public shares](https://netfoundry.io/docs/zrok/concepts/public-shares/) · [private shares](https://github.com/openziti/zrok/blob/main/website/docs/concepts/private-shares.mdx) |
| T04 | Cloudflare [tunnel concepts](https://developers.cloudflare.com/tunnel/concepts/) · [availability/replicas](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/) · [Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) · frp [README](https://github.com/fatedier/frp/blob/dev/README.md) · rathole [README](https://github.com/rathole-org/rathole/blob/main/README.md) |
| T05 | rsync [official restricted rrsync manual](https://www.samba.org/ftp/rsync/rrsync.1.html) · [upstream](https://github.com/RsyncProject/rsync) · [OpenSSH portable](https://github.com/openssh/openssh-portable) · local proof boundary [G03] |
| T06 | croc [README](https://github.com/schollz/croc/blob/main/README.md) · [web-client limits](https://github.com/schollz/croc/blob/main/web/README.md) · Magic Wormhole [file protocol](https://magic-wormhole.readthedocs.io/en/latest/file-transfer-protocol.html) · [Transit protocol](https://github.com/magic-wormhole/magic-wormhole-protocols/blob/main/transit.md) · Syncthing [syncing](https://docs.syncthing.net/users/syncing) · [versioning](https://docs.syncthing.net/users/versioning.html) |
| T07 | TUF [specification](https://theupdateframework.github.io/specification/latest/) · [security model](https://theupdateframework.io/docs/security/) · Uptane [2.1.0 standard](https://uptane.org/docs/2.1.0/standard/uptane-standard) · [design](https://uptane.org/learn-more/design) |
| T08 | Mender [update modules](https://docs.mender.io/artifact-creation/create-a-custom-update-module) · [state scripts](https://docs.mender.io/artifact-creation/state-scripts) · [Orchestrator GA and tier](https://mender.io/blog/official-release-new-component-orchestration) · [orchestration protocol](https://docs.mender.io/orchestrate-updates/interface-protocol) · RAUC [using/mark-good](https://rauc.readthedocs.io/en/latest/using.html) |
| T09 | balena [OS update process](https://docs.balena.io/reference/os/updates/update-process) · [rollback](https://docs.balena.io/reference/os/updates/rollbacks) · [queued updates](https://blog.balena.io/queued-os-updates-managed-by-the-supervisor/) · [supervisor upgrades](https://docs.balena.io/reference/supervisor/supervisor-upgrades) · [application update strategies](https://github.com/balena-io/docs/blob/main/pages/learn/deploy/release-strategy/update-strategies.md) |
| T10 | Komodo [resource sync](https://komo.do/docs/automate/sync-resources) · [procedures](https://komo.do/docs/automate/procedures) · Coolify [rollback scope](https://coolify.io/docs/applications/deployments/rollbacks) · [health checks](https://coolify.io/docs/applications/configuration/health-checks) |
| T11 | rclone [mount/VFS limits](https://rclone.org/commands/rclone_mount/) · [S3 integrity and ETags](https://rclone.org/s3/) · [copy semantics](https://rclone.org/commands/rclone_copy/) · [sync deletion semantics](https://rclone.org/commands/rclone_sync/) |

### Transport repositories and license scope / 传输仓库与许可范围

The 11 rows contain exactly 27 candidate repositories. Linked license exceptions override a simple repository badge; actual selected binaries still need a complete component inventory. / 本表 11 行恰含 27 个候选仓库；许可例外优先于仓库 badge，具体二进制仍须核对完整组成。

| ID | Upstream repositories and license evidence / 上游仓库及许可证据 |
| --- | --- |
| R01 | [tailscale/tailscale](https://github.com/tailscale/tailscale) · [juanfont/headscale](https://github.com/juanfont/headscale) · [netbirdio/netbird LICENSE exceptions](https://github.com/netbirdio/netbird/blob/main/LICENSE) · [gravitl/netmaker LICENSE](https://github.com/gravitl/netmaker/blob/develop/LICENSE.md) |
| R02 | [slackhq/nebula](https://github.com/slackhq/nebula) · [zerotier/ZeroTierOne root LICENSE](https://github.com/zerotier/ZeroTierOne/blob/dev/LICENSE.txt) · [same repository nonfree terms](https://github.com/zerotier/ZeroTierOne/blob/dev/nonfree/LICENSE.md) |
| R03 | [fosrl/pangolin LICENSE](https://github.com/fosrl/pangolin/blob/main/LICENSE) · [fosrl/newt](https://github.com/fosrl/newt) · [openziti/ziti](https://github.com/openziti/ziti) · [openziti/zrok](https://github.com/openziti/zrok) |
| R04 | [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared) · [fatedier/frp](https://github.com/fatedier/frp) · [rathole-org/rathole](https://github.com/rathole-org/rathole) |
| R05 | [RsyncProject/rsync](https://github.com/RsyncProject/rsync) · [openssh/openssh-portable](https://github.com/openssh/openssh-portable) |
| R06 | [schollz/croc](https://github.com/schollz/croc) · [magic-wormhole/magic-wormhole](https://github.com/magic-wormhole/magic-wormhole) · [syncthing/syncthing](https://github.com/syncthing/syncthing) |
| R07 | [theupdateframework/python-tuf pyproject terms/runtime](https://github.com/theupdateframework/python-tuf/blob/develop/pyproject.toml) · [theupdateframework/tuf-js](https://github.com/theupdateframework/tuf-js) · [uptane/uptane-standard specification LICENSE](https://github.com/uptane/uptane-standard/blob/master/LICENSE) |
| R08 | [mendersoftware/mender LICENSE](https://github.com/mendersoftware/mender/blob/master/LICENSE) · [rauc/rauc](https://github.com/rauc/rauc) |
| R09 | [balena-os/meta-balena](https://github.com/balena-os/meta-balena) |
| R10 | [moghtech/komodo](https://github.com/moghtech/komodo) · [coollabsio/coolify](https://github.com/coollabsio/coolify) |
| R11 | [rclone/rclone](https://github.com/rclone/rclone) · [COPYING](https://github.com/rclone/rclone/blob/master/COPYING) |

### Existing MCP compatibility evidence / 既有 MCP 兼容证据

| ID | Primary sources / 一手来源 |
| --- | --- |
| P01 | [Official TypeScript SDK stable v2 / v1 maintenance description](https://github.com/modelcontextprotocol/typescript-sdk) |
| P02 | [Protocol 2026-07-28 migration and legacy/stateless compatibility](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) |
