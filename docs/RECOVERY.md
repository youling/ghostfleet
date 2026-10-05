# Recovery and uncertain outcomes / 恢复与不确定结果

## 中文

<!-- topic:uncertainty -->
### UNKNOWN 是对账入口

响应丢失、进程中断、超时不证明远程 effect 未发生。typed receipt 的 `UNKNOWN`、job/session 的 generation、enrollment attempt dispatch/checkpoint 与设备 boot identity 用于恢复。不得因新会话、新 AI client 或重启浏览器而重新 mint、join、reboot、start job 或写交互 session。

先读取受保护 effect fence、控制面 persisted attempt/Node 和独立 current target。只有无dispatch的明确证据或contract允许的幂等步骤才可重试；高风险effect需要existingreceipt对应的ownerreconcile。不要删除或改写旧记录来消除冲突。

<!-- topic:restart -->
### 控制面重启与设备重启

参考 Durable Object 保存 lifecycle/evidence/node projection；启动后读取同一对象、同一attempt与最新 evidence。控制面进程重启不等于设备reboot，不能用它满足reboot proof。设备reboot需要事前持久化checkpoint+one-dispatchfence，独立观察boot已改变，同时transport/control/provider/enrollment identity恢复。

任务只能停止自己明确拥有的进程或连接。不要重置共同store、旧Fleet实例或秘密来恢复preview。只读Console/API/MCP readback须一致；新 FAIL/UNKNOWN 必须覆盖旧PASS，而不是选择最好看的历史值。

<!-- topic:rollback -->
### 兼容切换与回滚

每个capability切换记录old/new revision、publicpackage版本、privateconfig/projectionrevision、consumer、owner、权限与恢复测试。先dry/inert环境测试再受限canary。保留原通道直到同一身份、receipt parity、未知结果恢复和rollback均通过。

回滚先核对已发生effect与schema compatibility；重新指回旧package不一定能读取新版state。不可自删运行目录、资产记录或旧机制。明确哪些薄compatibilityglue保留，哪些通用实现下一独立PR删除；示例不携带真实node/provider配置。

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

Record old/new revisions, public package version, private config/projection revision, consumer, owner, authority and recovery tests for every capability cutover. Test in an inert environment before a bounded canary. Preserve the existing path until the same identity, receipt parity, uncertain-outcome recovery and rollback pass.

Before rollback, reconcile effects and schema compatibility: pointing at the old package may not make it able to read newer state. Do not delete runtime directories, asset records or prior mechanisms. Specify which thin compatibility glue remains and which generic implementation will be removed in a separate PR; examples contain no real node/provider configuration.
