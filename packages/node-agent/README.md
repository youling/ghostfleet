# ghostfleet-node-agent

> SQLite candidate / SQLite 实现候选：the production CLI now uses tasks.db; JSON task backends and automatic result dropping are removed. Historical JSON storage notes below are superseded by [the SQLite ADR](../../docs/architecture/NODE_AGENT_SQLITE.md). state.json remains metrics only. 旧 JSON 文件须显式离线迁移，不能自动清空。

GhostFleet 节点侧常驻运行时（ADR: `docs/architecture/NODE_AGENT_V0.md`）。这是一个
**只出站、只读、无 shell** 的最小 Agent：拉取任务、在本地白名单内执行、把结果回传。

English summary:
A minimal, outbound-only GhostFleet node runtime. It polls a control plane with a bearer
token, executes a fixed allowlist of read-only operations, and reports results through a
bounded, crash-safe outbox. No inbound port, no shell, no sudo, no privileged syscalls.
The package is stdlib-only and ships as a deterministic zipapp for `python3 -I`.

## 安全边界

| 边界 | 说明 |
| --- | --- |
| 无入站端口 | Agent 只发起到控制面的 HTTPS 请求，不监听任何 socket（sd_notify 是 Unix 数据报客户端） |
| 无 shell / 无任意命令 | 只按 operation 名分派到固定实现；参数里出现 `command`/`shell`/`args` 等 21 个禁用键直接拒绝 |
| 无 sudo / 无特权通路 | 以普通用户运行；不写系统路径、不改 systemd unit、不读 secret 文件（token 归属当前用户） |
| 只读词汇 | v0 只实现 `node.observe`、`service.status.read`、`capability.inspect`、`agent.self.test` |
| 失败关闭 | 配置/凭据/状态任一不符合契约即拒绝启动或停止上报；未知输入一律拒绝，不猜 |
| 启动信任闸门 | `run` 前校验 token 为常规文件、属主本人、mode 0600；默认配置必须 host root 拥有（user namespace 内按只读挂载判据）且 0644；不符退出 3 且不联网 |
| 公开投影 | `capability.inspect` 只读 `/etc/ghostfleet/capability-status.json` 的白名单字段，属主判据与配置相同，绝不读 root-only 私有 state |
| 凭据不落日志 | 日志与结构化事件只写固定字段，token/nonce/完整 params 绝不出现在 stdout |
| 运行期状态 fail-closed | state 目录必须 0700 且属主为当前用户，`state.json`/`ledger.json`/`outbox.json` 必须 0600 且属主为当前用户；不符拒绝启动/写入（`STATE_DIR_UNTRUSTED`） |

## 文件布局（与 ADR §4 一致）

| 路径 | 权限 | 内容 |
| --- | --- | --- |
| `/usr/local/libexec/ghostfleet/node-agent.pyz` | root:root 0755 | 载荷（确定性 zipapp，见下） |
| `/etc/ghostfleet/node-agent.json` | root:root 0644 | 非秘密配置：控制面 origin、心跳上下限、任务白名单 |
| `/etc/ghostfleet/capability-status.json` | root:root 0644 | 公开能力投影（bootstrap 原子写入）：schema、selection 摘要、artifact/user_unit 名+sha256、payload sha256、账户与 release pin；不含 token/私有路径 |
| `~/.config/ghostfleet/node-token` | 0600 | 节点 bearer token 原文（单行） |
| `~/.config/ghostfleet/node.json` | 0600 | `node_uid` / `platform` / `issued_at`（不含 origin） |
| `~/.local/state/ghostfleet-agent/` | 0700 | `state.json` / `ledger.json` / `outbox.json`（均 0600） |

控制面 origin 只能由 root-owned 配置给出，普通用户无法把 Agent 指向攻击者端点。
运行期状态文件同样按 fail-closed 校验：`ensure_state_dir` 要求目录属主 `== os.geteuid()` 且 mode `0700`，
三个状态文件读/写前要求属主 `== os.geteuid()` 且 mode `0600`；目录过宽时先记一次 `state_dir_permissions_loose`
告警再以 `StateWriteError` 拒绝（不静默放宽）。

启动信任闸门（任一不符即退出码 3，只报稳定错误码，不打印文件内容）：

