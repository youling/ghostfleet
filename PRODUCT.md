# Product boundary / 产品范围

## 中文

GhostFleet 的目标是尽快提供可用的原生远控通道，再以最薄的界面完成首次注册与状态监看。当前范围由 [#11](https://github.com/youling/ghostfleet/issues/11) 和 [ADR004](docs/adr/004-lightweight-enrollment-presence.md) 描述。

传输由 OpenSSH、Cloudflare Tunnel、Tailscale 承担。管理账户通过 SSH 认证后拥有该 OS 账户本来的权限；不逐条审批、解析、过滤或重放命令。root 专用公钥策略不改变普通用户原有认证。

面板只做 Operator/Read 登录、一次性票据、稳定节点身份、节点列表、最后收到的心跳、本机服务状态以及上报凭据撤销。v1 安装器只安装状态上报，不自动建立提供商网络或安装/改写 SSH。尚无原生远控通道的节点，先走传输安装指南。

节点 timer 定期运行单次上报，完成后退出。本地诊断使用 journald。仅保存最新心跳，不建时间序列平台、全量日志上传、自动修复器或命令接收器。服务 active 是本机进程状态，不是网络入口健康证明；心跳新鲜度和 NodeLifecycle.ACTIVE 分开。

源码、确定性测试、真实隔离运行、独立审查、系统级安装、受保护生产浏览器体验与发布分别报告。不以 CI 或示例截图冒充上线。Cloudflare 私有配置、真实域名、节点和凭据仍归实例所有者。

## English

Deliver useful native remote access quickly, with a minimal enrollment/presence UI. Native OpenSSH and upstream network providers own the session. No command parsing, filtering, approval, queue or replay is added. Root public-key authentication does not change ordinary users' OS policy.

The panel owns only Operator/Read login, one-time registration tickets, stable node identity, inventory, last-seen/local service observations and reporting revocation. The v1 installer adds reporting to an existing transport; it does not create provider networks or configure SSH. A systemd timer starts a one-shot Python reporter; local journald owns diagnostics. Only the latest report is retained.

Presence is distinct from lifecycle and inbound reachability. Source tests, isolated runtime validation, independent review, production system installation and actual release require their respective evidence. Private domains, devices, credentials and rollout remain instance-owned. See ADR004 and the deployment runbook.
