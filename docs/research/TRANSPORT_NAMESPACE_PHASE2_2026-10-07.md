# Transport Namespace & Adaptive Link Layer — Phase 2 真实链路对象建模

- Canonical issue: https://github.com/youling/ghostfleet/issues/36
- 前置：`docs/research/TRANSPORT_NAMESPACE_PHASE1_2026-10-07.md`
- Architect review: https://github.com/youling/ghostfleet/issues/36#issuecomment-6036252158
- 日期：2026-10-07
- 状态：Phase 2 已通过；冻结最小事实维度，表达层与最终 contract 继续 HOLD。

## 0. 已冻结的建模原则

1. 不以“多个进程共享同一 :22”作为事实模型。正确分层是 **provider / network plane → locator → endpoint/listener**；端口只是 endpoint 属性，不能反推 plane 或 authority。
2. caller authentication、authorization/authority 与 target identity proof 必须分层；调用方凭据不能替代目标机器身份证明。
3. canonical `node_uid` 是关联根；hostname、IP、provider locator、端口都不是节点 identity。
4. purpose 先于选链；Human / Machine / Recovery 不得因为某条链失败而隐式跨权限面切换。
5. `NOT_DISPATCHED` 才允许自动换链；`MAY_HAVE_EXECUTED / UNKNOWN` 必须先 reconcile。

## 1. 案例 A：Cloudflare machine-control

| 字段 | 事实 |
| --- | --- |
| provider | Cloudflare |
| network plane | Workers VPC / direct-tunnel 类私网连接；节点侧 cloudflared 主动建立出站连接 |
| locator | VPC binding name、private hostname 或其他 provider locator；只用于寻路 |
| endpoint/listener | 节点上的 OpenSSH endpoint/listener（例如 loopback sshd）；cloudflared 是 connector/hop，不是该 endpoint 的身份 |
| caller authentication | 由部署层的 Worker/API/MCP ingress 认证提供；属于 caller plane |
| authorization/authority | typed operation scope / policy 决定调用方允许执行的能力 |
| target identity proof | exact node/provider correlation + pinned SSH host identity |
| failure domain | Worker/VPC binding、Tunnel connector、origin endpoint、SSH handshake 分属不同 failure domain |
| Human/AI 可见表示 | provider-aware control target / typed control operation |
| durable evidence | canonical node reference、sanitized operation receipt、provider binding 摘要、identity verification result；不把 runtime locator 当 canonical identity |

GhostFleet 证据来源：
- `packages/typed-control/src/transport.ts`
- `packages/typed-control/src/routing.ts`
- `packages/typed-control/src/sshClient.ts`
- `packages/typed-control/src/cloudflareBackend.ts`
- `packages/typed-control/src/workersSocketStream.ts`

官方语义来源：
- https://developers.cloudflare.com/tunnel/
- https://developers.cloudflare.com/workers-vpc/

## 2. 案例 B：Tailscale Human maintenance

| 字段 | 事实 |
| --- | --- |
| provider | Tailscale |
| network plane | tailnet；WireGuard 直连优先，DERP 等 relay 是连接 fallback |
| locator | provider_ref、MagicDNS name、当前 peer address 等 runtime locator |
| endpoint/listener | Tailscale SSH 时为 tailscaled 在 Tailscale IP:22 上接管的 SSH server；native OpenSSH over tailnet 是另一个 endpoint 模式 |
| caller authentication | Tailscale user/device identity，必要时由 check mode 触发重新认证 |
| authorization/authority | tailnet ACL / SSH access rules |
| target identity proof | 受控 peer/provider correlation + Tailscale SSH host-key 语义；native OpenSSH 时使用 pinned host identity |
| failure domain | tailnet path、relay/DERP、Tailscale SSH availability、native sshd availability 必须分开 |
| Human/AI 可见表示 | MagicDNS / Tailscale-native target name；只作为可读导航，不成为 durable authority |
| durable evidence | canonical node reference、provider correlation 摘要、policy/tag check result、identity verification result；runtime locator 默认不落 durable truth |

GhostFleet 证据来源：
- `packages/runtime-python/src/ghostfleet_runtime/core/transport_resolution.py`
- `packages/runtime-python/src/ghostfleet_runtime/core/human_tailscale_ssh.py`
- `packages/runtime-python/src/ghostfleet_runtime/core/remote_maintenance.py`

