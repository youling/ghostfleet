# ADR 007 — 真实 VPS 验证的全自动下位机纳管 / Fully managed lower-node enrollment

状态：**ACCEPTED PRODUCT DIRECTION / IMPLEMENTATION IN PROGRESS**
决策日期：2026-11-22
Owner：Fleet Owner
主线：GhostFleet #11；私有 DCR / Host 消费合同：ai-hub #300

## 1. 决策摘要

正式版不以虚拟机作为首次纳管验收环境。先选一台真实、可恢复的**搬瓦工 VPS**走完整生产流程；通过后，再把同一套全自动流程用于国内生产力服务器。所有这些机器都是 **Managed / 下位节点**，不承担 Controller 角色。

目标体验是：

> 操作者在目标机打开可信的 GhostFleet 纳管入口，输入纳管域名。在控制面板选择这台机器发起的配对请求，手动签发短码，然后在目标机输入短码。此后安装、身份登记、Provider 复用、传输建立、DCR 能力发布、root 执行器配置和真实验收由同一受授权流程自动完成。最终 ChatGPT 对话可直接调用目标节点。

“全自动”是指**一次显式 Owner 授权 + 一次目标机 root 引导**后，不再要求操作者逐台编辑 Worker 源码、复制 Node UID/公钥、手工建 Tunnel/策略或逐条批准日常运维。它不等于任何持有心跳 Claim 的节点都自动获得 root。

## 2. 通用角色：Owner 授权的控制主体与下位机

**2026-11-24 方向修订候选（SOURCE/REVIEW ONLY）：** 原 2026-11-22 的 TP-only 是当时实例获准的有界拓扑基线，不是长期产品不变量，也不表示实际 TP 出站 SSH 或 A09 已通过。后续 Human 选择多上位机互为控制冗余；实例角色、已生效范围与现场证据回到私有 Fleet 拓扑 Work（ai-hub #340）及 [#64](https://github.com/youling/ghostfleet/issues/64)。本 ADR 不建立第二份实例角色真值，不自动扩大任何现役授权。

- 复用 `CONTROLLER_CAPABLE` / `MANAGED_ONLY` 语义。控制资质、实际出站 principal、已授目标/动作范围和 OS 权限分别证明。基础设施层级、在线、LAN、tag、别名或本机 root 都不产生控制权。获准 Controller 所在主机也可以是另一个获准主体的管理目标。
- 下位机纳管固定为 `MANAGED_ONLY`；本次真实 VPS Canary 与后续生产力服务器 rollout 仍按既定下位机 profile。其自身 root/业务/Reporter 凭据不授予反向或横向管理、凭据签发、策略修改、可信制品发布或独立备份删除。正常业务及响应流量单独按需允许。
- 多 Controller 可在明确授权内分工、互为故障接替；各控制主体使用独立、可撤销、受保护的凭据和目标范围。不复制同一份 root 私钥，不因心跳超时、自称接管或 Provider 在线自动升权。业务/CI 默认非 root；Human 及获授权的管理 Agent 保有相应目标上的管理员权限。
- 独立 Work 可以并行。接替同一个具有副作用的独占资源时，消费既有 Work/Execution Lifecycle 的 ownership、generation/fencing 与 UNKNOWN 对账语义；由资源端或其控制器拒绝旧 generation。不能证明旧动作结果/安全写入归属时只停止该资源的接替。原生 SSH 不假装天然具有 fencing；未受保护的非幂等命令不得自动重发。无需为所有调用引入全局选主或分布式锁。
- 控制状态、凭据恢复和独立救援必须具备可核验恢复路径；多个控制主体不等于独立电源、网络、存储或 Provider 故障域。节点更换遵守旧身份撤销、新 UID 独立准入及角色迁移，而不是复制旧身份。
- 复用现有 DCR/Worker/SSH/Host 执行链及私有实例策略。GhostFleet 不引入第二控制面、常驻 fleet agent、平行命令队列或新的全局角色注册表。下位机完全纳管不等于 Controller 冗余验收。