- token：`os.lstat` 必须是常规文件（拒绝符号链接）、属主 `uid == os.geteuid()`、mode 恰好 `0600`；失败码 `AGENT_CREDENTIAL_PERMISSIVE`。
- 配置：默认路径 `/etc/ghostfleet/node-agent.json` 必须是常规文件（拒绝符号链接）、mode 恰好 `0644`，并满足下面的 host-root 判据；用 `--config` 覆盖（仅排障/验收）时要求属主是当前用户且组/其他不可写；失败码 `AGENT_CONFIG_UNTRUSTED`。
- `capability-status.json`：读取前校验常规文件、mode 无组/其他写位，属主用同一 host-root 判据；不符返回 `UNKNOWN/CAPABILITY_STATUS_UNTRUSTED`，缺失返回 `UNKNOWN/CAPABILITY_STATUS_UNAVAILABLE`。

### host-root 判据（user namespace aware）

systemd 硬化过的 user unit 里 `PrivateUsers=` 等选项会启用 user namespace：host root 拥有的文件在沙箱内显示为 overflow uid（通常 65534），
单纯的 `st_uid == 0` 会必然失败并让服务无限重启。判据因此做**反查映射**（`src/ghostfleet_agent/trust.py`，Agent 与能力投影共用同一实现）：
把观测到的 `st_uid` 用 `/proc/self/uid_map` 的 `inside outside length` 三元组换回 host uid。

1. **st_uid 被某行覆盖**（`inside <= st_uid < inside + length` 且 `length > 0`）：`host_uid = outside + (st_uid - inside)`，
   可信当且仅当 `host_uid == 0`。
2. **st_uid 未被覆盖**（未映射，典型是 overflow uid）：要求 `st_uid == overflowuid`（读 `/proc/sys/kernel/overflowuid`，读不到用 65534）
   **且**该路径在 `/proc/self/mountinfo` 最长前缀匹配的挂载带 `ro` 选项 **且** `os.access(path, os.W_OK)` 为假。

只看「uid 0 是否出现在 uid_map 里」是不安全的：嵌套命名空间 `0 1002 1`（inside 0 ↔ host 1002）下，托管账户自己拥有的文件
在 ns 内就显示为 uid 0，会被误判成 host root 拥有；反查 host uid 得到 1002 后直接拒绝。

第 2 支不是放宽：只映射自身 UID 的 namespace 里「host root 拥有」与「host 65534 拥有」在 uid 上无法区分，唯一内核级等价不变量是只读挂载；
`RestrictNamespaces=yes` 阻止服务自建可写视图，因此门禁真正保证的是「托管账户改不了这个文件」。
解析失败（`uid_map` 不可读/格式错/数字溢出）一律 fail closed **到第 2 支**；mountinfo 不可读或无匹配挂载则判不可信。
mountinfo 读取上限 1 MiB（真实机器挂载项可能很多），超限按不可信处理。

不可信时的稳定 detail 码：`CONFIG_ROOT_NOT_PROVEN`（uid 不匹配）、`CONFIG_MOUNT_NOT_READONLY`（挂载可写）、`CONFIG_WRITABLE_BY_USER`（当前用户可写）、
`CONFIG_MODE_NOT_0644`；能力投影侧统一收敛为 `CAPABILITY_STATUS_UNTRUSTED`。

## 配置字段

`/etc/ghostfleet/node-agent.json`（严格 JSON，未知键即拒绝）：

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `control_plane_origin` | 是 | — | `https://` + `host[:port]`；loopback 明文 `http` 生产默认拒绝（`CONFIG_LOOPBACK_HTTP_FORBIDDEN`），仅 harness 环境变量 `GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP=1`（或显式 `allow_loopback_http=True`）放行并告警 |
| `heartbeat_interval_s` | 否 | 30 | 心跳/轮询周期，配置值钳制到 [15,300] 秒；客户端实际周期下限 30 秒（服务端下发更小值按 30 采用并记 warning，不 fatal） |
| `heartbeat_interval_min_s` / `heartbeat_interval_max_s` | 否 | 15 / 300 | 进一步收窄服务端下发 interval 的接受区间 |
| `jitter_ratio` | 否 | 0.1 | 抖动比例，钳制到 [0,0.5] |
| `request_timeout_s` | 否 | 10 | 单请求超时，范围 (0,300] |
| `allowed_units` | 否 | `[]` | `service.status.read` 白名单，最多 16 个，形如 `nginx.service` |
| `token_path` | 否 | `~/.config/ghostfleet/node-token` | 必须是绝对路径 |
| `node_meta_path` | 否 | `~/.config/ghostfleet/node.json` | 必须是绝对路径 |
| `state_dir` | 否 | `~/.local/state/ghostfleet-agent` | 必须是绝对路径 |
| `agent_version` | 否 | 包版本 | 上报到控制面的版本标识 |