官方语义来源：
- https://tailscale.com/kb/1193/tailscale-ssh
- https://tailscale.com/kb/1118/derp

## 3. 案例 C：Native / Recovery OpenSSH

| 字段 | 事实 |
| --- | --- |
| provider | 可为空，也可为 LAN、云厂商 recovery network、物理 console 的外部 provider；provider 名称本身不推出 authority |
| network plane | native LAN / provider management network / explicit recovery path |
| locator | 显式 IP、hostname、console/session locator；只能用于 runtime navigation |
| endpoint/listener | 节点 native OpenSSH sshd 或等价 recovery endpoint |
| caller authentication | OpenSSH public key、certificate 或受控 recovery credential |
| authorization/authority | authorized_keys / CA / sshd policy / recovery policy |
| target identity proof | pinned SSH host identity 或 provider 提供的独立 target proof |
| failure domain | 上级网络、provider recovery plane、native sshd、host identity verification 分开观察 |
| Human/AI 可见表示 | 显式 recovery target；不进入普通自动 resolver 的隐式 fallback |
| durable evidence | recovery 原因、operator/actor、canonical node reference、identity verification result；runtime locator 按策略最小化保存 |

官方语义来源：
- https://man.openbsd.org/sshd_config

## 4. 三案差异矩阵

| 维度 | A Cloudflare machine-control | B Tailscale Human maintenance | C Native/Recovery |
| --- | --- | --- | --- |
| provider | Cloudflare | Tailscale | optional/external |
| plane | Workers VPC / Tunnel-backed private path | tailnet | LAN / provider management / recovery |
| typical purpose | machine-control | human-maintenance | recovery / bootstrap |
| caller auth | deployment ingress identity | Tailscale identity | OpenSSH/recovery credential |
| authorization | typed scope/policy | tailnet ACL / SSH rule | sshd/authorized_keys/recovery policy |
| target proof | node/provider correlation + pinned SSH host identity | peer correlation + controlled host identity | pinned host identity / provider proof |
| automatic failover | 仅在同 purpose 且 NOT_DISPATCHED | 同约束 | 默认显式/人工 |
| locator role | runtime navigation | runtime navigation | runtime navigation |

## 5. 从事实模型反推的最小事实维度

Architect 已冻结以下**语义维度**，但未冻结最终代码类型名：

1. Node Identity
2. Provider
3. Network Plane
4. Locator
5. Endpoint / Listener
6. Caller Authentication
7. Authorization / Authority
8. Target Identity Proof
9. Purpose
10. Dispatch / Effect State
11. Failure Domain / Health Evidence

候选名词 `TransportIdentity` 继续 HOLD。它是否存在、是否只是若干事实维度的聚合视图，要等 provider-neutral contract 研究完成后再决定。

## 6. Human-visible scheme 候选

`ts://`、`cf://`、`ssh://` 目前仅作为 **Human-visible representation 候选**：

- 可以帮助操作者一眼判断走哪种 provider/plane；
- 不能成为 authority；
- 不能替代 canonical node identity；
- 不能把 provider、plane、locator、endpoint 再次压成一个不可解释字符串。

是否正式采用 URI scheme，继续 HOLD。

## 7. 仓库边界

GhostFleet 是通用 transport/control 产品 owner：

- 通用模型；
- provider-neutral contract；
- adapter boundary；
- Human-visible representation；
- safe failover/reconcile 规则。

私有部署仓库只保存真实节点、账号、provider ref、locator、生产 evidence 等实例事实，不复制第二套通用 transport 语义。

## 8. 下一阶段：Phase 3 provider-neutral contract

Phase 3 只研究 contract，不改生产链路。至少需要：

- Node / Plane / Locator / Endpoint / Caller / Authority / TargetProof / Purpose / DispatchState 的对象关系图；
- 现有 Python transport resolver 与 TypeScript typed-control 的逐字段映射；
- durable config 与 runtime observation 的边界；
- Cloudflare / Tailscale / native OpenSSH provider adapter boundary；
- compatibility plan；
- adaptive routing 输入/输出 contract 草案，但不实现评分算法。

Phase 3 完成后回到 #36 请求 Architect contract freeze。
