# Production node onboarding and approved-admin canary v1 / 生产节点纳管与特权金丝雀 v1

status: `OPERATIONAL_RUNBOOK / SOURCE_CONTRACT`
source_baseline: `youling/ghostfleet@986725ac4ce3c9c99f49a9f9f8f385f41c87b3d6`
scope: Linux typed-control V4, deployment-owned Worker/issuer, root-owned node helper
last_updated: 2026-11-09

## 中文

<!-- topic:purpose -->
### 1. 目的与适用范围

本文把首台 ThinkPad 生产特权远控的故障经验固化为可重复的工程流程，供后续 Linux 生产节点复用。它覆盖**已存在 Fleet 控制连接上的特权执行接入与验收**，不把它等同于设备首次纳管。

必须区分四个独立结果：

| 结果 | 证明什么 | 不证明什么 |
| --- | --- | --- |
| `SOURCE_ACCEPTED` | 公共源码、契约测试与 CI 通过 | 私有 Worker 已部署、节点已配置 |
| `DEPLOYED_READY` | 私有控制端版本、签发器、策略、DO、Tunnel/Provider 绑定可用 | 节点 Helper 已接受该调用主体 |
| `NODE_READY` | 单节点身份、专属 ops 入口、Host policy、Helper 与代际一致 | 真实 root canary 已成功 |
| `ADMIN_CANARY_ACCEPTED` | 一笔真实请求经 Human 批准、节点 root Helper 执行、DO 终态消费回读 | 另一台节点或完整 Enrollment 生命周期通过 |

2026-11-09，首个私有 Linux 消费者完成一笔只读 `/usr/bin/id` 生产金丝雀：真实签名租约、root Helper 回执、exit 0、输出丢弃、DO `CONSUMED`。这只是**单个消费者的一次特权通道验收**；不代表第二节点、Windows、OMV8、所有部署或正式软件发布通过。真实节点标识、请求 ID、密钥、指纹和原始日志留在私有部署工单。

<!-- topic:timeline -->
### 2. 首台节点复盘：时间为什么被拉长

耗时不是单一 SSH 故障，而是多个层次的契约差异逐个暴露。生产金丝雀承担了本应由离线/合成预检提前发现的工作。

| 阶段 | 实际故障 | 根因类别 | 正确的提前检查 |
| --- | --- | --- | --- |
| Caller 身份 | 节点拒绝 `ADMIN_AUTHENTICATED_ACTOR_OR_NODE_MISMATCH` | Host `subject_ref` 与生产认证主体不一致 | 对当前 `authKind + userId` 独立计算摘要；逐节点比对 Host config、Worker policy、node UID |
| SSH 特权主体 | `INVALID_SSH_COMMAND` | 私有 Worker 本地 SSH adapter 忽略 V4 的 `forcedCommandPrincipal`，仍使用旧硬编码主体 | Adapter contract test：显式主体、目标用户名精确匹配、普通账号/缺失主体拒绝 |
| SSH 错误类型 | 发送前错误被归为 `UNKNOWN` | 私有与公共包的 `SshExecutionError` 构造器身份不同，跨包 `instanceof` 失效 | 跨包测试 `NOT_DISPATCHED` 与 `MAY_HAVE_EXECUTED` 语义 |
| 私钥导入 | `Failed to decrypt key` | 私有 SSH 库不接受 OpenSSH 原生私钥容器格式 | 部署预检用库实际导入 key、导出公钥并比对已登记公钥指纹；不以 PEM 文本标签猜测 |
| 传输可用性 | `SSH_CONNECT_FAILED` | 节点 Tunnel/宿主离线；不是租约或 Helper 错误 | 金丝雀前只读检查 Tunnel 连接数、节点在线和普通通道 |
| 审批引用 | `ADMIN_REQUEST_OR_RESPONSE_INVALID` / `NOT_DISPATCHED` | GitHub 评论 URL 的 `#issuecomment` 不符合协议 `ref` 正则 | 预检所有租约字段；可选请求字段省略时由签发端生成合规引用 |
| 租约 TTL | Helper 返回 `ADMIN_LEASE_BOUNDS` | Worker 发 600 秒，Host 固定上限 300 秒 | 签发前按控制端、签发策略与节点 Host 上限取最小值 |
| Helper 错误回执 | 节点 `ok:false` 被 Zod success-only schema 掩盖 | 公共 V4 response schema 只接受 `ok:true` | 允许严格的结构化错误分支，保留错误码；派发后仍保持 UNKNOWN 并对账 |
| 终局请求 | TTL 300、未传 approval_ref，成功 | 所有边界最终一致 | 单次真实 canary：Human approval → execute once → exact-ID status terminal |

宿主配置中 14 键语义对比仅改变生产 Caller 的 `subject_ref`，其余字段保持不变，权限保持 root:root 0600；这是**该节点的 Host 变更证据**，不是可复制到其他节点的配置模板。最终成功请求使用 TTL 300 秒、max runtime 15 秒、`approval_ref` 省略、`/usr/bin/id`、`output=discard`。不要在公开仓记录该节点的配置摘要、身份摘要、SSH key、Host key 或真实请求标识。

