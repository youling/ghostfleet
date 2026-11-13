# NODE_AGENT_V0 — 常驻节点代理（ADR）

> Persistence update / 持久化更新：SQLite candidate replaces the JSON ledger/outbox/archive portions of this ADR. See [NODE_AGENT_SQLITE.md](NODE_AGENT_SQLITE.md) for the active storage contract, migration and evidence limits. Other node/auth/systemd contracts are unchanged.

| 字段 | 值 |
| --- | --- |
| 状态 | IMPLEMENTED_CANDIDATE（SQLite 子 PR #84 exact-head APPROVED；父 PR #83 集成 CI 6/6 PASS；父 PR 新 exact-head 独立审查与 Human release gate pending） |
| 日期 | 2026-11-12 |
| 关联 | GhostFleet #11（实施真实 Node Agent）、ai-hub REQ-01《托管服务生命周期》、REQ-01~REQ-04 全部满足前 `FULLY_MANAGED` 不可宣称 |
| 基线 | `0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1`（M3 源码冻结） |
| 变更边界 | 新增常驻运行时与节点侧协议；**不改变**特权中介（Human 授权 + JIT 租约 + 受限 Helper）的任何语义 |

## 0. English abstract

REQ-01 requires a managed node to run a dedicated, non-root, long-lived management service under a systemd user manager with Linger enabled. Today the repository ships only a synthetic `Type=oneshot` / `ExecStart=/bin/true` fixture and a root-only one-shot converger, so a release selection cannot honestly set `user_service_required=true`. This ADR defines a minimal but real resident **GhostFleet Node Agent**: a pull-based loop that authenticates with an enrollment-minted node credential, continuously observes local state, reports bounded health/observation deltas, executes a strictly read-only typed task vocabulary, and durably fences every dispatch with the existing `MAY_HAVE_EXECUTED` semantics. Privileged effects remain outside the agent: they still travel through `ghostfleet-ops` and the digest-pinned Helper under a JIT lease. Arbitrary remote shell is explicitly out of scope and rejected twice (control plane and agent).

## 1. 背景：REQ-01 现在缺什么

三条互相独立的事实（均读实现，不读 manifest）：

1. **unit 制品是测试夹具**：`packages/bootstrap/test/fixtures/ghostfleet-managed.service` 为 `Type=oneshot`、`ExecStart=/bin/true`、`Description=GhostFleet managed runtime (synthetic fixture)`；`docs/CHAIN-ACCEPTANCE-RUNBOOK.md` 亦自认该 unit 是 synthetic one-shot canary。
2. **发布选择里没有服务**：M3 的 `capability-artifacts.json` 5 个 artifact 全部是特权侧（installer、`fleet_privctl.py`、`fleet_privileged_ssh_entry.py`、`fleet_admin_command.py`、`privileged-ops.pub`），没有 user unit，因此 `capability.js` 依 `selection.user_unit` 是否存在推导出的 `user_service_required=false` 是**如实的**；`bootstrap.js` 在该字段为 false 时把服务状态标 `NOT_REQUESTED` 且不执行安装分支。既有 disposable 测试专门把该字段设成 true，只能证明"可选安装路径能工作"，不能证明发布选择会安装服务。
3. **候选运行时不是常驻服务**：`packages/runtime-python/src/ghostfleet_runtime/linux/cli.py` 自述 "Explicit candidate entrypoint; legacy bootstrap never invokes this implicitly"，要求 root（`LINUX_ROOT_REQUIRED`），且是一次性收敛器，明确 "no lifecycle promotion"。

结论：这不是 M3 漏了一个配置项，而是产品缺少常驻运行时本体。降低 REQ-01 定义等于放弃 `FULLY_MANAGED` 的语义，因此本 ADR 走实现路线。

## 2. 决策

| 编号 | 决策 |
| --- | --- |
| D1 | 新增常驻进程 **GhostFleet Node Agent**，以非 root 的 control account（如 `ghostfleet-managed`）运行，`Type=notify` + `Restart=on-failure` + `WatchdogSec=60` + Linger。 |
| D2 | 通信为**拉模型**：节点主动向控制面心跳/取任务/回结果，控制面不主动连节点、不需要入站端口。 |
| D3 | 节点凭证在 `POST /v1/enroll/complete` 时铸造（32 字节随机 token）；服务端存 `sha256` 用于认证，另存 AEAD 密文用于**首次认证前的可恢复重投递**（首次认证成功即销毁），节点以 Bearer + `x-ghostfleet-node-uid` 认证；不引入第二套身份体系，复用既有 `node_uid` 与 `EnrollmentAttempt`。 |
| D4 | v0 任务词汇**只含只读、非特权**操作；任何特权或变更型操作在控制面即 `TASK_OPERATION_FORBIDDEN`，在 Agent 侧再拒一次。特权效果继续走 `ghostfleet-ops` + 受限 Helper + JIT 租约，Agent 不持有也不需要该通路。 |
| D5 | 复用 `transport_contract` 的 `MAY_HAVE_EXECUTED` 栅栏语义：Agent 在执行任何任务前先把 `MAY_HAVE_EXECUTED` 落盘并 fsync，重启后对未收敛项上报 `UNKNOWN` 而不重跑。 |
| D6 | Agent 载荷是**确定性构建的 zipapp**，与 user unit 各为独立 pin 的内容寻址 capability artifact，安装到 `/usr/local/libexec/ghostfleet/node-agent.pyz`（`root:root 0755`）与 `~/.config/systemd/user/ghostfleet-managed.service`；发布选择置 `user_service_required=true`。 |
| D7 | 不允许任意远程 Shell：协议里没有 shell/argv/script 字段，Agent 只按 allowlist 分派本地实现函数；带禁用键或未知 operation 的任务一律拒绝并留下本地审计记录。 |
| D8 | 离线安全：SQLite 事务保存唯一任务事实，未确认结果按 task_id/digest 幂等重发；容量满则背压，绝不丢弃未发结果；隔离证据保留。 |

## 3. 非目标

- 不做节点侧特权执行、不做 sudo 包装、不做 Helper 的替代或代理。
- 不做任意命令/脚本执行（含"只读的 shell"）。
- 不在 v0 做节点密钥对、mTLS 或双向证书（token 轮换接口已在 v0 提供，见 §14）。
- 不改动 `REQ-01`~REQ-04 的定义，也不在证据齐备前把 `REQ-01` 从 `NOT_PROVEN` 提升。
- 不做 Windows/Android agent，不改动已有 Console/面板语义。

## 4. 运行架构

```
systemd --user (control account, Linger=yes)
└─ ghostfleet-managed.service  (Type=notify, Restart=on-failure, WatchdogSec=60)
   └─ /usr/bin/python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz run   # 非 root，无 sudo，无特权组
      ├─ observe     本地事实采集（identity/os/uptime/disk/user-units/capability digest）
      ├─ converge    与本地「已应用期望状态」比对，产出 drift 报告（只报告，不擅自改）
      ├─ heartbeat   有界健康上报（≤16 KiB）
      ├─ poll        取任务（租约 300 s）
      └─ execute     只读 typed 操作 + 结果回传（幂等）
```

