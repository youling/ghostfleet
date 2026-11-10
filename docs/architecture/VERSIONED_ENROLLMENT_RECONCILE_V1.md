# 版本化纳管与幂等收敛 v1 / Versioned enrollment and reconciliation v1

status: `PROPOSED / CONTRACT_AND_ACCEPTANCE_ONLY`
parent: `youling/ghostfleet#11`
baseline: `25e5f4b5b3c529a681c261a463a7582369be96c5`
authority: Human-approved direction; implementation, independent review and release remain separate.

This proposal is not a released bootstrap, an executable installer, a new authority grant, or a second node lifecycle. No production version or compatibility pair is certified here.

## 中文

<!-- topic:goal -->
### 1. 目标、完成边界与复用

目标是让新节点接入和旧节点维护不再被“所有组件必须追到当前 main”绑在一起：开发持续前进，节点在已验证的兼容范围内渐进收敛。Human 选定目标配置并完成必需的首次授权后，同一产品入口完成发现、最小变更、恢复和验收；不能要求 Human 临场拼第二套修复脚本。

本批只交付合同、验收用例与可审阅施工边界。真实安装、云端接线、权限、故障恢复和消费者验收仍未执行。需要其他执行者或 Human 的工作标为 `DEFERRED_*`，继续不依赖它的工作，不能将延期写成 PASS。

复用以下既有实现，不重新建产品、身份或任务数据库：

| 现有入口 | 本合同的增补，而非替代 |
|---|---|
| [Enrollment Template](../../packages/enrollment-template/src/resolver.js) | 保留 template id/version/generation/digest 与 attempt 绑定；明确其不同于软件版本 |
| [Convergence](../../packages/bootstrap/src/convergence.js) | 保留 DETECT/CLASSIFY/PLAN/最小变更/VERIFY/CHECKPOINT 思路，补跨版本与恢复义务 |
| [Management Plan](../../packages/bootstrap/src/management-plan.js) | 保留只读计划、NEW/ADOPT/REPAIR；升级是既有身份的收敛操作，不是重新纳管 |
| [Bootstrap](../../packages/bootstrap/src/bootstrap.js) | 接通所选能力与版本制品；已有 checkpoint 只是待复核线索 |
| [Ticket](../../src/control-plane/tickets.js) | 首次建立信任；不是每次更新时重复领取的凭据 |
| [Consumer acceptance](../CONSUMER_ACCEPTANCE.md) | 继续独立证明持久凭据托管、实际路由、正负例与执行者无关性 |

本基线尚未提供本合同描述的完整版本发布/升级执行链。当前包的 `0.1.0-dev` 和运行日期生成的 bootstrap 标识都不能单独证明某一组实际字节兼容。#55 首次安装接线、#62 安全启动器沿原 owner；本合同不修改其分支，也不撤销其有效缺陷。

<!-- topic:versions -->
### 2. 一个发布清单，多种独立版本

采用一个不可变 release manifest，把已验证可组合的组件固定下来；不是再造五套发布系统。

| 维度 | 记录内容 | 不得混淆 |
|---|---|---|
| 产品发布 | `release_version`、manifest digest、source revision、发布渠道 | `main` 或日期不是不可变发布 |
| 控制面与可选适配器 | 各组件版本、内容摘要、支持的接口版本 | 控制面更新不自动要求所有节点更新 |
| Bootstrap / node runtime / Helper | 各自版本、平台、制品摘要和接口 | Helper 的存在不证明执行入口或安装接线可用 |
| 配置模板 | 既有 id/version/generation/digest | 配置 generation 不是软件版本，也不是授权 generation |
| 协议与持久 schema | 每个接口的版本、明确支持范围、迁移方向 | 同一 SemVer major 不自动证明全部协议/存储兼容 |

Manifest 至少引用发布身份、确切组件字节、受支持平台、经过测试的控制面↔节点/Helper/协议组合、所需与可选能力、迁移/恢复说明。实际密钥、账号、节点地址与私有策略不得进入公开 manifest。

