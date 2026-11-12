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
| D1 | 新增常驻进程 **GhostFleet Node Agent**，以非 root 的 control account（如 `ghostfleet-managed`）运行，`Type=notify` + `Restart=always` + `WatchdogSec` + Linger。 |
| D2 | 通信为**拉模型**：节点主动向控制面心跳/取任务/回结果，控制面不主动连节点、不需要入站端口。 |
| D3 | 节点凭证在 `POST /v1/enroll/complete` 时**铸造一次**（32 字节随机 token，服务端只存 `sha256`），节点以 Bearer + `x-ghostfleet-node-uid` 认证；不引入第二套身份体系，复用既有 `node_uid` 与 `EnrollmentAttempt`。 |
| D4 | v0 任务词汇**只含只读、非特权**操作；任何特权或变更型操作在控制面即 `TASK_OPERATION_FORBIDDEN`，在 Agent 侧再拒一次。特权效果继续走 `ghostfleet-ops` + 受限 Helper + JIT 租约，Agent 不持有也不需要该通路。 |
| D5 | 复用 `transport_contract` 的 `MAY_HAVE_EXECUTED` 栅栏语义：Agent 在执行任何任务前先把 `MAY_HAVE_EXECUTED` 落盘并 fsync，重启后对未收敛项上报 `UNKNOWN` 而不重跑。 |
| D6 | Agent 载荷随 bootstrap 一起以 root-owned 文件安装到 `/usr/local/libexec/ghostfleet/node-agent/`，**不新增特权 installer 的 artifact 种类**；user unit 作为新的 capability artifact 被 pin，发布选择置 `user_service_required=true`。 |
| D7 | 不允许任意远程 Shell：协议里没有 shell/argv/script 字段，Agent 只按 allowlist 分派本地实现函数；带禁用键或未知 operation 的任务一律拒绝并留下本地审计记录。 |
| D8 | 离线安全：所有出站请求可安全重试（结果按 `task_id` 幂等），本地队列有容量上限与丢弃策略，丢包不改变已执行事实。 |

## 3. 非目标

- 不做节点侧特权执行、不做 sudo 包装、不做 Helper 的替代或代理。
- 不做任意命令/脚本执行（含"只读的 shell"）。
- 不在 v0 做节点密钥对、mTLS、双向证书或 token 轮换接口（见 §14）。
- 不改动 `REQ-01`~REQ-04 的定义，也不在证据齐备前把 `REQ-01` 从 `NOT_PROVEN` 提升。
- 不做 Windows/Android agent，不改动已有 Console/面板语义。

## 4. 运行架构

```
systemd --user (control account, Linger=yes)
└─ ghostfleet-managed.service  (Type=notify, Restart=always, WatchdogSec=120)
   └─ /usr/bin/python3 -I -m ghostfleet_agent        # 非 root，无 sudo，无特权组
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
| `/etc/ghostfleet/node-agent.json` | `root:root` `0644` | 非秘密配置：控制面 URL、心跳区间上下限、允许观测的 unit 名列表 |
| `%h/.config/ghostfleet/node-token` | `0600`（账户自身） | 注册时铸造的节点 token，仅本账户可读 |
| `%h/.config/ghostfleet/node.json` | `0600` | `node_uid`、平台、注册时间（非秘密但按最小暴露存放） |
| `%h/.local/state/ghostfleet-agent/state.json` | `0600` | 游标、序列号、退避状态、上次成功时间 |
| `%h/.local/state/ghostfleet-agent/ledger.json` | `0600` | 任务派发栅栏与结果摘要（跨重启存活） |
| `%h/.local/state/ghostfleet-agent/outbox.json` | `0600` | 待回传结果，上限 64 条 |

日志边界：只写 stdout（journald 捕获），结构化 JSON 行，字段白名单；**永不**写入 token、`resume_session`、短码、完整控制面响应体或任何私有部署事实。日志速率由循环周期天然限制，错误路径按退避降频。

## 5. 协议 v0（`ghostfleet-node-agent/v0`）

### 5.1 认证

- 节点 token 在 `completeEnrollmentTicket` 成功时铸造并以 `node_credential: {token, node_uid}` **只返回一次**；控制面只存 `sha256(token)` 于 node 记录，与 `node_uid` 绑定。courier 随即把它写成 control account 的 `~/.config/ghostfleet/node-token`（`0600`，目录 `0700`），token 不进日志/argv/状态行。
- 每个 agent 请求带：`Authorization: Bearer <token>`、`x-ghostfleet-node-uid: <node_uid>`、`x-ghostfleet-agent-version: <semver>`。
- 请求体（canonical JSON）：`schema`、`node_uid`、`nonce`（≥16 字节 base64url）、`sent_at`（RFC 3339 Z）、`boot_id`、`seq`（本次启动内单调递增）。

服务端校验顺序（全部失败即拒，且**在触碰任何状态之前**）：

1. body 大小上限（heartbeat ≤16 KiB、poll ≤4 KiB、result ≤64 KiB）→ `413`
2. `content-type: application/json` → `415`
3. token 摘要比对（常量时间）+ `node_uid` 与记录一致 → `401 NODE_AUTH_INVALID` / `403 NODE_SCOPE_MISMATCH`
4. 节点生命周期 ∈ {PROVISIONAL, ACTIVE} → `403 NODE_NOT_ADMITTED`
5. `sent_at` 偏差 ≤300 s → `401 NODE_CLOCK_SKEW`
6. 重放：同 `node_uid` 的 `nonce` 在 600 s 窗口内已出现 → `409 NODE_NONCE_REPLAY`（每节点环形保存，上限 256 条）
7. 速率：每节点 ≤120 请求/小时 → `429 NODE_RATE_LIMITED`

### 5.2 端点（挂在现有 `/v0` 路由表内，介于 `GET /v0/nodes` 与 `POST /v0/enrollment-attempts/{id}/{action}` 之间）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| POST | `/v0/nodes/{node_uid}/heartbeat` | 上报健康与观测摘要；响应回传 `interval_s`（钳制 15–300）与最多 2 个任务信封 |
| POST | `/v0/nodes/{node_uid}/tasks/poll` | 取任务（≤4 个/次），带 300 s 租约 |
| POST | `/v0/nodes/{node_uid}/tasks/{task_id}/result` | 回传结果；同 `task_id` 同摘要→幂等 200，不同摘要→`409 TASK_RESULT_CONFLICT` |

任务信封 `ghostfleet-node-task/v0`：`task_id`、`node_uid`、`operation`、`params`（只允许标量/列表，深度 ≤3，总长 ≤4 KiB）、`issued_at`、`expires_at`（≤ `issued_at`+600 s）、`attempt`（1–3）。

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
5. **flush**：按 `task_id` 幂等回传 outbox；失败按指数退避（1 s → 2 s → 4 s … 封顶 300 s，带抖动）重试，控制面不可达时保持循环、不退出、不丢已执行事实。

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
ExecStart=/usr/bin/python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=always
RestartSec=5
WatchdogSec=120
NotifyAccess=main
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-write
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=256M
TasksMax=64

[Install]
WantedBy=default.target
```

