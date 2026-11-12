# ghostfleet-node-agent

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
| `control_plane_origin` | 是 | — | `https://host[:port]`；loopback 明文 `http` 生产默认拒绝（`CONFIG_LOOPBACK_HTTP_FORBIDDEN`），仅 harness 环境变量 `GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP=1`（或显式 `allow_loopback_http=True`）放行并告警 |
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
| 0 | 成功（`--once` 一轮成功；SIGTERM/SIGINT 干净退出） |
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
- ledger 上限 512：只驱逐「已对账且 read_only」的终态（`RESULT_DROPPED` 最先），`MAY_HAVE_EXECUTED`、待对账条目、
  `UNKNOWN` 与任何 `may_mutate` 终态**永不驱逐**；被驱逐的 task_id 写入独立有界墓碑文件（上限 4096），
  `begin()` 命中墓碑按 `DONE` 处理，绝不因驱逐而重跑。墓碑满或账本达上限且无可驱逐条目时 `begin()` 拒绝、
  停止 poll（heartbeat 继续，health=`DEGRADED`、`health_reason=AGENT_LEDGER_EXHAUSTED`），对账腾出空间后自动恢复取任务。
- `SIGTERM` 收尾的 flush 预算固定 10 秒（与 unit 的 `WatchdogSec=60` 一致），超时不再阻塞退出。

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