`stable` / `canary` / `dev` 只是发布选择渠道。一次计划将渠道解析为确切 manifest digest 后固定，执行途中不追逐移动的 `latest`。同一发布号的字节不得覆盖；同号不同摘要是冲突，不能当正常补丁接受。安全撤回使用独立受信策略/撤回记录，不篡改旧清单。

验证制品来源与完整性复用既有可信分发/签名和授权设施；摘要只能证明内容一致，不能自行证明发布者可信。不得因为下载内容自带一个公钥，就把它安装成新信任根。没有已验证稳定组合时，诚实显示候选，不能给 `-dev` 改名后宣称稳定。

<!-- topic:compatibility -->
### 3. 兼容不是“版本号相等”，也不是“旧版一律允许”

对具体能力判断：当前受信兼容策略 + 控制面/节点的实际版本与协议 + 所选目标配置 + 有效授权 + 实测证据。版本相同但摘要不同不可接受；版本不同但组合经过验收可以继续工作。

版本兼容、更新建议和风险是正交字段，不用一个枚举掩盖多个事实：

- `compatibility = SUPPORTED | INCOMPATIBLE | UNKNOWN`；
- `update = NONE | AVAILABLE | DEPRECATED`；
- `security = ALLOWED | BLOCKED`，附适用能力/组件及依据；
- `conformance = CONVERGED | DRIFT | PARTIAL | UNKNOWN`，另记实际已验收能力。

这些是**提议的投影字段**，不是本 PR 已增加的 API/schema。它们不修改现有 NodeLifecycle 或自动晋升 admission。

规则：
1. 受支持的旧节点保留已验收能力；更新可用不使节点掉出目录，也不要求重新 claim。
2. 不兼容或被安全禁用时，只限制确实受影响的能力；仅当共同信任根或整个控制通道受影响时才扩大隔离范围，并记录依据。
3. 未知不是可兼容，也不等于资源不存在。无法证明时暂停相应变更，保留其他合法通道。
4. 不承诺未经测试的 N-1/N-2 窗口；每次发布明确列出经验证组合及撤回条件。可以设定向后兼容目标，但测试完成前不能标 SUPPORTED。
5. 新功能不应自动加入所有既有节点的 required capabilities。目标配置的新增能力须显式选定并沿现行授权处理。
6. 新节点接入不依赖全舰队升级。只有该节点选定的 required capabilities 和必要共同依赖影响其验收。

已签发 attempt 固定其确切模板和发布。新版本可在并行槽位发布，但不得静默改写进行中的 attempt。当前实现的 staleness/authority 检查仍生效；支持保留旧发布槽位需要明确实现与测试，不能简单删掉检查。授权撤销、过期、信任或策略 generation 失效仍必须拒绝。

<!-- topic:convergence -->
### 4. 首次纳管与后续升级共用引擎，信任建立不同

规划路径：

```text
read-only observe -> classify -> resolve immutable target -> compatibility check
 -> minimal plan -> applicable authority check -> apply known delta
 -> fresh readback -> capability/consumer evidence -> checkpoint
```

| 入口情形 | 应做什么 | 不应做什么 |
|---|---|---|
| NEW | 经现有一次性纳管与首次本地授权建立身份，再收敛所选能力 | 假定已存在 Fleet 远控才能开始 bootstrap |
| ADOPT | 核对现存身份与管理归属，按有效授权接管 | 复制其他设备身份或静默替换 host key |
| REPAIR | 保留身份与已成功步骤，修复已确认差异 | 遇到漂移就删状态重来 |
| UPGRADE | 使用既有可信节点身份和有效维护授权收敛到固定发布 | 重新消费 enrollment ticket、重新 join 或再造 node UID |
| CONFLICT / UNKNOWN | 对账冲突/原 attempt，保留运行态 | 把不可读或超时解释成 absent |