### 3. 跨层契约：一个值只定义一次，逐层校验

#### 3.1 身份与目标绑定

- `actor_ref` 由可信认证入口从 `authKind + userId` 派生；不得由工具输入自报。
- 每台节点的 Host 配置、私有 Worker policy 与请求租约必须同时匹配 `subject_ref`、`node_uid`、`generation`、`profile_generation`、`issuer_id`。
- 同一 Human/服务主体在多台节点上可能得到同一个 `subject_ref`，但必须在每个节点上重新计算并核对；不得把 ThinkPad 的配置文件或摘要直接复制到 JG/OMV8。
- SSH 目标必须匹配该节点登记的 Host key 指纹、专用 ops 用户名和独立私钥身份。普通 SSH key 与特权 ops key 必须分离。

#### 3.2 引用字段

`approval_ref` 是租约内的**有界协议引用标识符**，不是自由文本。公共 schema 使用：

```regex
^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$
```

- `#`、空白和任意 URL fragment 不在允许字符中。
- 私有请求接口的 `approval_ref` 是可选字段；不需要外部引用时应省略，由签发端生成稳定的 `app-<requestId>`。
- 如确需引用外部材料，传入符合 ref 语法的短标识符；可读 URL/Issue 链接放在 `work_ref` 或 `purpose`，不能塞入 `approval_ref`。
- 租约一旦签名，不得改字段后复用原签名；任何修改都必须重新申请和签发。

#### 3.3 TTL 与运行时间

签发端必须在签名前计算有效边界：

```text
effective_ttl =
  min(requested_ttl, issuer_policy_max_ttl, controller_max_ttl, node.max_ttl_seconds)

effective_runtime =
  min(requested_runtime, controller_max_runtime, node.max_runtime_seconds)
```

- 缺少节点上限或当前代际时，不得假设 300/600 秒；应拒绝签发或先完成只读策略同步。
- 节点上限是安全边界，不因客户端默认值更大而放宽。
- 当前 ThinkPad Host 基准为 max TTL 300 秒、max runtime 120 秒；这只是该实例事实，不是所有 Linux 节点的全局默认。
- 生产请求应显式使用已核对的 TTL（该节点示例为 300 秒）或省略以使用经验证的部署默认值。不得盲目沿用另一节点参数。

#### 3.4 SSH adapter 与派发状态

- V4 通过可信部署配置传递 `forcedCommandPrincipal`；SSH adapter 只允许该专用主体与精确目标用户名匹配，不能退回普通 shell。
- adapter 的 `SshExecutionError.dispatch_state` 必须跨包保持同一语义：`NOT_DISPATCHED` 仅表示 SSH 请求未进入可能发送阶段；调用 `channel.request` 前后可能存在部分发送时必须是 `MAY_HAVE_EXECUTED`。
- 不得仅靠字符串错误码或跨包 `instanceof` 猜测派发状态；用共享类型/显式适配器转换。
- Host key pin、专用用户名、key identity、期限和 stdin wire schema 均须在真实连接前校验。

#### 3.5 Helper 响应与不确定性

节点 Helper 有两种结构：

```json
{"ok":true,"receipt":{"schema":"ghostfleet-approved-admin-receipt/v1"}}
{"ok":false,"error":"ADMIN_LEASE_BOUNDS"}
```

- `ok:true` 必须继续通过严格 receipt schema，并绑定 lease/request/operation/node/actor/digest。
- `ok:false` 是结构化诊断，不是成功回执。控制端应保留符合协议的错误码，不得把它折叠成泛化 ZodError。
- 一旦 SSH forced-command 请求已经派发，收到 `ok:false` 仍不等于可以自动判定无副作用或安全重试；没有请求绑定的可信终态 receipt 时，结果仍是 `UNKNOWN`，必须按同一 request/lease 对账。
- malformed JSON、未知字段、错误码格式不合法或 receipt binding 不匹配均 fail closed；不能把解析失败转换为 SUCCEEDED。
- `STARTED/RUNNING` 不是完成。只有绑定原请求的终态 `SUCCEEDED/FAILED` receipt 与 DO 状态一致才可关闭。

#### 3.6 一次性消费

控制面 Durable Object 必须对 approve/consume/cancel 状态转换提供强一致事务 CAS；节点 root ledger 必须对同一 lease 做持久化一次性预留。二者是不同边界：

- 控制面 `CONSUMED` 不代替节点执行 receipt；
- 节点 `STARTED` 不代替终态成功；
- 断连、超时、回执解析失败均不能重发新 lease 绕过旧 lease；
- `UNKNOWN` 必须保留原 request/lease，先查询账本和节点 receipt，不清空账本、不盲目重试。

<!-- topic:flow -->
### 4. 端到端流程图

下图表达逻辑顺序，不代表每个部署都必须使用 Cloudflare；Worker、DO、Tunnel 是当前参考部署适配器。

