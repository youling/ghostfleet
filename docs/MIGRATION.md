# 迁移与历史出处 / Migration and provenance

| 字段 / Field | 值 / Value |
| --- | --- |
| 文档性质 / Classification | `DERIVED`：当前产品范围的迁移解释 / Migration guidance derived from the current product scope |
| `source_pointer` | [当前产品与实施入口 / Current product and implementation](https://github.com/youling/ghostfleet/issues/11)；[ADR004](adr/004-lightweight-enrollment-presence.md) |
| 旧基线 / Previous baseline | [`0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1`](https://github.com/youling/ghostfleet/tree/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1) |
| 当前版本 / Current revision | 读取 #11 引用的当前 PR、提交与裁决，不从本页推断分支状态 / Read the current PR, commit and disposition linked from #11; do not infer branch state from this page |
| `verified_at` | `2026-11-16`；文档范围核对日期，不是部署完成日期 / Documentation scope check date, not a deployment completion date |
| 真实迁移结果 / Live migration result | 由 #11 引用的实例回执提供；本文不覆盖已接受的现场证据，也不触发变更 / Established by instance receipts linked from #11; this page neither supersedes accepted live evidence nor initiates mutations |

## 1. 当前方向与旧基线 / Current direction and previous baseline

当前产品是原生 SSH 传输、轻量首次注册与节点心跳面板。Cloudflare Tunnel 和/或 Tailscale 连接同一 OpenSSH；面板与 oneshot reporter 仅管理注册、上报凭据和最新状态。ADR004 取代 2026-11-14 transport-only 阶段对全部面板与状态上报的排除，不恢复旧命令执行平台。旧基线的完整源树仍可通过上表固定提交访问；历史代码保留不等于当前版本已经部署或通过验收。

The current product combines native SSH transport with lightweight enrollment and presence. Cloudflare Tunnel and/or Tailscale reach the same OpenSSH service; the panel and oneshot reporter manage registration, reporting credentials and the latest observations only. ADR004 supersedes the 2026-11-14 transport-only exclusion of every panel and status-reporting feature, without restoring the former command-execution platform. The pinned source tree remains historical evidence, not proof of current deployment or acceptance.

[PR #83](https://github.com/youling/ghostfleet/pull/83) 的 Node Agent/SQLite 方向已被取代；历史关闭时未合并，候选为 [`95346d0546065dd39920f78eb526348114f9156f`](https://github.com/youling/ghostfleet/commit/95346d0546065dd39920f78eb526348114f9156f)。[PR #85](https://github.com/youling/ghostfleet/pull/85) 承接产品收敛，后续集成与接受记录由 #11 索引。本页不把移动分支头写成最终接受版本，也不保存 PR 的实时状态副本。

The Node Agent/SQLite direction in [PR #83](https://github.com/youling/ghostfleet/pull/83) is superseded. It was closed without merging, at candidate [`95346d0546065dd39920f78eb526348114f9156f`](https://github.com/youling/ghostfleet/commit/95346d0546065dd39920f78eb526348114f9156f). [PR #85](https://github.com/youling/ghostfleet/pull/85) carries the product convergence; #11 indexes subsequent integration and acceptance. This page neither freezes a moving branch as an accepted version nor duplicates live PR status.

## 2. 迁移映射 / Migration map

| 历史域 / Historical area | 当前处置 / Current disposition |
| --- | --- |
| Console 外观、first-use 与应用鉴权 / Console appearance, first-use and application authentication | 按 ADR004 在原目录选择性复用，不整包恢复旧 controller / Selectively reuse in the original directories under ADR004, without restoring the former controller wholesale |
| Worker/DO 与节点身份 / Worker/DO and node identity | 保留既有类、binding、对象身份、存储键和 node_uid；只增加票据与最新心跳投影 / Preserve the existing class, binding, object identity, storage key and node_uid; add tickets and the latest heartbeat projection only |
| 旧 bootstrap、capability bundle 与七证据纳管 / Former bootstrap, capability bundle and seven-evidence enrollment | 不恢复；当前安装器只为已有原生传输添加状态上报 / Do not restore; the current installer adds reporting to existing native transport only |
| Node Agent、SQLite 命令库、任务/租约/队列 / Node Agent, SQLite command store, jobs/leases/queues | 不恢复；会话与命令由原生 OpenSSH 和 OS 处理 / Do not restore; native OpenSSH and the OS handle sessions and commands |
| Helper、逐命令 HumanGate/JIT/issuer / Helper and per-command HumanGate/JIT/issuer | 不纳入新产品；连接准入与 OS 账户认证使用上游能力 / Excluded from the new product; upstream systems handle connection admission and OS account authentication |
| 自建命令审计、命令过滤、自动路径切换 / Custom command audit, filtering and automatic path switching | 不迁入；使用已有原生日志与人工新会话选路 / Not carried forward; use existing native logs and manual route selection for new sessions |
| 原生传输、文件传输与拓扑隔离 / Native transport, file transfer and topology isolation | 复用 OpenSSH、CF/TS、systemd/journald；通过标准 SSH/SFTP/rsync、上游网络策略与密钥管理验收 / Reuse OpenSSH, CF/TS and systemd/journald; validate standard SSH/SFTP/rsync, upstream network policy and key custody |

“被取代”描述产品方向，不能把旧 PR 的未修发现改写成已修复，也不能把历史静态验证、候选审查或旧环境结果复用为新通道的运行验收。

“Superseded” describes the product direction. It does not resolve outstanding findings in old PRs or convert historical static checks, candidate reviews or old-environment results into runtime acceptance of the new paths.

## 3. 42 个仓库的研究报告保留为固定历史来源 / Preserve the 42-repository report as an immutable source

旧研究报告 [REUSE_RECONNAISSANCE_2026-11-12.md](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md) 固定在旧基线，不随候选树中的文档删除而丢失。原文统计的是 **42 个主要上游仓库，不是 42 个独立项目**：管理面 14 个项目对应 15 个仓库，传输与云存储面另有 27 个仓库；原报告已将同一生态或配合使用的组件按机制分组。这份清单、当时的证据与结论均属于该日期、该产品范围的历史来源。其仓库数不能与本轮按项目统计的增量清单直接相加，也不能据此宣称覆盖了相加后的独立项目总数。

The historical [REUSE_RECONNAISSANCE_2026-11-12.md](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md) is pinned to the previous baseline and remains accessible even if omitted from the candidate tree. The source counts **42 primary upstream repositories, not 42 independent projects**: 14 management projects represented by 15 repositories, plus 27 transport and cloud-storage repositories. It already groups related or complementary components by mechanism. Its inventory, evidence and conclusions belong to that date and product scope. Do not add this repository count to the current project-based incremental inventory or present the sum as a total of independent projects.

后续调研引用固定历史来源，再单独标注适用领域、日期和增量结论。[2026-11-14 传输侦察](research/TRANSPORT_RECONNAISSANCE_2026-11-14.md) 仍是该日传输域的研究输入，不冒充对当前面板全部机制的核验。不要改写旧报告来制造“当时已经选择当前架构”的印象，也不要因保留研究记录而重新引入其讨论过的运行时依赖。

Later research cites the pinned history and identifies its own domain, date and incremental conclusions. The [2026-11-14 transport reconnaissance](research/TRANSPORT_RECONNAISSANCE_2026-11-14.md) remains dated transport-domain input, not verification of every current panel mechanism. Do not rewrite historical reports to imply they already selected today's architecture, or restore dependencies merely because a report discussed them.

## 4. 源码删除与真实卸载分别记录 / Separate source removal from live removal

仓库中的 source-only 删除只改变候选源树，不能证明某台机器、某个账户或 provider 上已经卸载旧服务、删除凭据或释放资源。本文不包含自动卸载脚本，也不触发这些动作。已有实例由其原 owner 在既有授权范围内核对实际安装、服务、网络入口与资源；必要的移除、保留或恢复分别记录结果，不依据仓库路径消失推定完成。

Source-only deletion changes the candidate tree. It does not prove that an old service, credential or resource has been removed from any host, account or provider. This page contains no automatic uninstaller and initiates no such action. The existing instance owner reconciles installed services, entry points and resources within the already authorized scope, recording removal, retention or recovery separately rather than inferring completion from missing repository paths.

对新实例，按 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) 使用上游软件，再按 [ACCEPTANCE.md](ACCEPTANCE.md) 验证原生传输。轻量注册与状态上报按 [PRESENCE.md](PRESENCE.md) 安装，按 [DELIVERY.md](DELIVERY.md) 分阶段交付。已有实例先核对其真实状态、消费者和数据，再选择变更与恢复路径；保留 DO 身份与既有 node_uid，不因重发票据另造节点。这里没有新设审批流程，也不要求把原始密钥、令牌或私有清单搬到公开仓。

For a new instance, follow [REMOTE_ACCESS.md](REMOTE_ACCESS.md) using upstream software and validate native transport with [ACCEPTANCE.md](ACCEPTANCE.md). Install enrollment/reporting through [PRESENCE.md](PRESENCE.md) and deliver by [DELIVERY.md](DELIVERY.md). For existing instances, reconcile actual state, consumers and data before choosing changes and recovery; retain DO identity and existing node_uid rather than creating another node when reissuing a ticket. This adds no approval workflow and requires no raw keys, tokens or private inventories in the public repository.

## 5. #69 的原工作与资源收口 / Close out the original #69 work and resources

[#69](https://github.com/youling/ghostfleet/issues/69) 的旧审批链停止新增产品投入，但已有工作和测试资源不能因产品重置而被视为自动结清。公开记录仍有 [claim](https://github.com/youling/ghostfleet/issues/69#issuecomment-6765779540)、[非终态 checkpoint](https://github.com/youling/ghostfleet/issues/69#issuecomment-6767386302) 和 [RESOURCE_PREP_PARTIAL / STOP BEFORE DEPLOYMENT 审查](https://github.com/youling/ghostfleet/issues/69#issuecomment-6768042463)。本轮没有证明这些资源已被移除，或该工作已经形成终态。

New product investment in the old approval chain of [#69](https://github.com/youling/ghostfleet/issues/69) stops, but the product reset does not automatically close existing work or test resources. Public records retain a [claim](https://github.com/youling/ghostfleet/issues/69#issuecomment-6765779540), a [nonterminal checkpoint](https://github.com/youling/ghostfleet/issues/69#issuecomment-6767386302), and a [RESOURCE_PREP_PARTIAL / STOP BEFORE DEPLOYMENT review](https://github.com/youling/ghostfleet/issues/69#issuecomment-6768042463). This checkpoint does not establish resource removal or a terminal outcome.

原实例 owner 继续负责核对资源是否存在、保留或移除的处置、旧候选的状态与可追溯的终态回执。公开工单仅记录必要摘要和公开证据指针，不添加私有仓库 URL、资源标识或凭据。这个历史收口职责独立于 #85 的通用配置与文档工作；它不恢复新产品的逐命令审批依赖，也不代表已经授权新的主机或 provider 变更。

The original instance owner retains responsibility for resource reconciliation, retention or removal, the old candidate's disposition, and a traceable terminal record. The public issue should contain only the necessary summary and public evidence pointers, without private repository URLs, resource identifiers or credentials. This historical closeout is separate from #85's generic configuration and documentation work; it neither restores a per-command approval dependency nor authorizes new host or provider changes.