UPGRADE 是计划意图，不要求增加一个 NodeLifecycle 状态或新身份。bootstrap 与 upgrade 可以使用不同的合法授权入口，但共用组件的 observe/plan/apply/verify 实现。可信本地施工使用已获授权的本地管理员能力；在线远控继续走其现有受控授权，不引入客户端 `is_local=true` 旁路。

对同一目标 D 与真实状态 S，收敛后再次执行不应产生实质差异：`reconcile(D, reconcile(D, S))` 与首次结果的受管资源状态相同。零差异允许新增审计观察，不允许重复创建身份/密钥、改文件时间戳、无必要重启服务或重新认证来伪装“已更新”。

每个受管组件应提供现有实现的可复用 observe/plan/apply/verify/rollback 或显式“不支持回退”语义。只在已确认差异、归属与授权下修改；不会管理的包、服务、NAS 共享/存储和业务数据不应被全局目标覆盖。没有选择 Helper 的模板不得安装它。

<!-- topic:recovery -->
### 5. 部分成功、外部副作用与恢复

不能把跨主机、云 API 和磁盘写入声称为一个原子事务。对同一 node、固定 target digest、组件和一次操作保存稳定 operation identity；在副作用前登记意图，保留结果与回读。复用现有持久存储/事务/锁设施，不再平行搭第二本纳管账。

- **本地已知差异**：按既有可信安装器原子替换文件或收敛服务；先验证字节与必要前置，再切换可用版本。只读探测或计划不能带安装/重启副作用。
- **云端创建/认证**：支持 provider 幂等键时复用同一键；不支持时先以既有 operation/resource binding 对账。超时不代表创建失败。
- **UNKNOWN/MAY_HAVE_EXECUTED**：不发新 ID 重做相同动作；先查询原请求、资源和节点状态。只有证明原操作未派发或已安全终结后，才走受支持恢复路径。
- **中途失败**：保留已验证组件与原 attempt；下一次只继续缺口。checkpoint 缺失或过旧不能替代现场复核，也不能证明“从未安装”。
- **并发与代际**：相同目标并发只允许一个 effect owner；过期计划在写前拒绝或重新规划。Desired config generation 与 authority generation 分开，不为升级忽略撤销。
- **离线**：节点保持最后一个已验收配置；报告离线/UNKNOWN，不因控制面不可达重置身份。取得有效新目标与授权后再继续。
- **回滚**：按节点及组件的已声明变更集恢复。代码回退不等于配置/服务/信任/云绑定回退；不得删除不属于本次操作的资源。不可逆迁移必须在执行前标明，不能自动假装可回滚。
- **维护入口中断**：先对账效果，不把换传输当作可重复执行证明；保留旧可用管理/恢复路径至新路径实证通过。

<!-- topic:acceptance -->
### 6. 身份、可用能力、版本符合度分别验收

继续使用既有 admission、consumer acceptance 与身份规则。核心 ACTIVE 不代表具体 consumer 已可管理；软件较旧也不自动撤销身份。能力必须由真实回读与独立消费者证据证明，不能由安装器自报 PASS。

需要区分：

```text
CONTRACT_READY != IMPLEMENTATION_READY != RELEASE_ACCEPTED
RELEASE_ACCEPTED != PRIVATE_DEPLOYED != NODE_ACCEPTED
NODE_VERSION_DRIFT != NODE_IDENTITY_REVOKED
DEFERRED != PASS
```

完整纳管所选必需能力没有证明时，不能标 FULLY_MANAGED。可以显示已证明的有限能力，但不可自动降低已选模板来凑完成。当前 admission 中包括的 reboot 等证据仍按现行合同处理；本提案不伪造 reboot PASS、不暗中删除门槛。需要调整分阶段验收语义时必须显式提出及审阅，不把历史要求藏在文案里略过。

版本差异不能成为额外的统一升级门；同样，ChatGPT 专属审批 UI、其它节点升级、可选数据面、非目标能力不得自动变为新节点基本接入的必需依赖。