~~~mermaid
sequenceDiagram
    autonumber
    actor Human
    participant Client as HTTP/MCP Client
    participant Worker as Trusted Control Adapter
    participant DO as Strongly Consistent Approval Ledger
    participant Tunnel as Pinned SSH Transport
    participant Helper as Root-owned Node Helper
    participant Ledger as Node Lease Ledger
    participant OS as systemd/cgroup

    Client->>Worker: Request exact node + argv + digest + bounds
    Worker->>Worker: Validate actor, target, ref, TTL and policy
    Worker->>DO: Persist PENDING request
    Human->>Worker: Independent authenticated approval
    Worker->>DO: Atomic APPROVED + signed lease
    Client->>Worker: Execute exact request_id once
    Worker->>DO: Atomic reserve/consume dispatch fence
    Worker->>Tunnel: SSH forced command + signed lease
    Tunnel->>Helper: Authenticated stdin wire
    Helper->>Helper: Verify actor/node/issuer/signature/generation/TTL
    Helper->>Ledger: Atomic one-use lease reservation
    Helper->>OS: Start bounded root unit
    OS-->>Helper: Terminal result + cgroup empty
    Helper->>Ledger: Persist terminal receipt
    Helper-->>Worker: Bound signed-lease receipt
    Worker->>DO: Persist reconciled terminal state
    Worker-->>Client: SUCCEEDED / FAILED
~~~

~~~mermaid
flowchart TD
    A[Request + trusted actor] --> B{Local schema / identity / TTL valid?}
    B -- no --> C[NOT_DISPATCHED]
    B -- yes --> D[Human approval + signed lease]
    D --> E{One-time dispatch fence acquired?}
    E -- no --> F[Existing state / reconcile]
    E -- yes --> G[SSH request may be sent]
    G --> H{Bound node receipt available?}
    H -- no or malformed --> I[UNKNOWN / reconcile same request]
    H -- ok:false --> J[Preserve helper error code; no success]
    J --> I
    H -- STARTED --> K[RUNNING / status poll]
    K --> H
    H -- terminal SUCCEEDED --> L[CONSUMED + exact receipt]
    H -- terminal FAILED --> M[FAILED + exact receipt]
~~~

### 5. 可重复预检：生产金丝雀之前必须覆盖什么

预检要尽量在纯函数、合成后端、Disposable Linux 或本地配置检查中完成。预检本身不得调用生产 `execute`，不得修改生产节点。

| 预检层 | 正向用例 | 负向用例 | 验收 |
| --- | --- | --- | --- |
| Lease schema | 所有必填字段、标准 ref、有效时间 | ref 含 `#`/空白、未知字段、错误 node/actor | 字段级错误，不连接 SSH |
| Identity/policy | 当前 actor、node、generation、profile、issuer 一致 | 旧 subject、错误 node、旧 generation、非受信 issuer | 明确拒绝，字段摘要脱敏 |
| Bounds | TTL/runtime 小于等于节点上限 | TTL 600 > Host 300、runtime 超限、过期 | 签发前拒绝，不触达节点 |
| SSH adapter | 显式 ops principal、Host key pin、key import 成功 | principal 不匹配、普通用户名、错误 Host key、无效 key | 明确 NOT_DISPATCHED |
| Dispatch contract | request 尚未发送、request 已发送 | 发送前错误与可能部分发送错误 | 分别保留 NOT_DISPATCHED / UNKNOWN |
| Helper response | 绑定成功 receipt、合法 `ok:false` | malformed JSON、非法 error code、receipt 错绑 | 保留 helper code；无 receipt 不判成功 |
| DO/节点账本 | 并发 CAS 仅一方成功、一次性 lease 消费 | 重复 execute、重复 cancel、丢响应、重启 | 同一 request/lease 对账，不重发 |
| Output | discard 无输出、bounded 字节数与 hash 一致 | discard 泄漏、超限、hash 不匹配 | 拒绝并保留不确定性 |
| Host 基准 | root:root 0600 config、Helper/issuer/代际匹配 | 权限过宽、文件漂移、Host policy 缺失 | NODE_READY=false |

推荐最小确定性测试集：

1. `approval_ref` 正确与含 `#` 的错误值；
2. Worker 默认/请求 TTL 与 Host max TTL 的 min-bound；
3. `forcedCommandPrincipal` 显式传递和普通用户拒绝；
4. 跨包 SSH error 的 dispatch-state 传递；
5. Host `ok:false` 每个错误码原样保留；malformed false 不泄露 raw data；
6. post-dispatch response lost / malformed 均为 UNKNOWN；
7. DO 并发 approve/consume CAS；
8. 节点 lease replay 拒绝；
9. 成功 receipt 必须精确绑定 node/actor/lease/request/operation/digest；
10. 成功和失败两种终态都能通过同一 request status 读回。

纯合成 10/10 不等于实机 10/10。Disposable root integration 可以证明通用 Helper 与 systemd/cgroup 行为；真实生产 canary 仍需独立 Human 授权和节点回执。

<!-- topic:runbook -->
### 6. 最短标准作业流程

#### A. 已在目录中的节点（如已有正常 DCR 的生产节点）

