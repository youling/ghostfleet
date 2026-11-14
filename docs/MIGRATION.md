# 迁移与历史出处 / Migration and provenance

| 字段 / Field | 值 / Value |
| --- | --- |
| 文档性质 / Classification | `DERIVED`：当前产品范围的迁移解释 / Migration guidance derived from the current product scope |
| `source_pointer` | [Human 产品范围 / product scope](https://github.com/youling/ghostfleet/pull/85#issuecomment-6875500332)；[#11 执行口径 / execution scope](https://github.com/youling/ghostfleet/issues/11#issuecomment-6875523241) |
| 旧基线 / Previous baseline | [`0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1`](https://github.com/youling/ghostfleet/tree/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1) |
| 当前候选 / Current candidate | [PR #85](https://github.com/youling/ghostfleet/pull/85)，本轮文档整理时尚未合并；最终 HEAD 以该 PR 后续记录为准 / Unmerged at this documentation checkpoint; use the PR's subsequent record for its final HEAD |
| `verified_at` | `2026-11-14`；来源核对日期，不是部署完成日期 / Source check date, not a deployment completion date |
| 真实迁移结果 / Live migration result | `NOT_RUN`；本文未执行主机、账户、provider 或资源变更 / This document performs no host, account, provider or resource mutation |

## 1. 当前方向与旧基线 / Current direction and previous baseline

当前候选把 GhostFleet 收敛为 Cloudflare Tunnel 和/或 Tailscale 到原生 OpenSSH 的通道配置。旧控制面和自建执行链不再是新功能的基础。旧基线的完整源树仍可通过上表固定提交访问；它记录的是历史实现，不能当作当前候选已经部署或已通过验收的证明。

The current candidate narrows GhostFleet to Cloudflare Tunnel and/or Tailscale connectivity to native OpenSSH. The old control plane and custom execution chain no longer form the basis for new features. The pinned commit above preserves the previous source tree as historical implementation evidence, not proof that the current candidate is deployed or accepted.

[PR #83](https://github.com/youling/ghostfleet/pull/83) 的 Node Agent/SQLite 方向已被取代；原生 PR 状态为关闭、未合并，冻结候选为 [`95346d0546065dd39920f78eb526348114f9156f`](https://github.com/youling/ghostfleet/commit/95346d0546065dd39920f78eb526348114f9156f)。[PR #85](https://github.com/youling/ghostfleet/pull/85) 是新方向的候选入口。本页不把 #85 的移动分支头写成最终接受的版本，也不把其修改提前描述为已经合入默认分支。

The Node Agent/SQLite direction in [PR #83](https://github.com/youling/ghostfleet/pull/83) is superseded. Its native PR state is closed and unmerged, with the candidate frozen at [`95346d0546065dd39920f78eb526348114f9156f`](https://github.com/youling/ghostfleet/commit/95346d0546065dd39920f78eb526348114f9156f). [PR #85](https://github.com/youling/ghostfleet/pull/85) is the new candidate entry. This page does not present its moving head as an accepted final version or describe its changes as already merged into the default branch.

## 2. 迁移映射 / Migration map

| 历史域 / Historical area | 当前处置 / Current disposition |
| --- | --- |
| Console、控制面、Worker/DO、自建 bootstrap / Console, control plane, Worker/DO and custom bootstrap | 从当前产品范围退出；使用上游安装、设备注册与连接配置 / Outside the current scope; use upstream installation, device enrollment and connection configuration |
| Node Agent、SQLite 命令库、任务/租约/队列 / Node Agent, SQLite command store, jobs/leases/queues | 不恢复；会话与命令由原生 OpenSSH 和 OS 处理 / Do not restore; native OpenSSH and the OS handle sessions and commands |
| Helper、逐命令 HumanGate/JIT/issuer / Helper and per-command HumanGate/JIT/issuer | 不纳入新产品；连接准入与 OS 账户认证使用上游能力 / Excluded from the new product; upstream systems handle connection admission and OS account authentication |
| 自建命令审计、命令过滤、自动路径切换 / Custom command audit, filtering and automatic path switching | 不迁入；使用已有原生日志与人工新会话选路 / Not carried forward; use existing native logs and manual route selection for new sessions |
| 文件传输与拓扑隔离的用户需求 / File-transfer and topology-isolation needs | 需求仍保留；通过标准 SSH/SFTP/rsync、上游网络策略与密钥管理验收，不恢复旧控制面 / Preserve the needs; validate standard SSH/SFTP/rsync, upstream network policy and key custody without restoring the old control plane |

“被取代”描述产品方向，不能把旧 PR 的未修发现改写成已修复，也不能把历史静态验证、候选审查或旧环境结果复用为新通道的运行验收。

“Superseded” describes the product direction. It does not resolve outstanding findings in old PRs or convert historical static checks, candidate reviews or old-environment results into runtime acceptance of the new paths.

## 3. 42 个仓库的研究报告保留为固定历史来源 / Preserve the 42-repository report as an immutable source

旧研究报告 [REUSE_RECONNAISSANCE_2026-11-12.md](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md) 固定在旧基线，不随候选树中的文档删除而丢失。原文统计的是 **42 个主要上游仓库，不是 42 个独立项目**：管理面 14 个项目对应 15 个仓库，传输与云存储面另有 27 个仓库；原报告已将同一生态或配合使用的组件按机制分组。这份清单、当时的证据与结论均属于该日期、该产品范围的历史来源。其仓库数不能与本轮按项目统计的增量清单直接相加，也不能据此宣称覆盖了相加后的独立项目总数。

The historical [REUSE_RECONNAISSANCE_2026-11-12.md](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md) is pinned to the previous baseline and remains accessible even if omitted from the candidate tree. The source counts **42 primary upstream repositories, not 42 independent projects**: 14 management projects represented by 15 repositories, plus 27 transport and cloud-storage repositories. It already groups related or complementary components by mechanism. Its inventory, evidence and conclusions belong to that date and product scope. Do not add this repository count to the current project-based incremental inventory or present the sum as a total of independent projects.

新调研应引用这份固定来源，再单独标注当前 transport-only 方向下的增量核验与结论。不要改写旧报告来制造“当时已经选择当前架构”的印象，也不要因保留研究记录而重新引入其讨论过的运行时依赖。

New research should cite the pinned source and separately identify incremental verification and conclusions for the current transport-only direction. Do not rewrite the old report to imply that it already selected today's architecture, or reintroduce runtime dependencies merely because the report discussed them.

## 4. 源码删除与真实卸载分别记录 / Separate source removal from live removal

仓库中的 source-only 删除只改变候选源树，不能证明某台机器、某个账户或 provider 上已经卸载旧服务、删除凭据或释放资源。本文不包含自动卸载脚本，也不触发这些动作。已有实例由其原 owner 在既有授权范围内核对实际安装、服务、网络入口与资源；必要的移除、保留或恢复分别记录结果，不依据仓库路径消失推定完成。

Source-only deletion changes the candidate tree. It does not prove that an old service, credential or resource has been removed from any host, account or provider. This page contains no automatic uninstaller and initiates no such action. The existing instance owner reconciles installed services, entry points and resources within the already authorized scope, recording removal, retention or recovery separately rather than inferring completion from missing repository paths.

对新实例，按 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) 使用上游软件，再按 [ACCEPTANCE.md](ACCEPTANCE.md) 验证。对已有实例，先识别其真实状态，再形成适用于该实例的变更与恢复路径。这里没有新设审批流程，也不要求把原始密钥、令牌或私有清单搬到公开仓。

For a new instance, follow [REMOTE_ACCESS.md](REMOTE_ACCESS.md) using upstream software, then validate with [ACCEPTANCE.md](ACCEPTANCE.md). For an existing instance, establish its actual state before selecting its change and recovery path. This guidance creates no new approval workflow and requires no raw keys, tokens or private inventories in the public repository.

## 5. #69 的原工作与资源收口 / Close out the original #69 work and resources

[#69](https://github.com/youling/ghostfleet/issues/69) 的旧审批链停止新增产品投入，但已有工作和测试资源不能因产品重置而被视为自动结清。公开记录仍有 [claim](https://github.com/youling/ghostfleet/issues/69#issuecomment-6765779540)、[非终态 checkpoint](https://github.com/youling/ghostfleet/issues/69#issuecomment-6767386302) 和 [RESOURCE_PREP_PARTIAL / STOP BEFORE DEPLOYMENT 审查](https://github.com/youling/ghostfleet/issues/69#issuecomment-6768042463)。本轮没有证明这些资源已被移除，或该工作已经形成终态。

New product investment in the old approval chain of [#69](https://github.com/youling/ghostfleet/issues/69) stops, but the product reset does not automatically close existing work or test resources. Public records retain a [claim](https://github.com/youling/ghostfleet/issues/69#issuecomment-6765779540), a [nonterminal checkpoint](https://github.com/youling/ghostfleet/issues/69#issuecomment-6767386302), and a [RESOURCE_PREP_PARTIAL / STOP BEFORE DEPLOYMENT review](https://github.com/youling/ghostfleet/issues/69#issuecomment-6768042463). This checkpoint does not establish resource removal or a terminal outcome.

原实例 owner 继续负责核对资源是否存在、保留或移除的处置、旧候选的状态与可追溯的终态回执。公开工单仅记录必要摘要和公开证据指针，不添加私有仓库 URL、资源标识或凭据。这个历史收口职责独立于 #85 的通用配置与文档工作；它不恢复新产品的逐命令审批依赖，也不代表已经授权新的主机或 provider 变更。

The original instance owner retains responsibility for resource reconciliation, retention or removal, the old candidate's disposition, and a traceable terminal record. The public issue should contain only the necessary summary and public evidence pointers, without private repository URLs, resource identifiers or credentials. This historical closeout is separate from #85's generic configuration and documentation work; it neither restores a per-command approval dependency nor authorizes new host or provider changes.
