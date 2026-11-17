# GhostFleet

## 中文

**原生 SSH 转发，轻量纳管与节点状态。** Cloudflare Tunnel / Tailscale 把连接送到同一 OpenSSH；一个小面板登记节点、管理心跳凭据，显示最近心跳与 SSH/cloudflared/tailscaled 的本机服务状态。

节点使用 Python 标准库、systemd timer/oneshot 与 journald，没有常驻 Node Agent、命令 API、任务队列或逐命令审批。面板中断不影响既有 SSH；“撤销上报”不等于撤销 SSH。

当前 main 已合入 [PR #85](https://github.com/youling/ghostfleet/pull/85) 的轻量面板与 reporter，并包含后续 [M3 修复 #90](https://github.com/youling/ghostfleet/pull/90)、[auth 响应头修复 #92](https://github.com/youling/ghostfleet/pull/92) 和文档纠偏 [PR #93](https://github.com/youling/ghostfleet/pull/93)。实例 owner 已报告生产 Worker 更新到 main `810494aae8de1785b9dd0727ee8ba1cabb0b371f`，并完成 ThinkPad 首节点的同节点热替换与 systemd 自动心跳；详细范围及剩余门禁见 [#11 实例回执](https://github.com/youling/ghostfleet/issues/11)。这不代表第二节点、所有网络路径或所有安全边界均已验收。main 合并或 CI 通过本身不等于生产部署、节点安装或真实连通验收。v1 注册已有原生传输的 Linux 主机并观察状态；不会自动安装提供商网络或配置 SSH。“心跳在线”不是远控端到端通过。

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

Current main includes the thin panel and reporter integrated through [PR #85](https://github.com/youling/ghostfleet/pull/85), plus the later [M3 source fix #90](https://github.com/youling/ghostfleet/pull/90), [auth response-header fix #92](https://github.com/youling/ghostfleet/pull/92), and documentation correction [PR #93](https://github.com/youling/ghostfleet/pull/93). The instance owner reports that the production Worker has been updated from main `810494aae8de1785b9dd0727ee8ba1cabb0b371f` and the first ThinkPad node completed same-node replacement and automatic systemd heartbeats. The [#11 instance receipts](https://github.com/youling/ghostfleet/issues/11) define the exact accepted scope and remaining gates. This does not establish second-node, every network path, or every security-boundary acceptance. A main merge or green CI alone is not production deployment, node installation or live connectivity acceptance. v1 registers Linux nodes with existing native transport; it does not install provider networks or configure SSH. Presence does not prove inbound administration. Run the commands above, then follow [the deployment runbook](docs/PRESENCE.md). Preserve instance-owned origins, credentials and DO identity. CI never deploys.

License: AGPL-3.0-only.