兼容别名：`control_plane_url` 与 `control_plane_origin` 二选一（同时出现即拒绝）；
`interval_s` 是 `heartbeat_interval_s` 的旧别名。

## 构建与运行

```bash
# 确定性构建（固定条目顺序/时间戳/权限，字节可复现）
python3 packages/node-agent/tools/build_pyz.py --out packages/node-agent/dist/node-agent.pyz

# 校验配置、凭据与启动信任闸门（不联网、不写盘；闸门失败退出 3）
python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz check-config

# 常驻运行（systemd Type=notify 下由 unit 调用；前台运行也可直接调试）
python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz run

# 读取本地状态的机器可读摘要（不联网）
python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz status --json
```

`run` 是默认子命令，也兼容 `--config PATH`、`--once`、`--version` 旧参数。
`-I` 隔离模式不读 `PYTHON*` 环境变量、不把 cwd 加入 `sys.path`，因此不得依赖 cwd
或环境变量来定位包内模块；zipapp 承载 `ghostfleet_agent` 包并直接执行 `run`。

`status --json` 示例（只读本地状态，单行 JSON）：

```json
{"ok":true,"command":"status","agent_version":"0.1.0.dev0","node_uid":"node-...","state_dir":"%h/.local/state/ghostfleet-agent","initialised":true,"boot_id":"...","seq":42,"last_start":"...","last_stop":null,"last_heartbeat_at":"...","last_health":"OK","stopping":false,"consecutive_failures":0,"polls":42,"tasks_executed":3,"outbox_overflow":0,"outbox_depth":0,"ledger_entries":3}
```

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（`--once` 一轮成功；SIGTERM/SIGINT 干净退出，不触发 systemd 重启） |
| 2 | 配置非法（JSON/字段/URL/白名单等不符合契约） |
| 3 | 凭据或配置不可用（文件缺失、不可读、token/node_uid 非法、权限/属主/符号链接不符合信任闸门）；此时绝不联网 |
| 4 | 认证/授权 FATAL（401/403），停止上报等待人类修复 |
| 5 | 可重试的运行期失败（5xx/网络/状态损坏等）；按退避重试 |

## 协议要点

请求头：`Authorization: Bearer <token>`、`x-ghostfleet-node-uid`、
`x-ghostfleet-agent-version`。请求体信封：
`schema` / `node_uid` / `nonce`（每请求新生成，base64url ≥16 字节）/ `sent_at`（RFC3339 Z）/
`boot_id`（每次进程启动新 UUID，随启动轮换）/ `seq`（同一 boot_id 内严格递增，重启归零）。

端点：`POST /v0/nodes/{node_uid}/heartbeat`、`POST /v0/nodes/{node_uid}/tasks/poll`、
`POST /v0/nodes/{node_uid}/tasks/{task_id}/result`。

错误分派：401/403 → FATAL（停止上报，等人工修复）；409 按码处理：nonce 重放/seq 回退换新 nonce 与 seq 重试一次、
boot 重放换新 boot_id 重试一次，`NODE_BOOT_ID_CAPACITY_REACHED` 无法自愈故按 FATAL（只能 operator rotate），
结果回传的 `TASK_RESULT_CONFLICT` / `TASK_RESULT_SCHEMA_UNSUPPORTED` / `TASK_RESULT_SCOPE_MISMATCH` / `TASK_OPERATION_MISMATCH`
视为永久拒绝（丢件 + warning，绝不重投）；429 读取并遵守 `Retry-After`，带该头时等待时长以服务端为准
（上限 3600s，超出按 3600 钳制，不被本地 300s 退避封顶截断、也不乘抖动），无该头才用本地指数退避；
5xx 与网络错误只退避重试，绝不当成功。结果回传（outbox flush）的 429 与心跳/轮询同规则：保留 outbox 条目并遵守 Retry-After。