[机器可读验收场景](../../test/fixtures/versioned-enrollment-v1.acceptance.json) 是**未来测试合同，不是已执行的产品测试**。每个场景最终须调用真实产品入口/组件，不得写成一个重复 expected 字段的假测试。结构校验器只检查此场景文件的完整性。

<!-- topic:delivery -->
### 7. 固定候选、批量交接与分节点收敛

先完成合同、场景、变更归属和施工包；把需要工头/独立 reviewer/生产凭据/Host 的项放入同一依赖表。不会因为一项延期阻断不依赖它的准备，也不能将相关依赖的实际执行顺序跳过。

建议施工分包（仍属 #11，不新设平级产品）：

| 包 | 现有 owner/位置 | 交付终点 |
|---|---|---|
| A 启动与所选能力 | 原 #55/#62 owners；bootstrap / installer | 同一首次授权过程完成所选安装；安全 root/sudo/su；真实 disposable OS 正负例 |
| B 发布与兼容 | 本合同下后续具名实现者；复用 bootstrap/template | 不可变 manifest、兼容判定与既有 identity/generation 规则适配 |
| C 收敛执行与恢复 | 原 #11 集成 owner；复用 A/B 与既有 journal/receipt | 新装、重复、升级、部分失败恢复、UNKNOWN、并发与回滚真实接线 |
| D 发布/消费者 | 现有 release 与部署 owner | exact-head 独立审查、候选发布锁定、私有接线、真实消费者证明 |

不在本批启动上述工头或声称已认领。以后派发必须附精确 source/制品、write set、测试矩阵、预期变更、恢复与停止条件。合并仍需现行 exact-head 审阅，不因“批量处理”自动自审。

舰队升级是一次可恢复的 campaign，而非全节点同步大改：只读盘点 → 冻结目标 → 一节点 canary → 分节点波次 → 状态回读。一个节点失败暂停受影响波次；不删除兼容旧节点、不重建已完成步骤、不全网旋转凭据。硬件重启、存储迁移、主机/provider 权限在真正执行前分别核准。

审查应一次性汇总当前可证明的 blocker 与非阻断债务。新 main/可选功能不使已冻结候选自然失效；新发现的身份、凭据、数据损坏或执行一致性缺陷则仍可阻断。目标是减少无效返修，不是限制发现真实问题。

<!-- topic:prior-art -->
### 8. 外部依据与采用范围

