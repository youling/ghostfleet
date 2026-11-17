# Architecture / 架构

当前语义由 [ADR004](adr/004-lightweight-enrollment-presence.md) 与 [#11](https://github.com/youling/ghostfleet/issues/11) 持有。本页是当前集成主干的 DERIVED 架构导航，说明组件职责、接口与边界；它不是实例发布状态库，也不代替生产验收。具体生产版本、节点验收与剩余门禁以 #11 回执为准。原 transport-only 图和旧控制平台保留在 Git 历史中。

## 中文

三个责任域互不冒充：

| 域 | 所有的事实与动作 | 不负责 |
|---|---|---|
| 原生传输 | CF/TS 网络准入、OpenSSH 主机/用户认证、正常 shell/exec/SFTP | 心跳控制面、逐命令审批 |
| 轻量面板与 API | 稳定 node_uid、一次性票据、上报凭据、最后心跳投影 | provider mint、SSH 管理私钥、远程执行 |
| Linux reporter | systemd 定时调度、读取固定 unit 状态、HTTPS 上报、journald | 常驻 Agent、任务队列、全量日志上传 |

一个参考 Worker 处理两个生产 HTTPS origin；同一个既有 DO 保存节点/票据。Panel 由部署方全站 Access 加应用角色保护；node origin 只暴露机器路由和哈希固定安装器。具体拓扑、凭据与真实证据留私有 owner。边界图与失败/恢复语义见 ADR004；部署动作见 [PRESENCE](PRESENCE.md)。

旧节点的 `ACTIVE`、资产字段与 node_uid 不被心跳覆盖。首次心跳只改变派生 presence。凭据撤销仅拒绝 reporting，原生 SSH 权限另行管理。网络/SSH/本机进程/心跳分别验收；一条路径成功不代表双路通过。

交付依赖与阶段图见 [DELIVERY](DELIVERY.md)：源码整合、私有发布包/双 origin、首节点系统级安装与浏览器首用、第二节点复制分别交付；CF 原生传输验收可按原授权独立推进。该图只表达依赖，当前完成状态回到 #11；ADR004 继续持有组件边界。

## English

ADR004 is the semantic owner; this page is derived architecture documentation for the integrated main, not a per-instance release ledger. Production versions, node acceptance and remaining gates are recorded in #11. Native network/SSH transport, panel/API state and Linux reporting are separate domains. One reference Worker uses two HTTPS origins and one existing DO. Instance-owned Access and Operator/Read authorization protect the panel; the machine origin exposes only authenticated claim/heartbeat plus the pinned public installer.

The reporter is scheduled, one-shot, and command-free. Existing node_uid, asset fields and lifecycle are retained. Heartbeat freshness does not promote ACTIVE or prove incoming SSH connectivity. Reporting revocation does not revoke SSH. See ADR004 for the diagram and bounded failure/recovery semantics, PRESENCE for deployment, and REMOTE_ACCESS for native transport setup.

[DELIVERY](DELIVERY.md) diagrams the delivery dependencies: source integration, instance package/two origins, first-node system installation and browser first use, then second-node replication. Native CF acceptance can proceed independently under existing authority. The diagram describes dependencies; #11 owns current status and ADR004 continues to own component boundaries.