任务信封按 ADR §5.2 接受 `schema` / `task_id` / `node_uid` / `operation` / `params` / `issued_at` / `expires_at` /
`attempt` / `lease_expires_at`：`lease_expires_at`（服务端 300 s 租约）可选，存在时必须是 RFC3339 UTC 字符串，
但 Agent 不拿它做本地过期判断（过期只看 `expires_at`），缺失也照常接受。

任务词汇：`node.observe`（want ⊆ identity/os/uptime/disk/services/capability）、
`service.status.read`（≤8 个 unit，必须在 `allowed_units` 白名单内）、
`capability.inspect`（只回公开投影：整体 sha256、selection 摘要、artifact/user_unit 名+sha256、payload sha256、账户/release pin；不回文件原文，也不读 `/var/lib/fleet/capability-state.json`；投影文件须通过上面的 host-root 判据）、
`agent.self.test`（回显 nonce 与版本）。未知 operation 返回 `TASK_OPERATION_UNKNOWN`。

结果状态（控制面据此决定是否重投）：

| 状态 | 含义 | 可安全重投 |
|---|---|---|
| `SUCCEEDED` | 实现执行成功，`data` 为结果 | 幂等，无需重投 |
| `REFUSED` | **执行前的校验拒绝**（信封/参数/白名单/过期/未知 operation），实现函数从未被调用，**保证无副作用** | 是 |
| `FAILED` | 只读 operation 的实现抛出异常；只读保证无副作用 | 是 |
| `UNKNOWN` | 执行期间异常且该 operation 声明为 `may_mutate`，或崩溃窗口内的栅栏任务；副作用不可判定 | **否** |

只读 / 可变更由 `tasks.py` 的 `OPERATION_SPECS` 逐 operation 显式声明（v0 四个 operation 全为
`read_only`）；将来任何可能改变节点状态的 operation 必须显式声明 `may_mutate`，其执行期异常一律报
`UNKNOWN`，绝不报 `REFUSED`——否则等于告诉控制面"随便重发，不会有副作用"。
`REFUSED` 是「实现从未被调用」的承诺：一旦进入实现函数，Agent 就没有资格替控制面断言零副作用，
因此 `may_mutate` 实现内部抛出的 `TaskRefused` 也按 `UNKNOWN` 处理（v0 四个只读 operation 不受影响）。

## 崩溃安全与幂等

- 执行前先把 `ledger[task_id] = MAY_HAVE_EXECUTED` 落盘（tmp+fsync+rename），然后才调用实现。
- 进程重启后只对栅栏任务上报 `UNKNOWN`，绝不重跑；已有 outbox 结果则按已有结果补账。
- outbox 上限 64 条，溢出时丢最旧并把丢弃记成 `RESULT_DROPPED` 与 `outbox_overflow` 计数；丢弃清单与 items
  **同一次原子写**持久化，重启 load 时重放为 `RESULT_DROPPED`；未发出的结果下次启动优先重发，同 task_id 同 `result_digest` 幂等。
- 所有状态文件写入均为原子替换（文件 fsync → rename → 目录 fsync），损坏或目录 fsync 失败都 fail-closed 而非静默重置。
- ledger 上限 512：只驱逐已收敛的条目——`RESULT_DROPPED` 记录（含 task_id 根本不在账本里的丢弃事件，否则 512 个
  不存在的 task 就能永久耗尽账本）最先，其次是「已对账且 read_only」的终态、以及 dispatch 前就产生的 `REFUSED`
  （实现从未被调用，副作用可证明为零）。`MAY_HAVE_EXECUTED`、待对账条目、`UNKNOWN` 与任何 `may_mutate` 终态
  **永不驱逐**；被驱逐的 task_id 写入独立有界墓碑文件（上限 4096），
  `begin()` 命中墓碑按 `DONE` 处理，绝不因驱逐而重跑。墓碑满或账本达上限且无可驱逐条目时 `begin()` 拒绝、
  停止 poll（heartbeat 继续，health=`DEGRADED`、`health_reason=AGENT_LEDGER_EXHAUSTED`），对账腾出空间后自动恢复取任务。
