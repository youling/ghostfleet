# GhostFleet 同状态兼容控制面 / Same-state GhostFleet control plane

兼容候选保留现役 v1 源码 `d0d3e40890e4efc3bb383a871333b222bf51cf9e` 的原入口，复用 RC3 `4b2a039dc6bce169d8b00ecd34736017df1732db` 的 v2 core 与报告协议。兼容 Worker 与 RC3 节点发行物各自固定来源。RC3 节点无需换包。

- 保留面板和节点 origin、面板根路径与现有静态资源、Access 和 bearer 配置、旧引导发现与固定下载、托管请求与领取、以及 `ManagedPanelDecisionReader.readManagedEnrollment(nodeUid, ticketId)`。具名 RPC 仍通过服务绑定。旧资产和授权配置继续从独立的实例资料构建。
- v2 面板操作使用当前面板的认证模式。Access 模式的写入需要当前面板 Origin 和有效 JWT。代理观测限于现有 scoped grant。v2 领取和报告使用专用限流绑定，缺失限流时不接受 v2 节点写入。保留旧面板 URL，v2 通过 API 消费。
- v1 和 v2 共用 `GHOSTFLEET_STATE` 内同一个 `GhostFleetState` SQLite 对象 `global` 与存储键 `ghostfleet-state`。两代写入在同一个事务中按已认证的接口分派。旧 v0 和 v2 的节点撤销都会废止两代未领取授权。新的授权会替代同 UID 的未领取授权，已领取的托管决定保留至原凭据变更或撤销。已配置历史 pin 只用于当前已领取决定读回。
- `/v0/nodes` 继续基于 v1 心跳判定在线状态。`/v2/nodes` 供兼容消费者核对 v2 目标、安装及运行版本与接收时间。已切换为唯一 v2 发送方的节点可能在旧面板显示过期，切换前需确认实际读端已能使用 v2。

The compatibility Worker retains the deployed v1 surfaces at the pinned legacy revision and reuses the pinned RC3 v2 core and reporting protocol. It has its own source revision. The original RC3 node artifacts can be reused byte for byte.

The existing panel and node origins retain their legacy HTTP routes, assets, Access policies and roles, exact bootstrap downloads, and private named decision RPC. The existing panel authentication mode applies to v2 panel actions. Scoped observers and rate-limited v2 node ingress keep their own restrictions. v2 is available through the API. Legacy presence remains a v1 heartbeat projection, so consumers should confirm they can read v2 freshness before a node becomes a v2-only writer.

One transaction updates the existing SQLite object's `ghostfleet-state` snapshot for both protocols. Revocation applies to pending claims and reporting on both. Changing the reporting credential invalidates old evidence and managed decisions, while adoption alone preserves the current credential. Explicitly retained artifact pins affect decision readback only.

## 切换和恢复 / Cutover and recovery

1. 构建前核对现役 Worker、两个路由、Access、资产摘要、具名绑定及实际消费者。固定兼容 Worker 源码及构建，单独签认发布；生产 overlay 使用该实例已核准的 `NEXTGEN_VERSION`、`NEXTGEN_CLAIM_LIMIT`、`GHOSTFLEET_REPORT_LIMIT`、精确源码 revision 和所需 observer grants。保留原服务名称、DO 绑定和 migration lineage。记录原 Worker 版本及 owner 核准的一致恢复点。
2. 发布时保持一代 Worker 全流量单写者。先验证旧路径、既有 UID/凭据、具名 RPC 和旧资产，再用获准 v2 profile 同 UID 接管。验证 systemd 的唯一发送方及两代读取。新的正负控使用合成身份或已授权 canary。
3. 回原 Worker 版本只恢复代码。原旧代码留存未知 v2 字段，但无法撤销 v2 未领取授权。退回旧代码前协调停止新签发/领取/节点撤销并清点未完成请求。旧入口和 v1 心跳可用于恢复。恢复兼容代码时再核对未领取授权、原 UID 和凭据状态。保留原 DO 与 node UID，DO 数据恢复只按另行确认的一致恢复点处理。

Validate the live deployment, both origins, Access, asset digests, named bindings and consumers before approval. Keep the Worker service, DO binding and existing migration lineage, and capture the prior Worker version and an approved consistent recovery point. The instance overlay supplies its reviewed rate-limit namespaces, version metadata, exact compatibility source revision, and any scoped observers.

Use one full-traffic Worker version and one node reporter during transition. Recheck the legacy surfaces and existing UID before accepting v2 evidence. If returning to the historical Worker, coordinate an enrollment and revoke freeze and resolve outstanding authorizations before resuming writes. That historical code retains stored v2 fields and cannot apply cross-protocol revocation. Verify pending authorizations and the original identity again on roll-forward.

## 验证 / Verification

`npm test` covers the compatibility routes, exact Origin and Access behavior, unified revocation and invitation handling, legacy decisions and preserved state. The release build and isolated Workers can be validated without deployment. Consumer and recovery acceptance uses the real named RPC and an isolated persisted SQLite object across the old, compatible and restored versions. Production approval also requires an actual owner readback of the bound consumers and recovery point.
