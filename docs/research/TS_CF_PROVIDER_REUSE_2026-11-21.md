# Tailscale × Cloudflare 上游能力复用地图（2026-11-21）

性质：**SOURCE_RESEARCH / DESIGN_ONLY / NO_PROVIDER_MUTATION**。由 GhostFleet #3 的 M2 架构研究接续，不新增平行控制面，不授权读取真实 Provider Token、改动 TS/CF、停止心跳、修改 Tailnet Policy 或上线自动修复。

## 1. 核心裁决：Provider-first，Host observation on demand

Tailscale 与 Cloudflare 已经是节点网络身份、设备连接状态、隧道接入状态的原始事实拥有者。GhostFleet 不应为这些同义字段再建一套自有状态真值；应把上游读回当作带来源、时刻、期限、可信边界的 evidence，按既有不可变 `node_uid` 做**经人工确认的映射**。

但 GhostFleet 不是 TS/CF Dashboard 的另一个皮肤：它还承担**跨提供商的独立节点身份、上报凭据、非 TS 用户/设备支持、Linux 本机特定服务状态与独立管理端 SSH 验收证据**。这部分 TS/CF 不能天然提供。

**本次决策不废除 ADR004 心跳。** 现役 `ghostfleet-heartbeat/v1` 是一个可独立于 TS/CF 凭据存在的出站见证：每 60 秒 one-shot，严格 4KiB JSON，报告 boot_id、reporter_version、ssh/cloudflared/tailscaled 三个指定 systemd system-manager unit；服务端接收时间为新鲜度权威。它确实与 Provider 对“在线”的部分语义重叠，但不应未经对照实验就删除、延长周期或偷偷新增 `heartbeat/v2`。下一阶段先提供 *provider-only view* 与 *host-augmented view* 的可选观察，证明各字段来源和差异，再决定心跳降频/可选安装。

## 2. 功能清单：直接用谁的能力