## 3. 验证环境：真实搬瓦工 VPS，不使用虚拟机

### Canary 选择

使用 Owner 指定的一台真实搬瓦工 VPS，记为 `BWH-CANARY`（具体实例、当前 SSH 端口和 immutable Node UID 由现场工头只读核对后记录，不能根据名称猜测）。它必须满足：

- 可通过提供商控制台或现有 SSH 路径恢复；有可用快照/重装能力或明确的数据恢复方式。
- 允许真实公网 DNS、TLS、Cloudflare/Tailscale、SSH 与 Worker/DCR 路径参与测试。
- 没有唯一生产数据、NAS 存储阵列、SMB/NFS 共享或不能中断的业务负载。
- 测试不得先清盘/重装；先记录 OS、磁盘/挂载、端口、防火墙、现有 SSH 身份和 Provider 状态。已有可复用状态先复用；测试清理只移除本流程自己创建的资源。

### Canary 不只是 SSH 连通

必须从真实 Panel 开始，经过真实公网路径和真实 Worker/DCR，最后由**普通 ChatGPT 对话**实际执行。Windows 手工 SSH、现场工头本地 jobctl 测试、GitHub CI、旧节点已有 Root Probe 都不能替代本次首次纳管验收。

Canary 通过后，按同一流程逐台纳入国内生产力服务器。首批按单节点 canary → 小批次 → 全量 rollout，不能一次并发改造所有生产节点。

## 4. 一次性全自动纳管流程

### 4.1 Panel 创建受授权的 Managed profile

Operator 登录受保护的 Panel，选择 `FULL_MANAGED_LOWER_NODE`。Panel/既有 DO：

1. 预留稳定 UUIDv4 `node_uid`，节点角色固定 `managed`。
2. 操作者选择目标机发起的待配对请求并手动签发一次性 ticket 和短码。短码为六位去掉易混字符的数字字母，自签发起十分钟内有效，忽略大小写。每张票据绑定设备保存在内存中的随机配对秘密，错误次数和原子消费沿用 ADR004。
3. 记录本次授权的节点 profile、Provider/传输选择策略、R0/Job/Root 能力范围、有效期与撤销句柄。Owner 对该 profile 的授权发生在 Panel 的受保护 Operator 操作中。
4. 展示纳管域名、目标 Node UID、短码与过期时间。目标机自己发现和校验独立引导制品。短码不能进入 URL、shell argv、环境变量、命令历史或日志。
5. 同一节点恢复走同一 UID 的 repair/resume/reissue；不因安装中断创建第二个 Node UID。

### 4.2 目标机只进行一次 root ceremony

操作者在目标机打开可信的 GhostFleet 纳管客户端/入口，输入纳管域名发起配对；在控制面板审核并手动签发短码后，在目标机可信终端以 root 权限输入六位短码执行引导仪式。引导器：

- 先验证 HTTPS origin、发行版本、字节数与 SHA-256，再执行任何下载内容；禁止未经校验的 `curl | sudo bash`。
- 仅在交互式隐藏输入中读取短码；不得回显、写入 argv、URL、shell history、journal 或普通错误日志。
- 在任何持久变更前完成 OS/systemd/架构/权限/网络/恢复能力预检；不兼容或未知时停止，并给出可恢复阶段。
- 领取 ticket 时只消费一次，绑定原 Node UID 与 profile；Claim 是一次性引导授权，不是通用永久 root 密钥。
- 在同一授权流程中依序安装/修复 GhostFleet reporter、原生管理传输、DCR 节点目标/策略与专用 root helper；每一阶段产生可查询的幂等 receipt。
- 对每个阶段做 postcondition 检查；响应丢失时按原 operation/ticket/Node UID 查询，不盲目重复写入。

这是一条受授权的 provisioning ceremony，不要求恢复旧的通用命令队列、驻留 Agent 或逐命令审批系统。

### 4.3 Provider-first：先发现并复用 TS / CF

