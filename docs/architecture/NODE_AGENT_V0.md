# NODE_AGENT_V0 — 常驻节点代理（ADR）

| 字段 | 值 |
| --- | --- |
| 状态 | PROPOSED（AI 工头起草，等待独立 exact-head Review） |
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
| D8 | 离线安全：所有出站请求可安全重试（结果按 `task_id` 幂等），本地队列有容量上限与丢弃策略，丢包不改变已执行事实。 |

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
| `/etc/ghostfleet/node-agent.json` | `root:root` `0644` | 非秘密配置：节点面桥 origin、心跳秒数与上下限（30/30/300）、允许观测的 unit 名列表；无 `schema`、无 `node_uid`、无凭据 |
| `%h/.config/ghostfleet/node-token` | `0600`（账户自身） | 注册时铸造的节点 token，仅本账户可读 |
| `%h/.config/ghostfleet/node.json` | `0600` | `node_uid`、平台、注册时间（非秘密但按最小暴露存放） |
| `%h/.local/state/ghostfleet-agent/state.json` | `0600` | 游标、序列号、退避状态、上次成功时间 |
| `%h/.local/state/ghostfleet-agent/ledger.json` | `0600` | 任务派发栅栏与结果摘要（跨重启存活） |
| `%h/.local/state/ghostfleet-agent/outbox.json` | `0600` | 待回传结果，上限 64 条 |

日志边界：只写 stdout（journald 捕获），结构化 JSON 行，字段白名单；**永不**写入 token、`resume_session`、短码、完整控制面响应体或任何私有部署事实。日志速率由循环周期天然限制，错误路径按退避降频。

配置契约（与 `packages/node-agent` 的实际解析器一致，courier 按此逐键生成）：

- `/etc/ghostfleet/node-agent.json` 恰好 5 个键：`control_plane_origin`、`heartbeat_interval_s`、`heartbeat_interval_min_s`、`heartbeat_interval_max_s`、`allowed_units`。agent 拒绝任何未知顶层键（`CONFIG_UNKNOWN_KEY`）与非数字心跳（`CONFIG_TYPE_INVALID`）；心跳是数字秒（30 / 30 / 300，ADR 速率预算按 30 s 周期），不是区间对象。
- `control_plane_origin` 是**节点面（node-plane）桥**的 origin，不是 Enrollment/Assets origin：后者受 Access 保护或只服务一次性下载，agent 连上去只会得到 302/403。三个 origin 由交付命令显式交付（节点面 origin 经 `GHOSTFLEET_NODE_PLANE_ORIGIN` 环境变量交给 courier）；courier 只校验并消费，不自行推导。缺失、形态不是精确 HTTPS origin、或与 enrollment origin 同 host 一律 fail closed（`CAPABILITY_NODE_PLANE_ORIGIN_REQUIRED` / `_INVALID` / `_NOT_SEPARATED`），且在写任何文件之前拒绝。
- 配置不含 `schema`、`node_uid` 或任何凭据；`node_uid` 只住在 `%h/.config/ghostfleet/node.json`（`0600`）。courier 写完后必须能被 `python3 -I <payload> check-config --config <file>` 接受，这条交叉契约由 bootstrap 测试回放真实字节保证。

## 5. 协议 v0（`ghostfleet-node-agent/v0`）

### 5.1 认证

- 节点 token 在 `completeEnrollmentTicket` 成功时铸造（32 字节 CSPRNG → base64url），`node_credential: {token, node_uid, handoff_id}` **可从同一 resume capability 重取，直到节点首次认证成功**：控制面同时保存 `sha256(token)`（认证用）与 `AEAD(token)`（重投递用）。密钥由 `HKDF-SHA256(ikm=GHOSTFLEET_OPERATOR_TOKEN, info="ghostfleet/node-credential-handoff/v1")` 派生，AAD 绑定 `{node_uid, ticket_id, handoff_id}`；加密副本在**节点首次通过认证的请求**到达后立即销毁（不依赖 courier 回执），并另有 24 h / 20 次重投递上限。过期后 `complete` 返回 `credential_handoff: "EXPIRED"` 且不含 token——补救是退役节点重新签票，不放宽窗口。courier 用 `tmp`+`fsync`+`rename` 原子写入 control account 的 `~/.config/ghostfleet/node-token`（`0600`，目录 `0700`），token 不进日志/argv/状态行。
- 每个 agent 请求带：`Authorization: Bearer <token>`、`x-ghostfleet-node-uid: <node_uid>`、`x-ghostfleet-agent-version: <semver>`。
- 请求体（canonical JSON）：`schema`、`node_uid`、`nonce`（≥16 字节 base64url）、`sent_at`（RFC 3339 Z）、`boot_id`、`seq`（本次启动内单调递增）。

