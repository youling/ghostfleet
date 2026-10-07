# Transport Namespace & Adaptive Link Layer — Phase 1 事实盘点与外部证据

- Canonical issue: https://github.com/youling/ghostfleet/issues/36
- 日期：2026-10-07
- 状态：Research；本文件记录事实与候选，不构成最终 contract。

## 1. 范围

本阶段只回答三个问题：

1. GhostFleet 当前有哪些 transport/control 事实；
2. Cloudflare、Tailscale、OpenSSH 官方语义分别是什么；
3. 哪些不变量足以进入下一阶段真实链路建模。

私有部署节点、真实 provider_ref、账号、locator 与生产 evidence 不复制到本公开仓库。

## 2. GhostFleet 当前实现事实

### 2.1 typed-control

相关代码：

- `packages/typed-control/src/transport.ts`
- `packages/typed-control/src/routing.ts`
- `packages/typed-control/src/sshClient.ts`
- `packages/typed-control/src/cloudflareBackend.ts`
- `packages/typed-control/src/workersSocketStream.ts`
- `packages/typed-control/src/targets.ts`

当前事实：

- control target 以 canonical node identity 为关联根，但 transport 仍主要由 `mesh_hostname | direct_tunnel | local_ssh` 等模式表达；
- Cloudflare backend 负责提供 socket/stream，不应同时承担 target selection 或 SSH policy；
- SSH client 已有 pinned host identity；
- dispatch 已区分 `NOT_DISPATCHED | MAY_HAVE_EXECUTED`，这为跨链路安全切换提供了现成 effect-state 基础。

### 2.2 runtime-python transport resolution

相关代码：

- `packages/runtime-python/src/ghostfleet_runtime/core/transport_resolution.py`
- `packages/runtime-python/src/ghostfleet_runtime/core/human_tailscale_ssh.py`
- `packages/runtime-python/src/ghostfleet_runtime/core/remote_maintenance.py`

当前事实：

- node identity 与 runtime locator 已有明确分离倾向；
- provider reference / tag / pinned verifier 等可以参与 target correlation；
- hostname、IP、SSH alias 等不能天然成为 authority；
- transport failure 与 target identity failure 必须分开处理。

## 3. 官方文档索引

| 主题 | 官方来源 | 对 GhostFleet 的直接约束 |
| --- | --- | --- |
| Cloudflare Tunnel | https://developers.cloudflare.com/tunnel/ | cloudflared 是节点主动建立的出站 connector；Tunnel 本身不要求节点开放公网入站端口。 |
| Workers VPC | https://developers.cloudflare.com/workers-vpc/ | Workers 可通过 VPC binding/网络连接私网资源；provider、plane、origin endpoint 不能压成一个 locator 字符串。 |
| Tailscale SSH | https://tailscale.com/kb/1193/tailscale-ssh | Tailscale SSH 在 Tailscale IP:22 上由 tailscaled 处理，认证/授权来自 Tailscale；它与 native OpenSSH 是不同 authority plane。 |
| Tailscale DERP | https://tailscale.com/kb/1118/derp | DERP 是连接路径 fallback，不是节点 identity 或 authorization 边界。 |
| OpenSSH sshd | https://man.openbsd.org/sshd_config | ListenAddress/Port 描述 listener；host key 与 authorized_keys/CA 等承担不同身份与授权职责。 |

## 4. Phase 1 冻结不变量

本阶段只冻结不变量，不冻结最终类型名：

1. `node_uid != locator`；
2. provider / network plane / locator / endpoint-listener 不能混为一个字段；
3. caller authentication/authorization 与 target identity proof 必须分层；
4. transport 选择必须先有明确 purpose/authority boundary；
5. hostname/IP/port 不能单独成为 authority；
6. 只有 `NOT_DISPATCHED` 才能安全考虑自动换链；`MAY_HAVE_EXECUTED/UNKNOWN` 必须先 reconcile；
7. fallback 只能发生在同一被允许 purpose 的候选集合内。

## 5. 继续 HOLD 的候选

以下仅保留为研究候选：

- `TransportIdentity` 作为一等对象名；
- `ts:// / cf:// / ssh://` 作为 Human-visible scheme；
- purpose 的最终枚举；
- dedicated machine listener/port；
- adaptive routing 的评分算法与探测周期。

## 6. Phase 1 → Phase 2

Phase 2 不再从抽象名词出发，而以三个真实案例逐字段建模：

- Cloudflare machine-control；
- Tailscale Human maintenance；
- Native/Recovery OpenSSH。

Phase 2 文件：`docs/research/TRANSPORT_NAMESPACE_PHASE2_2026-10-07.md`。
