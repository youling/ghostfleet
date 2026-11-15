# GhostFleet — 项目规则 / Project rules

先读取当前 [ai-use AGENTS.md](https://github.com/youling/ai-use/blob/main/AGENTS.md)，再应用本仓规则。Human 当前方向、明确授权和实时 GitHub 事实优先。GitHub 写权限或架构师身份不自动授予生产部署、凭据、设备或破坏性操作权限。

当前产品：**原生 SSH 传输 + 轻量首次注册与节点心跳面板**。依据 [#11](https://github.com/youling/ghostfleet/issues/11) 与 [ADR 004](docs/adr/004-lightweight-enrollment-presence.md)。它取代 transport-only 阶段对面板和心跳的排除，不恢复旧命令执行平台。

1. 复用 OpenSSH、cloudflared、tailscaled、systemd/journald 和标准库；不自建 SSH server、任务队列、常驻命令 Agent、Helper/JIT、逐命令审批或平行命令审计。
2. 传输入口和 SSH 认证独立于面板。root 使用公钥专用策略；普通用户保留系统原有认证策略。既有 SSH 不因面板中断或撤销 reporting token 而被切断。
3. 唯一 UI 目录是 `console/`。复用既有 `node_uid`、节点记录和 Worker/DO 存储身份；presence 是最后心跳的派生展示，不是 NodeLifecycle.ACTIVE 或消费者远控验收。
4. 节点端只安装自己的 oneshot 上报程序和 timer；不解析或执行远端命令，不修改 SSH/provider/其他用户配置。日志留 journald，不上传全量 journal。
5. 真正的节点、域名/IP、tailnet、账号、策略、凭据、私钥、原始日志只留实例 owner。公共源码、文档和 CI 只使用合成材料及保留示例域名。
6. 普通仓库工作使用隔离分支和 PR，重要变更绑定 exact HEAD、确定性测试、公开边界检查和适用审查。不直接写 main，不把作者自检称为独立审查。
7. 双语安装/运维文档、可恢复失败语义和实际行为测试随实现更新。测试结论不外推为生产部署；临时 user-unit 不冒充生产 root system-unit 验收。
8. 不增加与当前可用目标无关的部署门禁、等待期、数据库或框架。只阻断真正受影响的操作，其他合法工作继续。

## English

Read current ai-use first. GhostFleet combines native SSH transport with a thin enrollment/presence panel. ADR004 supersedes the previous exclusion of all panel/reporting code; it does not revive the old execution platform. Reuse native components and the existing Console/node_uid/DO identity. Reporting is not SSH authority, ACTIVE lifecycle or inbound connectivity proof.

No resident command agent, queue, custom SSH server, Helper/JIT, command approval/filter or parallel audit pipeline. Keep actual instance configuration, credentials and raw evidence private. Use isolated branches and exact-head tests/review; source acceptance is not production authority. Retain explicit failure/recovery behavior, bilingual operations docs and publication checks. Avoid new machinery unrelated to the accepted minimal product.