服务端校验顺序（全部失败即拒，且**在触碰任何状态之前**）：

1. body 大小上限（heartbeat ≤16 KiB、poll ≤4 KiB、result ≤64 KiB）→ `413`
2. `content-type: application/json` → `415`
3. token 摘要比对（常量时间）+ `node_uid` 与记录一致 → `401 NODE_AUTH_INVALID` / `403 NODE_SCOPE_MISMATCH`
4. 节点生命周期 ∈ {PROVISIONAL, ACTIVE} → `403 NODE_NOT_ADMITTED`
5. `sent_at` 偏差 ≤300 s → `401 NODE_CLOCK_SKEW`
6. 重放：同 `node_uid` 的 `nonce` 在 600 s 窗口内已出现 → `409 NODE_NONCE_REPLAY`（每节点环形保存，上限 256 条）
7. 速率：每节点 token bucket——容量 24、补充 1 token / 10 s（≈360 请求/小时），`heartbeat`/`poll`/`result` 各计 1 → 超限 `429 NODE_RATE_LIMITED` 并带 `Retry-After`。节点周期下限 30 s ⇒ 基线 2 请求/30 s = 240/小时，另留 120/小时给结果与重试（ADR 修订前的「≤120/小时」与 30 s 心跳自相矛盾，此条取代之）。
8. 序号：同 `boot_id` 内 `seq` 必须严格递增（允许乱序 ≤64）；`boot_id` 单调，旧 `boot_id` 重现 → `409 NODE_BOOT_REPLAY`；同 `boot_id` 内 `seq` 回退或跳跃 >64 → `409 NODE_SEQ_REGRESSION`。`(boot_id, seq)` 是唯一性单位，进程重启后新 `boot_id` + `seq` 从 0 开始。

### 5.2 端点（挂在现有 `/v0` 路由表内，介于 `GET /v0/nodes` 与 `POST /v0/enrollment-attempts/{id}/{action}` 之间）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| POST | `/v0/nodes/{node_uid}/heartbeat` | 上报健康与观测摘要；响应回传 `interval_s`（钳制 15–300）与最多 2 个任务信封 |
| POST | `/v0/nodes/{node_uid}/tasks/poll` | 取任务（≤4 个/次），带 300 s 租约 |
| POST | `/v0/nodes/{node_uid}/tasks/{task_id}/result` | 回传结果；同 `task_id` 同摘要→幂等 200，不同摘要→`409 TASK_RESULT_CONFLICT` |

任务信封 `ghostfleet-node-task/v0`：`task_id`、`node_uid`、`operation`、`params`（只允许标量/列表，深度 ≤3，总长 ≤4 KiB）、`issued_at`、`expires_at`（≤ `issued_at`+600 s）、`lease_expires_at`（服务端按 300 s 租约计算）、`attempt`（1–3）。

### 5.4 公网入口（严格桥，不是通用代理）

控制面的 `/v0/*` 整体在 Cloudflare Access 之后（`authorizeApi()`），节点 token 无法也**不得**从公网打管理面。节点面新增一个独立的严格桥 Worker（`workers/node/`，产物名 `ghostfleet-node-plane`，挂在部署方自己的 zone，`workers_dev=false`、`preview_urls=false`、不新增任何 Access Bypass）：