纳管流程必须有 Provider Adapter/Owner-backed readback，不能让每台节点都重复安装网络组件：

**Tailscale**
- 先读取本机 `tailscale status --json`、设备身份、版本、Tailnet 地址、Tag 与连接状态。
- 如果已属于目标 Tailnet 且身份/策略符合要求，复用现有设备，不重新注册、不更换 Key、不重复打 Tag。
- 若未加入，使用私有 Provider Owner 已授权的最小范围接口签发一次性/受限 Auth Key，按角色写入 Tag；节点不持有 Tailnet 管理 API Token。
- 读取 Devices API 的 `connectedToControl` 与现有 Service 状态；不要将 `lastSeen` 当 60 秒心跳，也不要将 TS 在线推导为 SSH/Root 可用。
- 服务发现优先评估 Tailscale Services/MagicDNS/TailVIP；多网卡、Tag、ACL、RootlessKit namespace 必须实测。

**Cloudflare**
- 先读回当前 `cloudflared` unit、Tunnel、Connector 与 origin，已有健康路径直接复用。
- 只有当所选 DCR transport 确实需要且不存在可复用入口时，才由私有 Provider Owner 自动创建该节点 Tunnel/route；凭据通过 Cloudflare secret/受保护的 Host 文件传递，不进入仓库、Issue、命令行或日志。
- 复用 Tunnel API、Connector 状态与 Health Alert，不自建重复隧道心跳。Tunnel Edge healthy 不能证明 origin SSH 已认证。
- 不要求每台机器同时部署 Tailscale 和 Cloudflare；以现有可用路径、恢复能力和 Owner 策略选择最小充分组合。

**GhostFleet**
- 自身只维护稳定 `node_uid`、生命周期、最后一次独立 Reporter 事实，以及跨 Provider 的证据来源/时效关联。
- 不复制 TS/CF 设备注册表；不从 hostname、IP、MAC 或 Tunnel ID 自动推断 Node UID。
- Provider device/tunnel 与 Node UID 的绑定由受保护的 Owner-backed enrollment receipt 建立；重复或冲突绑定必须拒绝并提供人工可读错误。

### 4.4 DCR 不再逐节点手改源码

正式版不能要求每新增一台节点都修改 `runtimeTarget.ts`、`operation-policy.json`、`wrangler.production.jsonc` 并单独部署 Worker。

应消费现有 Worker/DO 与私有 Fleet registry，形成**动态、受 Owner profile 授权的节点能力投影**：

- `node_uid → reviewed transport locator → pinned host identity → capability profile` 是一个原子可审记录。
- 真实路由可以复用 Tailscale 私网/Services、现有 Cloudflare Tunnel/VPC 或已授权 Controller 的受限管理通道；具体选路由私有 Host Owner 负责，但不能引入第三套网络。
- 若当前 Workers VPC/Tunnel binding 只能静态绑定，则必须在发布前解决“单节点一份 Wrangler binding”的扩展瓶颈；不得声称自动纳管已完成，也不得把 Claim 直接写成任意执行权限。
- 节点身份、SSH Host Key pin、Root helper/profile、Job capability、有效期、撤销与回滚需与同一 Node UID 绑定；重复 UID/重复 Tunnel/host-key 漂移 fail closed。
- Provider Token、SSH private key、root secret 不写入 GhostFleet 公共仓、Worker 日志、Issue 或 ChatGPT 消息。模型只获得授权工具调用，不直接获得可导出的长期 root 私钥。

### 4.5 Root 能力是正式纳管目标

Owner 选择 `FULL_MANAGED_LOWER_NODE` 即授权该节点进入既定的 Root-capable Managed profile。执行器沿用现有签名 lease/OS executor/专用 root helper，不建立第二 Root 控制面：