文件布局（root-owned 代码 / 用户-owned 状态）：

| 路径 | 属主 / 权限 | 内容 |
| --- | --- | --- |
| `/usr/local/libexec/ghostfleet/node-agent.pyz` | `root:root` `0755` | Agent 载荷（单个 Python zipapp，作为被 pin 的 capability artifact 安装，逐字节校验） |
| `/etc/ghostfleet/node-agent.json` | `root:root` `0644` | 非秘密配置：控制面 URL、心跳区间上下限、允许观测的 unit 名列表。键集合由 agent 侧白名单裁定：`control_plane_origin`（必填，值来自交付的 `node_plane_origin`）+ 可选 `heartbeat_interval_s`/`heartbeat_interval_min_s`/`heartbeat_interval_max_s`（数字，30–300）/`allowed_units`；出现 `schema`、`node_uid` 等白名单外键即 `CONFIG_UNKNOWN_KEY` 拒绝启动，因此 courier 写的字节必须由**可执行**契约测试回放真 agent 的 `check-config` 验证 |
| `%h/.config/ghostfleet/node-token` | `0600`（账户自身） | 注册时铸造的节点 token，仅本账户可读 |
| `%h/.config/ghostfleet/node.json` | `0600` | `node_uid`、平台、注册时间（非秘密但按最小暴露存放） |
| `%h/.local/state/ghostfleet-agent/state.json` | `0600` | 游标、序列号、退避状态、上次成功时间 |
| `%h/.local/state/ghostfleet-agent/tasks.db` | `0600` | SQLite 任务真值：栅栏、正文/摘要、投递状态与隔离历史 |
| `%h/.local/state/ghostfleet-agent/tasks.db.lock` | `0600` | 运行进程独占锁，避免两个 Agent 交叉执行任务 |

日志边界：只写 stdout（journald 捕获），结构化 JSON 行，字段白名单；**永不**写入 token、`resume_session`、短码、完整控制面响应体或任何私有部署事实。日志速率由循环周期天然限制，错误路径按退避降频。

配置契约（与 `packages/node-agent` 的实际解析器一致，courier 按此逐键生成）：

- `/etc/ghostfleet/node-agent.json` 恰好 5 个键：`control_plane_origin`、`heartbeat_interval_s`、`heartbeat_interval_min_s`、`heartbeat_interval_max_s`、`allowed_units`。agent 拒绝任何未知顶层键（`CONFIG_UNKNOWN_KEY`）与非数字心跳（`CONFIG_TYPE_INVALID`）；心跳是数字秒（30 / 30 / 300，ADR 速率预算按 30 s 周期），不是区间对象。
- `control_plane_origin` 是**节点面（node-plane）桥**的 origin，不是 Enrollment/Assets origin：后者受 Access 保护或只服务一次性下载，agent 连上去只会得到 302/403。三个 origin 由交付命令显式交付（节点面 origin 经 `GHOSTFLEET_NODE_PLANE_ORIGIN` 环境变量交给 courier）；courier 只校验并消费，不自行推导。缺失、形态不是精确 HTTPS origin、或与 enrollment origin 同 host 一律 fail closed（`CAPABILITY_NODE_PLANE_ORIGIN_REQUIRED` / `_INVALID` / `_NOT_SEPARATED`），且在写任何文件之前拒绝。
- 配置不含 `schema`、`node_uid` 或任何凭据；`node_uid` 只住在 `%h/.config/ghostfleet/node.json`（`0600`）。courier 写完后必须能被 `python3 -I <payload> check-config --config <file>` 接受，这条交叉契约由 bootstrap 测试回放真实字节保证。

## 5. 协议 v0（`ghostfleet-node-agent/v0`）

### 5.1 认证

- 节点 token 在 `completeEnrollmentTicket` 成功时铸造（32 字节 CSPRNG → base64url），`node_credential: {token, node_uid, handoff_id}` **可从同一 resume capability 重取，直到节点首次认证成功**：控制面同时保存 `sha256(token)`（认证用）与 `AEAD(token)`（重投递用）。密钥由 `HKDF-SHA256(ikm=GHOSTFLEET_OPERATOR_TOKEN, salt=空, info="ghostfleet/node-credential-handoff/v1", len=32)` 派生（不新增 secret；operator secret 轮换会使历史密文不可解，节点须重新签票，这是有意的 fail-closed），`AES-256-GCM`（12 字节随机 IV、16 字节认证标签，IV 与密文均以 base64url 存放），AAD 绑定 `{node_uid, ticket_id, handoff_id}`；加密副本在**节点首次通过认证的请求**到达后立即销毁（不依赖 courier 回执），并另有 24 h / 20 次重投递上限。内部状态机用 `credential_handoff_state` 表达 `SEALED`（可重取）/`CONSUMED`（节点已首次认证成功，`complete` 只回 `credential_handoff: "CONSUMED"`、不含 token）/`EXPIRED`（TTL 或投递预算耗尽）；该字段只是记录而不是认证边界——真正的边界是 AEAD 认证失败即拒绝，改写它拿不到 token。operator 轮换凭据（rotate）必须同时清空该状态与密文。过期后 `complete` 返回 `credential_handoff: "EXPIRED"` 且不含 token——补救是退役节点重新签票，不放宽窗口。courier 用 `tmp`+`fsync`+`rename` 原子写入 control account 的 `~/.config/ghostfleet/node-token`（`0600`，目录 `0700`），token 不进日志/argv/状态行。
- 每个 agent 请求带：`Authorization: Bearer <token>`、`x-ghostfleet-node-uid: <node_uid>`、`x-ghostfleet-agent-version: <semver>`。
- 请求体（canonical JSON）：`schema`、`node_uid`、`nonce`（≥16 字节 base64url）、`sent_at`（RFC 3339 Z）、`boot_id`、`seq`（本次启动内单调递增）。

服务端校验顺序（全部失败即拒，且**在触碰任何状态之前**）：

1. body 大小上限（heartbeat ≤16 KiB、poll ≤4 KiB、result ≤64 KiB）→ `413`
2. `content-type: application/json` → `415`
3. `x-ghostfleet-node-uid` 头必须存在且等于路径（缺失 → `401 NODE_AUTH_INVALID`，不一致 → `403 NODE_SCOPE_MISMATCH`）；随后 token 摘要比对（常量时间）+ `node_uid` 与记录一致 → `401 NODE_AUTH_INVALID` / `403 NODE_SCOPE_MISMATCH`
4. 节点生命周期 ∈ {PROVISIONAL, ACTIVE} → `403 NODE_NOT_ADMITTED`
5. `sent_at` 偏差 ≤300 s → `401 NODE_CLOCK_SKEW`
6. 重放：同 `node_uid` 的 `nonce` 在 600 s 窗口内已出现 → `409 NODE_NONCE_REPLAY`（每节点环形保存，上限 256 条）
7. 速率：每节点 token bucket——容量 24、补充 1 token / 10 s（≈360 请求/小时），`heartbeat`/`poll`/`result` 各计 1 → 超限 `429 NODE_RATE_LIMITED` 并带 `Retry-After`。节点周期下限 30 s ⇒ 基线 2 请求/30 s = 240/小时，另留 120/小时给结果与重试（ADR 修订前的「≤120/小时」与 30 s 心跳自相矛盾，此条取代之）。
8. 序号：同 `boot_id` 内 `seq` 必须严格递增（允许乱序 ≤64）；`boot_id` 单调，旧 `boot_id` 重现 → `409 NODE_BOOT_REPLAY`；同 `boot_id` 内 `seq` 回退或跳跃 >64 → `409 NODE_SEQ_REGRESSION`。`(boot_id, seq)` 是唯一性单位，进程重启后新 `boot_id` + `seq` 从 0 开始。退役 `boot_id` 历史**不得静默驱逐**：达保存上限时新 `boot_id` fail closed（`409 NODE_BOOT_ID_CAPACITY_REACHED`）并要求 operator `rotate`，而不是让被驱逐的旧 `boot_id` 变成可重放、或把活跃 `boot_id` 锁死。

