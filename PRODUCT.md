# 产品范围 / Product boundary

## 中文

GhostFleet 的目标是尽快提供可用的原生远控通道，再以最薄的界面完成首次注册与状态监看。当前范围由 [#11](https://github.com/youling/ghostfleet/issues/11) 和 [ADR004](docs/adr/004-lightweight-enrollment-presence.md) 描述。

传输由 OpenSSH、Cloudflare Tunnel、Tailscale 承担。管理账户通过 SSH 认证后拥有该 OS 账户本来的权限；不逐条审批、解析、过滤或重放命令。root 专用公钥策略不改变普通用户原有认证。

面板只做 Operator/Read 登录、一次性票据、稳定节点身份、节点列表、最后收到的心跳、本机服务状态以及上报凭据撤销。v1 安装器只安装状态上报，不自动建立提供商网络或安装/改写 SSH。尚无原生远控通道的节点，先走传输安装指南。

节点 timer 定期运行单次上报，完成后退出。本地诊断使用 journald。仅保存最新心跳，不建时间序列平台、全量日志上传、自动修复器或命令接收器。服务 active 是本机进程状态，不是网络入口健康证明；心跳新鲜度和 NodeLifecycle.ACTIVE 分开。

源码、确定性测试、真实隔离运行、独立审查、系统级安装、受保护生产浏览器体验与发布分别报告。不以 CI 或示例截图冒充上线。Cloudflare 私有配置、真实域名、节点和凭据仍归实例所有者。

### 正式版扩展：全自动 Managed 下位机纳管（ADR007）

上面的 ADR004 是轻量 Reporter/Presence 子能力，不是完整纳管终点。正式版另提供受 Owner 授权的 `FULL_MANAGED_LOWER_NODE` profile：目标 Linux 机器在可信终端输入域名发起配对，面板匹配请求并手动签发六位短码；目标机输入短码校验固定摘要制品并完成一次 root bootstrap；同一 ceremony 自动完成主机预检、原生传输、复用现有 Tailscale/Cloudflare、DCR 节点身份/策略、专用 Root helper/签名租约与 ChatGPT 实际验收。

**Controller 的数量和分工属于实例拓扑，不是 GhostFleet 固定角色。** Owner 可以为多个独立的高信任控制主体授权日常分工与故障接替；每个主体必须独立验证身份、目标范围和撤销能力。公网及其他 `MANAGED_ONLY` 下位节点只接收获授权的管理，不能自行晋升或反向、横向取得控制权。新节点的 heartbeat Claim 不授予 root；Root profile 仍由受保护 Operator 对指定下位机的一次授权产生，已授权范围内的连续运维不逐条弹卡。详见 [ADR007 §2](docs/adr/007-fully-managed-lower-node-enrollment.md) 与 [拓扑验收](docs/ACCEPTANCE.md)。

全自动意味着新增节点不再要求手改 Worker 源码、复制 UID/公钥或逐台手工创建 Tunnel。应由现有 Worker/DO 与私有 Fleet registry 动态发布经审核的 Node UID、传输定位符、Host Key pin 和能力策略；已有 TS/CF 先探测并复用，不为形式统一重复安装。真实搬瓦工 VPS 是首个 E2E Canary，**不使用虚拟机**；通过后再分批纳管国内生产力服务器。完整状态与验收见 [ADR007](docs/adr/007-fully-managed-lower-node-enrollment.md) 和 [GhostFleet #11](https://github.com/youling/ghostfleet/issues/11)。

## English

Deliver useful native remote access quickly, with a minimal enrollment/presence UI. Native OpenSSH and upstream network providers own the session. No command parsing, filtering, approval, queue or replay is added. Root public-key authentication does not change ordinary users' OS policy.

The panel owns only Operator/Read login, one-time registration tickets, stable node identity, inventory, last-seen/local service observations and reporting revocation. The v1 installer adds reporting to an existing transport; it does not create provider networks or configure SSH. A systemd timer starts a one-shot Python reporter; local journald owns diagnostics. Only the latest report is retained.

The Owner defines each instance's controller set and independently authorized management scopes. Multiple eligible controllers may provide redundancy without sharing private keys or granting managed-only nodes outbound control. Local root is not Fleet authority; takeover of an exclusive resource uses the existing ownership and reconciliation contract. Presence is distinct from lifecycle and inbound reachability. Source tests, isolated runtime validation, independent review, production system installation and actual release require their respective evidence. Private domains, devices, credentials and rollout remain instance-owned. See ADR004 and the deployment runbook.