- `SIGTERM` 收尾的 flush 预算固定 8 秒并计入下面的停机上界；该预算**逐条检查**（每条 result POST 之前算一次剩余预算、单请求超时钳到剩余预算），耗尽即停，未发出的条目留在 outbox 下次启动优先重发。
- 409 冲突（nonce/seq/boot 回放）的自动重试与第一次尝试**共用同一份超时预算**，且预算是 `send()` 入口处的**绝对截止点**：本地构包/序列化（`next_seq` + fsync）、transport 往返、`retry_hook` 的耗时全部从里面扣，每次 POST 之前都按截止点重算剩余超时。重试还要额外满足「剩余 ≥ `MIN_SEND_WINDOW_S` + 上一次的本地构包开销」，否则直接放弃重试、把第一次的 409 交给上层。**第一次尝试同样受一条硬规则约束**：构包与序列化之后剩余 < `MIN_SEND_WINDOW_S` 时一个字节都不发（返回网络错误形态交给退避），绝不靠把超时抬到 0.05 s 地板硬发——否则剩余 0.001 s 也会 POST 0.05 s，凭空多烧掉一个最小发送窗口。**这份预算是「网络 POST 的预算」，不是 `send()` 的墙钟上界**：重试既不会拿到第二份预算，也不会靠本地构包时间吃穿预算（本地耗时先被扣掉），但本地构包/序列化（`next_seq` + fsync）与 `retry_hook` **不可中断**，它们跑起来就无法被预算打断，因此一次 `send()` 的实际墙钟可能超过预算（rev-core 实测预算 1.0 s + 1.2 s 慢构包 → 墙钟 1.2 s、一个 POST 都没发）。回归测试 `test_local_build_cost_is_charged_before_the_first_attempt`、`test_every_attempt_fits_the_remaining_window`、`test_request_is_not_sent_when_the_local_build_consumes_the_budget`。
- 账本终态（result 摘要）没提交成功时，刚入队的结果会被**从 outbox 撤回**，绝不发送；撤回只认**真实返回值**：条目不在队列（`removed=False`）或落盘失败都算撤回失败，一律 fail closed（记 `result_retract_failed` / `result_uncommitted_unsendable`），既不发出去，也绝不把「撤回失败」当成功让 flush 删掉条目——那等于静默丢结果。
- 发送前还有一道**逐字段闸**，拿 outbox body 与账本事实（含墓碑）对账：`body.task_id`、`body.operation`、嵌套的 `result.task_id` / `result.node_uid` / `result.schema` / `result.operation` 分别必须等于任务 id、本节点 uid、`ghostfleet-node-task/v0`、账本 operation；`result.status` 必须是合法状态且等于账本终态；`body.result_digest` 必须等于 `result` 的规范摘要，也必须等于账本已提交的摘要。任一不符就**绝不原样发送**：账本终态是 `UNKNOWN` 时撤回旧 body、按**账本 operation** 重建 `UNKNOWN`（重算摘要并覆盖同一条账本终态；`complete()` 对终态异摘要仍然 fail closed）；其它终态（`SUCCEEDED`/`FAILED`/`REFUSED`）时撤回条目并在账本记 `result_state=RESULT_DROPPED`，日志 `result_body_unverifiable` 给出字段级原因，执行终态与摘要保持原样、同一 task 重投被 `inspect()` 跳过——结局确定、不重试、不自旋。已收敛并被有界驱逐的终态只在墓碑里留下 `result_digest`，墓碑摘要同样算「已提交」——否则账本压满时会把合法待发的结果误撤回，而墓碑只让 `begin()` 返回 `DONE`、不会补发，该 result 就永久丢了（回归测试 `test_evicted_terminal_result_is_still_sendable_via_its_tombstone`）。这样同一 task 只可能有一个会被发出的摘要（重启后是 `UNKNOWN`），不会出现"真实结果 + UNKNOWN"两条摘要被控制面判成 `TASK_RESULT_CONFLICT`。升级路径（账本里已是 `UNKNOWN`、队列里却是旧版本用错 operation 写的 body）的回归测试：`test_legacy_unknown_body_is_rebuilt_with_the_ledger_operation`（只发一条、operation 与摘要都等于账本）、`test_unverifiable_succeeded_body_is_dropped_not_sent`（零 POST、`RESULT_DROPPED`、重投无第二条结果）、`test_failed_retract_is_reported_and_deletes_nothing`（撤回失败 → 拒发、条目仍在、结构化原因）。
- 「dispatch 前就拒绝」的路径同样**先读账本历史再下结论**（`ledger.inspect()`，只读）：`MAY_HAVE_EXECUTED` → 按既有语义对账成 `UNKNOWN`；已有终态或只剩墓碑 → 记 `task_duplicate_skipped` 后跳过；只有完全没见过的 task_id 才写 `REFUSED`。否则同一 task_id 第二次到达（内容被改成未知 operation）会覆盖第一个摘要，甚至把已排队的 `UNKNOWN` 撤回。账本 `complete()` 自身也有 backstop：已有终态但 `result_digest` 不同时直接抛 `LedgerWriteError`（同摘要幂等）。**对账出来的 `UNKNOWN` 绑定账本里 `begin()` 记录的 operation，绝不使用重投 envelope 的 operation**：控制面按 ADR:109 校验 `result.operation` 等于任务 operation，用新 operation 回 `UNKNOWN`（同一 task_id 从 `node.observe` 重投成 `capability.inspect`）会被 409 `TASK_OPERATION_MISMATCH` 永久丢弃，而账本已是终态、下一次重投又被 `inspect()` 跳过——`MAY_HAVE_EXECUTED` 的任务就永远没有可接受的结果。outbox 里已有 body 时用的是与发送闸**同一套逐字段校验**（一条实现、两处调用：`_outbox_body_problems`），与账本不一致就撤回并按账本 operation 重建 `UNKNOWN`（撤不回则 fail closed，发送闸拒发），绝不原样发送。回归测试 `test_known_terminal_task_is_not_refused_again`、`test_known_in_flight_task_is_reconciled_not_refused`、`test_reconciled_unknown_uses_the_operation_recorded_at_fence_time`、`test_queued_result_with_a_foreign_operation_is_rebuilt_not_sent`、`test_tombstoned_task_is_skipped_not_refused`、`test_first_unknown_operation_is_still_refused`、`tests/test_ledger.py::test_complete_rejects_a_second_digest_for_a_terminal_task`。