### 5.2 端点（挂在现有 `/v0` 路由表内，介于 `GET /v0/nodes` 与 `POST /v0/enrollment-attempts/{id}/{action}` 之间）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| POST | `/v0/nodes/{node_uid}/heartbeat` | 上报健康与观测摘要；响应回传 `interval_s`（钳制到 30–300：30 s 是速率底线，即使配置写得更窄也不会低于它）与最多 2 个任务信封 |
| POST | `/v0/nodes/{node_uid}/tasks/poll` | 取任务（≤4 个/次），带 300 s 租约 |
| POST | `/v0/nodes/{node_uid}/tasks/{task_id}/result` | 回传结果；同 `task_id` 同摘要→幂等 200，不同摘要→`409 TASK_RESULT_CONFLICT`；`result.status` 必须是 `SUCCEEDED`/`REFUSED`/`FAILED`/`UNKNOWN`，其它值 fail-closed 为 `UNKNOWN` |
| POST | `/v0/node-tasks` | **operator 写权限**；入参 `node_uid`/`operation`/`params`/`ttl_seconds`（字段名以此为准；未知键一律 `400 TASK_REQUEST_INVALID`），返回任务信封与 `task_id`；队列满（未过期非终态 ≥64）→ `409 TASK_QUEUE_FULL`，不得因已过期任务而永久 409 |
| GET | `/v0/node-tasks?node_uid=` | **operator 读权限**；返回该节点任务投影（`status`/`result_outcome`/`result_digest`/`attempt`）。`result_outcome` 是 operator 侧字段名，取值必须就是节点上报的四值 `status` 词汇，不是第二套词汇；缺 `agent` 子树的历史记录必须先归一化，未知异常只回 `500 INTERNAL_ERROR`，不回显内部错误文本 |
| POST | `/v0/node-credential/rotate` | **operator 写权限**；一次性返回明文 `node_credential: {token, node_uid, handoff_id}`——与 `/v1/enroll/complete` 同形，`rotate` 会清空 handoff，故 `handoff_id` 为 `null`（响应带 `cache-control: no-store`）；旧 token 立即失效并重置该节点 nonce/seq/boot 状态与 handoff 密文 |

结果信封在写入前必须绑定：`schema` 等于 `ghostfleet-node-task/v0`（否则 `400 TASK_RESULT_SCHEMA_UNSUPPORTED`）、`result.task_id` 等于路径 `task_id`（`409 TASK_RESULT_SCOPE_MISMATCH`）、`result.operation` 等于任务 `operation`（`409 TASK_OPERATION_MISMATCH`）、`result.node_uid` 等于路径且等于 token 归属（`403 NODE_SCOPE_MISMATCH`）。这四个码都属「需人工」终态类，客户端不得自动重试。`result_digest` 由服务端对 result 做 canonical JSON 后计算，节点自报值只作咨询（跨语言浮点渲染差异），不得作为幂等键。`result` 的 canonical JSON 深度上限 64，超限 → `400 TASK_RESULT_INVALID`。

结果提交的请求体形状固定为「顶层 `task_id` + 嵌套 `result`」：`task_id` 必须等于路径 `task_id`（否则 `400 NODE_REQUEST_INVALID`），`result` 必须是对象（否则 `400 TASK_RESULT_INVALID`）。摘要与幂等只按嵌套 `result` 计算，顶层不带其他语义字段；§5.1 的请求体字段（`schema`/`node_uid`/`nonce`/`sent_at`/`boot_id`/`seq`）在此之外一并必填。

任务信封 `ghostfleet-node-task/v0`：`task_id`、`node_uid`、`operation`、`params`（只允许标量/列表，深度 ≤3，总长 ≤4 KiB）、`issued_at`、`expires_at`（≤ `issued_at`+600 s）、`lease_expires_at`（服务端按 300 s 租约计算）、`attempt`（1–3）。

### 5.3 v0 词汇表（只读）

| operation | 语义 | 约束 |
| --- | --- | --- |
| `node.observe` | 采集 `want` 指定的本地事实 | `want` ∈ {identity, os, uptime, disk, services, capability} |
| `service.status.read` | 读指定 user unit 的 active 状态 | ≤8 个 unit，名必须匹配 `^[a-z][a-z0-9_.@-]{0,63}\.service$`；无 shell，`subprocess` 数组传参 |
| `capability.inspect` | 读本地 capability 摘要 | 只回 digest 与组件状态，不回文件内容；数据源是 bootstrap 写的 `/etc/ghostfleet/capability-status.json`（root `0644`，只含公开 artifact 名与 sha256、`release_pin`、`applied_at`），**不读** root `0600` 的 `/var/lib/fleet/capability-state.json`；文件缺失 → `UNKNOWN` |
| `agent.self.test` | 端到端自检 | 回显 `nonce` 与 agent 版本 |

其余 operation → `400 TASK_OPERATION_FORBIDDEN`。`params` 中出现禁用键（`command`/`cmd`/`script`/`shell`/`args`/`argv`/`exec`/`run`/`url` 等）→ `400 TASK_PARAMS_FORBIDDEN`。

### 5.4 公网入口（严格桥，不是通用代理）

控制面的 `/v0/*` 整体在 Cloudflare Access 之后（`authorizeApi()`），节点 token 无法也**不得**从公网打管理面。节点面新增一个独立的严格桥 Worker（`workers/node/`，产物名 `ghostfleet-node-plane`，挂在部署方自己的 zone，`workers_dev=false`、`preview_urls=false`、不新增任何 Access Bypass）：