- 完成固定 `root-probe`，持久回执必须报告真实 `execution_privilege=root`、`changed=false`。
- 再验证受委托 Root maintenance session：绑定 Node UID、Actor、Profile generation、范围、有效期与撤销句柄。
- 一次授权后，范围内日常诊断/安装/服务配置等连续 root 操作不逐条弹审批。
- 超出已委托范围的不可逆磁盘/RAID、破坏数据、全局密钥/ACL、毁掉唯一救援路径等操作属于新范围，才请求额外确认。
- 普通 `fleet-job/v1` 的 `NoNewPrivileges=yes` 路径保持独立；不通过 sudoers 意外继承 root。Node 的本地 sudo 配置不能替代 ChatGPT Root lease。
- Root capability 到期/撤销后，Reporter 和 SSH 状态不自动变更；各层分别报告。

## 5. Panel 的最终状态模型

现有 `NodeLifecycle` 和 ADR004 Presence 语义保持不变；新增一个**纳管流程投影**，不能把它写回原有状态字段：

| 阶段 | 面板显示 | 通过证据 |
|---|---|---|
| 0 | `TICKET_ISSUED` | Operator profile、稳定 UID、短码 TTL、artifact pin |
| 1 | `HOST_PREFLIGHT_OK` | 真实目标机 OS/systemd/恢复条件与 root ceremony receipt |
| 2 | `PRESENCE_READY` | 节点专属 reporter claim + 新鲜 heartbeat |
| 3 | `PROVIDER_READY` | TS/CF 原生状态与已审核 UID 映射，或明确记录不需要该 Provider |
| 4 | `TRANSPORT_READY` | 从实际 Controller/获授权 DCR transport 建立新 SSH 会话，host-key pin 匹配 |
| 5 | `DCR_READY` | 当前 ChatGPT 会话 R0 与 typed Job 正向 receipt，准确 Node UID/policy revision |
| 6 | `ROOT_READY` | root-probe + Owner-delegated Root session 实际回执 |
| 7 | `FULLY_MANAGED` | 上述必需阶段全绿、无 UNKNOWN、恢复路径已验证 |

错误应明确区分 `BLOCKED`、`RETRYABLE`、`UNKNOWN`、`REVOKED`；不允许失败自动 re-enroll/new UID。用户可在 Panel 看到阻断阶段、简短原因、下一步动作和 repair/resume 入口。

## 6. 正式版验收：搬瓦工真实节点

**不使用虚拟机。** 第一轮使用真实搬瓦工 VPS，第二轮才进入国内生产力服务器。

### Canary 验收顺序

1. **干净基线**：记录实例别名、当前 Node UID（若已存在）、OS/内核、SSH 端口、host-key fingerprint、数据/业务可恢复性、当前 Tailscale/Cloudflare 状态。不要先重装/清盘。
2. **真实 Panel**：在搬瓦工 VPS 的可信纳管入口输入域名。Operator 在生产候选 Panel 中匹配设备请求并手动签发 `FULL_MANAGED_LOWER_NODE` 短码。
3. **一次 Root 引导**：在目标机输入短码。入口获取并校验独立的引导制品，用本次配对凭据完成领取。其余 UID、公钥、Tunnel ID 和策略数据均沿已授权流程传递。
4. **自动完成**：bootstrap preflight、claim、host provisioning、Provider reuse、SSH host-key pin、DCR dynamic catalog/capability、Root helper/lease、heartbeat。每步有持久 receipt。
5. **ChatGPT 正向验证**：当前普通 ChatGPT 对话 list_nodes → node.inspect → nonroot `/usr/bin/id` → fixed root-probe → Root session 两条连续无害命令，回执全部绑定同一 Node UID。
6. **负测**：短码过期/错误次数锁定、重复 Claim、下载摘要不符、Provider API 不可用、DNS/Edge/Origin 区别、host-key 漂移、策略撤销、Root lease 到期/撤销、Worker 版本回退、安装中断恢复。
7. **清理与复测**：仅清理本次明确创建的 canary 资源；保留原有 SSH/业务路径；重启/重新登录后复核 Node UID、reporter、Provider、DCR 与 Root session。写入 #11/#300 的完整凭据和准确版本。

