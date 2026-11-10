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

本规范完整整合 S1（版本化发布与兼容设计）、S2（幂等收敛与故障恢复引擎）和 S3（六级证据模型与验收矩阵）三项架构合同。真实安装、云端接线、权限授予、故障注入与消费者验收仍未执行。需要其他执行者或 Human 介入的工作严格标为 `DEFERRED_*`，继续推进不依赖其的工作，绝不能将延期写成 PASS。

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
### 2. 发布清单、渠道解耦与来源真实性 (S1)

采用一个不可变 release manifest，把已验证可组合的组件固定下来；不是再造五套发布系统。

#### 2.1 不可变载荷与可变渠道指针解耦

明确区分不可变制品集合与动态发布渠道：
- `ReleaseManifestPayloadV1`：不可变产品发布载荷，记录确切组件版本、内容摘要、支持平台、接口契约和能力集。
- `ReleaseChannelPointerV1`：可变渠道指针（如 `stable`、`canary`、`dev`），指向确切的 `manifest_digest`，附带单调递增的序列号/代际以及经验证的发布者凭据。渠道指针绝不属于不可变 Manifest 载荷的一部分。

计划阶段将渠道解析为确切的 `manifest_digest` 后立即冻结；执行期间严格绑定该固定摘要，绝不追逐移动中的 `latest`。回滚操作仅改变渠道指针指向此前已验收的清单摘要，不篡改或覆盖已有不可变清单。

#### 2.2 规范摘要与来源真实性

采用 RFC 8785 JSON Canonicalization Scheme (JCS) 与 SHA-256 计算规范摘要：
```text
manifest_digest = "sha256:" + hex(SHA256(JCS(ReleaseManifestPayloadV1)))
```
载荷本身在结构上排除 `digest` 字段与分离签名/封套字段。校验器在哈希前必须拒绝重复 JSON 键、非 I-JSON 输入、格式错误的数值与未归一化的 Unicode。

摘要一致仅证明字节未被篡改，绝不等于发布者真实可信。在执行任何特权安装或更新前，必须通过已建立的可信根验证发布者签名与来源证明。随不可变清单附带的公钥不能自声明为信任锚点；缺失发布者证明时，系统报告 `PUBLISHER_UNVERIFIED` / `UNKNOWN`，绝不因摘要匹配而放行安装。

#### 2.3 正交维度解耦

| 维度 | 记录内容 | 不得混淆 |
|---|---|---|
| 产品发布 | `release_version` (SemVer)、manifest digest、source revision | `main` 分支或构建日期不是不可变发布 |
| 控制面与可选适配器 | 各组件版本、内容摘要、支持的接口版本 | 控制面更新不自动要求所有受管节点更新 |
| Bootstrap / node runtime / Helper | 各自版本、平台架构、制品摘要和接口 | Helper 的存在不证明执行入口或安装接线可用 |
| 配置模板 | 既有 template id/version/generation/digest | 配置 generation 不是软件版本，也不是授权 generation |
| 协议与持久 schema | 每个接口的版本、支持范围、迁移方向 | 同一 SemVer major 不自动证明存储/协议兼容 |
| 执行授权 | 会话/任务租期、授予范围、失效时间 | 授权代际不同于配置代际，过期即失效 |

<!-- topic:compatibility -->
### 3. 能力级兼容判定与外部证据绑定 (S1/S3)

对具体能力判断：当前受信兼容策略 + 控制面/节点的实际版本与协议 + 所选目标配置 + 有效授权 + 实测证据。版本相同但摘要不同不可接受；版本不同但组合经过验收可以继续工作。

#### 3.1 外部兼容证据记录

兼容证据必须作为独立的不可变记录（`CompatibilityAttestationV1` / `ReleaseCompatibilityEvidence`）存在，按已计算出的 `manifest_digest` 索引，绝不放在 Manifest 载荷内部，从而消除摘要自引用死锁。

