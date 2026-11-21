# GhostFleet 加入与远控就绪研究

研究日期：2026-11-18（Asia/Shanghai）。源码基线：`ce645aacde8caa72b866bb127a05c746323f8d1f`。本记录对照精确源码与上游官方文档，分析加入流程及原生 SSH 就绪方案；方案均为候选，尚未实施或现场测试。

[本轮调研总览](ONBOARDING_RECONNAISSANCE_2026-11-18.md) · [现有主工单 #11](https://github.com/youling/ghostfleet/issues/11)

## 结论与证据级别

**建议把“加入动作简单”和“最终远控可用”作为同一向导的两个交付目标，保持 reporter 与 SSH 分工。** 单行加入可以做；单行并不要求签名 JWT，更不意味着跨控制面、节点文件和 provider 配置形成一个数据库事务。当前源码已具有一次性票据、独立 node_uid、错误次数锁定和本地恢复基础，应在原路径上改进，而不引入第二个身份/任务系统。

采用源码与官方资料对照研究（MIXED）。本仓行为结论为 `SOURCE_INSPECTED`；外部能力为 `DOCUMENTED_CAPABILITY`；方案与适配判断为 `INFERRED/PROPOSED`；生产与现场新验证为 `NOT_RUN`。源码检查不证明生产配置、真实网络路径或设备安装结果；本记录不修改现行实施合同。

## 1. 现有源码已经解决什么

精确基线：GhostFleet `ce645aacde8caa72b866bb127a05c746323f8d1f`。

| 事实 | 当前行为 | 对提案的影响 |
| --- | --- | --- |
| 签发/领取 | 预留稳定 node_uid；随机票据定位符；独立 8 位十进制码；10 分钟 TTL；5 次错误锁票据 | 提案里的 5 次/10 分钟不是全新能力；现状是按票据锁定，并非按 IP 全局封禁 |
| 原子性 | 同一 `global` DO 的 `storage.transaction` 内读取 snapshot、dispatch、写回；响应等事务完成 | 一次领取已有权威落点；不要另建 mint/nonce 服务 |
| 凭据 | 领取返回 32 个随机字节的节点 reporting token，服务端只保存摘要 | 加入凭据和长期 reporting 凭据应继续分开 |
| 恢复 | claim 的 HTTP 结果不确定时不自动重试；为同一 node_uid reissue；本地保存后失败走 repair | 简化界面不能破坏此区分，也不能失败后自动再建节点 |
| 安装交互 | `install()` 要求 Linux、root、`sys.stdin.isatty()`；随后 `getpass` 读短码 | 直接把当前安装器改为 `curl ... | bash` 会与 TTY 条件冲突；必须明确 stdin/TTY 设计 |
| 持久化 | config 先写；临时文件 fsync 后 replace；后续自己的文件和 systemd unit 按摘要清单维护 | 可继承恢复基础；这不是跨 provider/SSH/服务端的全局原子事务 |
| UID | UI 从票据显示 UID；安装器从 claim 响应写入 config；replace 校验旧 UID | “手工搬运 UID”主要是现场交接/工具接线痛点，当前 claim 本身不要求用户重新输入 UID |
| 观测 | heartbeat 严格只接受协议、boot ID、版本和 3 个 unit 状态 | 增加网络端点须显式扩展版本/合同；不能把新字段假装当前已支持 |

源码：[presence.js](https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/src/control-plane/presence.js)、[worker.js](https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/src/adapters/cloudflare/worker.js)、[heartbeat.py](https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/scripts/heartbeat.py)、[app.js](https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/console/app.js)。

## 2. 单行加入：优先复用票据，区分两种 UX

**当前合同兼容的改进**：安装命令、节点标签和恢复入口由 Console 自动关联，复制命令后只保留一次短码输入；不要求用户再复制 UID。可以把长 Python bootstrap 隐藏在“复制加入命令”后，保留可展开审阅。减少界面搬运不必先改变凭据模型。

**后续可选的自包含加入**：若明确要取消短码交互，建议在既有票据中增加高熵随机 opaque join capability，只存摘要、绑定同一 node_uid/到期时间/用途，并在现有 DO 内一次性消费。推荐使用成熟随机数接口的 32 字节随机量；它只是可逆设计建议，不是当前已批准的实现合同。不要把 8 位短码直接变成可全球检索的唯一 bearer。8 位十进制的理论熵约 26.6 bit；即使单票据允许 5 次尝试，其安全性仍依赖随机定位符、尝试次数与过期等组合条件，不能外推到任意分布式暴力猜测。

**签名不是必要前提。** JWT 适合携带可验证声明；本产品仍需要一次性消费、撤销、重新签发和 node_uid 关联状态。签名并不会让一个 bearer token 天然只能用一次，`jti` 也需要消费策略配合。因此本产品的单一既有 DO 场景中，opaque 随机令牌比新建签名密钥分发/轮换机制更直接。这是结合现有架构的推断，不是 JWT 标准要求。[RFC 7519 §4.1](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1)

**单行复制有真实取舍**：若命令携带完整 bearer，终端 history、进程参数、屏幕录制/剪贴板会接触它；将其嵌入 `/join/<token>` 还会扩展到 URL 日志。短 TTL/一次消费降低泄漏后的窗口，但不能称为“无泄漏”。尽量通过 HTTPS 请求体或认证头传递，失败诊断不回显 secret；下载代码与凭据数据分开，保留固定制品摘要检查。不要为了形式上一行就把网络响应未经验证交给 root shell。关于 URL 泄漏与短期/限用途 bearer 的依据见 [RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750.html#section-5.3)；shell/argv 边界是针对本安装流程的工程推断。

若提供 `join --token-file`、受保护 FD 或交互读取路径，应与无人值守安装场景一起确定；它们不是要求用户额外输入的通用前置。保持一个适合默认交互的简单入口，自动化路径按需要增加。

## 3. 速率限制：Worker 边缘保护不能冒充全局次数保证

截至研究日期，Cloudflare Workers Rate Limiting 官方页明确：计数按 Cloudflare location 分开、更新最终一致，多个请求可能在同步前通过；`await limit()`、共享 namespace 都不能把它变成全球精确计数。严格跨 location 限制需要把同一个 key 的检查和持久更新集中到同一个 DO。[官方 Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

因此建议 **KEEP** 当前 DO 内的每票据错误计数与一次性状态。边缘/IP 限流只作额外的容量保护，不宣称严格“全球 5 次”；同一出口 NAT 共享 IP、攻击者换 IP、合法用户被锁都是需要说明的反例。高熵 token 路径仍需 TTL/撤销/一次消费，不以限流代替凭据质量。无需为了这个问题另建 Redis 或新 DO 命名空间。

DO 存储具有事务与强一致语义；Worker/DO 代码发布却可能暂时跨版本。因此若增加 join 字段/路由，应保持新旧请求和存储兼容，不能让滚动发布把旧 reporter 全部拒绝。[DO Storage](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/)、[DO 已知事项](https://developers.cloudflare.com/durable-objects/platform/known-issues/)

## 4. “纳管即远控”应是可恢复流程与真实结果

建议同一向导按既有 Work 承载以下阶段，不创建新的执行队列或后台命令 Agent：

1. Owner 选择目标 OS 用户、允许的管理来源与原生通道；指定运维公钥及已核验主机身份/端点。
2. 需要时，由**现役工头或显式可选的一次性 provisioning 组件**在首次获授权安装阶段配置原生 SSH。后续 reporter 不负责写 `authorized_keys`、provider 策略或 root 配置。
3. 注册 reporter；接收 heartbeat 后仅记录“上报在线”。
4. 从指定管理客户端建立全新 SSH 会话，确认 host key、目标用户、目标机器，以及拒绝来源/错误 key 的负测。测试不用旧 ControlMaster 复用连接冒充新路径。
5. 展示“已验证可用的通道、客户端视角与验证时间”，保留可回源证据；一次成功仅适用于该来源、身份、路径与当时配置。Cloudflare 未验证而 Tailscale/直连已可用时分别展示；不因某条可选路径未验收把所有能力判为不可用。

该方案以“一个流程交付可用远控”为目标，但**不声称所有步骤同进同退**。DNS/Access 配置、公钥写入、reporter claim 与控制端别名属于不同故障域；某步失败应保留已成功的结果和恢复入口，不能自动撤销可用 SSH 或创建新节点。

当前 [ADR004](https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/docs/adr/004-lightweight-enrollment-presence.md) 明确 v1 reporter 不改 SSH/provider。若增加可选首次 provisioning，需要明确修改的文档/源码范围及 owner 执行合同；不能只在现有 reporter 加一行写 root key 就认为是纯 UI 优化。这不是要求逐命令 Human 批准；应沿已授权的一次初装范围执行。

### 公钥安装与端点处理的最小约束

- 有现成可用 SSH 登录路径时，优先复用系统工具 `ssh-copy-id -i <明确公钥文件>`，避免默认挑选 ssh-agent 中所有身份；`-n` 可预览。普通模式会检查已安装 key，`-f` 会跳过检查并可能重复追加。该工具本身仍要求已有认证路径，不解决零信任首次 bootstrap。[Debian trixie ssh-copy-id](https://manpages.debian.org/trixie/openssh-client/ssh-copy-id.1.en.html)
- 若必须本机首次写入，需保留原 key 行和 options，以 key 类型+blob 而非注释识别，不删除未知 key，不用去重重写破坏既有 key 约束；明确文件所有者/权限、并发写入和失败回退。SSH 公钥可部署到目标，运维私钥只留获授权的管理端；不要把“全舰队公共运维公钥”偷换为每台边缘节点都存放全舰队私钥。OpenSSH 对 authorized_keys 的格式与 StrictModes 见 [sshd(8)](https://man.openbsd.org/sshd.8)。
- IP/隧道 hostname 是候选 locator，不是 host identity，也不证明从任意控制端可达。自动生成 ssh_config 应验证 host/port/user 等字段，不能允许任意 reporter 字段成为 `ProxyCommand` shell 片段。
- `ssh-keyscan` 只能收集 key，不能证明 key 真实归属；应与可信终端/已有 owner 证据比较。已验证同一主机的多条路径可使用 `HostKeyAlias` 绑定同一主机键；使用 `StrictHostKeyChecking` 明确主机变更行为。[ssh-keyscan(1)](https://man.openbsd.org/ssh-keyscan.1)、[ssh_config(5)](https://man.openbsd.org/ssh_config.5)

## 5. 上游经验与取舍

| 上游 | 当前官方事实 | 对 GhostFleet 的建议 |
| --- | --- | --- |
| Tailscale | one-off auth key 用后撤销；key 过期/撤销和已登记节点的存续是不同事情；tag 可在加入时限定设备归属/策略 | **REUSE_KNOWLEDGE**：一次加入凭据与长期节点身份分开；不要把 reporting 撤销写成 SSH 撤销。不导入新的 overlay |
| Headscale | 稳定文档提供非交互 preauthkey；默认 1 小时、一次使用 | **REUSE_KNOWLEDGE**：单行/非交互体验与一次性、限时并不冲突；不需要为学习该 UX 迁移 control plane |
| Teleport | 18.x 当前文档给出 Bound Keypair：18.1 起用于 bots，18.8 起支持标准 agents；需唯一 token 和客户端持久状态；恢复模式有边界 | **DEFER_ARTIFACT / LEARN**：未来机器凭据轮换/恢复若变成主要问题，可借鉴 proof-of-possession；本轮不装 Teleport、不引入证书身份平台 |
| Smallstep | 在原生 OpenSSH 旁提供 CA/证书与 IdP 登录，含客户端配置、证书取得及续期 | **DEFER** SSH CA：少量稳定管理员/机器尚不足以证明新 issuer/续期/可用性成本值得；保留原生公钥，未来规模/多操作者需求再评估 |

来源：[Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys)、[Headscale stable getting started](https://headscale.net/stable/usage/getting-started/)、[Teleport bound keypair](https://goteleport.com/docs/reference/machine-workload-identity/bound-keypair/)、[Smallstep SSH 工作原理](https://smallstep.com/docs/ssh/how-it-works/)。上述为研究日期读取的文档快照，不宣称目标机器已安装这些版本，也不把 Preview/未来默认计划写成已上线事实。

## 6. 候选实现的 11 组验证场景

| 场景 | 应有结果 |
| --- | --- |
| 同一票据并发领取/跨 location 重放 | 最多一次成功；仍指向同一 node_uid；之后冲突/拒绝 |
| 过期、撤销、第五次错误、旧 token 再次使用 | 拒绝且无新节点/凭据；严格次数由同一 DO 证明 |
| claim 已提交但响应丢失 | 不自动重试 claim/不新建节点；回到同一节点 reissue |
| config 已落盘、unit 安装失败 | repair 复用同一配置；不 claim、不轮换 SSH |
| 初装命令来自 pipe、TTY、自动化文件/FD | 各模式行为明确；没有隐藏等候输入或意外输出 secret |
| 安装器 bytes/hash 不符、重定向、不正确 origin | 不能执行未验证源码或把凭据送错位置 |
| 插入同一 SSH key 两次/本地已有带 options 的 key | 不重复或放宽原有权限；保留未知 key |
| 公钥已部署、DNS/Access 路径失败 | 分阶段报告，保留可用路径，不误报全局原子成功 |
| heartbeat ONLINE 但入站防火墙/SSH key/host key 错 | 仍显示上报在线，远控路径未通过；不自动绕过 host key |
| 伪造 endpoint 字段包含换行/命令符号 | 不生成可执行 shell/ssh_config 注入；只接受明确字段格式 |
| 更新/reissue/revoke reporter | SSH 凭据和原生可用路径保持；节点身份不漂移 |

以上 11 组是候选验收输入，应随被选中的实现范围落实；全部尚未在本研究中执行。未选择的未来能力不构成当前部署可用性的额外前置。

## 7. 未知项与后续范围

后续范围仍需在现有主工单中确定：默认保留一次复制加短码，还是提供完全无人值守入口；可选首次公钥配置的范围；多操作者的身份和私钥保管方式；真实端点归属、主机身份及各来源路径的现场结果；生产限流和日志保留配置。现有源码与官方证据足以支持小型设计候选。若选择改变 token 语义或首次 root 配置，应明确相应实现合同并验证相关反例；无需引入整套 RMM、MDM 或新的 overlay 平台。

**建议的下一步**：沿现有 #11 收敛“加入体验与可恢复原生 SSH 就绪向导”，优先减少无需扩大 SSH 写入范围的信息搬运；token 语义、自动公钥写入和端点字段模型作为后续明确的版本变更。候选方案不代表已实现或已获现场验收。


## 8. Owner 决策更新 · 2026-11-22：真实 VPS 全自动下位机

本节更新第 7 节尚未决定的入口形式，历史研究结论仍保留。

- **验收环境已决定：真实搬瓦工 VPS，不使用虚拟机。** Canary 必须实际经过正式 Panel 域名、真实 HTTPS、ticket/短码、Provider、原生 SSH、Worker/DCR 和 ChatGPT 对话；本机 SSH/CI/已有节点迁移不替代首次加入。
- **交互模式已决定：全自动 Managed 下位机。** Operator 在受保护 Panel 创建 `FULL_MANAGED_LOWER_NODE` ticket；目标机只做一次 root bootstrap + 短码输入。其后同一受授权流程自动完成主机预检、原生传输、TS/CF 发现与复用、DCR identity/policy、Root helper/签名 lease 与 ChatGPT 实际验收。
- **角色固定：TP 是唯一 Controller。** 搬瓦工 Canary 及后续国内生产力服务器都是 Managed Nodes，不允许自报升格 Controller 或获得 Managed→Managed 新管理权限。
- **不再要求逐节点静态 Worker 源码/Wrangler 配置。** 私有 Fleet/DCR 需要把已审核的 immutable Node UID、Provider/transport locator、Host Key pin 和 capability profile 动态发布。当前 static VPC binding 若不能支持新增节点，应在产品发布前修正；不能手工改一份 Worker 配置后声称自动纳管。
- **已有 Provider 优先复用。** 自动发现 Tailscale/Cloudflare 现状，健康且身份符合就复用；只有所选控制路径确实需要、且无现成可用资源时才按 Owner profile 创建。Provider 健康不替代 SSH/Root 真实握手。
- **Root 是 FULLY_MANAGED 的必要能力。** 固定 root-probe 之后，还要证明一次 Owner 授权覆盖指定 Node/任务范围/期限内的连续 Root session；普通 `fleet-job/v1` 不是 Root 通道。

实现与验收细节见 [ADR007](../adr/007-fully-managed-lower-node-enrollment.md)。这一决策只确定正式版目标和真实 Canary 选择，不表示 bootstrap、动态 DCR 或连续 Root session 已经全部实现。