### 国内生产力服务器 rollout

搬瓦工 Canary 通过后，国内生产力服务器按一台一批使用同一个 `FULL_MANAGED_LOWER_NODE` profile：
- 先自动探测并复用其已有 TS/CF，不能为了统一形式重装或更换身份。
- 本批国内服务器仍使用 `MANAGED_ONLY` 下位机 profile。Controller 资质与冗余是实例拓扑的独立验收，不随首次纳管授予。
- 生产节点必须在同一授权流程内完成存储/业务服务的本地只读预检。OMV8/NAS 继续使用专用 Phase 0，不能把普通 Debian 检查当作 RAID/共享数据安全证明。
- 每台节点的 DCR/Root 真实 ChatGPT receipt 通过后才算 FULLY_MANAGED；批次间保留回滚与停发开关。

## 7. 失败恢复与安全边界

- Ticket/Claim 响应不确定：查原 ticket/Node UID，不能重发为新节点。
- Provider 已注册但 DCR 未发布：保留 Provider 身份，修复同一 Node UID，不重新 join。
- Host Key 已更新但 DCR 未同步：停止连接并通过可信 Host channel 核对，不能关闭 host-key checking。
- DCR 已发布但 Root helper 未安装：节点为 `DCR_READY` 而非 `FULLY_MANAGED`，在同一授权范围内 resume。
- Root lease 到期/撤销：结束后续 Root 操作，保留审计与可重新授权入口；不撤销独立 Reporter/SSH，除非 Owner 另行操作。
- 不允许 Claim 自己改写全局 Tailnet ACL、Cloudflare Access、Worker actor scopes 或 Controller role。
- 不允许自动清理未归本流程所有的文件、密钥、Tunnel、磁盘、挂载和业务数据。

## 8. 职责与交付边界

- **GhostFleet #11 / 公共仓**：Panel UI、ticket/短码、安装器固定摘要、流程状态投影、恢复体验、公开 Provider evidence contract 与端到端验收合同。
- **ai-hub #300 / 私有 Fleet**：Provider OAuth/Token、真实 UID↔Provider 绑定、动态 DCR catalog/route/policy、SSH host identity、Root helper/lease、生产 Worker 与 Host 部署。
- **现场工头**：搬瓦工真实 canary、随后国内生产节点的现场执行；按阶段提交 exact source/runtime/receipt。
- **架构师**：源码/测试/协议/文档、跨仓一致性审查、阻断条件收敛。
- **私有实例 owner**：维护已授权 Controller 集合、独立身份、目标范围、接替与恢复证据；本批真实 VPS 和后续生产节点仍是 Managed 下位节点。

## 9. 不纳入本次正式版

不引入第二 overlay 网络、第二身份签发器、第二数据库、常驻通用 Node Agent、另一套命令队列/审批卡、独立 Guardian、定制文件传输服务或逐节点静态 Worker 源码分支。

### English summary

The first end-to-end acceptance target is a **real Bandwagon VPS, not a VM**. The selected test and rollout hosts remain managed-only lower nodes. Controller cardinality, qualification and scoped failover belong to the private instance topology. Each controller uses independently revocable credentials; takeover of an exclusive resource follows the existing Work ownership, generation/fencing and UNKNOWN-reconciliation contract. Neither a heartbeat nor local root grants Fleet control. The prior single-controller scope is historical, not a permanent product constraint or evidence of completed isolation. On the target, open the trusted enrollment client and enter the enrollment domain. In the Panel, match the pending request and manually issue a six-character code valid for ten minutes. Enter the code in the client. The client fetches the pinned bootstrap and binds the claim to that device's pairing proof. The existing stack then handles provider reuse, SSH/DCR, the signed root helper and actual ChatGPT R0, Job and consecutive delegated root receipts. New nodes must not require per-node source edits or manual Worker/Tunnel setup. Only a fresh real ChatGPT end-to-end receipt can mark a node FULLY_MANAGED.