### 停机预算（`TimeoutStopSec=30` 内，三段相加）

| 段 | 常量 | 上界 | 来源 |
| --- | --- | --- | --- |
| 睡眠打断粒度 | `loop.STOP_SLICE_S` | 1 s | 每 ≤1 s 检查一次 `stop_event` |
| 在途 HTTP 请求 | `config.DEFAULT_REQUEST_TIMEOUT_S` | 10 s | ADR §6 的请求超时；**单个阻塞 HTTP 请求不可中途 abort，只能靠它封顶**（这是从 ADR §6 推导出的既有边界，不是本次放宽） |
| 有界 result flush | `loop.SHUTDOWN_FLUSH_BUDGET_S` | 8 s | ADR §8，`TimeoutStopSec` 的 ≤1/3 |
| 余量 | `loop.SHUTDOWN_RESERVE_S` | 2 s | `STOPPING=1`、last_stop 落盘、进程退出 |
| **合计** | — | **21 s** | **21 ≤ 30，余量 9 s** |

不含余量的「信号 → 退出」基线是 1 + 10 + 8 = **19 s**。

这个上界是**运行时逐请求检查**的结果，不是常量相加的自我声明：`stop_event` 在心跳之前、poll 之前、以及
`outbox.flush()` 的**每一条 send 之前**检查；停机路径只带 deadline（不带 `stop_event`，保证已完成的 result
仍尝试发出），每条 send 的单请求超时被钳到「剩余预算」，`remaining < MIN_SEND_WINDOW_S` 立即停止并保留 pending。
客户端在 `send()` 入口取一次绝对截止点，409 冲突重试只拿「截止点 − 现在」，且要求剩余 ≥ `MIN_SEND_WINDOW_S` +
上一次的本地构包开销，否则**完全不重试**；每次 POST 的超时也被钳到当时的剩余时间，且构包后剩余
不足 `MIN_SEND_WINDOW_S` 时任何一次尝试（含第一次）都不发。

