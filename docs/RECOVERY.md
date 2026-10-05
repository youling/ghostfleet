# Recovery and uncertain outcomes / 恢复与不确定结果

## 中文

<!-- topic:uncertainty -->
### UNKNOWN 是对账入口

响应丢失、进程中断或超时不证明远程副作用未发生。类型化回执中的 `UNKNOWN`、任务/交互会话代次、纳管尝试的派发/检查点和设备启动身份用于恢复。不能因新会话、新 AI 客户端或浏览器重启而重新签发凭据、加入、重启、启动任务或写入交互会话。

先读取受保护的防重复派发记录、控制面已持久化的尝试/节点和独立观察的当前目标。只有明确证明未派发，或契约允许的幂等步骤才可重试；高风险副作用须由责任方根据既有回执对账。不能删除或改写旧记录来隐藏冲突。

<!-- topic:restart -->
### 控制面重启与设备重启

参考 Durable Object 保存生命周期、证据和节点投影；启动后读取同一对象、同一尝试及最新证据。控制面进程重启不等于设备重启，不能满足设备重启证据。设备重启需要事前持久化的检查点和一次派发防重复记录，独立观察到启动代次已改变，同时确认传输、控制、提供方和纳管身份恢复。

任务只能停止自己明确拥有的进程或连接。不能通过重置共享存储、既有实例或凭据来修复预览。控制台、API 与只读 MCP 的回读必须一致；新 `FAIL/UNKNOWN` 覆盖旧 `PASS`，恢复时不能选择最有利的历史结果。

<!-- topic:rollback -->
### 兼容切换与回滚

每个能力切换须记录新旧源码版本、公开包版本、私有配置/投影版本、调用方、责任方、权限与恢复测试。先在无实际副作用的环境测试，再进行受限真实试验。保留原通道，直到同一身份、回执等价性、未知结果恢复和回滚均通过。控制面准入不证明调用方已切换；每个调用方还须验收其目录发现、认证配置、调用路由、正负权限和身份回读。

回滚前核对已发生的副作用与 schema 兼容性；重新指向旧包不保证能读取新版状态。不得自行删除运行目录、资产记录或旧机制。明确保留哪些薄兼容衔接代码，以及哪些通用实现将在后续独立 PR 删除；示例不含真实节点或提供方配置。

## English

<!-- topic:uncertainty -->
### UNKNOWN requires reconciliation

Lost responses, interrupted processes and timeouts do not prove that a remote effect did not happen. Typed UNKNOWN receipts, job/session generations, enrollment dispatch/checkpoints and device boot identity support recovery. A new session, AI client or browser restart must not re-mint, re-join, reboot, start a job or write an interactive session.

Read the protected effect fence, persisted control-plane attempt/Node and independent current target first. Retry only when absence of dispatch is proved or the contract permits an idempotent step. High-risk effects require owner reconciliation against the existing receipt. Never delete or rewrite prior records to hide a conflict.

<!-- topic:restart -->
### Control-plane restart and device reboot

The reference Durable Object persists lifecycle, evidence and node projection. Recover by reading the same objects/attempt and latest evidence. Restarting the control-plane process is not a device reboot and cannot satisfy reboot proof. A device reboot needs a persisted pre-dispatch checkpoint and one-dispatch fence, independently observed changed boot, and restored transport/control/provider/enrollment identity.

Stop only processes/connections clearly owned by this task. Do not reset shared stores, prior instances or credentials to repair a preview. Console/API/MCP readbacks must agree. New FAIL/UNKNOWN supersedes old PASS; recovery cannot select the most favorable historical observation.

<!-- topic:rollback -->
### Compatibility cutover and rollback

Record old/new revisions, public package version, private config/projection revision, consumer, owner, authority and recovery tests for every capability cutover. Test in an inert environment before a bounded canary. Preserve the existing path until the same identity, receipt parity, uncertain-outcome recovery and rollback pass. Control-plane admission does not establish consumer cutover; each consumer also needs acceptance of catalog discovery, authentication/configuration, call routes, positive/negative permissions and identity readback.

Before rollback, reconcile effects and schema compatibility: pointing at the old package may not make it able to read newer state. Do not delete runtime directories, asset records or prior mechanisms. Specify which thin compatibility glue remains and which generic implementation will be removed in a separate PR; examples contain no real node/provider configuration.