- 只接受三条精确 POST 路径（`/v0/nodes/{node_uid}/heartbeat`、`/v0/nodes/{node_uid}/tasks/poll`、`/v0/nodes/{node_uid}/tasks/{task_id}/result`，参数用严格字符类），其余一律 `404`；不代理任何其他 `/v0/*`、`/mcp`、`/v1/*`。
- 转发 header 正向 allowlist：`authorization`、`content-type`、`x-ghostfleet-node-uid`、`x-ghostfleet-agent-version`；其余丢弃，不转发客户端 IP/UA。响应只回 `content-type`、`retry-after` 与固定安全头。
- 桥在触碰 Service Binding **之前**做 body 上限（heartbeat ≤16 KiB、poll ≤4 KiB、result ≤64 KiB → `413`）与 `content-type` 校验（`415`）；限流 binding 仅作咨询性防滥用（缺失/抛错 fail open，显式 `success:false` → `429`），限流成功**不是**授权。
- 通过 Service Binding `GHOSTFLEET_CONTROL_PLANE` 调用控制面；binding 缺失 → `503 NODE_PLANE_NOT_CONFIGURED`，绝不回退公网 URL。
- 控制面二次校验不变：token 摘要、`node_uid`、生命周期、时钟、nonce、序号、速率全部在状态变更前完成。

### 5.3 v0 词汇表（只读）

| operation | 语义 | 约束 |
| --- | --- | --- |
| `node.observe` | 采集 `want` 指定的本地事实 | `want` ∈ {identity, os, uptime, disk, services, capability} |
| `service.status.read` | 读指定 user unit 的 active 状态 | ≤8 个 unit，名必须匹配 `^[a-z][a-z0-9_.@-]{0,63}\.service$`；无 shell，`subprocess` 数组传参 |
| `capability.inspect` | 读本地 capability state 摘要 | 只回 digest 与组件状态，不回文件内容 |
| `agent.self.test` | 端到端自检 | 回显 `nonce` 与 agent 版本 |

其余 operation → `400 TASK_OPERATION_FORBIDDEN`。`params` 中出现禁用键（`command`/`cmd`/`script`/`shell`/`args`/`argv`/`exec`/`run`/`url` 等）→ `400 TASK_PARAMS_FORBIDDEN`。

## 6. 持续工作循环

单次迭代（默认 30 s，抖动 ±10%，随控制面 `interval_s` 调整）：

1. **observe**：采集有界事实（CPU 负载、内存、磁盘使用率、uptime、允许的 user unit 状态、capability state 摘要、agent 版本）。
2. **converge-report**：与上次成功上报的观测比对，产 `drift` 列表（例如 unit 从 active→failed、capability 摘要变化、磁盘越线）。**只报告，不擅自修改**：v0 的收敛动作就是把事实与差异讲清楚，变更仍由授权路径驱动。
3. **heartbeat**：上报 `health`（`OK`/`DEGRADED`/`FAILING`）、`drift`、`agent_version`、`capability_digest`、`queue_depth`；读取 `interval_s`。
4. **poll + execute**：逐个任务走 §7 的栅栏与 allowlist 分派，结果入 outbox。
5. **flush**：按 `task_id` 幂等回传 outbox；失败按指数退避（1 s → 2 s → 4 s … 封顶 300 s，带抖动）重试。`429` 遵守 `Retry-After`，`401/403` 停止上报并进入 FATAL 等待人类修复，`409` 按码分派（`NODE_NONCE_REPLAY`/`NODE_SEQ_REGRESSION` 立即换新 `seq`/`nonce` 重试一次，`NODE_BOOT_REPLAY` 换新 `boot_id`），5xx 与网络错误只重试不当成功。控制面不可达时保持循环、不退出、不丢已执行事实。

这条循环满足"Agent 真正承担持续管理工作"：它持续采集、比对漂移、上报健康并执行控制面下发的有界管理工作；心跳只是循环的一个阶段，不是全部。

## 7. 耐用状态与崩溃语义

任务执行前：`ledger[task_id] = {state: MAY_HAVE_EXECUTED, operation, started_at}` → `fsync` 目录项 → 才调用实现函数。完成后写 `{state: SUCCEEDED|FAILED, finished_at, result_digest}`。启动时扫描 ledger：任何 `MAY_HAVE_EXECUTED` 且无终态的任务，先补写一条 `UNKNOWN` 结果进 outbox（只报事实，不重跑），再标 `RECONCILED`。