**表中「在途 HTTP 请求 10 s」是网络 POST 的超时上界**（一次 `send()` 内所有 POST，含 409 重试，合计受同一个
截止点约束），不是 `send()` 的墙钟上界：本地构包/序列化（`next_seq` + fsync）与 `retry_hook` **不可中断**，
它们花的时间会从剩余窗口里扣掉、却无法在执行途中被打断。因此最坏墙钟是 1（睡眠）+ 10（POST）+ 该次 send 的
本地构包/`retry_hook` 耗时 + 8（flush）+ 2（余量）；本地耗时由 fsync 主导（毫秒级），由 2 s 余量吸收，
所以 19 s 基线 + 余量仍成立的前提是「单次本地构包/`retry_hook` ≤ 2 s」。
测试：`test_stop_budget_is_a_runtime_deadline_not_a_constant_sum`
（64 条 pending + 假时钟、每条 send 0.2 s，断言 elapsed ≤8 s + 一次 send 颗粒、逐条拿到递减的剩余预算、
pending 可见）；`tests/test_outbox.py` 的 `test_flush_stops_before_any_send_when_stop_event_is_set`、
`test_flush_checks_stop_event_before_every_send`、`test_flush_honours_deadline_and_passes_remaining_budget_as_timeout`；
`test_shutdown_flush_never_doubles_the_retry_budget`（flush 预算 3 s 的对照装置：第一次 409 花 2.8 s → 不重试、
只发 1 次；花 1.5 s → 重试只拿剩余 1.5 s），`tests/test_client.py` 的
`test_conflict_retry_is_skipped_when_the_timeout_budget_is_spent`、
`test_conflict_retry_gets_only_the_remaining_budget`、`test_local_build_cost_is_charged_before_the_first_attempt`、
`test_every_attempt_fits_the_remaining_window`、`test_request_is_not_sent_when_the_local_build_consumes_the_budget`（假 transport + 假时钟，慢 body_builder / 慢 retry_hook，
断言每次尝试的超时都不超过当时剩余窗口、单次 send 总耗时 ≤ 预算）。
静态哨兵不是"总和 ≤30"了事：`test_stop_budget_is_a_runtime_deadline_not_a_constant_sum` 用模块常量逐段断言
（`STOP_SLICE_S ≤ 1`、`DEFAULT_REQUEST_TIMEOUT_S ≤ 10`、`SHUTDOWN_FLUSH_BUDGET_S ≤ 8`、
`SHUTDOWN_RESERVE_S ≥ 2`），并额外断言总和之外仍留出 ≥ `SHUTDOWN_RESERVE_S` 的余量——只把某一段偷偷
改大（例如 `STOP_SLICE_S=9`）也会立刻红，而不是靠总和碰巧还 ≤30 混过去。
注意：生产默认值满足上表；若运维显式把 `request_timeout_s` 调大，必须自行保持三段之和 + 2 s ≤ 30 s。

## 运行行为（真机取证）

以下三个行为由 Ubuntu 24.04 / systemd 255 真机 journal 取证驱动；测试全部为确定性注入，不依赖真实 systemd。

- **离线不会变成重启风暴**：控制面不可达时主循环按 1→2→4…300 s 退避重试；喂狗由常驻 daemon 线程
  按 `WatchdogSec/3 = 20 s` 独立完成，不依赖主线程推进，因此离线退避（每段 < 30 s）或长网络阻塞都不会饿死 watchdog。
  `SIGTERM` 收尾顺序固定为「停喂狗线程 → `STOPPING=1` → 有界 flush → 写 last_stop → 退出」，`STOPPING` 之后不再发 `WATCHDOG`；
  `--once` 不启动该线程，也不发 `WATCHDOG`。线程内任何异常只记一次 `watchdog_thread_failed` warning 后退出线程，绝不影响主循环。
  测试：`tests/test_loop_fake_control_plane.py` 的 `test_watchdog_thread_beats_on_fake_time_axis`、
  `test_offline_backoff_keeps_watchdog_beating`、`test_shutdown_joins_watchdog_before_stopping`、
  `test_watchdog_thread_exception_does_not_kill_the_loop`、`test_run_once_never_starts_the_watchdog_thread`。