1. 读取当前 catalog、Worker runtime/source、policy digest 和工具目录；确认没有漂移。
2. 只读核验普通身份、普通 SSH/Tunnel、目标 Host key、可执行文件 digest。
3. 从节点自己的 Host config 读取 max TTL/runtime、node UID、generation/profile generation、issuer key ID、subject_ref（只在私有环境，不把值写入公开文档）。
4. 在控制端用当前认证主体独立计算 actor_ref；逐节点核对 Host config 与 Worker policy。
5. 执行确定性预检和 Disposable integration；通过后才能进入一笔 Human-approved 只读 canary。
6. 真实 canary 创建一次请求、等待同一请求 APPROVED、execute 一次、status 直到终态；不在生产上通过第二次 execute 验证重放，重放用 synthetic/disposable 负测。
7. 记录 exact source/runtime version、request/lease/operation IDs、终态 receipt、DO 状态和回滚依据，私有化存储。

#### B. 全新 Linux 生产节点

1. 默认 topology role 设为 `MANAGED_ONLY`：它只接受可信控制端下发，不成为控制器、签发者、审批者或跨节点 relay。当前公开拓扑策略仍需消费独立 source/deployment acceptance；未部署强制策略前，不得把“设计默认”说成已生效。
2. 通过现有 Enrollment Console/Provider 路径建立唯一 node identity；新节点拥有独立 TS/CF provider material、SSH Host key、ops key、Host config、state ledger 与 node generation。
3. 不复制 ThinkPad/JG 的 `tailscaled.state`、Tunnel UUID/secret、SSH 私钥/公钥、Host key、node UID、账本或 profile generation。
4. 首次 root/bootstrap 由节点所有者按该平台受审流程执行；Phase 0 只读检查先于任何 materialization。
5. 为该节点从可信认证主体计算 subject_ref，并与 Worker policy/Host config 对齐；验证专用 ops principal、Host key pin、密钥导入、TTL/runtime 上限。
6. 通过预检后只做一笔 Human-approved 只读 canary；普通 NORMAL 与 Human-approved ADMIN 分开验收。
7. 只有 identity、normal control、topology negative、admin canary（若该节点需要）、rollback 与独立 consumer readback 全部按目标通过，才晋升相应生命周期状态。

#### C. JG 第二节点

- JG 已有 Fleet node identity 和普通 DCR 路径；不应再次创建重复 node UID，也不应把普通 DCR 已通写成特权管理员已通。
- 沿现有 Host owner 工单独立安装/核验 Helper 与 ops principal；使用 JG 自己的 key、Host key、generation/profile、Host policy 与 Tunnel。
- ThinkPad 成功证明公共 V4 链路有一条可用实现路径；它不证明 JG 的 systemd、Host policy、SSH、OCI workload 或生产数据已就绪。
- JG 的 OCI admission/import/smoke 是另一项验收，不得和 Fleet admin canary 合并成一个 PASS。

#### D. OMV8 / NAS

- OMV8 走独立 NAS first-use 流程，不复制 JG/TP 凭据；必须先有当前部署版本的受保护 Console、真实 Operator、TS Provider、NAS 专属 CF Tunnel/credential 与有效一次性票据。
- 唯一一次本机 Human root ceremony 前先执行内建只读 Phase 0，确认 OMV/Debian、systemd、现有 TS/cloudflared 状态、磁盘/RAID/卷/共享/核心服务和恢复条件。
- 第一轮不做格式化、分区/RAID/文件系统变化、挂载/卸载业务卷、SMB/NFS 变更、业务容器变更或自动 reboot。
- 首次纳管后日常操作使用 NORMAL；需要提权时才走独立 Human-approved ADMIN。若首次纳管 Provider/Ticket 尚未 READY，NAS 保持未触碰，不用手工 SSH/复制密钥绕过产品路径。

<!-- topic:timing -->
### 7. 耗时目标与停止条件

**5–10 分钟只能是成熟后的重复操作目标，不是当前承诺。** 它只可能适用于：节点已在目录、普通通道在线、Host/Worker policy 已对齐、独立凭据已就绪、预检全绿、Human 审批通道活跃且没有版本漂移。首次安装、Provider 授权、Host 恢复、NAS Phase 0 或未知网络问题不属于该时间目标。

每轮应记录时间花在哪一层：源码/部署版本确认、Host/Worker 配置对齐、传输恢复、Human 审批等待、节点 Helper、终态回执。至少积累数台同类型节点的实测中位数与 P90，再确定 SLA；不要用一次模拟 15 秒脚本推导完整纳管时间。

以下情况立即停止当前请求，不做盲目重试：

- actor/node/issuer/generation/profile 不匹配；
- Host key、ops principal、密钥身份或 TTL/runtime 不匹配；
- `NOT_DISPATCHED` 以外的未知派发状态，或任何 `UNKNOWN`；
- approval/lease 已过期；
- DO/节点账本无法查询、receipt 缺失或绑定不一致；
- Tunnel/宿主离线，或请求目标并非当前确认节点；
- Provider、Access、Operator、一次性 Ticket 未达到真实 READY；
- NAS 的存储/服务/恢复风险未经过本机 Phase 0 与 Human gate。