写盘一律 `tmp + os.replace` 并 `fsync` 文件与目录，避免半写状态。outbox 上限 64 条：溢出时保留最新 64 条并把被丢弃条目的 `task_id` 记入 ledger 的 `RESULT_DROPPED`（这是事实记录，不是静默丢弃）。

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
ConfigurationDirectory=ghostfleet
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
- **故障恢复**：`Restart=on-failure` + `RestartSec=5`（正常 `SIGTERM` 退出 0 不重启，异常退出/信号/看门狗超时才重启，语义边界明确）；`WatchdogSec=60` 由 Agent 每次循环 `sd_notify(WATCHDOG=1)` 喂狗，卡死则被杀重启。
- **配置有效性必测**：unit 必须通过 `systemd-analyze --user verify`；`ProtectHome=read-only` 是合法取值（`read-write` 不是，旧稿已修），真实读写目录只经 `ReadWritePaths` 精确开放。
- **目录必须先存在**（实测教训）：`ReadWritePaths` 指向不存在的目录会让服务在挂载命名空间阶段直接失败（`status=226/NAMESPACE`，且 `Restart=on-failure` 会无限重试）。因此 unit 用 `StateDirectory=ghostfleet-agent` + `ConfigurationDirectory=ghostfleet` 让 systemd 创建这两个目录（`verify` 与启动均通过），courier 安装时也要创建并把 `~/.config/ghostfleet` 收紧到 `0700`——两条路径互为自愈。
- **安全停止**：`SIGTERM` → 停止取新任务、flush outbox（有界超时 10 s）、写 `last_stop` 事实、退出 0。
- **健康可见性**：`systemctl --user show` 的 `ActiveState`/`NRestarts`/`ExecMainStatus` 外加 Agent 自报的 `health`，构成独立消费者可观察的外部证据。

## 9. 安全边界与威胁模型

| 攻击面 | 缓解 |
| --- | --- |
| 控制面被冒充 / 中间人 | 仅 HTTPS；控制面 URL 来自 root-owned 配置，不由任务下发；凭据不明文落日志 |
| 节点 token 泄漏 | `0600` 单账户可读；服务端只存摘要（AEAD 副本仅在首次认证前存在，首次认证即销毁）；绑定 `node_uid`；支持轮换（`POST /v0/node-credential/rotate`，旧 token 立即失效）与吊销（`revoked` → Agent 清凭据并停止上报） |
| 重放已抓取请求 | 600 s `nonce` 窗口 + `sent_at` 偏差限制 |
| 恶意任务（提权/命令注入） | 双端 allowlist、无 shell、数组传参、禁用键递归检查、参数长度与深度上限 |
| 崩溃后重复执行 | `MAY_HAVE_EXECUTED` 栅栏 + 服务端按 `task_id` 幂等 |
| Agent 越权 | 无 sudo、无特权组、无 Helper 访问；`NoNewPrivileges`、`ProtectSystem=strict`（`/var/lib/fleet`、`/etc/sudoers.d` 均不可写） |
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
5. unit 文本必须通过 `systemd-analyze --user verify`（CI 与 disposable 各一次），并断言不含 `sh -c`/`curl`/`wget`/`/bin/sh`、不写 `%h` 之外路径、不声明 `ProtectHome=read-write` 之类非法取值（`CAPABILITY_USER_UNIT_UNSAFE`）。

## 12. 验收矩阵

| 验收项 | 证明方式 | 类型 |
| --- | --- | --- |
| 生命周期 | disposable Linux 上 `systemctl --user is-active` 持续 `active`，`NRestarts` 稳定，超过一个心跳周期仍有新观测 | 真实 systemd |
| 开机恢复 | `loginctl terminate-user` / 重启 user manager 后服务自动回来，无需人类登录 | 真实 systemd |
| 故障恢复 | `kill -9` 主进程 → `Restart=on-failure` 拉回，`NRestarts` +1，心跳恢复；`SIGTERM` 干净退出 0 且**不**重启 | 真实 systemd |
| 配置有效 | `systemd-analyze --user verify` 通过；保护项与实际读写路径一致（写入被拒的路径确实被拒） | 真实 systemd |
| 持续工作 | 控制面下发 `node.observe`/`service.status.read`，节点返回真实观测，且两次结果随时间变化 | 端到端 |
| 身份安全 | 三账户隔离（Human / ops / managed）；managed 无 sudo、无 ops 组 | 真实 systemd + 断言 |
| 权限安全 | managed 直接调用 Helper → 被 `dedicated_caller_identity` 拒；`sudo -n` 被拒 | 负向证明 |
| 任务安全 | 重放 nonce → 409；重复 result → 幂等；崩溃在 `MAY_HAVE_EXECUTED` → 上报 UNKNOWN 且不重跑；越权 operation → 400 | 确定性测试 + 真机 |
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