每条兼容证据必须精确绑定：
1. 目标组件元组：控制面、node runtime、特权 Helper（若选定）的具体版本与制品 SHA-256 摘要；
2. 协议与模式版本：控制 API 版本与持久化 checkpoint 模式；
3. 目标运行环境：操作系统发行版、内核代际与 CPU 架构；
4. 实测能力子集：具体通过验收测试的能力列表（兼容性是按能力划分的）；
5. 证据出处：测试套件版本、CI 工作流运行引用、Job 标识、测试报告制品摘要及时间戳。

#### 3.2 判定状态与正交投影

判定状态采用封闭枚举：
- `SUPPORTED`：所有必需证据引用均可解析且与目标元组完全匹配；
- `INCOMPATIBLE`：存在明确的负向兼容测试结果或适用的安全撤回记录；
- `UNKNOWN`：证据缺失、过期、无法验证或属于不同制品元组。未经验证的旧版本组合只能是 `UNKNOWN`，绝不能默认视为兼容；示例中的占位符摘要与缺少测试的元组一律保持 `UNKNOWN`（`evidence_ref: null`）。

各状态为**正交投影字段**，不修改现有 NodeLifecycle 状态机：
- `compatibility = SUPPORTED | INCOMPATIBLE | UNKNOWN`；
- `update = NONE | AVAILABLE | DEPRECATED`；
- `security = ALLOWED | BLOCKED`，附受限能力范围及依据；
- `conformance = CONVERGED | DRIFT | PARTIAL | UNKNOWN`，附实际验证能力。

规则：
1. 受支持旧节点保留已验收能力；更新可用不使节点掉出目录，也不要求重新 claim。
2. 不兼容或被安全撤回时，仅在实际受影响能力范围内拦截；仅当共同信任根受损时才扩大隔离。
3. 无法证明兼容时暂停相应变更，保留其他合法通道。
4. 不承诺未经测试的 N-1/N-2 兼容窗口；每次发布明确列出经验证组合及撤回条件。

<!-- topic:convergence -->
### 4. 统一收敛引擎与分级信任建立 (S2)

规划收敛路径：
```text
observe -> classify -> resolve immutable target -> compatibility check
 -> plan minimal delta -> verify authority -> apply known delta
 -> fresh readback -> record evidence -> checkpoint
```

#### 4.1 共享引擎的五个类型化接口

统一引擎提供五个明确的类型化边界：
1. `observe(target, selectors)` → 清洗后的观测事实 + 观测时间戳/来源 + 身份绑定；
2. `plan(desired, observed, release, compatibility)` → 包含最小变更、冲突/未知项与所需权限的只读计划；
3. `apply(plan, execution_context)` → 执行操作回执；执行前必须重新比对目标、制品摘要、当前状态与会话权限；
4. `verify(plan, fresh_observation)` → 逐个组件的独立验证结果与符合度投影；
5. `checkpoint(operation_receipts)` → 无凭据的恢复线索（线索仅供复查，不等于主机合规证明）。

#### 4.2 四种计划意图与信任入口

`NEW / ADOPT / REPAIR / UPGRADE` 是计划意图，不是新设立的 NodeLifecycle 状态，它们共用组件级收敛实现：

| 入口情形 | 应做什么 | 不应做什么 |
|---|---|---|
| NEW | 经现有一次性纳管与首次本地授权建立身份，再收敛所选能力 | 假定已存在 Fleet 远控才能开始 bootstrap |
| ADOPT | 核对现存身份与管理归属，按有效授权接管 | 复制其他设备身份或静默替换 host key |
| REPAIR | 保留身份与已成功步骤，修复已确认差异 | 遇到漂移就删状态重来 |
| UPGRADE | 使用既有可信节点身份和有界维护授权收敛到固定发布 | 重新消费 enrollment ticket、重新 join 或再造 node UID |
| CONFLICT / UNKNOWN | 停止受影响写操作，对账冲突/原 attempt，保留运行态 | 把不可读或超时解释成 absent |