- **子进程不继承 systemd 通知变量**：`CommandRunner` 派生 `systemctl`/`loginctl` 等命令行工具时，会从子进程环境中剔除
  `NOTIFY_SOCKET`、`LISTEN_FDS`、`LISTEN_PID`、`WATCHDOG_USEC`、`WATCHDOG_PID`（但保留 `PATH`/`HOME`/`LANG`/`XDG_RUNTIME_DIR`，
  不做 `env -i` 式清空）。否则这些 libsystemd 工具退出时会向 `NOTIFY_SOCKET` 发 `EXIT_STATUS=0`，systemd 每轮记一条
  "Got notification message from PID <child>, but reception only permitted for main PID <main>" 拒绝日志。
  测试：`tests/test_observe.py` 的 `test_child_environment_strips_systemd_notification_keys`、
  `test_command_runner_child_cannot_see_notify_socket`、`test_command_runner_output_is_unchanged_by_environment_stripping`。
- **SIGTERM 能打断睡眠，退出不撞 `TimeoutStopSec`**：主循环所有睡眠（poll 间隔、指数退避、Retry-After）都按
  ≤1 s 的片等待 `stop_event`，因此信号到达后 ≤1 s 脱离睡眠；随后**不再发起任何新请求**（心跳之前、poll 之前、
  每条 result send 之前都查 stop：真机上曾出现 signal 之后又打一条 poll 的缺陷，已由 loop 级测试锁定）、停止取新任务
  （同一批里尚未开始的 task 不进 ledger，控制面可安全重投）、停喂狗线程、发 `STOPPING=1`、执行 ≤8 s 有界 flush、
  写 last_stop、以 0 退出。
  睡眠中的 `SIGTERM` 总时延 ≤1 s（+flush ≤9 s）；计入在途 HTTP 与余量的最坏上界见上一节「停机预算」= 21 s < 30 s。
  **不可中断的边界**（诚实声明）：阻塞中的 HTTP 请求由 `request_timeout_s`（默认 10 s）封顶；正在执行的只读任务在
  操作之间协作取消——剩余 unit 不再读取，结果报 `FAILED` + `AGENT_EXECUTION_INTERRUPTED`（只读、无副作用、可重投），
  单个已在跑的子命令由 `SYSTEMCTL_TIMEOUT_S=5 s` 封顶。
  测试：`tests/test_loop_fake_control_plane.py` 的 `test_sigterm_during_backoff_exits_within_five_seconds`、
  `test_sigterm_during_idle_interval_exits_within_five_seconds`、
  `test_sigterm_during_task_reports_interrupted_failed_and_exits_zero`、
  `test_stop_event_is_checked_before_starting_remaining_batch`、
  `test_sleep_with_jitter_returns_immediately_when_stop_event_is_set`；
  `tests/test_tasks.py` 的 `test_interrupt_before_implementation_is_failed_not_refused`、
  `test_interrupt_between_units_stops_the_rest_of_the_task`、
  `test_interrupt_with_may_mutate_implementation_is_unknown`。
- **state 目录权限告警只打一次，但仍 fail-closed**：state 目录（默认 `~/.local/state/ghostfleet-agent`，期望 `0700`）若对 group/other 开放，
  先记一条 `state_dir_permissions_loose` warning（同一 `path`+`mode` 组合每进程生命周期只记一次），随后**每次**都以
  `StateWriteError` 拒绝（不静默放宽、也不继续运行）。
  告警字段 `writable_by_group`/`writable_by_other` 直接说明是否需要 `chmod 0700`。
  **过宽定义**：`mode & 0o077 != 0`，即除属主之外任何人拥有任何权限；其中 group/other 的写位（`0o022`）风险最高，必须收紧。
  测试：`tests/test_state.py` 的 `test_state_dir_loose_permission_warns_once_then_fails_closed`。

## 结构化事件

常驻运行在 stdout 每轮输出单行 JSON，固定字段
`{"ts":ISO8601,"event":"poll|task_start|task_result|backoff|fatal","seq":N,"detail":...}`。
`detail` 只允许 operation 名、task_id、状态/错误码等白名单字段；token、nonce、完整 params
永不进入日志。

## 测试

```bash
cd packages/node-agent
python3 -m pytest -q
```

测试全部确定性：不访问外网（本地 `http.server` 假控制面绑 127.0.0.1）、无长睡眠、时间可控；
包含 zipapp 冒烟（临时 pyz + `python3 -I` 跑 `check-config`/`status --json`）与
"重新构建字节等于 `dist/node-agent.pyz`"的确定性断言。
