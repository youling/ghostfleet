# GhostFleet

## 中文

**原生 SSH 转发，轻量纳管与节点状态。** Cloudflare Tunnel / Tailscale 把连接送到同一 OpenSSH；一个小面板登记节点、管理心跳凭据，显示最近心跳与 SSH/cloudflared/tailscaled 的本机服务状态。

节点使用 Python 标准库、systemd timer/oneshot 与 journald，没有常驻 Node Agent、命令 API、任务队列或逐命令审批。面板中断不影响既有 SSH；“撤销上报”不等于撤销 SSH。

当前 main 已合入 [PR #85](https://github.com/youling/ghostfleet/pull/85) 的轻量面板与 reporter，以及后续 M3 修复/升级 runbook、auth 安全头、验收与架构文档、现场研究/测试、systemd 观测边界、NAS 安全边界和 Cloudflare 客户端 SSH 诊断（[#90–#101](https://github.com/youling/ghostfleet/pulls?q=is%3Apr+is%3Amerged)）。实例 owner 报告生产 Worker 仍运行源码 `810494aae8de1785b9dd0727ee8ba1cabb0b371f`；ThinkPad 与 JG 两台物理节点已分别使用独立身份/上报凭据完成系统级安装与自动心跳。**Cloudflare SSH 到 JG 尚未验收**：必须确认实际 Published Route 类型、客户端 `cloudflared`、有效 `ProxyCommand`，并完成新 SSH 会话正测和拒绝来源/身份负测。详细实例状态与剩余 M2/M3/M4 门禁见 [#11](https://github.com/youling/ghostfleet/issues/11)。文档/测试 PR 不要求仅为此重发生产 Worker。main 合并或 CI 通过本身不等于生产部署、节点安装或真实连通验收。v1 注册已有原生传输的 Linux 主机并观察状态；不会自动安装提供商网络或配置 SSH。“心跳在线”不是远控端到端通过。

[产品范围](PRODUCT.md) · [架构](docs/ARCHITECTURE.md) · [传输安装](docs/REMOTE_ACCESS.md) · [面板与心跳部署](docs/PRESENCE.md) · [文档目录](docs/README.md)

### 开发

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:python
npm run build
npm run test:live
```

服务端开发 Node22+；节点 Python3.10+ 和支持 DynamicUser/LoadCredential 的 systemd，首验 Debian13。节点不需要 npm、Node、curl 或额外 Python 包。构建输出静态页面、哈希固定的单文件安装器与 Worker 配置；部署由实例 owner 配置 origin、Access、应用凭据与现有 DO 绑定。测试不自动发布。

## English

**Native SSH transport, lightweight enrollment and presence.** Cloudflare Tunnel/Tailscale reach the same OpenSSH service. A thin panel registers nodes, issues reporting-only credentials and shows last-seen plus local upstream service states.

The Linux reporter is a Python-standard-library oneshot scheduled by systemd, with diagnostics in journald. No resident command agent, job queue, execution API or per-command approval. A panel outage does not terminate SSH; reporting revocation is not SSH revocation.

Current main includes the thin panel and reporter integrated through [PR #85](https://github.com/youling/ghostfleet/pull/85), followed by the M3 fixes/runbook, auth response headers, acceptance/architecture docs, field research/tests, systemd observation scope, NAS safety boundary and Cloudflare client-side SSH diagnostics ([#90–#101](https://github.com/youling/ghostfleet/pulls?q=is%3Apr+is%3Amerged)). The instance owner reports that the production Worker remains on source `810494aae8de1785b9dd0727ee8ba1cabb0b371f`; the ThinkPad and JG physical nodes have each been enrolled with independent identities/reporting credentials and systemd-driven heartbeats. **Cloudflare SSH to JG is not yet accepted**: the actual Published Route type, client `cloudflared`, effective `ProxyCommand`, a fresh successful SSH session and a denied-source/identity negative test remain to be verified. The [#11 instance receipts](https://github.com/youling/ghostfleet/issues/11) define the exact accepted scope and remaining M2/M3/M4 gates. Documentation/test PRs do not require a production Worker redeploy by themselves. A main merge or green CI alone is not production deployment, node installation or live connectivity acceptance. v1 registers Linux nodes with existing native transport; it does not install provider networks or configure SSH. Presence does not prove inbound administration. Run the commands above, then follow [the deployment runbook](docs/PRESENCE.md). Preserve instance-owned origins, credentials and DO identity. CI never deploys.

License: AGPL-3.0-only.