#### 4.3 计划身份绑定与过期防护

计划对象至少绑定：目标 node UID（或未建身份前的 attempt ID）、期望模板摘要与代际、不可变 release manifest 摘要与组件制品摘要、观测状态快照摘要、计划 ID、过期时间、预期状态代际、所需能力子集及对应授权引用。执行器在产生副作用前重新校验目标身份与代际；过期或被取代的计划立即拒绝并重新规划。

#### 4.4 真正的二次运行零差异与 NAS 安全边界

对同一目标 D 与真实状态 S，二次执行必须达到真实零差异：`reconcile(D, reconcile(D, S))` 产生 `ZERO_DELTA`。不允许通过重复创建身份/密钥、修改文件时间戳、无必要重启服务或重新认证来伪装“已更新”。

针对 NAS 设备（如 OMV8）：存储池、RAID 阵列、文件系统、共享目录、业务容器和持久卷严格排除在受管写集之外。只读盘点不代表可随意修改；没有单独授权，不得触发主机重启。

<!-- topic:recovery -->
### 5. 副作用分类、持久日志与故障恢复 (S2)

不能把跨主机、云 API 和磁盘写入声称为一个原子事务。必须对同一 node、固定 target digest、组件和一次操作保存稳定 operation identity；在副作用前登记意图，保留结果与回读。

#### 5.1 操作副作用分级

每个计划操作必须声明其副作用等级：
- `REPEATABLE_LOCAL`：确定性本地状态（如受管包、配置文件、服务）。先比对内容，内容一致则零变更；使用原子替换并验证。
- `RECONCILABLE_EXTERNAL`：云端 Provider 支持幂等键或可查询资源引用。重试时复用同一 operation ID，先对账原资源。
- `ONE_SHOT`：节点身份创建、Ticket 领用、一次性网络秘钥铸造。丢失响应时严禁静默重发新请求铸造新凭据。
- `COMPENSATABLE`：可在确认资源所有权与补偿记录后精确反向冲正的操作。
- `IRREVERSIBLE`：不可逆操作（如不可逆数据迁移），必须在执行前显式标明，不承诺自动回滚。

#### 5.2 持久操作日志与并发防护

操作状态迁移严格遵循：
```text
PLANNED → PREPARED → DISPATCHED → ACKNOWLEDGED → VERIFIED
```
异常状态处理：
- `UNKNOWN / MAY_HAVE_EXECUTED`：严禁使用新 operation ID 盲目重试；必须对账原请求状态。
- `COMPENSATING → COMPENSATED`：仅在已确认资源归属且补偿成功后标记。
- `FAILED_FINAL`：仅用于已证实未产生副作用的确定性失败。

并发防护通过持有单调递增代际（fencing epoch）的持久分布式锁实现。锁过期不代表第二执行者可重复发起不确定的外部调用。持久日志中只记录脱敏引用，严禁泄露密钥、Token 或密码。

#### 5.3 故障恢复与离线保留

- 崩溃恢复：先重新观测组件现状，对账处于 UNKNOWN 状态的外部操作；仅继续确实未执行或可安全收敛的缺失差量。
- 离线处理：节点离线时保持最后一个已验收的本地配置，上报 OFFLINE/UNKNOWN；控制面不可达不触发身份重置或清空状态。
- 回滚边界：回滚严格限定于本次操作已声明并记录的变更集；代码回退不等于配置/服务/云端绑定自动回退，绝不误删未受管资源或业务数据。

<!-- topic:acceptance -->
### 6. 三域证据分立与六级证据模型 (S3)

继续使用既有 admission、consumer acceptance 与身份规则。核心 ACTIVE 不代表具体 consumer 已可管理；软件较旧也不自动撤销身份。能力必须由真实回读与独立消费者证据证明，不能由安装器自报 PASS。