`UNKNOWN` 的唯一正确动作是保留原 request/lease 并查询状态、节点账本、Helper receipt 和系统日志。不得创建新请求来掩盖旧请求，也不得通过清空 ledger、重装 Helper 或更换 node identity 解决不确定性。

<!-- topic:roles -->
### 8. 正交权限模型

OS 操作权限与舰队拓扑角色是两个独立维度：

| 维度 | 值 | 含义 |
| --- | --- | --- |
| OS authority | `NORMAL` | 普通用户权限 |
| OS authority | `HUMAN_APPROVED_ADMIN` | 对精确命令/副作用取得一次性 Human 授权 |
| Fleet topology | `CONTROLLER_CAPABLE` | 可在部署策略允许的精确范围内管理目标 |
| Fleet topology | `MANAGED_ONLY` | 只接受控制端命令，不可控制其他节点 |

一个 `MANAGED_ONLY` 节点可以在 Human 授权下执行本机 root 操作，但不会因此成为控制器。新增公网节点默认目标为 `MANAGED_ONLY`；在当前拓扑策略 PR/私有部署未合并上线前，必须明确标注为**目标策略/待部署**，不能宣称已强制执行。

## English

<!-- topic:purpose -->
### 1. Purpose and scope

This document turns the first ThinkPad production approved-admin integration into a repeatable engineering procedure for later Linux nodes. It covers **approved-admin enablement and acceptance on an existing Fleet control path**; it is not the same as first-time device enrollment.

Keep four results separate:

| Result | Proves | Does not prove |
| --- | --- | --- |
| `SOURCE_ACCEPTED` | Public source, contract tests and CI pass | Private Worker deployed or node configured |
| `DEPLOYED_READY` | Private control version, issuer, policy, DO and Tunnel/provider bindings are ready | Node helper accepts the caller |
| `NODE_READY` | Node identity, dedicated ops ingress, Host policy, helper and generations agree | A real root canary passed |
| `ADMIN_CANARY_ACCEPTED` | One real request passed Human approval, node root-helper execution and DO terminal consumption readback | Another node or the complete enrollment lifecycle passed |

On 2026-11-09, the first private Linux consumer completed one read-only production `/usr/bin/id` canary: real signed lease, root-helper receipt, exit 0, discarded output and DO `CONSUMED`. This is **one consumer's single privileged-lane acceptance**, not a claim that a second node, Windows, OMV8, every deployment or a formal software release passed. Real node IDs, request IDs, keys, fingerprints and raw logs remain in private deployment records.

<!-- topic:timeline -->
### 2. First-node retrospective: why it took so long

The delay was not one SSH fault. Multiple cross-layer contract mismatches surfaced one by one. Production canaries were used to discover issues that should have been caught by offline/synthetic preflight.

| Stage | Observed failure | Root cause class | Earlier check that should catch it |
| --- | --- | --- | --- |
| Caller identity | Node rejected `ADMIN_AUTHENTICATED_ACTOR_OR_NODE_MISMATCH` | Host `subject_ref` did not match the production authenticated actor | Independently derive the current `authKind + userId` reference and compare Host config, Worker policy and node UID |
| SSH principal | `INVALID_SSH_COMMAND` | Private Worker SSH adapter ignored V4 `forcedCommandPrincipal` and retained an old hard-coded principal | Adapter contract test for explicit principal, exact target match, ordinary-user and missing-principal denial |
| SSH error type | A pre-send error became `UNKNOWN` | Private and public `SshExecutionError` constructors had different identities, breaking cross-package `instanceof` | Cross-package dispatch-state test for `NOT_DISPATCHED` and `MAY_HAVE_EXECUTED` |
| Key import | `Failed to decrypt key` | Private SSH library did not accept the native OpenSSH private-key container | Preflight actual library import, export public key and compare its registered fingerprint; do not infer from PEM label |
| Transport | `SSH_CONNECT_FAILED` | Tunnel/host offline; not a lease or helper defect | Read-only Tunnel connection, node-online and normal-channel check before canary |
| Approval reference | `ADMIN_REQUEST_OR_RESPONSE_INVALID` / `NOT_DISPATCHED` | GitHub comment URL's `#issuecomment` violated protocol `ref` grammar | Preflight all lease fields; omit the optional request field so the issuer can create a compliant reference |
| Lease TTL | Helper returned `ADMIN_LEASE_BOUNDS` | Worker issued 600 seconds while Host cap was 300 seconds | Clamp at issuance to the minimum of controller, issuer and node caps |
| Helper error receipt | Node `ok:false` was masked by a success-only Zod schema | Public V4 response schema accepted only `ok:true` | Accept a strict structured error branch, preserve the code; after dispatch still keep UNKNOWN and reconcile |
| Final request | TTL 300, approval_ref omitted, succeeded | All constraints finally aligned | One production canary: Human approval → execute once → exact-ID terminal status |