- [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)：借鉴不可变发布内容与接口变更的版本表达；SemVer 本身不是兼容测试。
- [Kubernetes version skew policy](https://kubernetes.io/releases/version-skew-policy/)：借鉴按组件明确受支持版本差异，而不照搬其具体版本窗口或升级顺序。
- [Ansible declarative modules](https://docs.ansible.com/projects/ansible/latest/command_guide/intro_adhoc.html)：借鉴观察实际状态、只修改目标差异。没有要求引入 Ansible 作为必需依赖。
- [Ansible check mode](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_checkmode.html)：计划/模拟与实际执行须分别证明，不能用 check 结果替代设备验收。

## English

<!-- topic:goal -->
### Goal, boundary and reuse

Permit independently evolving software and tested version skew without making every node follow the latest development commit. Reuse the existing template, ticket, bootstrap/convergence, management planner, identity, lifecycle and consumer-acceptance contracts linked above. This delivery is a proposal and acceptance specification only; deferred implementation, independent review, deployment and device work is not passed work. Existing #55/#62 ownership and findings remain intact.

<!-- topic:versions -->
### Immutable releases and separate version dimensions

Use one immutable release manifest referencing exact component versions/digests, source revisions, platforms, supported interfaces, required/optional capabilities and verified compatibility combinations. Control-plane, bootstrap/runtime/Helper, template generation and protocol/storage schema evolve independently. A release date is observation metadata, not executable provenance. Channels resolve once to an immutable target; never follow mutable latest during an attempt. Same version with different bytes is a conflict. Integrity alone does not authenticate a publisher; reuse existing trusted distribution and approval, without accepting a trust root supplied by the download itself. No stable release or supported combination is certified by this proposal.

<!-- topic:compatibility -->
### Capability-specific compatibility

Compatibility (`SUPPORTED/INCOMPATIBLE/UNKNOWN`), update advice (`NONE/AVAILABLE/DEPRECATED`), security policy (`ALLOWED/BLOCKED`) and conformance (`CONVERGED/DRIFT/PARTIAL/UNKNOWN`) are proposed orthogonal projections, not new implemented APIs or a second node lifecycle. Keep tested older capabilities usable. Restrict incompatible/security-blocked effects at their actual scope; shared trust compromise can require wider isolation with evidence. Do not promise an untested N-minus-one window. New optional features do not automatically become requirements for all nodes.

An in-flight enrollment keeps its exact release/template binding. Supporting retained release slots requires an implementation, not removing current staleness checks. Revocation, expiry and authority generations remain effective. A new node does not wait for fleet-wide upgrades.

<!-- topic:convergence -->
### One engine, different trust-entry paths

Observe, classify, freeze the target, check compatibility, plan the minimum delta, check current authority, apply, independently read back and checkpoint. NEW uses initial enrollment trust; ADOPT verifies existing identity/ownership; REPAIR preserves successful steps; UPGRADE uses existing authenticated identity and maintenance authority rather than consuming another enrollment ticket. CONFLICT/UNKNOWN requires reconciliation. UPGRADE is an intent, not a new node identity/lifecycle state.

Repeated execution of the same desired state produces no material changes after convergence: no duplicate identity/credential, unnecessary timestamp write, service restart or reauthentication. Audit observations may be appended. Reuse component implementations for observe/plan/apply/verify/rollback and explicitly identify unsupported reversals. Unselected privileged components and unmanaged host/business state remain untouched. Authorized local construction does not depend on a pre-existing online Fleet control path; remote authority is not bypassed through a locality flag.

<!-- topic:recovery -->
### Recovery and external effects

Do not claim a global atomic transaction across disk, hosts and providers. Persist a stable operation identity and intent before effects using existing journal/transaction facilities. Reuse provider idempotency keys where supported; otherwise reconcile original resource bindings before retrying. UNKNOWN/MAY_HAVE_EXECUTED never justifies a new identifier and blind repeat. Resume missing steps after fresh observation; a checkpoint is a hint, not proof. Enforce one effect owner, reject stale plans before writes and keep desired-state generations separate from authority generations. Offline nodes retain their last accepted state. Rollback is node/component scoped and verifies configuration, services, trust and provider bindings, not only code. Never remove resources outside the operation; irreversible migrations need explicit preconditions and authority. Preserve an accepted control/recovery path until its successor is proven.

<!-- topic:acceptance -->
### Evidence and completion

Identity admission, consumer acceptance, capability readiness and version conformance stay separate. ACTIVE is not consumer acceptance; version drift is not identity revocation. Missing required capabilities cannot be hidden by silently weakening a selected template. Existing reboot/admission rules are not removed or marked passed here; any staged-admission change needs explicit review. Client-specific approval UX and unrelated fleet work are not automatic prerequisites for basic enrollment. The linked JSON scenarios are future implementation acceptance cases; the supplied checker validates their structure only, not runtime behavior.

<!-- topic:delivery -->
### Bounded delivery and rollout

Prepare contracts, scenarios and one consolidated handoff before engaging deferred workers or humans. Keep packages A–D with existing owners; later dispatches bind exact inputs/write sets, preconditions, expected changes, recovery and tests. No worker is launched by this document. Review a frozen candidate against a consolidated blocker list; new development commits do not endlessly reset the gate, while genuine new safety/correctness findings still matter. Rollout uses inventory, a pinned target, one canary and per-node waves. Device, production, credential and outage permissions remain separate; merge is not deployment.

<!-- topic:prior-art -->
### Prior art

The official references above support immutable versioned releases, explicit component skew policies, declarative minimum-delta convergence and separating simulation from real execution. They do not certify GhostFleet, require new infrastructure, or supply its compatibility matrix.