#### 6.1 区分三个独立的证据领域

1. **Release Compatibility Evidence（发布兼容证据）**：证明特定组件、版本、协议和平台元组在 CI/测试环境中已通过联合实测。
2. **Node Conformance Evidence（节点符合度证据）**：证明特定节点在特定时刻的观测状态与所选的不可变发布及模板完全符合。
3. **Consumer Acceptance（消费者验收证据）**：证明独立消费者能够通过受管路由与持久凭据正常纳管节点，通过正负例权限检验，并具备独立回退计划。

三者拥有不同的生命周期与主体，不得混为一谈。

#### 6.2 六级证据等级 (T0–T5)

每个验收场景与测试执行必须明确声明其证据等级，弱等级证据严禁假借为强等级证据：

| 等级 | 证据类别 | 证明能力 | 无法证明的内容 |
|---|---|---|---|
| T0 | 静态/规范/模式校验 | 合同结构、封闭枚举、字段引用、无违规机密 | 实际运行时行为与系统交互 |
| T1 | 单元测试 / AST 解析 | 纯解析器、分类器、规范摘要计算、规划算法逻辑 | 持久化存储、系统调用或 OS 副作用 |
| T2 | 契约模拟 / Worker 集成 | 状态机迁移、API 鉴权、并发/重放防护、故障注入 | 真实硬件、真实 Provider 凭据或真实主机 |
| T3 | 一次性合成环境 / 容器 | 实际安装流程、服务收敛、配置原子写、重启计数、崩溃恢复 | 生产 Provider 授权与外部网络环境 |
| T4 | 一次性设备 / 系统集成 | Systemd 完整接线、特权 Helper 隔离、NAS 存储写集保护 | 跨网络消费者路由与最终托管凭据 |
| T5 | 独立消费者端到端读回 | 生产部署版本、真实 Provider 凭据、独立观察者端到端托管 | 其他未经实测的发布元组或节点 |

#### 6.3 封闭测试结果词汇与 24 个用例冻结

测试结果采用封闭词汇：`PASS`、`FAIL`、`BLOCKED`、`UNKNOWN`、`NOT_RUN`、`DEFERRED`。只有 `PASS` 计入验收；`NOT_RUN`、`DEFERRED` 与 `BLOCKED` 绝不能通过汇总或包装伪造成 `PASS`。

[24 项机器可读验收场景](../../test/fixtures/versioned-enrollment-v1.acceptance.json) 是**未来执行合同，当前保持 NOT_RUN**。用例覆盖 6 大分组与 T0–T5 全部层级：
- 版本与兼容：VE-01 (T2), VE-02 (T1), VE-03 (T1), VE-04 (T2), VE-05 (T2)
- 身份与纳管：VE-06 (T1), VE-07 (T3), VE-08 (T1)
- 幂等收敛：VE-09 (T3), VE-10 (T3), VE-11 (T4), VE-12 (T1)
- 恢复与并发：VE-13 (T3), VE-14 (T2), VE-15 (T3), VE-16 (T1), VE-17 (T3), VE-18 (T3)
- 授权与本地施工：VE-19 (T1), VE-20 (T2), VE-21 (T1)
- 消费者与设备验收：VE-22 (T5), VE-23 (T4), VE-24 (T0)

24 个用例标识已严格冻结，不为虚增覆盖率而增减用例。

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

不在此处声称上述工程已经实现或已获独立审批。合并仍需现行 exact-head 审阅，不因“批量处理”自动自审。

舰队升级是一次可恢复的 campaign，而非全节点同步大改：只读盘点 → 冻结目标 → 一节点 canary → 分节点波次 → 状态回读。一个节点失败暂停受影响波次；不删除兼容旧节点、不重建已完成步骤、不全网旋转凭据。硬件重启、存储迁移、主机/provider 权限在真正执行前分别核准。