| 事实或能力 | 原始拥有者 / 官方入口 | GhostFleet 新增应否承担 | 不可推导的事 |
| --- | --- | --- | --- |
| TS 设备 ID、Tag、OS、版本、Tailnet 地址、是否连接协调面 | Tailscale Machines、Devices API，`GET /api/v2/tailnet/{tailnet}/devices` | **只读映射**，不复制设备注册/密钥管理 | TS connected 不等于 sshd/业务/Raid 正常 |
| TS 设备当前连接 | `connectedToControl`（Devices API），或受信客户端 `tailscale status --json` 的 `Online` | API 为 Provider 状态一手来源；不再用自有 heartbeat 证明“TS 在线” | 不能把 `lastSeen` 当持续刷新心跳 |
| TS Last Seen、Key 失效、加入/删除/授权 | Devices API；管理 Webhook `nodeCreated`/`nodeDeleted`/`nodeApproved`/`nodeKeyExpired` | 消费只读结果；Webhook 校验签名后仅触发重新对账 | 官方 Webhook 当前**无通用 nodeConnected/nodeDisconnected** 事件，不用它代替在线状态查询 |
| TS direct / DERP / 网络条件 | 本机 `tailscale status --json`、`tailscale netcheck`、TS ping | 有界、按需、从指定受信客户端诊断，不上传私有原始 netmap | 控制面 API 在线不代表本机到指定对端直连或 ACL 放行 |
| CF Tunnel healthy/degraded/down/inactive | Cloudflare Tunnel API、Tunnel dashboard | **复用原状**，不自建另一套 Tunnel heartbeat | Tunnel→Edge healthy 不等于源站服务/SSH origin reachable |
| CF Connector 版本、Edge 连接/colo、配置源 | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections`，Tunnel/configurations 只读读回 | 只保留有限状态与配置散列/时间；真实 Tunnel UUID 留私有 | 接入边缘 ≠ DNS/Access App/SSH 端到端成功 |
| CF Tunnel 状态变化通知 | Cloudflare `Tunnel Health Alert`（Webhook、邮件等；所有 Zero Trust 计划） | 优先接收已验真的 Provider 通知 + 定期 API 对账，不自行分钟级重复探测 | Webhook 迟到/丢失、Dashboard 状态过期时不能当实时 SSH 证明 |
| CF 身份和审计 | Cloudflare Access App/Policy、Access authentication/per-request logs | 对准入判定读取相应审计证据，不自己实现 IdP | Access Allow ≠ sshd authenticated；非身份类日志可能走 GraphQL |
| 服务发现和多宿主切换 | **Tailscale Services**：`svc:` 名称、TailVIP、MagicDNS、Service host/approval/drain、服务状态 | **优先采用上游服务语义**，不自建动态路由器 | Service Connected/advertising 不等于 L7 端到端；有版本、Tag、TCP 和多网卡限制 |
| 单机私有应用发布 | Tailscale Serve（Tailnet 内），CF Published Application（CF 外网 + Access） | 作为已存在的 Provider 端点选项；不新建公私转换代理 | Serve 不能自动解决 RootlessKit 的命名空间穿越；Funnel 是**公网发布**不等同 Serve |
| 本机 systemd unit、boot_id、主机服务、NAS 业务健康 | Linux systemd/journald、本机实际管理器，必要时 GhostFleet oneshot | **保留最小补充**，核对真实 manager 与快照时效 | Provider 健康不能证明 RAID/SMB/NFS/Docker/sshd 正常 |
| 目标 SSH 身份、公钥、root exec/SFTP | 原生 OpenSSH、从 TP/Operator 的新会话实测 | 与 Provider 状态分层显示，不由 Provider 代替 | 主机 SSH 正测和 Tailnet/CF 准入负测彼此不能替代 |
| 任务是否可以接单、权限、JIT | 私有 Fleet/DCR/Runner Owner + approved Policy | 公共只报能力事实，不授权，不能自 Claim 升格 | TS/CF 在线不等于 DCR 权限或 Job READY |
| 文件传输 | 当前 SSH/SFTP/rsync；TS Taildrop 可研究个人设备文件交互 | 保留 #36 标准传输路径 | Taildrop 目前不支持带 Tag 设备，不能代替 tagged VPS/NAS 的 SFTP |

### 两个容易犯的错误

1. **TS `lastSeen` 不是 60 秒心跳。** Tailscale 2025-10 更新 Devices API 的 `connectedToControl`，且 `lastSeen` 仅在 `connectedToControl=false` 时返回。当前连接状态应优先看明确的布尔字段；缺失/无法读取 = UNKNOWN，不能用上次 `lastSeen` 或 API 请求成功推断 ONLINE。
2. **CF Tunnel Healthy 只是 Connector→Edge。** 官方明确说 Tunnel 健康不包含 Origin 服务状态。Cloudflare Tunnel API 和 Connector list 可以直接复用；端到端 SSH、Access Policy、DNS/hostname、Origin listener 分别验收。Cloudflare API 中连接记录还可能短暂保留断开的连接，不能把记录行数直接当作活跃链路数。

## 3. 有价值的潜在替代：Tailscale Services

这比把网关 IP 统一成某个 `10.200.0.1` 更接近产品诉求。Tailscale Services 可将若干宿主的 TCP 服务映射为**稳定 MagicDNS 服务名和 TailVIP**；服务主机可审批、增加、Drain，并能跨多主机提供服务。服务与设备身份分离，符合 GhostFleet ADR006 的 `service_ref` 方向。

但它**不是**对所有 `HostServiceEndpoint` 场景的直接替代：

- Service Host 必须是 **tag-based identity**；JG 当前 user-bound 是否应迁移另案审批。不能为了抽象统一而擅自变更节点身份。
- 当前仅 TCP；最低支持的宿主客户端版本 1.86.0（文档列出的 prerelease 例外另计）；旧客户端的 `accept-routes` 有差异。
- 官方列有特定多网卡/路由表/SO_MARK 的可达性限制，恰好需对照 JG/TP 多网卡试验。
- OCI RootlessKit `--disable-host-loopback` 使容器不必然访问宿主 Tailnet Service；实际代理/namespace 必须按 Host owner 的原有隔离设计证明，不能复用 TS Services 的“服务已发布”证明容器已可达。
- 现役 A09 Tailnet allow-all 未关闭，不能此刻给不可信 CI Job 开放生产 Services。使用 Tailscale Services 应先明确宿主身份、Service ACL、允许的数据面端口和负控。

建议先把它作为 **Provider-native service candidate**，由原 Host/Runner owner 在独立非生产 TCP 服务上对照已有 root-owned HTTP CONNECT 代理：来源、身份、受限端口、跨宿主可用性、失败/取消、真实 rootless network namespace；无收益不迁移 #407。

另：Tailscale Serve 在 Tailnet 内代理本机服务，并能向 Backend 传身份 Header；**只有后端绑定 localhost、避免被其他网络路径伪造 Header** 时才可考虑把 Header 用于认证。原生 SSH 仍按当前 #64 host-key/authorized_keys 边界。Tailscale SSH 是另一套认证与监听方式，会接管 Tailnet IP 的 22 端口，不能暗改现有 native OpenSSH，更不能直接套用到非标准 8280 端口。

## 4. Provider 证据先行：M2 最小显示契约

同一节点行不是一个大绿灯，而是**分别带来源和时间的事实**：

| 层级 | 推荐字段/取值（只作视图投影） | 原始来源 | 禁止推导 |
| --- | --- | --- | --- |
| provider/tailscale | `CONTROL_CONNECTED / CONTROL_DISCONNECTED / UNKNOWN` | Tailscale Devices API `connectedToControl`；受信本机 CLI `Online` 需另标来源 | Host alive / ACL ACCEPT |
| provider/cloudflare | `EDGE_HEALTHY / EDGE_DEGRADED / EDGE_DOWN / INACTIVE / UNKNOWN` | Cloudflare Tunnel status / notification+API readback | SSH origin、Access Allow |
| host/systemd | `ACTIVE / INACTIVE / NOT_FOUND / UNKNOWN`（按 unit、system/user manager 分） | 现有一轮 reporter/systemctl | TS connected 或 CF Edge 状态 |
| caller-to-target | `SSH_AUTHENTICATED / DENIED / UNKNOWN` | 指定 TP/Operator 的新建、host-key pin 会话 | 其他来源、其他协议 |
| DCR admission | `ADMISSIBLE / NOT_DISPATCHED / UNKNOWN` | 私有 Fleet 当前策略与 capability ledger | 心跳 ONLINE 自动发执行权 |

每条证据的 `source_kind`、`source_revision`、`collected_at`、`provider_event_at`（如有）、`valid_until`、`node_uid` 的**人工审批映射引用**、`scope`、`error_code` 应分开记录。API 拉取时刻不等于服务端真正发生上线/下线的时刻；超时、429、无 Token、旧缓存 = UNKNOWN/STALE，不把失败解析为 DOWN。一个 Provider 的 DENIED 不能因为另一条 LAN 路由可达就自动绕过。

**不另建 TS/CF 管理 SSOT。** 私有 Fleet 保存 `node_uid ↔ TS Device ID` / `node_uid ↔ CF Tunnel/Connector` 已审映射；任何设备重入网、host-key/Tag 迁移或 Tunnel replica 切换都需要证据审查。Reporter Token 的 Claim 也不能自动给 TS/CF 设备或 DCR 执行权限。

## 5. 去重实验：先 Shadow，后 Decide

**Stage A — 只读契约和权限确认（立即）**
- Tailscale 最小推荐 `devices:core:read`；使用短期、受控 OAuth/Trust Credential，不用全权限 API Key。Cloudflare 最小 `Cloudflare Tunnel Read` 或对应 Connector Read，Access 日志单独 `Access: Audit Logs Read`。如业务用不到 Access 审计，不给该 Scope。
- 禁止将凭据放在 GhostFleet 公共仓、Worker 日志、聊天或可被 Node/Job 读取的卷。Provider read adapter 归私有 Fleet/Host owner，不在公开 GhostFleet 里自行请求私有 API。
- 核对实际计划是否支持 Tailscale Services/Webhook/CF 通知，不假设所有可选服务都已启用；若缺权限或接口，标记 NOT_CONNECTED 而非无设备。

**Stage B — 5 台节点 48–72 小时 Shadow（需实例 Owner 单独执行）**
- **不变更** 现有每 60 秒 one-shot heartbeat，不改原 Node ID/TS/CF 权限。将 TS Devices API 设备连接状态（低频采集，建议初始 2–5 分钟，实际频率需看配额）与 CF Tunnel Health 通知+定期 API readback 单独入暂存观察流。
- 对每台节点按时间比较：TS connected、CF Edge status、GhostFleet heartbeat last_seen/systemd snapshot、TP 原生 SSH 独立对照（仅选获准节点及低频无副作用身份命令）。
- 记录缺测率、延迟、相互矛盾比例、上游 API/事件中断、权限/维护成本、实际 CPU/带宽及是否独立识别 TS/CF 双断但一般 HTTPS 仍通等情况。禁用“一个指标推全绿”。
- 试验完成后才决策：① **provider-first** 页面不再用 GhostFleet heartbeat 证明 TS/CF 在线；② **host-augmented** 继续装 one-shot 以观测本机核心 unit；③ 可选 **provider-only** 模式不安装 reporter，但 UI 明确显示 OS service state UNKNOWN。要降频或废除心跳需另行兼容性/安全决策，不原地改 v1 时效阈值。

**Stage C — 逐步消费**
- Cloudflare Tunnel 健康优先使用官方通知，Webhook 须受控、验签/防重放或使用经保护的接收渠道并定期与 API 对账。
- Tailscale Webhook 主要是管理与密钥事件，没有通用 online/offline 事件，不能省去对当前连接状态的读取。
- Worker/DO 展示时使用 Provider Evidence overlay + 原有 Node 记录，不将一个事件变成节点创建/Claim/权限更改。真正迁移之前，必须以 synthetic replay 测丢包、迟到、重放、重复设备、缺失 Token、跨 Tailnet 映射和 Provider 自身故障。

## 6. 不再自己做什么

- 不继续建设独立的云隧道 heartbeat/keepalive；CF Tunnel 已有连接管理、健康枚举与告警。
- 不实现 Tailscale 设备注册/审批、密钥过期或 MAC 固定 IP 机制；复用 Admin API、Webhook、MagicDNS 和现有设备身份。
- 不再为了 Runner 代理自建全舰队动态路由服务；先对照 Tailscale Services/Serve 与现役 #407，容器命名空间和 Host owner 安全规则不能省。
- 不新增“任意网络问题都重启 Tailscale/Cloudflare”的 Guardian。L0 systemd/Provider 原生恢复、网络配置单一写主优先。
- 不改变当前 GhostFleet `heartbeat/v1`、DCR Capability、Tailnet A09 Policy、Cloudflare Access、现役 Runner 作业、SMB/NFS/RAID 或 NAS 敏感服务。

## 7. 对公共/私有仓的交接

**GhostFleet #3/#11**：拥有 Provider-first **事实模型、文档、合成回放契约**；不托管真实 API Token 或设备映射，不签 Node 执行权限。

**ai-hub / Fleet Owner**：拥有私有 Provider 只读 OAuth Token、真实设备/隧道绑定、Shadow 实验、旧新采样对照与授权结果；不能让任意新设备由“TS API 存在”自动写入 DCR 控制目录。

**Runner Owner**：保留现役 JG/TP 出站代理与双机 CI 主工作线；只有合规 Tailnet ACL、可复核服务需求和实测命名空间可达才研究 per-job TS 或 Tailscale Services。

### 参考原始来源

- [Tailscale API](https://tailscale.com/docs/reference/tailscale-api) · [Trust Credential scopes](https://tailscale.com/docs/reference/trust-credentials) · [Machines filters](https://tailscale.com/docs/features/access-control/device-management/how-to/filter)
- [Tailscale 官方 Changelog：2025-10-08 Devices API](https://tailscale.com/changelog) · [Tailscale Webhooks](https://tailscale.com/docs/features/webhooks)
- [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) · [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) · [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh) · [Taildrop](https://tailscale.com/docs/features/taildrop)
- [Cloudflare Tunnel Observability/Notifications](https://developers.cloudflare.com/tunnel/observability/) · [Tunnel API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/) · [Tunnel Connections](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get/) · [Origin troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/)
- [Cloudflare Access authentication logs](https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/access-authentication-logs/)

### English summary

**Provider-first, not provider-only.** Use Tailscale Devices API (`connectedToControl`) and Cloudflare Tunnel status/health notifications as authoritative *provider connection* evidence; they do not prove host health, identity authorization or authenticated SSH. Keep GhostFleet's stable node identity and minimal optional host observation, but stop using its own heartbeat to infer Tailscale/Cloudflare network health. Tailscale Services should be evaluated before building any cross-host service router; service hosts must be tagged and real RootlessKit namespaces still require independent reachability/security verification. Keep the existing reporter unchanged through a time-bounded, read-only shadow comparison before deciding whether to downshift or make it optional.
