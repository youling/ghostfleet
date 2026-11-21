# ADR 006 — 节点身份、服务端点与被动连通性证据

状态：**ARCHITECT_ACCEPTED_SOURCE_ONLY / NO_PRODUCTION_AUTHORITY**  
日期：2026-11-21  
决策入口：[GhostFleet #3](https://github.com/youling/ghostfleet/issues/3) · 产品主线 [#11](https://github.com/youling/ghostfleet/issues/11) · 传输验收 [#36](https://github.com/youling/ghostfleet/issues/36) · 权限边界 [#64](https://github.com/youling/ghostfleet/issues/64)

## 1. 结论：KEEP / CHANGE / DEFER / REJECT

| 提案 | 架构裁决 | 具体归属 |
| --- | --- | --- |
| Stable Node Identity + Locator | **KEEP / EXTEND** | 公共 GhostFleet 只读契约，复用现有 Fleet \`node_uid\`，不另 mint |
| \`HostServiceEndpoint(service_ref, namespace_ref)\` | **CHANGE / SOURCE_ONLY** | 公共事实模型与纯校验器；实际绑定由私有 Host owner 提供 |
| 被动连通性/服务健康 | **KEEP / STAGE** | 下一阶段版本化、预算受限的一次性观测；不能改 ADR004 v1 心跳格式 |
| 常驻 Guardian、重启隧道、FIB/默认路由自愈 | **DEFER** | 私有 Host owner 的独立 opt-in 实验；有实机收益/负控再议 |
| 统一 node-agent、第二路由/网络管理器、旧 Adaptive Router | **REJECT** | 不恢复旧 PR #67 或自建管理平面 |
| Node Capability Discovery | **KEEP / SPLIT** | 公共：自报可观测能力事实；私有 Fleet：授权、版本/可信度与接单准入 |
| 每 Job Ephemeral TS/OIDC 身份 | **DEFER EXPERIMENT** | ai-hub Runner owner 的工作负载专属身份；不得继承 Host/Controller |
| JG/TP 自建 Runner 与 CI 迁移 | **KEEP / PARALLEL** | ai-hub #339/#374/#404 原 owner；不等待本 ADR |

此 ADR 是 **M0 范围裁决和 M1 纯离线事实候选**，不是实例部署证明。原生 OpenSSH、Tailscale、Cloudflare Tunnel、systemd、当前网络管理器仍拥有执行职责。GhostFleet 不建立新的远程命令、ACL、密钥、重试队列、IPAM 或命令审计引擎。

## 2. 唯一身份、可变地址与服务端点

三个不能相互替代的概念：

- **节点身份**：Fleet 唯一 \`node_uid\`。绝不由网卡 MAC、DHCP IP、Tailscale IP、MagicDNS、Tunnel UUID、hostname、同一 SSID 或报告凭据反推/重新发行。
- **服务逻辑身份**：\`service_ref\`（如 \`host-proxy\`）、\`namespace_ref\`（指服务被消费的逻辑隔离域，如 RootlessKit worker）、\`purpose_ref\` 与 \`caller_ref\`。**应用逻辑 namespace ≠ Linux network namespace**；后者只是实现细节。
- **端点定位证据**：\`locator_ref\` 是私有 owner 持有的**不透明索引**，不是 URL/IP/Socket 路径；绑定类型可以是 \`unix_socket\`、\`http_connect\`、\`private_ipv4\`、\`mesh\` 或 \`tunnel\`。来源、有效期与路径/目标身份证据单独记录；地址更换应更新定位事实，不改变 node_uid。

现役 ai-hub PR #407 使用经 Host Owner 验证的本机 RFC1918 地址、root-owned 配置与 RootlessKit 网络隔离。**保留此合同**。不因为想统一端点而硬设 \`10.200.0.1\` 或放宽 \`--disable-host-loopback\`。验证容器可达性必须发生在**实际 RootlessKit 隔离命名空间**，不能用宿主自身 curl 成功替代。

## 3. M1 最小公开接口（不执行）

\`src/control-plane/endpoint-evidence.js\` 的唯一职责：

\`\`\`text
inspectEndpointEvidence(
  {node_uid, service_ref, namespace_ref, purpose_ref, caller_ref},
  evidence[], now_ms
)
  -> {state, candidate_refs, authorization:"NOT_EVALUATED",
      connectivity_effect:"NONE", execution_effect:"NONE"}
\`\`\`

候选输入是已从私有 owner 获取的**离线证据副本**；它只能描述“来源声称某个端点在某时间和命名空间可达”。模块不验证来源签名、不读取真实地址、不查 provider、不登录节点、不触碰网络、不返回可直接连接的 URL。字段枚举及数量/时间/格式有限；错误只给稳定代码，不回显原始输入。

- 任一目标身份证据冲突 → \`IDENTITY_CONFLICT\`，返回零候选。
- 同一请求出现明确的 \`DENIED\` → \`DENIED\`，**禁止切换 CF/LAN 路径绕过该准入拒绝**。
- 过期、未来时间、UNKNOWN、未验证身份或无对应证据 → \`UNKNOWN\`，零候选。
- 只有完全匹配、期限内、路径自称可达且目标 pin 有受审证据时，返回 \`CANDIDATE_EVIDENCE_ONLY\` 和排序后的不透明 \`candidate_refs\`。

**任何返回值都不是 permission/grant。** 原始证据不能自授可信身份；实际连接前，私有 Fleet/Host 必须通过独立的 Operator 身份、真实 Policy、host-key/TS/CF 目标证明与终端命名空间探针校验。此模块永远不调用、选择或自动回退执行中的 SSH 命令；\`MAY_HAVE_EXECUTED/UNKNOWN\` 结果必须由原执行方先对账，不能按 locator 自动重发。

## 4. M2 观察不是 Guardian

第一步保留 ADR004 的 Python oneshot + systemd Timer：

- 版本化扩展候选 **heartbeat/v2**，绝不往当前严格 4KiB \`heartbeat/v1\` 塞字段或放松已有验证。
- 分别观察 \`reported_presence\`、正确 system/user manager 的 \`local_unit_state\`、Tailscale/Cloudflare 的 \`provider_state\`、独立客户端的 \`authenticated_path_state\`，再另行展示 \`capability_claim\` 与 \`job_admission\`。**ONLINE ≠ SSH READY ≠ JOB ADMISSIBLE**。
- 记录 \`source\`、\`observed_at\`、\`boot_id\`、有效期和有限错误代码。不同管理器的 \`not_found\` 只表示该 manager 未发现服务；\`unknown\` 不等于服务未安装。
- 网络变化时只读观察 carrier/route ownership、provider 状态、SSH listener 和出站心跳；采样预算/退避/抖动与短期脱敏本地证据，不上传原始 netmap、IP、密钥、全部路由表或业务目录。
- 本机无法证明“远端仍能 SSH 进入”；需要 TP/可信 Operator 独立新会话验证。无可用上游或远端失联只报告 \`UNKNOWN/DEGRADED\`，不承诺持续拥有 default route。

若 L0（NetworkManager/systemd-networkd/ifupdown、systemd Restart、tailscaled/cloudflared 原生恢复）不足，**才**为单一已审自有 unit 研究 L2。禁止普通守护循环自动重写 FIB/默认路由、DHCP、路由器、ACL、TS re-auth、Access、密钥或重启所有入口；系统网络配置必须有唯一 owner。新增常驻 Guardian 须新 ADR、独立身份/最小权限、冷却/熔断/次数上限、Owner 授权和可验证回滚。

## 5. Runner 消费边界

不要合并三种身份：Host 的 Fleet \`node_uid\`、一次 GitHub Runner registration/attempt、每 Job 的可选短命 TS device。Github Runner 监听器**先**需要出站 HTTPS 443 接单；工作流内 Tailscale Action 不能补偿启动前断网。Job TS 使用 OIDC、独立 \`tag:ci-ephemeral\`、专用数据端口白名单和失联清理证据。Userspace networking 是 SOCKS5/HTTP proxy，不代表任意 rootless 程序自动透明 TUN；Exit Node 也必须有真正可用的异地互联网出口。

现役 #64 A09 Tailnet allow-all 未解决之前，不把执行第三方代码的 Job 接入生产 Tailnet。此试验不作为 JG/TP 单机 Runner E2E 或两机调度的前置。普通 CI 使用本地可信 Runner，紧急构建仍保留不依赖 GitHub Actions 控制面的受控入口。

## 6. 事实、责任与验收

| 对象 | 公共 GhostFleet | 私有 Fleet / Host / Runner |
| --- | --- | --- |
| 节点身份 | \`node_uid\` 格式与注册/心跳语义 | 真实 UID ↔ 资产、注册来源及 Host 证明 |
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