审查应一次性汇总当前可证明的 blocker 与非阻断债务。新 main/可选功能不使已冻结候选自然失效；新发现的身份、凭据、数据损坏或执行一致性缺陷则仍可阻断。目标是减少无效返修，不是限制发现真实问题。

<!-- topic:prior-art -->
### 8. 外部依据与采用范围

- [SemVer 2.0.0](https://github.com/semver/semver.org/blob/gh-pages/spec/v2.0.0.md)：借鉴不可变发布内容与接口变更的版本表达；SemVer 本身不是兼容测试。
- [Kubernetes version skew policy](https://github.com/kubernetes/website/blob/main/content/en/releases/version-skew-policy.md)：借鉴按组件明确受支持版本差异，而不照搬其具体版本窗口或升级顺序。
- [Ansible declarative modules](https://github.com/ansible/ansible-documentation/blob/devel/docs/docsite/rst/command_guide/intro_adhoc.rst)：借鉴观察实际状态、只修改目标差异。没有要求引入 Ansible 作为必需依赖。
- [Ansible check mode](https://github.com/ansible/ansible-documentation/blob/devel/docs/docsite/rst/playbook_guide/playbooks_checkmode.rst)：计划/模拟与实际执行须分别证明，不能用 check 结果替代设备验收。
- RFC 8785 (JSON Canonicalization Scheme / JCS)：借鉴不可变载荷的确定性规范化哈希算法，排除签名封套，防止跨平台字符编码与属性排序歧义。

## English

<!-- topic:goal -->
### Goal, boundary and reuse

Permit independently evolving software and tested version skew without making every node follow the latest development commit. This specification integrates the S1 (Versioned Releases & Compatibility), S2 (Idempotent Convergence & Fault Recovery Engine), and S3 (Six-Tier Evidence Hierarchy & Acceptance Contract) architectural deliverables.

Reuse the existing template, ticket, bootstrap/convergence, management planner, identity, lifecycle and consumer-acceptance contracts linked above. This delivery is a proposal and acceptance specification only; deferred implementation, independent review, deployment and device work remain labeled `DEFERRED_*` and are never substituted with a synthetic PASS. Existing #55/#62 ownership and findings remain intact.

<!-- topic:versions -->
### Immutable release manifest, channel decoupling and publisher authenticity (S1)

Adopt a single immutable release manifest to pin verified component combinations, rather than introducing redundant release systems.

#### 2.1 Immutable Payload and Mutable Channel Decoupling

Explicitly separate immutable release artifacts from dynamic distribution channels:
- `ReleaseManifestPayloadV1`: Immutable product release composition recording exact component versions, artifact SHA-256 digests, target OS/arch platforms, interface contracts, and required/optional capability sets.
- `ReleaseChannelPointerV1`: Mutable channel pointer (such as `stable`, `canary`, `dev`) mapping to an exact `manifest_digest`, carrying monotonically increasing sequence/generation numbers and authenticated publisher provenance. The channel pointer is strictly external to the immutable manifest payload.

A planning phase resolves the channel pointer once to an immutable `manifest_digest` and binds execution to that target; an in-flight operation never chases a moving `latest`. A rollback mutates the channel pointer to a previously accepted manifest digest, never rewriting historical manifests.

#### 2.2 Canonical Hashing and Publisher Authenticity

Canonical digests are computed using RFC 8785 JSON Canonicalization Scheme (JCS) with SHA-256:
```text
manifest_digest = "sha256:" + hex(SHA256(JCS(ReleaseManifestPayloadV1)))
```
The payload strictly excludes the `digest` field and detached signature/envelope fields by design. The verifier rejects duplicate JSON properties, non-I-JSON inputs, malformed numeric values, and non-normalized Unicode prior to hashing.

Digest match proves artifact integrity, not publisher authenticity. Privileged execution requires verifying the publisher signature against an independently established trust anchor. An untrusted manifest cannot bootstrap trust by providing its own embedded public key. If publisher verification fails or is absent, the system reports `PUBLISHER_UNVERIFIED` / `UNKNOWN`.

#### 2.3 Orthogonal Dimensions

Release version (SemVer), component bytes, configuration template generations, protocol/storage schema versions, provider credential generations, and human authorization leases are orthogonal dimensions. They evolve independently and must never be collapsed into a single indicator.

<!-- topic:compatibility -->
### Capability-specific compatibility and external evidence (S1/S3)

Compatibility is evaluated against explicit tuples: trusted compatibility policy + actual component/protocol versions + selected configuration profile + active authority lease + verified evidence.

#### 3.1 External Compatibility Attestation

Compatibility evidence is recorded as an external, immutable artifact (`CompatibilityAttestationV1` / `ReleaseCompatibilityEvidence`) indexed by the computed `manifest_digest`. This eliminates circular digest dependencies.

Each attestation binds:
1. Target component tuple: Exact versions and SHA-256 digests of control plane, node runtime, and privileged Helper (if selected);
2. Protocol & schema: Control API and persistent checkpoint versions;
3. Target platform: OS distribution, kernel line, and CPU architecture;
4. Verified capability subset: Specific capabilities passing verification;
5. Evidence provenance: Test suite revision, workflow run reference, job identifier, test report artifact digest, and verification timestamp.

#### 3.2 Evaluation States and Orthogonal Projections

Evaluation states use a closed vocabulary:
- `SUPPORTED`: All required evidence references resolve and match the exact target tuple;
- `INCOMPATIBLE`: Explicit negative test results or security revocations apply;
- `UNKNOWN`: Evidence is missing, stale, unverifiable, or belongs to a different artifact tuple. Unverified tuples and placeholder digests strictly remain `UNKNOWN` with `evidence_ref: null`. SemVer proximity never implies compatibility.

Compatibility (`SUPPORTED/INCOMPATIBLE/UNKNOWN`), update advice (`NONE/AVAILABLE/DEPRECATED`), security policy (`ALLOWED/BLOCKED`), and conformance (`CONVERGED/DRIFT/PARTIAL/UNKNOWN`) are orthogonal projection models that leave the core NodeLifecycle intact. Tested older nodes remain active and accepted; revocations isolate only the affected capabilities.

<!-- topic:convergence -->
### Unified convergence engine and differentiated trust entry (S2)

The execution cycle follows:
```text
observe -> classify -> resolve immutable target -> compatibility check
 -> plan minimal delta -> verify authority -> apply known delta
 -> fresh readback -> record evidence -> checkpoint
```

#### 4.1 Five Explicit Typed Boundaries

The unified convergence engine exposes five typed boundaries:
1. `observe(target, selectors)`: Sanitized observed host facts, observation source/timestamp, and identity binding;
2. `plan(desired, observed, release, compatibility)`: Immutable read-only plan containing minimum delta, conflicts, and required authority;
3. `apply(plan, execution_context)`: Operation receipts; re-verifies target identity, artifact digests, and session lease before execution;
4. `verify(plan, fresh_observation)`: Per-component verified outcomes and conformance projection;
5. `checkpoint(operation_receipts)`: Credential-free recovery hints (hints to inspect, not compliance proof).

#### 4.2 Four Plan Intents with Distinct Trust Entry

`NEW / ADOPT / REPAIR / UPGRADE` share the same convergence engine but operate under distinct trust boundaries:
- `NEW`: Relies on initial one-time enrollment ticket and initial local authorization to establish durable identity.
- `ADOPT`: Validates existing identity and ownership; never copies another node's identity or silently replaces host keys.
- `REPAIR`: Retains node identity and intact components, repairing only confirmed configuration or service drift.
- `UPGRADE`: Uses existing authenticated node identity and maintenance authority leases; never consumes a new enrollment ticket.
- `CONFLICT / UNKNOWN`: Stops mutations on affected components and reconciles against the original attempt.

#### 4.3 Plan Identity and Stale-Plan Fencing

Every plan binds target node UID / attempt ID, desired template digest/generation, release manifest digest, component artifact digests, observed snapshot digest, expiry, and authorization reference. Stale plans or mismatched generations are rejected before writes and require replanning.

#### 4.4 True Zero-Delta and Appliance Safety

Re-executing converged state must yield zero delta: `reconcile(D, reconcile(D, S))` produces `ZERO_DELTA`. It must not rewrite identical files, restart unchanged services, touch timestamps, or remint credentials.

On storage appliances (such as OMV8): Storage pools, RAID arrays, filesystems, shared folders, business containers, and persistent volumes are strictly excluded from the management write set. Rebooting a host requires separate explicit authority.

<!-- topic:recovery -->
### Effect classification, durable journal and fault recovery (S2)

Distributed actions across hosts, cloud APIs, and local filesystems are not atomic. Operations maintain a stable operation identity derived from node binding, target digest, component, and intent.

#### 5.1 Effect Classification

Planned operations declare one of five effect classes:
- `REPEATABLE_LOCAL`: Deterministic local configuration/packages. Compares content first; atomic file replacement; zero delta on repeat.
- `RECONCILABLE_EXTERNAL`: Cloud provider supports idempotency keys or resource queryability. Reuses original operation identity.
- `ONE_SHOT`: Node identity minting, ticket claim, Tailscale key issuance. Lost responses require querying state, never blind reminting.
- `COMPENSATABLE`: Operations that can be undone given proven resource IDs and bounded compensation records.
- `IRREVERSIBLE`: Operations lacking automatic reversal; must be explicitly flagged before execution.

#### 5.2 Durable Journal and Concurrency Fencing

Operations follow a durable state progression:
```text
PLANNED → PREPARED → DISPATCHED → ACKNOWLEDGED → VERIFIED
```
Exceptional handling:
- `UNKNOWN / MAY_HAVE_EXECUTED`: Prohibits blind retry with new IDs; forces read-only reconciliation of the original request.
- `COMPENSATING → COMPENSATED`: Entered only upon proven resource ownership and successful rollback.
- `FAILED_FINAL`: Reserved for deterministic failures proven not to have executed.

Concurrency is fenced via monotonically increasing fencing epochs on a durable distributed lock. Lock expiration alone does not authorize repeating ambiguous external calls.

#### 5.3 Recovery and Offline Continuity

- Crash recovery re-observes current state and queries UNKNOWN operations, executing only proven missing steps.
- Offline nodes preserve their last accepted configuration and report OFFLINE/UNKNOWN without resetting identity.
- Rollback restores only resources declared in the operation's specific changeset, never deleting preexisting or business data.

<!-- topic:acceptance -->
### Three evidence domains and six-tier evidence hierarchy (S3)

Node admission, consumer acceptance, and version conformance remain decoupled. Capabilities require live verification receipts, never installer self-declarations.

#### 6.1 Three Distinct Evidence Domains

1. **Release Compatibility Evidence**: Proves an exact component/protocol/platform tuple passed joint verification in test environments.
2. **Node Conformance Evidence**: Proves an individual node's observed components conform to an immutable desired release at a specific point in time.
3. **Consumer Acceptance (`ConsumerAcceptance`)**: Proves an independent consumer can manage the node via accepted routes and durable credentials, with verified permissions and rollback plans.

#### 6.2 Six-Tier Evidence Hierarchy (T0–T5)

Every acceptance case and test execution declares an explicit evidence tier; weaker tiers cannot masquerade as stronger tiers:

| Tier | Class | What it proves | What it cannot prove |
|---|---|---|---|
| T0 | Static / Schema / Doc Check | Specification contract, closed enums, reference validity, secret safety | Runtime behavior or OS effects |
| T1 | Unit Test / AST Parsing | Pure parser, resolver, JCS canonical digest, planner algorithms | Durable persistence, system calls, OS effects |
| T2 | Contract Mock / Worker Integration | State machine transitions, auth gates, replay protection, fault injection | Physical hosts, live cloud credentials |
| T3 | Synthetic Disposable OS / Container | Package installation, service convergence, atomic file writes, crash recovery | Production provider credentials or live network |
| T4 | Disposable Appliance / System Integration | Systemd full stack, privileged Helper isolation, appliance storage safety | Live consumer routes or production custody |
| T5 | Live Independent Consumer Readback | Production deployment, real provider credentials, end-to-end custody proof | Untested release tuples or other nodes |

#### 6.3 Closed Result Vocabulary and Frozen Acceptance Set

Test results use a closed vocabulary: `PASS`, `FAIL`, `BLOCKED`, `UNKNOWN`, `NOT_RUN`, `DEFERRED`. Only `PASS` contributes to acceptance.

The [24 acceptance scenarios](../../test/fixtures/versioned-enrollment-v1.acceptance.json) are **future execution contracts, currently retained as NOT_RUN**. The 24 cases span all six groups and T0–T5 tiers:
- Version & Compatibility: VE-01 (T2), VE-02 (T1), VE-03 (T1), VE-04 (T2), VE-05 (T2)
- Identity & Enrollment: VE-06 (T1), VE-07 (T3), VE-08 (T1)
- Convergence: VE-09 (T3), VE-10 (T3), VE-11 (T4), VE-12 (T1)
- Recovery & Concurrency: VE-13 (T3), VE-14 (T2), VE-15 (T3), VE-16 (T1), VE-17 (T3), VE-18 (T3)
- Authority & Local Execution: VE-19 (T1), VE-20 (T2), VE-21 (T1)
- Acceptance & Storage Safety: VE-22 (T5), VE-23 (T4), VE-24 (T0)

The 24 case IDs are frozen as the v1 acceptance set.

<!-- topic:delivery -->
### Bounded delivery packages and campaign rollout

Implementation is divided into bounded delivery packages under #11 without creating parallel products:

| Package | Owner / Seam | Deliverable Scope |
|---|---|---|
| A: Bootstrap & Selected Capabilities | #55/#62 owners; bootstrap / installer | Single initial authorization ceremony; privileged root/sudo handling; disposable OS tests |
| B: Release & Compatibility | Future implementer; bootstrap / template | Immutable manifest schema, RFC 8785 JCS, compatibility evaluator, generation rules |
| C: Convergence Engine & Recovery | #11 integration owner; convergence / journal | Observe/plan/apply/verify implementation, Durable Journal, concurrency fencing, rollback |
| D: Release & Consumer Acceptance | Release & deployment owners | Exact-HEAD review, release candidate locking, private provider wiring, live consumer proof |

Rollout proceeds as an auditable campaign: read-only inventory → freeze target → single-node canary → wave-based deployment → readback verification.

<!-- topic:prior-art -->
### Prior art

- [SemVer 2.0.0](https://github.com/semver/semver.org/blob/gh-pages/spec/v2.0.0.md): Immutable release versions and interface change expressions.
- [Kubernetes version skew policy](https://github.com/kubernetes/website/blob/main/content/en/releases/version-skew-policy.md): Explicit supported version skew across distributed components.
- [Ansible declarative modules](https://github.com/ansible/ansible-documentation/blob/devel/docs/docsite/rst/command_guide/intro_adhoc.rst): Declarative state observation and minimal delta convergence.
- [Ansible check mode](https://github.com/ansible/ansible-documentation/blob/devel/docs/docsite/rst/playbook_guide/playbooks_checkmode.rst): Distinct separation between read-only planning and live execution.
- RFC 8785 (JSON Canonicalization Scheme / JCS): Deterministic canonical hashing of immutable release manifests, excluding detached signatures and preventing cross-language serialization ambiguity.