- **开机恢复**：`loginctl enable-linger <control_account>`（已在 #79 账户隔离里实现）+ `WantedBy=default.target` → 无人类登录也自动拉起。
- **故障恢复**：`Restart=always` + `RestartSec=5`；`WatchdogSec=120` 由 Agent 每轮 `sd_notify(WATCHDOG=1)` 喂狗，卡死则被 systemd 杀掉重启。
- **安全停止**：`SIGTERM` → 停止取新任务、flush outbox（有界超时 10 s）、写 `last_stop` 事实、退出 0。
- **健康可见性**：`systemctl --user show` 的 `ActiveState`/`NRestarts`/`ExecMainStatus` 外加 Agent 自报的 `health`，构成独立消费者可观察的外部证据。

## 9. 安全边界与威胁模型

| 攻击面 | 缓解 |
| --- | --- |
| 控制面被冒充 / 中间人 | 仅 HTTPS；控制面 URL 来自 root-owned 配置，不由任务下发；凭据不明文落日志 |
| 节点 token 泄漏 | `0600` 单账户可读；只存摘要于服务端；绑定 `node_uid`；可被控制面吊销（`revoked` 字段 → Agent 清凭据并停止上报） |
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

1. **Agent 载荷**随 bootstrap 内嵌、由 root 写入 `/usr/local/libexec/ghostfleet/node-agent/`（`root:root`、`0755`），因此它天然被已 pin 的 `bootstrap_sha256` 覆盖，**不需要**给特权 installer 增加新的 artifact 种类。
2. **user unit** 作为新的 capability artifact（`user_unit`）被 pin，安装路径为 control account 的 `~/.config/systemd/user/<name>.service`（#79 已有安装分支），随后 `systemctl --user enable --now` + `loginctl enable-linger`。
3. 发布选择必须显式设置 `user_service_required=true`，并让 `capability.js` 与 `bootstrap.js` 的推导不再"没 unit 就当不需要"——改为：选择声明 `managed` 角色时缺 unit 制品即 `fail closed`。
4. 单元字节、ExecStart 路径与安装目录必须三方一致（unit 里的 `PYTHONPATH`/`ExecStart` 指向 bootstrap 安装路径），由确定性测试断言。

## 12. 验收矩阵

| 验收项 | 证明方式 | 类型 |
| --- | --- | --- |
| 生命周期 | disposable Linux 上 `systemctl --user is-active` 持续 `active`，`NRestarts` 稳定，超过一个心跳周期仍有新观测 | 真实 systemd |
| 开机恢复 | `loginctl terminate-user` / 重启 user manager 后服务自动回来，无需人类登录 | 真实 systemd |
| 故障恢复 | `kill -9` 主进程 → `Restart=always` 拉回，`NRestarts` +1，心跳恢复 | 真实 systemd |
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
4. ai-hub `#375`/`#298` 重新 pin 新 main、重新 vendor、重新验收。
5. 重新生成绑定新 SHA 的 Human 授权页；绑定 `0cbb9c1` 的旧页对新版本无效。

## 14. 风险与未决（非阻塞）

- 单 `Durable Object` blob 写入在心跳频繁时成本偏高；v0 用心跳区间下限 15 s + 只写增量字段缓解，v1 再考虑拆分存储。
- token 无轮换接口：v0 依赖控制面吊销 + 重新注册；v1 加轮换与节点密钥对（届时可复用 `PRIVILEGE_LEASE_VALIDATOR_V0` 的签名风格）。
- 控制面 ↔ 节点的时间同步仅靠 ±300 s 窗口；真机上需要 chrony/systemd-timesyncd 在位（disposable 验收会断言）。
- 日志目前只进 journald，不集中上传；跨节点日志聚合留给后续版本。
