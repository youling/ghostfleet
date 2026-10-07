# Transport Namespace & Adaptive Link Layer — Phase 2 真实链路对象建模

- Issue: https://github.com/youling/ghostfleet/issues/36（原 #33 已删除；Fleet commit comment `203835259` 记为历史 superseded）
- 前置：Phase 1 研究报告（fleet `issue33-transport-namespace` 分支），Architect review commit comment `203835259`
- 日期：2026-10-07
- 状态：Research 证据；Phase 2 已由 #36 comment 6036252158 通过，冻结事实维度与不变量，不冻结最终代码名/枚举/URI scheme/算法。

## 0. 已内化的两条裁决修正

1. 不再以"多个进程共享同一 :22"作为事实模型。正确分层是 **plane（网络平面）→ locator（寻路名/地址）→ listener（实际监听进程）**，端口只是 listener 的属性，不能反推 plane/authority。
2. `identity_proof` 必须分层：caller authentication/authorization（Access policy、OAuth、service token）与 target identity proof（pinned SSH host key / provider_ref+tag 绑定）是两类证据，不得混为一类。

## 1. 案例 A：Cloudflare machine-control（Fleet steady-state）

| 字段 | 事实 |
| --- | --- |
| provider | Cloudflare（CF-B control ingress） |
| network plane | Workers VPC（`cf1:network` / direct tunnel），cloudflared 出站长连 |
| locator | `controlHostname(node_uid, suffix)` 或 `NODE_<uid>` VPC binding name（`typed-control/src/routing.ts`） |
| listener | 节点上 loopback 的 OpenSSH sshd（被 cloudflared 转发指向） |
| caller authentication | Worker 侧 OAuth 2.0/PKCE + Cloudflare Access owner 校验；Service Binding 仅 Worker↔Worker |
| authorization/authority | MCP scopes（`fleet.read/operate/exec/privileged`）；`actor_ref=sha256(authKind:userId)` |
| target identity proof | pinned SSH host key（algorithm+SHA256，`sshClient.ts`）+ exact node/provider binding |
| failure domain | Workers/VPC binding 缺失（`CONTROL_VPC_BINDING_MISSING`）、cloudflared service down、loopback sshd down；各自独立 |
| Human/AI 可见表示 | Worker URL / MCP tool 目录（`fleet.exec` 等 typed tool） |
| durable evidence 允许保存 | actor_ref、operation receipt（sanitized）、provider binding 摘要；不存 locator、不存节点真实 IP/hostname |

证据来源：`packages/typed-control/src/{transport.ts,sshClient.ts,cloudflareBackend.ts,workersSocketStream.ts,routing.ts}`、`fleet/20_control_plane/cloudflare/worker/src/{index.ts,mcp.ts,routing.ts}`。

## 2. 案例 B：Tailscale Human maintenance

| 字段 | 事实 |
| --- | --- |
| provider | Tailscale |
| network plane | tailnet（WireGuard 直连优先，DERP 中继兜底） |
| locator | node_uid → exact `management_provider_refs.tailscale` → 当前 peer（必须带 `tag:fleet-ssh-target`），`TailscalePeer.machine_name` 仅 runtime locator |
| listener | Tailscale IP:22 上由 Tailscale 接管的 netstack SSH server（Tailscale SSH）；或 native OpenSSH 通过 tailnet 可达 |
| caller authentication | Tailscale ACL（Human identity / check mode 强制周期性重新认证） |
| authorization/authority | tailnet policy SSH access rules（`src/dst/users/action`）；Fleet 侧 `TransportMode.NORMAL` 要求 provider_ref + service tag 唯一匹配 |
| target identity proof | Tailscale SSH 路径：JIT `ssh_known_hosts` + Tailscale 分发的 host key；native OpenSSH 路径：pinned host key（禁 accept-new/TOFU） |
| failure domain | tailnet 连接失败 / DERP 降级 / Tailscale SSH disabled（BWH canary 当前刻意如此）/ native sshd 不可达 |
| Human/AI 可见表示 | MagicDNS hostname / `tailscale ssh user@host` |
| durable evidence 允许保存 | node_uid、provider_ref 摘要、tag 校验结果、pinned host key 摘要；runtime locator 不进 durable |

证据来源：`transport_resolution.py`（fleet 与 ghostfleet 双份）、`docs/old/v1/TRANSPORT_RESOLUTION_V1.md`、`docs/research/CLOUDFLARE_TAILSCALE_REUSE_2026-08-30.md`、`docs/runbooks/MANAGED_LINUX_VPS_ONBOARDING.md`。