The Host config's 14-key semantic comparison changed only the production caller `subject_ref`, with all other fields unchanged and permissions root:root 0600. This is **one node's Host-change evidence**, not a reusable config file for other nodes. The final successful request used TTL 300 seconds, max runtime 15 seconds, omitted `approval_ref`, `/usr/bin/id` and `output=discard`. Do not place that node's config digest, identity digest, SSH key, Host key or real request identifiers in public documentation.

### 3. Cross-layer contracts

#### 3.1 Identity and target binding

- `actor_ref` is derived by the trusted authenticated ingress from `authKind + userId`; tools must not self-assert it.
- The node Host config, private Worker policy and request lease must all agree on `subject_ref`, `node_uid`, `generation`, `profile_generation` and `issuer_id`.
- The same Human/service principal may derive the same `subject_ref` across multiple nodes, but it must be independently recomputed and checked for each node. Never copy ThinkPad's config file or digest to JG/OMV8.
- SSH target identity must match that node's registered Host-key fingerprint, dedicated ops username and separate private-key identity. Ordinary SSH and privileged ops keys remain distinct.

#### 3.2 Reference fields

`approval_ref` is a bounded **protocol reference identifier**, not free-form prose. The public schema uses:

```regex
^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$
```

- `#`, whitespace and arbitrary URL fragments are not allowed.
- The private request field `approval_ref` is optional; when no external reference is needed, omit it and let the issuer generate a stable `app-<requestId>`.
- If an external reference is required, pass a short identifier matching the grammar. Put readable URLs/issue links in `work_ref` or `purpose`, not `approval_ref`.
- Never edit a signed lease and reuse its signature. Any changed field requires a new request and approval.

#### 3.3 TTL and runtime

The issuer must calculate effective bounds before signing:

```text
effective_ttl =
  min(requested_ttl, issuer_policy_max_ttl, controller_max_ttl, node.max_ttl_seconds)

effective_runtime =
  min(requested_runtime, controller_max_runtime, node.max_runtime_seconds)
```

- If the node cap or current generation is unknown, do not assume 300/600 seconds; refuse signing or complete a read-only policy sync first.
- The node cap is a security boundary. Do not relax it to match a larger client default.
- The current ThinkPad Host baseline was max TTL 300 seconds and max runtime 120 seconds. These are instance facts, not universal Linux defaults.
- Use the verified node-specific TTL explicitly (300 seconds in that instance) or omit it only when the deployed default is known to be within the node cap.

#### 3.4 SSH adapter and dispatch state

- V4 passes `forcedCommandPrincipal` from trusted deployment configuration. The SSH adapter accepts only that dedicated principal with an exact target-username match; it must never fall back to an ordinary shell.
- `SshExecutionError.dispatch_state` must preserve one meaning across package boundaries: `NOT_DISPATCHED` means the SSH request never entered a possible-send stage; once a request may be partially sent it is `MAY_HAVE_EXECUTED`.
- Do not infer dispatch state from error strings or a cross-package `instanceof` check alone; use a shared type or explicit adapter conversion.
- Validate Host-key pin, dedicated username, key identity, deadlines and stdin wire schema before real command dispatch.

#### 3.5 Helper responses and uncertainty

The node helper has two response shapes:

```json
{"ok":true,"receipt":{"schema":"ghostfleet-approved-admin-receipt/v1"}}
{"ok":false,"error":"ADMIN_LEASE_BOUNDS"}
```

- `ok:true` must pass the strict receipt schema and bind lease/request/operation/node/actor/digest.
- `ok:false` is structured diagnostic data, not a success receipt. The controller must preserve a protocol-shaped error code instead of reducing it to a generic Zod error.
- Once the SSH forced-command request has been dispatched, `ok:false` does not by itself authorize an automatic no-effect/retry conclusion. Without a request-bound terminal receipt, keep the outcome `UNKNOWN` and reconcile the same request/lease.
- Malformed JSON, unknown fields, invalid error-code grammar or mismatched receipt binding fail closed; never turn parse failure into SUCCEEDED.
- `STARTED/RUNNING` is not completion. Close only when a request-bound terminal `SUCCEEDED/FAILED` receipt and DO state agree.

#### 3.6 One-time consumption

The control-plane Durable Object must use strongly consistent transactional CAS for approve/consume/cancel transitions. The node root ledger must independently reserve a lease exactly once. These are different boundaries:

- Control-plane `CONSUMED` does not replace the node execution receipt.
- Node `STARTED` does not replace terminal success.
- Disconnects, timeouts and receipt-parse failures must not mint a replacement lease to bypass the original.
- Preserve `UNKNOWN` and reconcile the original request/lease against the control ledger and node receipt. Never clear the ledger or blindly retry.

<!-- topic:flow -->
### 4. End-to-end diagrams

The sequence describes logical order, not a Cloudflare requirement. Worker, DO and Tunnel are the current reference-deployment adapters.

