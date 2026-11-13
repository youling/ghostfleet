# ghostfleet-node-agent

> SQLite v1：任务执行栅栏、结果正文、投递状态统一写入 `tasks.db`；旧 JSON 任务账本和自动丢弃已取消，`state.json` 只记录观测统计。旧状态必须离线验证、显式导入并保留原件。参见 [SQLite 合同](../../docs/architecture/NODE_AGENT_SQLITE.md)。

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
| 运行期状态 fail-closed | state 目录必须属当前用户且权限 0700；`state.json`、`tasks.db`、`tasks.db.lock` 属主为当前用户且权限 0600。SQLite schema、完整性和进程独占锁异常时停止执行。 |

## 文件布局（与 ADR §4 一致）

| 路径 | 权限 | 内容 |
| --- | --- | --- |
| `/usr/local/libexec/ghostfleet/node-agent.pyz` | root:root 0755 | 载荷（确定性 zipapp，见下） |
| `/etc/ghostfleet/node-agent.json` | root:root 0644 | 非秘密配置：控制面 origin、心跳上下限、任务白名单 |
| `/etc/ghostfleet/capability-status.json` | root:root 0644 | 公开能力投影（bootstrap 原子写入）：schema、selection 摘要、artifact/user_unit 名+sha256、payload sha256、账户与 release pin；不含 token/私有路径 |
| `~/.config/ghostfleet/node-token` | 0600 | 节点 bearer token 原文（单行） |
| `~/.config/ghostfleet/node.json` | 0600 | `node_uid` / `platform` / `issued_at`（不含 origin） |
| `~/.local/state/ghostfleet-agent/` | 0700 | `state.json`（观测统计）、`tasks.db`（任务唯一真值）、`tasks.db.lock`（进程锁），文件均 0600 |

控制面 origin 只能由 root-owned 配置给出，普通用户无法把 Agent 指向攻击者端点。
运行期状态文件同样按 fail-closed 校验：`ensure_state_dir` 要求目录属主 `== os.geteuid()` 且 mode `0700`，
状态文件和数据库读写前要求属主 `== os.geteuid()` 且 mode `0600`；目录过宽时先记一次 `state_dir_permissions_loose`
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
{"ok":true,"command":"status","agent_version":"0.1.0.dev0","node_uid":"node-...","state_dir":"%h/.local/state/ghostfleet-agent","initialised":true,"boot_id":"...","seq":42,"last_start":"...","last_stop":null,"last_heartbeat_at":"...","last_health":"OK","stopping":false,"consecutive_failures":0,"polls":42,"tasks_executed":3,"outbox_overflow":0,"outbox_depth":0,"ledger_entries":3,"task_store":"sqlite/v1","task_counts":{"ACKED":3},"quarantined":[]}
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

- 任务唯一权威状态是本地 SQLite `tasks.db`，不再存在独立 JSON ledger/outbox/tombstones 或自动丢弃、驱逐流程。详见 [SQLite 持久化合同](../../docs/architecture/NODE_AGENT_SQLITE.md)。
- **执行前**：`BEGIN IMMEDIATE` 在一个事务里提交 `MAY_HAVE_EXECUTED` 栅栏；COMMIT 成功后才调用本地实现。
- **执行后**：同一事务一次写入执行终态、原始规范化结果正文、唯一摘要与 `PENDING`。网络请求绝不在事务中进行。
- **重启**：对只有栅栏、没有结果的任务生成一条 `UNKNOWN` + `PENDING`，不再执行；已有 PENDING 正文/摘要保持不变并重发。
- **ACK**：仅在服务端明确接受后才把记录改成 `ACKED` 并删除正文，保留 task_id/operation/digest 防重放。响应丢失时重发同一正文和摘要。
- **隔离**：不可信结果、永久拒收或 node_uid 更换均标记 `QUARANTINED`，完整保留原正文、摘要和节点身份；不发送、不删除、不自动改摘要。
- **背压**：同时未完成的栅栏/PENDING 默认上限 64，达到后暂停领取新任务，继续心跳与回传旧结果；绝不驱逐未发结果。数据库真实大小上限默认 64 MiB，空间不足会 fail closed。
- **存储恢复**：本地文件系统、`journal_mode=DELETE`、`synchronous=EXTRA`、排它进程锁。无法确认 COMMIT 结果时立即停止并重启重读数据库；旧 JSON 须停机后显式离线导入，原件及哈希清单保留。
- **停机**：SIGTERM 后停止新任务与新轮询；有界 flush 只尝试已完成结果，未发正文下次继续发送。发送预算计入本地构包、网络和重试。

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
pending 可见）；`tests/test_sqlite_loop.py` 的 `test_stop_before_flush_leaves_body_and_sends_nothing`、
`test_sqlite_stop_after_first_send_preserves_second_result`、`test_sqlite_expired_deadline_does_not_start_delivery`；
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
  （同一批里尚未开始的 task 不进入 SQLite 执行栅栏，控制面可安全重投）、停喂狗线程、发 `STOPPING=1`、执行 ≤8 s 有界 flush、
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