## 3. 案例 C：Native/Recovery OpenSSH

| 字段 | 事实 |
| --- | --- |
| provider | 可为空，或为外部 recovery provider（LAN / 云管理网 / 物理 console）；authority 不得从 provider 名称自动推出 |
| network plane | LAN / provider 管理网 / 显式 recovery 路径 |
| locator | 显式给定 IP/hostname（禁止作为 authority，仅 runtime locator） |
| listener | 节点上 sshd 的实际 listener（可与 Tailscale SSH 在不同地址族上同数字端口） |
| caller authentication | OpenSSH 公钥（controller fallback key 仅限 machine/bootstrap/recovery 用途） |
| authorization/authority | authorized_keys 加 ADD→VERIFY→SWITCH→RETIRE 流程；禁止 password root 作为长期 primary |
| target identity proof | pinned host key（必须，禁 TOFU/accept-new） |
| failure domain | 上级网络/provider 故障；不依赖 Tailscale/Cloudflare 任一控制面 |
| Human/AI 可见表示 | `ssh user@ip`（显式 recovery 通道，不进入自动解析） |
| durable evidence 允许保存 | 同 A 的 receipt 规则；recovery 触发原因、operator 身份 |

证据来源：`docs/runbooks/MANAGED_LINUX_VPS_ONBOARDING.md`（L90-105）、`fleet/10_platforms/linux/...` onboarding 文档。

## 4. 三案差异矩阵

| 维度 | A Cloudflare machine-control | B Tailscale Human maintenance | C Native/Recovery |
| --- | --- | --- | --- |
| plane | Workers VPC / direct tunnel | tailnet | LAN / provider 管理网 |
| purpose | machine-control | human-maintenance | recovery / bootstrap |
| caller auth | OAuth+Access+scope | Tailscale ACL + Human identity | OpenSSH 公钥 |
| target proof | pinned host key + provider binding | JIT host key 或 pinned host key | pinned host key |
| 自动重试/切换 | NOT_DISPATCHED 才允许 | 同约束，且仅在同 purpose 候选链内 | 人工触发 |
| durable evidence | sanitized receipt | 同 | 同 |
| 与 #33 `ssh:// :22` 的关系 | `cf://`（locator 是 binding/hostname，listener 落在 loopback） | `ts://`（locator 是 provider_ref，listener 是 tailnet :22） | `ssh://`（显式 recovery） |

## 5. 从事实模型反推的候选类型（不冻结名词）

1. **Plane**：`cloudflare-vpc` / `tailnet` / `native-lan` ——网络平面的一等事实。
2. **Locator**：每 plane 内的寻路信息（binding name / provider_ref / 显式 IP），只做 runtime 解析输入，永不作为 authority。
3. **Listener**：实际监听进程（cloudflared→loopback sshd / Tailscale SSH / native sshd），是 plane 与 locator 的"落点"。
4. **CallerAuth**：入口处的认证/授权（OAuth+Access / Tailscale ACL / OpenSSH 公钥），与调用方身份绑定。
5. **TargetProof**：目标机器身份证明（pinned host key / provider_ref+tag+JIT key），与 machine 绑定，不得与 CallerAuth 混用。
6. **Purpose**：`machine-control | human-maintenance | recovery` ——选择 plane 的第一输入。
7. **DispatchGate**：`NOT_DISPATCHED` 才允许选链；`MAY_HAVE_EXECUTED/UNKNOWN` 必须 reconcile。

候选名词 `TransportIdentity` 在 Phase 2 通过后仍保持 HOLD；是否形成聚合视图由 Phase 3 contract freeze 决定。

## 6. 仓库归属说明

- 本通用模型与候选 contract 归 GhostFleet（`docs/research/`），属于"通用 transport/control 产品"语义。
- Fleet 只保留私有部署事实（真实 node_uid、provider_ref、evidence、账号/locator），不得复制第二套通用语义。

## 7. Phase 2 完成定义与下一步

- [x] 三个真实案例逐字段建模（A/B/C）。
- [x] 三案差异矩阵。
- [x] 从事实反推候选类型（不先套名词）。
- [x] Architect review Phase 2 → 已冻结 Node Identity / Provider+Plane / Locator / Endpoint+Listener / Caller Authentication / Authority / TargetProof / Purpose / Dispatch+Effect State / FailureDomain+HealthEvidence 这些事实维度。
