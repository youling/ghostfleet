# Fleet migration and canonical ownership

## 中文

GhostFleet 公共仓库拥有通用产品实现；私有 Fleet 在完成替代验收前继续拥有现有生产操作和私有实例配置。此阶段不复制实时 registry，也不把 GhostFleet 的合成测试节点当成私有 Fleet 的已纳管节点。

旧代码删除不是当前 V0 控制面验收的副作用。切换必须按能力逐项完成：

| 能力 | GhostFleet 当前证据 | 替代旧实现前的验收 |
| --- | --- | --- |
| Enrollment / HumanGate / evidence admission | core + HTTP + 本地 Durable Object synthetic 流程 | 真实 Linux canonical launcher、证据来源与身份绑定 |
| 持久化及 reconcile | 本地运行时重启恢复；显式不确定状态 | 丢失响应、服务重启和真实设备结果对账 |
| Linux convergence / reboot | 目前仅公共 evidence contract | 幂等 zero-delta、真实 reboot、独立第二节点 canary |
| Windows / Android | adapter boundary，尚未迁移 | 对应平台契约、权限及实机 canary |
| typed operations / long jobs / sessions | 未在 V0 实现 | 全部现有调用方迁移，负向权限验证及 receipt parity |
| MCP | 只读 Streamable HTTP，官方 client 本地验证 | 线上连接、OAuth 集成及消费者验证 |
| Console / deployment | 本地静态资源、鉴权和 API | 真实部署、生产身份系统、安全复审及源码提供 |

每次 cutover 要有旧/新 exact revision、能力对照测试、consumer 切换证据和回滚路径。通过后，旧实现可改为明确调用公共 package 的薄兼容层；公共 core 只在 GhostFleet 维护，不在 Fleet 复制第二份修复。薄层退役和旧代码删除应在私仓独立 PR 完成，保持实例数据和配置在私有 owner。

当前结论：能够在云端完成 V0 开发和参考运行验证；尚未证明 GhostFleet 的真实设备能力超过旧 Fleet，不能移除旧生产实现。

## English

GhostFleet owns the reusable public product. Private Fleet retains its existing production operations and instance configuration until a capability-specific replacement is verified. Do not copy live registries or treat synthetic nodes as admitted private devices.

Each cutover requires exact old/new revisions, capability parity and negative authority tests, consumer migration evidence, independent live canaries, and a rollback path. After acceptance, Fleet may retain a thin package-consuming compatibility layer; generic core fixes belong exclusively in GhostFleet. Retire the old implementation in a separate private-repository PR after consumers have moved.

Cloud development and local reference validation are feasible. V0 does not yet exceed the old system's live-device capabilities and does not authorize removal of the production implementation.
