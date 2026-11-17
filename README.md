# GhostFleet

## 中文

**原生 SSH 转发，轻量纳管与节点状态。** Cloudflare Tunnel / Tailscale 把连接送到同一 OpenSSH；一个小面板登记节点、管理心跳凭据，显示最近心跳与 SSH/cloudflared/tailscaled 的本机服务状态。

节点使用 Python 标准库、systemd timer/oneshot 与 journald，没有常驻 Node Agent、命令 API、任务队列或逐命令审批。面板中断不影响既有 SSH；“撤销上报”不等于撤销 SSH。

当前 main 已合入 [PR #85](https://github.com/youling/ghostfleet/pull/85) 的轻量面板与 reporter，并包含后续 [M3 修复 #90](https://github.com/youling/ghostfleet/pull/90) 和 [auth 响应头修复 #92](https://github.com/youling/ghostfleet/pull/92)。M2 Worker 曾按较早的 main 版本部署；后续源码修复是否已进入生产，以 [#11 实例回执](https://github.com/youling/ghostfleet/issues/11) 为准。main 合并或 CI 通过不等于生产部署、节点安装或真实连通验收。v1 注册已有原生传输的 Linux 主机并观察状态；不会自动安装提供商网络或配置 SSH。“心跳在线”不是远控端到端通过。

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

Current main includes the thin panel and reporter integrated through [PR #85](https://github.com/youling/ghostfleet/pull/85), plus the later [M3 source fix #90](https://github.com/youling/ghostfleet/pull/90) and [auth response-header fix #92](https://github.com/youling/ghostfleet/pull/92). The M2 Worker was deployed from an earlier main revision; whether later source fixes have reached production must be read from the [#11 instance receipts](https://github.com/youling/ghostfleet/issues/11). A main merge or green CI is not production deployment, node installation or live connectivity acceptance. v1 registers Linux nodes with existing native transport; it does not install provider networks or configure SSH. Presence does not prove inbound administration. Run the commands above, then follow [the deployment runbook](docs/PRESENCE.md). Preserve instance-owned origins, credentials and DO identity. CI never deploys.

License: AGPL-3.0-only.
