# ADR 006 — 节点身份、服务端点与被动连通性证据

状态：**ARCHITECT_ACCEPTED_SOURCE_ONLY / NO_PRODUCTION_AUTHORITY**  
日期：2026-11-21  
决策入口：[GhostFleet #3](https://github.com/youling/ghostfleet/issues/3) · 产品主线 [#11](https://github.com/youling/ghostfleet/issues/11) · 传输验收 [#36](https://github.com/youling/ghostfleet/issues/36) · 权限边界 [#64](https://github.com/youling/ghostfleet/issues/64)

## 1. 结论：KEEP / CHANGE / DEFER / REJECT

| 提案 | 架构裁决 | 具体归属 |
| --- | --- | --- |
| Stable Node Identity + Locator | **KEEP / EXTEND** | 公共 GhostFleet 只读契约，复用现有 Fleet `node_uid`，不另 mint |
| `HostServiceEndpoint(service_ref, namespace_ref)` | **CHANGE / SOURCE_ONLY** | 公共事实模型与纯校验器；实际绑定由私有 Host owner 提供 |
| 被动连通性/服务健康 | **KEEP / STAGE** | 下一阶段版本化、预算受限的一次性观测；不能改 ADR004 v1 心跳格式 |
| 常驻 Guardian、重启隧道、FIB/默认路由自愈 | **DEFER** | 私有 Host owner 的独立 opt-in 实验；有实机收益/负控再议 |
| 统一 node-agent、第二路由/网络管理器、旧 Adaptive Router | **REJECT** | 不恢复旧 PR #67 或自建管理平面 |
| Node Capability Discovery | **KEEP / SPLIT** | 公共：自报可观测能力事实；私有 Fleet：授权、版本/可信度与接单准入 |
| 每 Job Ephemeral TS/OIDC 身份 | **DEFER EXPERIMENT** | ai-hub Runner owner 的工作负载专属身份；不得继承 Host/Controller |
| JG/TP 自建 Runner 与 CI 迁移 | **KEEP / PARALLEL** | ai-hub #339/#374/#404 原 owner；不等待本 ADR |

此 ADR 是 **M0 范围裁决和 M1 纯离线事实候选**，不是实例部署证明。原生 OpenSSH、Tailscale、Cloudflare Tunnel、systemd、当前网络管理器仍拥有执行职责。GhostFleet 不建立新的远程命令、ACL、密钥、重试队列、IPAM 或命令审计引擎。

## 2. 唯一身份、可变地址与服务端点

三个不能相互替代的概念：

- **节点身份**：Fleet 唯一 `node_uid`。绝不由网卡 MAC、DHCP IP、Tailscale IP、MagicDNS、Tunnel UUID、hostname、同一 SSID 或报告凭据反推/重新发行。
- **服务逻辑身份**：`service_ref`（如 `host-proxy`）、`namespace_ref`（指服务被消费的逻辑隔离域，如 RootlessKit worker）、`purpose_ref` 与 `caller_ref`。**应用逻辑 namespace ≠ Linux network namespace**；后者只是实现细节。
- **端点定位证据**：`locator_ref` 是私有 owner 持有的**不透明索引**，不是 URL/IP/Socket 路径；绑定类型可以是 `unix_socket`、`http_connect`、`private_ipv4`、`mesh` 或 `tunnel`。来源、有效期与路径/目标身份证据单独记录；地址更换应更新定位事实，不改变 node_uid。

现役 ai-hub PR #407 使用经 Host Owner 验证的本机 RFC1918 地址、root-owned 配置与 RootlessKit 网络隔离。**保留此合同**。不因为想统一端点而硬设 `10.200.0.1` 或放宽 `--disable-host-loopback`。验证容器可达性必须发生在**实际 RootlessKit 隔离命名空间**，不能用宿主自身 curl 成功替代。

## 3. M1 最小公开接口（不执行）

`src/control-plane/endpoint-evidence.js` 的唯一职责：

```text
inspectEndpointEvidence(
  {node_uid, service_ref, namespace_ref, purpose_ref, caller_ref},
  evidence[], now_ms
)
  -> {state, candidate_refs, authorization:"NOT_EVALUATED",
      network_connectivity_effect:"NONE", execution_effect:"NONE"}
```

候选输入是已从私有 owner 获取的**离线证据副本**；它只能描述“来源声称某个端点在某时间和命名空间可达”。模块不验证来源签名、不读取真实地址、不查 provider、不登录节点、不触碰网络、不返回可直接连接的 URL。字段枚举及数量/时间/格式有限；错误只给稳定代码，不回显原始输入。

- 任一目标身份证据冲突 → `IDENTITY_CONFLICT`，返回零候选。
- 同一请求出现明确的 `DENIED` → `DENIED`，**禁止切换 CF/LAN 路径绕过该准入拒绝**。
- 过期、未来时间、UNKNOWN、未验证身份或无对应证据 → `UNKNOWN`，零候选。
- 只有完全匹配、期限内、路径自称可达且目标 pin 有受审证据时，返回 `CANDIDATE_EVIDENCE_ONLY` 和排序后的不透明 `candidate_refs`。

**任何返回值都不是 permission/grant。** 原始证据不能自授可信身份；实际连接前，私有 Fleet/Host 必须通过独立的 Operator 身份、真实 Policy、host-key/TS/CF 目标证明与终端命名空间探针校验。此模块永远不调用、选择或自动回退执行中的 SSH 命令；`MAY_HAVE_EXECUTED/UNKNOWN` 结果必须由原执行方先对账，不能按 locator 自动重发。

## 4. M2 供应商事实优先：观察不是 Guardian

**2026-11-21 的复用纠偏：先问 Tailscale/Cloudflare 已经知道什么，再决定 GhostFleet 是否需要自己上报。** 完整审查见 [TS/CF Provider-first 能力复用地图](../research/TS_CF_PROVIDER_REUSE_2026-11-21.md)。

- **Tailscale 本身拥有设备连接状态。** 优先使用 Admin Devices API 的 `connectedToControl`（不是把 `lastSeen` 当心跳）、设备身份/Tag/密钥事件和受信本机 `tailscale status --json`。公开 GhostFleet 不复制 Device Registry，不凭设备名/IP 自动绑定 `node_uid`，私有 Fleet 维护审过的映射与最小只读权限。
- **Cloudflare 本身拥有 Tunnel→Edge 状态。** 优先使用官方 `healthy/degraded/down/inactive` 与 Health Alert 通知/只读 API；Healthy 不能证明 origin SSH 可靠，也不能代替 Access 身份策略。TS Webhook 目前覆盖设备增删/批准/密钥事件等，不能假定提供通用 online/offline 推送。
- **Tailscale Services 已提供部分跨宿主稳定服务发现/路由。** 优先审查其 MagicDNS/TailVIP、Host approval/drain 和多宿主机制，**不要为同一用途再造 Adaptive Router**。它要求 tag-based Service Host，RootlessKit 命名空间、ACL/端口与多网卡可达仍需独立实验；不替代 Host owner 的本地 namespace 安全验证。
- **GhostFleet 只补真实缺口。** 本机 service manager 的单位状态、boot_id、任意未装 TS/CF 节点的独立出站见证，以及 TP/可信 Operator 的全新 SSH 认证证据，与 TS/CF 控制面状态不同。视图必须展示 `reported_presence`、`provider_state`、`local_unit_state`、`authenticated_path_state` 和 `job_admission` 各自的来源/时效；**ONLINE ≠ SSH READY ≠ JOB ADMISSIBLE**。
- **现役 ADR004 heartbeat/v1 不动。** 严格 4KiB、Python one-shot + systemd Timer 和既有 server-side freshness 阈值仍是当前生产合同。先做 48–72 小时有界只读 Shadow 对照：TS devices 控制面、CF Tunnel 事件/API、GhostFleet heartbeat/三个 systemd unit 和少量获准的独立 SSH 对照。量化误判/迟到/缺测、Token/轮询成本及独立可用性；完成前**不开发 heartbeat/v2、不降频或停止 reporter**。后续如采用可选的 provider-only 与 host-augmented 模式，仍需单独兼容性/用户授权。
- 无有效观测时只报 `UNKNOWN/STALE`：Provider API 超时、缓存/事件延迟、客户端未授权、CF down、TS session 过期都不能通过单一绿灯推断主机死亡或登录可用。不同 systemd manager 的 `not_found` 只表示该 manager 未找到，不等于服务不存在。
- **不自动修网。** 优先利用 NetworkManager/systemd-networkd/ifupdown、systemd Restart、TS roaming/DERP、CF Tunnel replicas；网络管理单一写主。只有上游原生恢复实测不足才为特定 unit 申请 L2 独立 opt-in Guardian，要求次数上限、冷却、熔断和带外恢复；普通观察循环不得写 FIB、DHCP、Tailnet ACL、TS 重新登录、CF Access 或密钥。

## 5. Runner 消费边界

不要合并三种身份：Host 的 Fleet `node_uid`、一次 GitHub Runner registration/attempt、每 Job 的可选短命 TS device。Github Runner 监听器**先**需要出站 HTTPS 443 接单；工作流内 Tailscale Action 不能补偿启动前断网。Job TS 使用 OIDC、独立 `tag:ci-ephemeral`、专用数据端口白名单和失联清理证据。Userspace networking 是 SOCKS5/HTTP proxy，不代表任意 rootless 程序自动透明 TUN；Exit Node 也必须有真正可用的异地互联网出口。

现役 #64 A09 Tailnet allow-all 未解决之前，不把执行第三方代码的 Job 接入生产 Tailnet。此试验不作为 JG/TP 单机 Runner E2E 或两机调度的前置。普通 CI 使用本地可信 Runner，紧急构建仍保留不依赖 GitHub Actions 控制面的受控入口。

## 6. 事实、责任与验收

| 对象 | 公共 GhostFleet | 私有 Fleet / Host / Runner |
| --- | --- | --- |
| 节点身份 | `node_uid` 格式与注册/心跳语义 | 真实 UID ↔ 资产、注册来源及 Host 证明 |
| Locator | 规范、离线分类、候选证据 | 实际接口地址、Socket 路径、TS/CF 绑定、时序来源 |
| HostServiceEndpoint | 不透明引用与命名空间隔离契约 | 具体 RootlessKit/UDS/Proxy gateway、Host owner 校验 |
| Connectivity | 一次性采样/原因状态与版本格式 | 真实健康采集、外部握手、网络恢复所有权 |
| Capability | **声称**的工具/运行时、版本、置信来源 | signed policy、JIT/Helper、DCR scope、Job admission |
| Runner | 短命身份语义 | 注册/派单、GitHub OIDC、TS 配置、CI/disk 清场 |

**M1 验收反例**：两物理网卡 + Wi-Fi 切换；克隆 heartbeat token；同名/重复子网；重新入网/host-key 更换；跨 namespace 借道；证据过期、未来时间、错误来源；TS policy DENY 但 LAN 存在；身份不匹配时不得继续。**M2** 加入 TS direct↔DERP、CF Edge healthy/origin down、system/user manager not_found、网络全断与重复故障观察。M3 L2/M4 Job TS 继续 HOLD，不能从 M1 合成测试自动升级。

**所有现有生产配置保持不变。** 不添加 daemon、网络管理器、systemd unit、Tailnet tag/Policy、Cloudflare 应用、Runner Job 令牌或 Workflow；不创建新 Control Plane、身份签发器或数据平面。

### English summary

GhostFleet may own stable identity semantics and bounded, read-only endpoint/connectivity evidence. Real locators, authorization, network-route writers, credential custody and Runner deployment stay with their current private owners. The offline M1 helper returns opaque candidate references **only**, never a network address, authorization or execution permission. Existing ADR004 heartbeat/v1 and native transport remain unchanged. An always-on Guardian and per-job Tailscale are independent opt-in research gates, not prerequisites to current CI deployment.

上游参考：GitHub 官方《Self-hosted runners reference》（HTTPS 443 出站要求） · [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking) · [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action) · [Tailscale ephemeral nodes](https://tailscale.com/docs/features/ephemeral-nodes) · [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/observability/)。