~~~mermaid
sequenceDiagram
    autonumber
    actor Human
    participant Client as HTTP/MCP Client
    participant Worker as Trusted Control Adapter
    participant DO as Strongly Consistent Approval Ledger
    participant Tunnel as Pinned SSH Transport
    participant Helper as Root-owned Node Helper
    participant Ledger as Node Lease Ledger
    participant OS as systemd/cgroup

    Client->>Worker: Request exact node + argv + digest + bounds
    Worker->>Worker: Validate actor, target, ref, TTL and policy
    Worker->>DO: Persist PENDING request
    Human->>Worker: Independent authenticated approval
    Worker->>DO: Atomic APPROVED + signed lease
    Client->>Worker: Execute exact request_id once
    Worker->>DO: Atomic reserve/consume dispatch fence
    Worker->>Tunnel: SSH forced command + signed lease
    Tunnel->>Helper: Authenticated stdin wire
    Helper->>Helper: Verify actor/node/issuer/signature/generation/TTL
    Helper->>Ledger: Atomic one-use lease reservation
    Helper->>OS: Start bounded root unit
    OS-->>Helper: Terminal result + cgroup empty
    Helper->>Ledger: Persist terminal receipt
    Helper-->>Worker: Bound signed-lease receipt
    Worker->>DO: Persist reconciled terminal state
    Worker-->>Client: SUCCEEDED / FAILED
~~~

~~~mermaid
flowchart TD
    A[Request + trusted actor] --> B{Local schema / identity / TTL valid?}
    B -- no --> C[NOT_DISPATCHED]
    B -- yes --> D[Human approval + signed lease]
    D --> E{One-time dispatch fence acquired?}
    E -- no --> F[Existing state / reconcile]
    E -- yes --> G[SSH request may be sent]
    G --> H{Bound node receipt available?}
    H -- no or malformed --> I[UNKNOWN / reconcile same request]
    H -- ok:false --> J[Preserve helper error code; no success]
    J --> I
    H -- STARTED --> K[RUNNING / status poll]
    K --> H
    H -- terminal SUCCEEDED --> L[CONSUMED + exact receipt]
    H -- terminal FAILED --> M[FAILED + exact receipt]
~~~

### 5. Repeatable preflight before production canary

Preflight should run in pure functions, synthetic backends, disposable Linux or local config checks. It must not call production `execute` or mutate a production node.

| Layer | Positive case | Negative case | Acceptance |
| --- | --- | --- | --- |
| Lease schema | Required fields, canonical ref, valid time | Ref with `#`/space, unknown field, wrong node/actor | Field-level error, no SSH connect |
| Identity/policy | Current actor/node/generation/profile/issuer agree | Old subject, wrong node, stale generation, untrusted issuer | Explicit denial, sanitized field names |
| Bounds | TTL/runtime within node caps | TTL 600 > Host 300, runtime over cap, expired | Refuse before signing, no node touch |
| SSH adapter | Explicit ops principal, Host-key pin, key import | Principal mismatch, ordinary username, wrong Host key, invalid key | Explicit NOT_DISPATCHED |
| Dispatch contract | Request not sent vs request sent | Pre-send error vs possible partial send | Preserve NOT_DISPATCHED / UNKNOWN |
| Helper response | Bound success receipt, valid `ok:false` | Malformed JSON, invalid error code, wrong receipt binding | Preserve helper code; no receipt is not success |
| DO/node ledger | One concurrent CAS winner, one-time lease | Replay execute, duplicate cancel, lost response, restart | Reconcile same request/lease; no resend |
| Output | Discard without output, bounded bytes/hash match | Discard leak, over-limit, hash mismatch | Reject and preserve uncertainty |
| Host baseline | root:root 0600 config, helper/issuer/generation match | Over-broad permissions, config drift, missing Host policy | NODE_READY=false |

Minimum deterministic tests:

1. Valid `approval_ref` and invalid `#` reference.
2. Worker requested/default TTL bounded by Host maximum.
3. Explicit `forcedCommandPrincipal` and ordinary-user denial.
4. Cross-package SSH error dispatch-state preservation.
5. Preserve every protocol-shaped Host `ok:false` code; malformed false responses must not leak raw data.
6. Post-dispatch response loss/malformed response remains UNKNOWN.
7. Concurrent DO approve/consume CAS.
8. Node lease replay denial.
9. Success receipt binds exact node/actor/lease/request/operation/digest.
10. Both terminal success and failure are readable through the same request status.

Synthetic 10/10 is not real-device 10/10. Disposable root integration proves generic helper/systemd/cgroup behavior; a production canary still needs independent Human authorization and node receipt.

<!-- topic:runbook -->
### 6. Short standard operating procedure

#### A. Existing nodes already in the catalog

1. Read current catalog, Worker runtime/source, policy digest and tool catalog; confirm no drift.
2. Read-only check normal identity, normal SSH/Tunnel, target Host key and executable digest.
3. Read the node's own Host max TTL/runtime, node UID, generation/profile, issuer key ID and subject_ref from its private config.
4. Independently derive actor_ref from the current authenticated principal and compare with that node's Host config and Worker policy.
5. Run deterministic preflight and disposable integration. Only then request one Human-approved read-only canary.
6. Create one request, wait for APPROVED on that same ID, execute once, and poll status to terminal. Do not test replay by a second production execute; replay denial belongs in synthetic/disposable tests.
7. Record exact source/runtime, request/lease/operation IDs, terminal receipt, DO state and rollback reference in private storage.