- 只接受三条精确 POST 路径（`/v0/nodes/{node_uid}/heartbeat`、`/v0/nodes/{node_uid}/tasks/poll`、`/v0/nodes/{node_uid}/tasks/{task_id}/result`，`node_uid` 必须匹配 `^node-[A-Za-z0-9-]{1,80}$`、`task_id` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$`，与控制面同一字符类——桥不得比控制面更窄，否则控制面合法 id 在边缘 404），其余一律 `404`；不代理任何其他 `/v0/*`、`/mcp`、`/v1/*`。
- 转发 header 正向 allowlist：`authorization`、`content-type`、`x-ghostfleet-node-uid`、`x-ghostfleet-agent-version`；其余丢弃，不转发客户端 IP/UA。响应只回 `content-type`、`retry-after` 与固定安全头。
- 桥在触碰 Service Binding **之前**做 body 上限（heartbeat ≤16 KiB、poll ≤4 KiB、result ≤64 KiB → `413`）与 `content-type` 校验（`415`）；限流 binding 仅作咨询性防滥用（缺失/抛错 fail open，显式 `success:false` → `429`；binding 存在但抛错或返回非对象时必须记一条结构化告警 `rate_limiter_unavailable`，让「已启用但坏掉」可见），限流成功**不是**授权。
- 通过 Service Binding `GHOSTFLEET_CONTROL_PLANE` 调用控制面；binding 缺失 → `503 NODE_PLANE_NOT_CONFIGURED`，绝不回退公网 URL。
- 节点面源站是**交付期部署事实**，不是代码常量：交付命令（`createTicketDelivery`，协议 `ghostfleet-enrollment-delivery/v2`）显式导出 `GHOSTFLEET_NODE_PLANE_ORIGIN=<origin>`；courier 校验它是精确 HTTPS origin（无 path/query/userinfo/尾斜杠），且它的 host 与 `GHOSTFLEET_ASSETS_ORIGIN`、`GHOSTFLEET_ENROLLMENT_URL` 的 host **三者两两不同**（`CAPABILITY_NODE_PLANE_ORIGIN_REQUIRED` / `CAPABILITY_NODE_PLANE_ORIGIN_INVALID` / `CAPABILITY_NODE_PLANE_ORIGIN_NOT_SEPARATED`，全部在任何文件写入之前），然后写进 `/etc/ghostfleet/node-agent.json` 的 `control_plane_origin`。**agent 绝不使用 enrollment/broker origin**：那是 Access 保护的源站，节点面按裁决不设任何 Bypass，把两者混用只会让 agent 永远拿到 302/403 然后 FATAL。
- 控制面二次校验不变：token 摘要、`node_uid`、生命周期、时钟、nonce、序号、速率全部在状态变更前完成。

## 6. 持续工作循环

单次迭代（默认 30 s，抖动 ±10%，随控制面 `interval_s` 调整）：

1. **observe**：采集有界事实（CPU 负载、内存、磁盘使用率、uptime、允许的 user unit 状态、capability state 摘要、agent 版本）。
2. **converge-report**：与上次成功上报的观测比对，产 `drift` 列表（例如 unit 从 active→failed、capability 摘要变化、磁盘越线）。**只报告，不擅自修改**：v0 的收敛动作就是把事实与差异讲清楚，变更仍由授权路径驱动。
3. **heartbeat**：上报 `health`（`OK`/`DEGRADED`/`FAILING`）、`drift`、`agent_version`、`capability_digest`、`queue_depth`；读取 `interval_s`。
   - **显式 `null` 是合法上报**：`capability_digest` 在节点还没有（或尚未重新投影）`/etc/ghostfleet/capability-status.json` 时就是 `null`，表示「能力投影未知」。控制面必须接受 `null` 并把记录写成 `null`（未知不可伪造成新鲜），只有「非 `null` 且非字符串」或「字符串不匹配 `sha256:<64hex>`」才算非法载荷。`health` 同理允许 `null`。**任何「未知态」字段都不许用 400 把节点锁在门外**——那会让 PROVISIONAL 节点永远进不了 poll/result 阶段。
   - 这条契约必须由**真机抓到的字节**回归：控制面测试里放一份真实 agent 发出的 heartbeat 请求体 fixture（未投影态，`capability_digest: null`），断言穿过完整校验链返回 200 且落库为 `null`。分侧自造 fixture 会同时骗过两侧（本仓已经因此漏过一次：plane 单测、agent 单测都绿，真机首跳即 400）。
4. **poll + execute**：逐个任务走 §7 的栅栏与 allowlist 分派，结果入 outbox。
5. **flush**：按 `task_id` 幂等回传 outbox；失败按指数退避（1 s → 2 s → 4 s … 封顶 300 s，带抖动）重试。`429` 遵守 `Retry-After`（服务端对自己的限流节奏有最终权威：带 `Retry-After` 时按它睡眠、上限 3600 s，不受本地 300 s 退避封顶约束；只有本地指数退避封顶 300 s），`401/403` 停止上报并进入 FATAL 等待人类修复，`409` 按码分派（`NODE_NONCE_REPLAY`/`NODE_SEQ_REGRESSION` 立即换新 `seq`/`nonce` 重试一次，`NODE_BOOT_REPLAY` 换新 `boot_id`），5xx 与网络错误只重试不当成功。控制面不可达时保持循环、不退出、不丢已执行事实。

这条循环满足"Agent 真正承担持续管理工作"：它持续采集、比对漂移、上报健康并执行控制面下发的有界管理工作；心跳只是循环的一个阶段，不是全部。

**看门狗喂狗不依赖主线程推进（实测教训，2026-11-12）**：首版只在成功路径与分块睡眠的块间发 `WATCHDOG=1`。控制面不可达时，每轮都走失败分支并进入 1→2→4→8→16→32 s 退避（每段都短于 30 s 分块上限），`remaining` 归零，于是一次都不喂——真实 systemd 上表现为每约 60 s `Watchdog timeout (limit 1min)` → `SIGABRT` → 重启，`NRestarts` 无限增长（离线时最需要它保持运行，恰恰最先被自己杀掉）。因此喂狗由**独立常驻线程**负责：`sd_notify(READY=1)` 之后启动一个 daemon 线程，按 `WatchdogSec/3`（≈20 s）周期发送 `WATCHDOG=1`，用 `Event.wait(timeout)` 以便 `shutdown()` 能立即唤醒退出（`shutdown()` 先 set + `join(≤2 s)` 再发 `STOPPING=1`）；线程内异常只记 warning 不杀进程；`--once` 单次运行不启动该线程。成功路径上的喂狗点保留作冗余。`NotifyAccess=main` 保持不变：systemd 用 `SCM_CREDENTIALS` 判 PID，而其中携带的是 **TGID**，主进程创建的线程发送 `sd_notify` 会被识别为主进程（实测 tgid=411 / tid=412，收方看到 pid=411），不需要放宽成 `all`。

## 7. 耐用状态与崩溃语义

当前权威设计见 [SQLite 持久化合同](NODE_AGENT_SQLITE.md)。此前 JSON ledger/outbox 分文件提交、`RESULT_DROPPED` 自动驱逐及跨文件撤回/重建机制已废弃。

唯一任务真值是当前非 root 账户持有的本地 SQLite `tasks.db`。一个任务行同时包含 task_id、node_uid、operation、attempt、执行栅栏、结果正文/摘要和投递状态。采用 `BEGIN IMMEDIATE`、`journal_mode=DELETE`、`synchronous=EXTRA`、进程排它锁及 0600 文件权限：

1. **执行前**：提交 `MAY_HAVE_EXECUTED` 栅栏后才执行；没有成功的持久化栅栏就不能运行任务。
2. **执行结果**：终态与唯一 body/digest、`PENDING` 在一个事务中提交。`REFUSED` 只表示实现未调用；只读执行中错误为 `FAILED`；可能已执行而事实未知为 `UNKNOWN`。
3. **崩溃恢复**：只剩栅栏则事务内生成 UNKNOWN 正文，不重跑。已有 PENDING 按原摘要/原正文重试；服务端按 task_id + digest 幂等吸收。
4. **确认**：服务端接受后才标 `ACKED`、清除正文并保留 identity/digest 墓碑，防止再次执行。
5. **隔离**：正文冲突、永久拒收、身份更换只标 `QUARANTINED`，原始证据不被删除或重算。
6. **容量**：未完成栅栏和 PENDING 共用 64 条上限；满则停止 poll 新任务、继续 heartbeat/回传。ACKED 紧凑保留，数据库有实际容量上限；磁盘/锁/提交异常均 fail closed。
7. **迁移**：旧 JSON 原件只通过受控停机、备份、显式导入及哈希校验迁移，不静默当作空库重建。没有 HTTP 发生在 SQLite 事务内。

安装时验证 pyz 内容摘要并使用 root-owned 安装目录。运行期继续检查 token 0600 和 root-owned 配置，不依赖自哈希建立信任。

## 8. systemd 生命周期

```ini
[Unit]
Description=GhostFleet Node Agent
After=network-online.target

[Service]
Type=notify
NotifyAccess=main
ExecStart=/usr/bin/python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz run
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=XDG_RUNTIME_DIR=%t
Restart=on-failure
RestartSec=5
WatchdogSec=60
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=read-only
StateDirectory=ghostfleet-agent
StateDirectoryMode=0700
ConfigurationDirectory=ghostfleet
ConfigurationDirectoryMode=0700
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=%h/.config/ghostfleet %h/.local/state/ghostfleet-agent
MemoryMax=256M
TasksMax=64

[Install]
WantedBy=default.target
```

- **开机恢复**：`loginctl enable-linger <control_account>`（已在 #79 账户隔离里实现）+ `WantedBy=default.target` → 无人类登录也自动拉起。
- **故障恢复**：`Restart=on-failure` + `RestartSec=5`（正常 `SIGTERM` 退出 0 不重启，异常退出/信号/看门狗超时才重启，语义边界明确）；`WatchdogSec=60` 由 Agent 的**常驻 watchdog 线程**每 `WatchdogSec/3`（≈20 s）发 `sd_notify(WATCHDOG=1)` 喂狗（不依赖主线程推进，见 §6），主线程卡死超过 60 s 才被杀重启。
- **配置有效性必测**：unit 必须通过 `systemd-analyze --user verify`；`ProtectHome=read-only` 是合法取值（`read-write` 不是，旧稿已修），真实读写目录只经 `ReadWritePaths` 精确开放。
- **目录必须先存在**（实测教训）：`ReadWritePaths` 指向不存在的目录会让服务在挂载命名空间阶段直接失败（`status=226/NAMESPACE`，且 `Restart=on-failure` 会无限重试）。因此 unit 用 `StateDirectory=ghostfleet-agent` + `ConfigurationDirectory=ghostfleet` 让 systemd 创建这两个目录（`verify` 与启动均通过），courier 安装时也要创建并把 `~/.config/ghostfleet` 收紧到 `0700`——两条路径互为自愈。
- **user manager 的硬化会隐式启用 `PrivateUsers=`（实测，2026-11-12）**：`man systemd.exec` 明确写着，mount 类保护项（`PrivateTmp`/`PrivateDevices`/`ProtectSystem`/`ProtectHome` 等）在 per-user manager 里只有隐式开启 `PrivateUsers=` 才可用。实际效果：服务进程处在只映射自身 UID 的 user namespace（`/proc/self/uid_map` = `1002 1002 1`），**host root 拥有的文件在沙箱内一律显示为 overflow uid**（`/proc/sys/kernel/overflowuid`，默认 65534），同时 `/` 被以 `ro` 挂载。实测（Ubuntu 24.04 / systemd 255）：沙箱内 `stat /etc/ghostfleet/node-agent.json` 得到 `65534:65534 0644`、`/` 挂载选项 `ro,relatime`。因此在 unit 里用「`st_uid == 0`」判 host root 归属**必然失败**——首轮真机启动就是这么挂的：`AGENT_CONFIG_UNTRUSTED` / `CONFIG_OWNER_NOT_ROOT`，退出 3，`Restart=on-failure` 无限重启。
- **host-root 信任判据（Agent 与能力投影共用同一实现）**：默认路径上的文件可信，当且仅当它是常规文件（`lstat`，非符号链接），且满足其一：(a) 把观测到的 `st_uid` 按 `/proc/self/uid_map` 的行（`inside outside length`，依次是「命名空间内 UID、host UID、长度」）**反查回 host uid**——存在 `inside <= st_uid < inside + length`（且 `length > 0`）的行时 `host_uid = outside + (st_uid - inside)`，反查结果恰好为 `0` 才可信；(b) 观测到的 `st_uid` 未被任何映射行覆盖（典型是只映射自身 UID 的沙箱里的 overflow uid）时，要求 `st_uid == overflowuid` **且** 该路径在 `/proc/self/mountinfo` 中按最长前缀匹配到的挂载带 `ro` **且** `os.access(path, W_OK)` 为假。配置文件另要求 `mode == 0644`；`/etc/ghostfleet/capability-status.json` 另要求 `mode & 0o022 == 0`。`/proc/self/uid_map` 或 `mountinfo` 读不到、行格式非法一律 fail closed（此时只接受 (b) 的只读证明）。
  - **必须反查被观测的 uid，不能只看「uid 0 是否被映射」**：在 `0 1002 1` 这类嵌套命名空间里，host uid 1002 拥有的文件会以 uid `0` 出现在进程视野中；「只要映射里出现 0 就要求 `st_uid == 0`」会把托管账户自己的文件误判成 host root 拥有。反查映射（`outside + (st_uid - inside) == 0`）在两种命名空间形态下都成立。
  - (b) 不是放宽：在只映射自身 UID 的命名空间里「host root 拥有」与「host 65534 拥有」在 uid 上无法区分，唯一的内核级等价不变量是只读挂载；`RestrictNamespaces=yes` 又阻止服务自己再建 mount namespace 造可写视图。门禁真正要保证的是「托管账户改不了这个文件」，`ro` 挂载由内核强制，等价成立。
  - 负向臂必须证明：可写挂载上的 overflow uid 文件仍被拒；`W_OK` 为真被拒；mode 不是 0644 被拒；反查映射结果不是 0 被拒（含 `0 1002 1` + `st_uid == 0` 与 `1002 1002 1` + `st_uid == 1002` 两臂）；`uid_map` 畸形时只读证明之外的组合被拒。
- **`ConfigurationDirectoryMode=0700`**：courier 为放 `node-token` 把 `~/.config/ghostfleet` 建成 `0700`，而 `ConfigurationDirectory=ghostfleet` 默认要求 `0755`，systemd 每次启动都告警 `ConfigurationDirectory 'ghostfleet' already exists but the mode is different (File system: 700 ConfigurationDirectoryMode: 755)`；若目录尚未存在，systemd 会按 0755 创建。unit 必须显式 `ConfigurationDirectoryMode=0700` 与 courier 口径对齐。
- **`StateDirectoryMode=0700`**：`StateDirectory=ghostfleet-agent` 默认按 `0755` 创建，而 agent 自己的启动自检要求状态目录只有属主可写，于是每轮启动都会打出一条 `state_dir_permissions_loose mode 0o755` 的 warning（首轮真机一次启动出现 4–5 条），日志被自己的告警噪声淹没。unit 显式 `StateDirectoryMode=0700`，agent 侧对同一 path/mode 的 warning **每进程只打一次**（去重，不降级为静默）。
- **子进程必须剥掉 notify 环境（实测教训，2026-11-12）**：`NOTIFY_SOCKET` 会随环境继承给每一个被调起的子进程；实测 `systemctl`、`loginctl`、`systemd-analyze` 这类 libsystemd CLI 在**退出时**会向 `NOTIFY_SOCKET` 发一条 `EXIT_STATUS=0`。`NotifyAccess=main` 下这些消息不被接受，journal 每轮刷 `Got notification message from PID <child>, but reception only permitted for main PID <main>`；一旦放宽成 `NotifyAccess=all`，这些伪 `EXIT_STATUS=0` 就会被当成主进程的退出状态，污染服务结果。因此 `CommandRunner.run()` 必须显式传 `env=`，在 `dict(os.environ)` 基础上删除 `NOTIFY_SOCKET`、`LISTEN_FDS`、`LISTEN_PID`、`WATCHDOG_USEC`、`WATCHDOG_PID`（保留 `PATH`/`HOME`/`LANG`/`XDG_RUNTIME_DIR`），并由单测断言 spawn 环境的键集合、以及 observe 输出不因剥离而改变。
- **unit 必须钉住 `XDG_RUNTIME_DIR=%t`（实测教训，2026-11-13）**：user manager 的 `XDG_RUNTIME_DIR` 可能来自启动它的会话/服务管理器环境，而不是账号本身。GitHub Actions runner 上实测：托管账号 uid 1002 的 agent 继承了 `/run/user/1001`（runner 用户），而它的 user bus 在 `/run/user/1002/bus`，于是每一条 `systemctl --user show --property=ActiveState --value <unit>` 都连不上 bus → 非零退出 → 观测结果被归一并吞成 `unknown`（`service.status.read` 返回 `units.ghostfleet-managed.service=unknown`，operator 侧同一 unit 是 `active`）。沙箱与硬化不是原因：同款加固的 user unit 在 systemd 255 上跨 unit 查询正常（`show_rc=0`），WSL 里 `terminate-user` 后重建的 manager 也会自己修正继承值，所以这类污染只在特定 runner 上出现。`%t` 在 user unit 中展开为该账号自己的 runtime 目录（实测 `/run/user/<uid>`），因此 unit 里写 `Environment=XDG_RUNTIME_DIR=%t` 与「谁污染了 manager 环境」无关。验收必须同时断言两件事：unit 文本含该行，以及运行时 `/proc/<MainPID>/environ` 的 `XDG_RUNTIME_DIR` 恰为 `/run/user/<uid>`。agent 侧「`systemctl` 非零退出不记日志」仍是已知观测盲区（后续跟进），不是本条的替代品。
- **安全停止**：`SIGTERM` → 主循环停止取新任务、**不再发起新的 heartbeat/poll**、停止启动批次中尚未开工的任务；`shutdown()` 随后在预算内**只 flush 已经执行完成的结果**（停止路径上唯一允许发生的请求：这些是已承诺的事实，不是新决策），写 `last_stop` 事实后退出 0。预算不是常量相加的纸面算术，而是运行时逐请求生效：`stop_event` 在 heartbeat 前、poll 前、批次内每条任务开工前检查，`Outbox.flush` 接受 deadline 参数，单条请求的 socket 超时被钳制到剩余预算，且 **409 冲突重试共享同一 remaining**（重试前按已耗时扣减；剩余不足最小发送窗口就不再重试，直接返回首次结果）——否则一次发送可以吃掉两倍剩余预算，「8 s flush / 30 s 停机」就不是硬上界。最坏停机时延 ≈ 1 s（分块睡眠可打断）+ 剩余预算内的单请求 + 8 s（flush），必须显著小于 `TimeoutStopSec=30`，并由「64 条 pending + 慢控制面 + `SIGTERM`」的真实时限测试守护（只把常量相加的测试不算证据）。
- **健康可见性**：`systemctl --user show` 的 `ActiveState`/`NRestarts`/`ExecMainStatus` 外加 Agent 自报的 `health`，构成独立消费者可观察的外部证据。

## 9. 安全边界与威胁模型

| 攻击面 | 缓解 |
| --- | --- |
| 控制面被冒充 / 中间人 | 仅 HTTPS（唯一例外是受控验收环境里显式开启的 loopback 明文：需要 `allow_loopback_http` 配置或测试专用环境变量，且 unit 永不设置；默认拒绝）；控制面 URL 来自 root-owned 配置，不由任务下发；凭据不明文落日志 |
| 节点 token 泄漏 | `0600` 单账户可读；服务端只存摘要（AEAD 副本仅在首次认证前存在，首次认证即销毁）；绑定 `node_uid`；支持轮换（`POST /v0/node-credential/rotate`，旧 token 立即失效）与吊销（`revoked` → Agent 清凭据并停止上报） |
| 重放已抓取请求 | 600 s `nonce` 窗口 + `sent_at` 偏差限制 |
| 恶意任务（提权/命令注入） | 双端 allowlist、无 shell、数组传参、禁用键递归检查、参数长度与深度上限 |
| 崩溃后重复执行 | `MAY_HAVE_EXECUTED` 栅栏 + 服务端按 `task_id` 幂等 |
| Agent 越权 | 无 sudo、无特权组、无 Helper 访问；`NoNewPrivileges`、`ProtectSystem=strict`（`/var/lib/fleet`、`/etc/sudoers.d` 均不可写） |
| 伪造 root-owned 配置/投影 | 信任判据是「host root 拥有」或（user namespace 内）「只读挂载 + overflow uid + 当前用户不可写」；`RestrictNamespaces=yes` 阻止自造挂载视图；判据解析失败 fail closed |
| 日志泄密 | 字段白名单 + 脱敏 + 只写 stdout |
| 资源耗尽 | `MemoryMax`、`TasksMax`、body 上限、队列表上限、退避封顶 |

身份隔离三者的最终形态：Human（人类账户）≠ `ghostfleet-ops`（特权 Helper 中介）≠ control account（常驻 Agent）。Agent 既不能读人类密钥，也不能调用 Helper；Helper 的 `dedicated_caller_identity()` 仍要求 `SUDO_USER == ghostfleet-ops`。

## 10. 控制面改动与耐用性约束

- 现有 store 是单 `Durable Object` 一整个 blob（`ghostfleet-state`）、无 CAS、`events` 无上限。v0 新状态一律挂在 `nodes[node_uid]` 之下（`agent`、`tasks`、`nonces`、`result_digests`），并给 `events` 加上限（保留最近 N 条）。
- 因为无 CAS，写路径必须**幂等且可安全重放**：同 `task_id` 同 `result_digest` 视为成功；同 `task_id` 不同摘要拒绝而不是覆盖。
- 5xx 不回写的既有行为意味着"控制面 500 但已执行"可能发生——这正好由 Agent 侧 outbox 重试 + 幂等结果吸收，不允许 Agent 把 5xx 当成功。

## 11. 安装与制品

1. **Agent 载荷**是确定性构建的单个 zipapp（`packages/node-agent/dist/node-agent.pyz`），作为独立的、内容寻址的 capability artifact 被 pin 并分发——**不**随 bootstrap 内嵌，避免把实现字节塞进已冻结的启动器。安装到 `/usr/local/libexec/ghostfleet/node-agent.pyz`（`root:root` `0755`），逐字节校验 SHA-256。CI 必须从源码重建 pyz 并断言字节相等，且用 `python3 -I <pyz> check-config` 冒烟（隔离模式是硬约束，不允许 `sys.path` 注入或依赖 cwd）。
2. **user unit** 是第二个独立 pin 的 artifact，安装到 control account 的 `~/.config/systemd/user/ghostfleet-managed.service`，随后 `systemctl --user daemon-reload && systemctl --user enable --now ghostfleet-managed.service` + `loginctl enable-linger`。
3. 三方一致由确定性测试断言：unit 的 `ExecStart` 路径 == pyz 安装路径；unit 的 `ReadWritePaths` 与凭证/状态路径 == courier 实际创建路径（`%h/.config/ghostfleet`、`%h/.local/state/ghostfleet-agent`）；selection 中 pyz 与 unit 的 `sha256` == 安装时校验值。
4. 发布选择必须显式 `user_service_required=true` 且声明 `managed` 角色；缺 unit 或 pyz 制品 → `fail closed`（`CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE`），不再“没 unit 就当不需要”。
5. unit 的 `ExecStart` 是**唯一**启动形态：必须精确等于 `/usr/bin/python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz run`，不得携带 `--config`/`--token`/`--url` 等参数。`--config` 只是测试与排障口子（信任规则仅要求属主为当前用户且组/其他不可写），生产路径固定读 root 拥有的 `/etc/ghostfleet/node-agent.json`；unit 是 pin 过的 root 安装制品，参数面不给攻击者留扩展位。
6. 回滚必须与本 run 的写入对称：若 `/etc/ghostfleet/capability-status.json` 由本次安装写入，回滚要在同一原子序列里删除它（旧文件已存在则恢复原字节）。不许出现「已回滚但投影还写着新 SHA」的状态——那会让 agent 上报 READY 而实际跑的是旧制品。
7. `/etc/ghostfleet/capability-status.json` 只能由一个产品内写入器产出（courier 与验收共用同一个函数/命令，禁止验收脚本手写 JSON 绕过），输入是已校验的 selection 与 artifact 实测摘要，写出用 tmp+fsync+rename 原子替换，schema `ghostfleet-capability-status/v1`。
8. unit 文本必须通过 `systemd-analyze --user verify`（CI 与 disposable 各一次），并断言不含 `sh -c`/`curl`/`wget`/`/bin/sh`、不写 `%h` 之外路径、不声明 `ProtectHome=read-write` 之类非法取值（`CAPABILITY_USER_UNIT_UNSAFE`）。
9. courier 生成的 `/etc/ghostfleet/node-agent.json` 字节必须由**可执行**契约测试回放真 agent：把 courier 写出的那段 body 落成临时文件，跑 `python3 -I <pyz> check-config --config <file>`（配 0600 token 与 `token_path`），断言退出 0；负向臂回放带 `schema`/`node_uid`/嵌套 `heartbeat_interval_s` 的旧形状，断言非 0（`CONFIG_UNKNOWN_KEY`/`CONFIG_TYPE_INVALID`）。理由：字段名靠人眼对齐已经出过一次事故（旧 body 会把托管服务打成 `exit 2` 崩溃循环），契约必须能被机器验证。
10. 交付命令导出 `GHOSTFLEET_NODE_PLANE_ORIGIN` 是节点面唯一合法来源（见 §5.4）：courier 写配置前完成 origin 形态与三 host 互异校验，回滚时若配置由本次写入则删除、旧文件恢复原字节（与第 6 条同一原子序列）。

## 12. 验收矩阵

| 验收项 | 证明方式 | 类型 |
| --- | --- | --- |
| 生命周期 | disposable Linux 上 `systemctl --user is-active` 持续 `active`，`NRestarts` 稳定，超过一个心跳周期仍有新观测 | 真实 systemd |
| 开机恢复 | `loginctl terminate-user` / 重启 user manager 后服务自动回来，无需人类登录 | 真实 systemd |
| 故障恢复 | `kill -9` 主进程 → `Restart=on-failure` 拉回，`NRestarts` +1，心跳恢复；`SIGTERM` 干净退出 0 且**不**重启 | 真实 systemd |
| 离线稳定 | 控制面置为不可达（`https://127.0.0.1:1` 或保留域名）持续 ≥180 s：全程 `ActiveState=active`、`NRestarts` 不增、journal 无 `Watchdog timeout`/`Failed with result 'watchdog'`/`SIGABRT`；恢复可达后心跳与任务处理自动继续。EVIDENCE 记录首尾 `NRestarts`、`ActiveEnterTimestamp`、`WatchdogTimestamp` | 真实 systemd |
| 通知卫生 | 全量跑完后 journal `Got notification message from PID ..., but reception only permitted for main PID` 计数为 0（子进程未继承 `NOTIFY_SOCKET`）；且负向单测证明 CLI 的伪 `EXIT_STATUS=0` 不会进入服务结果 | 真实 systemd + 单元测试 |
| 配置有效 | `systemd-analyze --user verify` 通过；保护项与实际读写路径一致（写入被拒的路径确实被拒） | 真实 systemd |
| 沙箱信任判据 | 真实 systemd 下 unit `active` + `READY`（同时证明 `PrivateUsers` 里 `sd_notify` 可用）；EVIDENCE 记录沙箱内 `uid_map`、`overflowuid`、`/` 的 `ro` 挂载、配置文件的沙箱内 uid/mode；负向臂「rw 挂载 + overflow uid 文件」被拒、反查映射结果非 0 被拒。沙箱内视图**必须**用 `nsenter -t <MainPID> -U -m --preserve-credentials --` 采集：直接 `stat /proc/<pid>/root/...` 得到的是宿主 UID 视图（stat 的 u/g 由读者命名空间解释），不能作为沙箱证据 | 真实 systemd + 单元测试 |
| 持续工作 | 控制面下发 `node.observe`/`service.status.read`，节点返回真实观测，且两次结果随时间变化 | 端到端 |
| 身份安全 | 三账户隔离（Human / ops / managed）；managed 无 sudo、无 ops 组 | 真实 systemd + 断言 |
| 权限安全 | managed 直接调用 Helper → 被 `dedicated_caller_identity` 拒；`sudo -n` 被拒 | 负向证明 |
| 任务安全 | 重放 nonce → 409；重复 result → 幂等；崩溃在 `MAY_HAVE_EXECUTED` → 上报 UNKNOWN 且不重跑；越权 operation → 400 | 确定性测试 + 真机 |
| 结果唯一性 | SQLite 提交终态/正文/摘要/PENDING 失败后绝不可发送未提交正文；重启后只可把执行栅栏恢复为唯一 UNKNOWN。服务端 ACK 后本地提交失败，仍保留同正文/摘要重发而非冒充已送达；以故障注入断言 | 确定性测试 |
| 停止语义 | `SIGTERM` 后主循环零 heartbeat/poll；`shutdown()` 仅在预算内 flush 已完成结果；409 重试共享同一剩余预算（假 transport 两次 0.2 s、预算 0.25 s 时总耗时不超 0.25 s）；三段预算的**每一项**都有上限断言，改大任一项即红 | 确定性测试 + 真实 systemd |
| 结果词汇不塌陷 | 真 agent + 真控制面：operator 读到的 `result_outcome` 必须等于 agent 上报的 `status`（四值词汇 `SUCCEEDED`/`REFUSED`/`FAILED`/`UNKNOWN`），禁止全部投影成 `UNKNOWN`；缺失/非法值才 fail-closed 到 `UNKNOWN`，且**读取投影时也要白名单**——durable 里被塞入历史/外来词汇的记录，`GET /v0/node-tasks` 必须归一化为 `UNKNOWN`，不得原样透出第二套词汇 | 端到端 + 契约测试 |
| 入站鉴权完整性 | 缺 `x-ghostfleet-node-uid` → 401；节点 token 打 operator 路由 → 401；无 authorizer 直接构造 handler 调 operator 动作 → 全拒；`rotate` 与 `/v1/enroll/complete` 响应带 `cache-control: no-store`；明文 token 只在一次性响应里出现；`rotate` 与 `complete` 的 `node_credential` 同形（`{token, node_uid, handoff_id}`），按 ADR 读 `.token` 必须有效；凭据重投递预算必须**真的跑到 `EXPIRED`**（第 21 次取回不带 token，24 h TTL 到期同样），只断言常量不算证据 | 确定性测试 |
| 队列与持久化有界 | 5 轮×64 任务后 durable 条目 ≤ `TASK_RETENTION_LIMIT`、快照字节有界；`COMPLETED` 与 `EXPIRED` 都参与修剪；64 个过期任务后（无任何 poll）operator `POST /v0/node-tasks` 仍返回 2xx，不得永久 409；历史记录缺 `agent` 子树时 `GET /v0/node-tasks` 返回 200 空列表 | 确定性测试 |
| 重放与自锁防护 | 退役 `boot_id` 不静默驱逐（达上限 fail closed 且活跃 boot 不受影响）；深嵌套 result（>64 层）→ 400 契约码而非 JS 异常文本 | 确定性测试 |
| 独立验收 | 外部消费者（只读 token）观察到真实 `ActiveState`、自报 health、任务结果时间线 | 端到端 |

在以上全部通过前，REQ-01 保持 `NOT_PROVEN`。

## 13. 发布影响（M4）

1. GhostFleet 实现并合并本 ADR 的产物（Agent、unit、协议、测试）。
2. 重新生成 capability selection：加入真实 `user_unit` artifact，`user_service_required=true`。
3. 重算 `bootstrap_sha256`、assets manifest、selection digest、delivery sample digest。
4. 新公开入口作为**部署输入**进入私有侧：桥 Worker（`ghostfleet-node-plane`）及其 zone 主机名、`ghostfleet-control-plane` Service Binding、可选限流 namespace；私有授权包新增该 origin，且必须保持“未登录不能访问管理面”这项验收不变。
5. ai-hub `#375`/`#298` 重新 pin 新 main、重新 vendor、重新验收。
6. 重新生成绑定新 SHA 的 Human 授权页；绑定 `0cbb9c1` 的旧页对新版本无效。

## 14. 风险与未决（非阻塞）

- 单 `Durable Object` blob 写入在心跳频繁时成本偏高；v0 用心跳区间下限 30 s + 只写增量字段缓解，v1 再考虑拆分存储。
- v0 已提供轮换端点（`POST /v0/node-credential/rotate`，operator 鉴权，旧 token 立即失效并重置该节点 nonce/seq 状态）与吊销；节点侧非对称密钥对（可复用 `PRIVILEGE_LEASE_VALIDATOR_V0` 的签名风格）留给 v1。
- 控制面 ↔ 节点的时间同步仅靠 ±300 s 窗口；真机上需要 chrony/systemd-timesyncd 在位（disposable 验收会断言）。
- 日志目前只进 journald，不集中上传；跨节点日志聚合留给后续版本。
- `AGENT_LEDGER_EXHAUSTED` 是兼容保留的健康原因码；现指 SQLite 中未完成栅栏/PENDING 达到背压上限。此时继续心跳、暂停取新任务并保存全部结果，旧 JSON 驱逐策略不再适用。
- `capability.inspect` 新鲜度由安装器契约保证（rollback 删投影），agent 只校验文件属主与权限、不判 `applied_at` 陈旧；真出现陈旧投影，上报的是「安装器说的事实」，责任在安装器而非 agent。
- 常驻 watchdog 线程引入了进程内并发：它只做一件事（定时 `sd_notify(WATCHDOG=1)`），不读状态、不写文件、不加锁，异常自吞并记 warning，`shutdown()` 用 `Event` 立即唤醒并 `join(≤2 s)`；因此不会掩盖主线程卡死（不共享进度加锁是关键）。若未来需要把喂狗与「主线程确有推进」绑定，必须另加进度计数器，而不是把喂狗搬回主线程——首版这样就正是离线自杀的成因。
- 子进程环境剥离 `NOTIFY_SOCKET`/`LISTEN_*`/`WATCHDOG_*` 只作用于 agent 调起的子进程；agent 自身仍从 systemd 收到的环境里读这些变量，二者不冲突（剥离只发生在 `CommandRunner.run()` 的 spawn 环境副本上）。
- **先写者胜的任务结果幂等**是有意接受的：同一 `task_id` 首个被接受的结果生效，之后不同摘要只回 `409 TASK_RESULT_CONFLICT`、不回滚已存结果。因此持有节点 token 的一方可以记录一次伪造成功；唯一救济是 operator `rotate`（连带重置该节点 nonce/seq/boot 与 handoff 密文）。v0 不引入结果签名，非对称签名留给 v1。
- **速率限制在 Durable Object 内按节点计**：突发 24 次仍会各写一次 blob；桥侧的 `NODE_PLANE_RATE_LIMITER` 只是咨询性防滥用（缺省 fail open）。认证前的全局/出口节流属部署面（Cloudflare 边缘限流 / Access 策略），不在本 ADR 的能力承诺内；v0 用 body 上限 + 单 blob 有界修剪把成本封住。
- **handoff 是簿记不是鉴权边界**：`SEALED`/`CONSUMED`/`EXPIRED` 只决定能否再取回 token，token 在 `rotate` 之前始终有效；24h / 20 次窗口内持有 resume capability 的一方可以取回同一 token（这是为了「complete 响应丢失可恢复」付出的代价）。resume capability 因此必须按 bearer secret 处理（0400 输入、不进 argv/日志/history），首次认证成功即销毁密文。绑定客户端指纹/双向 TLS 留给 v1。
