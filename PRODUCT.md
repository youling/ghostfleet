# 产品范围 / Product boundary

## 中文

GhostFleet 以原生远控、稳定节点身份、轻量状态和可重复安装交付多节点能力。[#11](https://github.com/youling/ghostfleet/issues/11) 持有当前目标与接受结论；[ADR004](docs/adr/004-lightweight-enrollment-presence.md) 描述主干 v1 基座，0.3.0 候选的固定入口见 [DELIVERY](docs/DELIVERY.md)。下列 v1 能力与后续候选分别适用。

传输由 OpenSSH、Cloudflare Tunnel、Tailscale 承担。管理账户通过 SSH 认证后拥有该 OS 账户本来的权限；不逐条审批、解析、过滤或重放命令。root 专用公钥策略不改变普通用户原有认证。

主干 v1 面板负责 Operator/Read 登录、一次性票据、稳定节点身份、节点列表、最后收到的心跳、本机服务状态以及上报凭据撤销。v1 安装器只安装状态上报，不自动建立提供商网络或安装/改写 SSH。尚无原生远控通道的节点，先走传输安装指南。

节点 timer 定期运行单次上报，完成后退出。本地诊断使用 journald。仅保存最新心跳，不建时间序列平台、全量日志上传、自动修复器或命令接收器。服务 active 是本机进程状态，不是网络入口健康证明；心跳新鲜度和 NodeLifecycle.ACTIVE 分开。

源码、确定性测试、真实隔离运行、独立审查、系统级安装、受保护生产浏览器体验与发布分别报告。不以 CI 或示例截图冒充上线。Cloudflare 私有配置、真实域名、节点和凭据仍归实例所有者。

### 0.3.0 候选：统一安装与分项能力

[统一安装合同](https://github.com/youling/ghostfleet/issues/11#issuecomment-7218722415)要求同一受审入口与版本化 profile 覆盖首装、同 UID 接管、覆盖升级、重复执行、owned repair 和中断恢复。当前 [RC3](https://github.com/youling/ghostfleet/pull/143) 的实际范围如下；隔离验收不表示已经正式签名或迁移真实节点。

| 组件 | 当前候选能力与边界 |
| --- | --- |
| GhostFleet 自有组件 | Debian 13 amd64、原生 systemd；统一 `install.py plan/apply/status/repair`，保留原身份、凭据、外部数据和独立 SSH。未知归属只阻断受影响动作。 |
| 签名更新 | 原生 APT 验证独立信任根、时效、索引和包摘要；周期更新只更新 reporter，安装器与 profile 沿可信安装入口维护。恢复通过发布者批准的更高版本前滚。 |
| TS / CF | `none` 或 `observe`；现阶段读取原生状态，不承诺自动安装或接管所有 Provider 服务。实际网络策略与认证由可信实例持有。 |
| K3s | 默认 `none`；外部 Server/Agent 可观察，明确获准的专用 Agent 可 `prepare/start`。当前不自动安装 Server，不授予集群或 Fleet 管理权。 |
| 平台 | arm64 reporter 可构建，但统一安装器不支持 arm64 运行；兼容设备仍须自己的只读探测与 owner 授权。 |

首个既有节点的迁移按[同 UID 方向](https://github.com/youling/ghostfleet/issues/11#issuecomment-7211586141)验收；隔离 VM 已用于受控验证。本次实例[集成交付](https://github.com/youling/ghostfleet/issues/11#issuecomment-7217955618)包含 TS 与 K3s，公共产品仍支持无 K3s 节点。主机硬件、网络位置、Fleet 角色与 Kubernetes 角色分别描述。

### Controller、Managed 与历史目标

按[多 Controller / TS-first 裁决](https://github.com/youling/ghostfleet/issues/11#issuecomment-7213963670)，Controller 是独立获授权的执行主体，可以有多个；凭据、目标范围和救援路径分别验证。标签或心跳不授予 OS/root/Work 权限。Managed 节点完成纳管不自动取得反向或横向管理能力；只有明确未派发的传输失败才可沿获准备用路径切换，鉴权拒绝维持拒绝，UNKNOWN 先对账。

[ADR007](docs/adr/007-fully-managed-lower-node-enrollment.md)保留旧全自动纳管目标与原实例阶段要求。其单 Controller、特定 VPS 首验和排除 VM 的安排是历史有界实例选择，不能覆盖后发的多 Controller、既有节点迁移及隔离试验裁决。全自动纳管、私有 DCR、Root 委派和真实消费者仍需各自接受证据；公共仓不实现私有命令审批/租约服务。

旧纳管集成 [#135](https://github.com/youling/ghostfleet/pull/135) 仍 HOLD，与 RC3 分叉。既有功能、消费者、凭据及回退依赖完成替代对账前，不能以新版候选存在为由宣布旧线已经退役。关系与尚缺证据见 [DELIVERY](docs/DELIVERY.md)。

## English

Deliver useful native remote access quickly, with a minimal enrollment/presence UI. Native OpenSSH and upstream network providers own the session. No command parsing, filtering, approval, queue or replay is added. Root public-key authentication does not change ordinary users' OS policy.

The panel owns only Operator/Read login, one-time registration tickets, stable node identity, inventory, last-seen/local service observations and reporting revocation. The v1 installer adds reporting to an existing transport; it does not create provider networks or configure SSH. A systemd timer starts a one-shot Python reporter; local journald owns diagnostics. Only the latest report is retained.

Presence is distinct from lifecycle and inbound reachability. Source tests, isolated runtime validation, independent review, production system installation and actual release require their respective evidence. Private domains, devices, credentials and rollout remain instance-owned. See ADR004 for main's v1 baseline.

The 0.3.0 RC3 candidate adds one reviewed installer/profile for Debian 13 amd64/systemd installation, same-UID adoption, upgrade, no-op and owned repair. Signed APT updates the reporter; trust and bootstrap/profile changes retain their independent delivery path. TS/CF modes only observe native state. K3s remains optional: observe an external Server/Agent or prepare/start an explicitly approved dedicated Agent. The installer does not install a Server or run on arm64.

Multiple independently authorized Controllers are a current product direction; the old single-Controller/VPS-only choice in ADR007 is historical instance scope. The current existing-node migration and isolated VM evidence do not prove full-managed/Root or production acceptance. This instance requires integrated TS/K3s delivery, while the public product retains non-K3s support. Old #135 remains HOLD and is not an ancestor of RC3; consumers and rollback dependencies must be reconciled before retirement.