#### B. A new Linux production node

1. Default topology role is `MANAGED_ONLY`: it accepts commands from the trusted control plane but cannot become a controller, issuer, approver or cross-node relay. Until public topology policy and private deployment enforcement are merged/deployed, mark this as a target policy, not a live guarantee.
2. Enroll through the existing Enrollment Console/Provider path with one NodeIdentity. The node owns independent TS/CF material, SSH Host key, ops key, Host config, state ledger and node generation.
3. Never copy ThinkPad/JG `tailscaled.state`, Tunnel UUID/secret, SSH keys, Host key, node UID, ledger or profile generation.
4. First root/bootstrap uses the reviewed local process for that node; read-only Phase 0 precedes materialization.
5. Derive subject_ref from the trusted authenticated actor for this node and compare it with Worker policy/Host config; verify dedicated ops principal, Host-key pin, key import and TTL/runtime caps.
6. Run deterministic preflight and then one low-risk read-only canary. Accept NORMAL and Human-approved ADMIN as separate lanes.
7. Promote the intended lifecycle only after identity, normal control, topology negative, admin canary (if required), rollback and independent consumer readback all pass.

#### C. JG as the second node

- JG already has a Fleet node identity and ordinary DCR path. Do not create a duplicate node UID or infer privileged-admin acceptance from ordinary DCR success.
- Under the existing Host owner, independently install/verify the helper and ops principal with JG's own key, Host key, generation/profile, Host policy and Tunnel.
- ThinkPad's success proves one public V4 path works; it does not prove JG's systemd, Host policy, SSH, OCI workload or production data are ready.
- JG OCI admission/import/smoke is a separate acceptance and must not be folded into one Fleet admin PASS.

#### D. OMV8 / NAS

- OMV8 uses its own NAS first-use path. Do not copy JG/TP credentials. Require the current protected Console, real Operator, TS Provider, NAS-specific CF Tunnel/credential and valid one-time ticket.
- Before the one local Human root ceremony, run the built-in read-only Phase 0 to inspect OMV/Debian, systemd, current TS/cloudflared state, disks/RAID/volumes/shares/core services and recovery conditions.
- First pass must not format, repartition, change RAID/filesystems, mount/unmount business volumes, change SMB/NFS, mutate business containers or reboot automatically.
- After enrollment, normal operations use NORMAL; only elevated actions use separate Human-approved ADMIN. If Provider/Ticket is not truly READY, leave the NAS untouched; do not bypass the product path with manual SSH or copied keys.

<!-- topic:timing -->
### 7. Time target and stop conditions

**Five to ten minutes is only a future repeat-operation target, not a promise.** It may be achievable only when the node is already in the catalog, normal transport is online, Host/Worker policy is aligned, unique credentials are ready, preflight is green, Human approval is active and no version drift exists. First install, Provider authorization, Host recovery, NAS Phase 0 and unknown network issues are outside this target.

Record where time is spent: source/deployment currentness, Host/Worker alignment, transport recovery, Human approval wait, node helper and terminal receipt. Establish a measured median and P90 across several same-class nodes before setting an SLA; a synthetic 15-second script does not establish full enrollment time.

Stop the current request immediately on:

- actor/node/issuer/generation/profile mismatch;
- Host key, ops principal, key identity or TTL/runtime mismatch;
- `NOT_DISPATCHED` other than a proven pre-dispatch result, or any `UNKNOWN`;
- expired approval/lease;
- unavailable DO/node ledger, missing receipt or binding mismatch;
- offline Tunnel/host or a target not independently confirmed;
- Provider, Access, Operator or one-time Ticket not truly READY;
- NAS storage/service/recovery risk not cleared by local Phase 0 and the Human gate.

The only correct action for `UNKNOWN` is to preserve the original request/lease and query status, node ledger, helper receipt and system journal. Never create a replacement request to hide an old one, and never clear the ledger, reinstall the helper or replace node identity to escape uncertainty.

<!-- topic:roles -->
### 8. Orthogonal authority model

OS operation authority and fleet topology role are independent dimensions:

| Dimension | Value | Meaning |
| --- | --- | --- |
| OS authority | `NORMAL` | Ordinary user authority |
| OS authority | `HUMAN_APPROVED_ADMIN` | One-time Human approval for an exact command/effect |
| Fleet topology | `CONTROLLER_CAPABLE` | May manage only targets allowed by deployment policy |
| Fleet topology | `MANAGED_ONLY` | Accepts control-plane commands; cannot control other nodes |

A `MANAGED_ONLY` node may execute a local root command after Human approval, but does not thereby become a controller. New public nodes should default to `MANAGED_ONLY`; until the topology source tranche and private deployment policy are merged and deployed, this remains a **target policy, not an enforced live guarantee**.
