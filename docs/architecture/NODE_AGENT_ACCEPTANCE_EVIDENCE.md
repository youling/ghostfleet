## 当前 SQLite 集成候选证据（PR #83 exact HEAD dafee5e，2026-11-13）

**当前被测字节必须以本节为准。** 下方旧 §0–§10 的 WSL Ubuntu/systemd 255 数据属于 SQLite 合入前的历史候选，旧 pyz 为 b2b2acea… / 225,102 B；它不是当前 SQLite 候选的制品证据，不得用于声称当前字节已通过 systemd 255 真机测试。

| 项 | 当前精确值 |
|---|---|
| 集成 PR | https://github.com/youling/ghostfleet/pull/83 |
| 集成 HEAD | dafee5e683b2cffd76a7314f9280b62a71ec8fa1（#84 merge commit） |
| 基线 | 0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1 |
| 完整 CI | https://github.com/youling/ghostfleet/actions/runs/43446581056，6/6 SUCCESS |
| pyz | 216,146 B / SHA-256 3ee59187c94c20072e59335017fd8df0ce0cb610c1502af69915fca5be9ca036 |
| systemd unit | 979 B / SHA-256 e3b06cf3e1d421b4ea356bf619794995a0de906f69607889c62c96576ef0aadf |
| 生命周期 job | https://github.com/youling/ghostfleet/actions/runs/43446581056/job/131957487998 |
| 运行环境 | GitHub-hosted disposable Linux，systemd 259，真实 root/user manager；本地 synthetic control-plane harness |
| 断言 | 86 OK、297 EVIDENCE、0 FAIL |

本轮真实 systemd disposable 证据：
- ghostfleet-managed 独立非 root 账户；无登录会话；Linger=yes。
- 精确 pyz 与 unit 安装；systemd-analyze --user verify exit 0；服务 Type=notify 达到 active/running。
- 删除 state/config 目录后由 systemd 自愈为 0700。
- loginctl terminate-user 销毁 user manager 后，Linger 自动恢复服务，无登录会话；这证明 user-manager 重建，不是物理内核重启。
- kill -9 主进程后 NRestarts 0→1 并恢复；SIGTERM 正常退出 0 且不自动重启。
- 控制面不可达 241 秒期间服务持续 active、watchdog 推进、NRestarts 不变；恢复后心跳恢复。
- 真实只读任务观察 ghostfleet-managed.service 状态；node.observe 两次结果有变化；SQLite crash fence 恢复为 UNKNOWN 且不重执行；结果最终 ACKED。
- managed 账户无 sudo；sandbox 的 PrivateUsers、只读根挂载、配置/凭据权限均有实测断言。

**明确未证明：** 物理主机重启、OMV8 硬件/真实磁盘、生产 Cloudflare/DO、真实 tailnet、凭据轮换、多节点租约竞争、正向完整 capability-status（本 job 只安装 pyz+unit，缺少完整特权制品）。控制面为合成测试服务，不是生产控制面。

本节仅证明该 exact candidate 在 disposable Linux/systemd 259 环境中的生命周期与合成任务工作。它不等于生产部署授权，也不将 REQ-01 提升为已完成。仍需父 PR #83 新 exact-head 独立审查、Human 受保护合并及目标 OMV8 单独验收。

---

# Node Agent 验收证据（REQ-01 / v0）

## 历史候选证据说明

下方原始 WSL systemd 255 记录测量的是 SQLite 合入前的 b2b2acea… / 225,102 B 候选。仅保留作历史比较，不代表当前 SQLite pyz 3ee59187… 已在 systemd 255 上重跑。


## 0. English abstract

Measured evidence for the REQ-01 acceptance rows that must not be faked by a synthetic PASS: the managed node agent runs as a real `Type=notify` systemd user unit, stays `active` through a 100 s+ outage of the control plane with a live watchdog, stops on `SIGTERM` without issuing a single further request while a request is in flight, and is auto-started by `logind` + `Linger` after the distribution instance cold-starts, with no login session present. The host namespace view (`nsenter -U -m --preserve-credentials`) is recorded because mount hardening implicitly enables `PrivateUsers` for per-user instances; `host root` files appear as `overflowuid` there, which is exactly why the ADR requires an inverse `uid_map` lookup instead of trusting `st_uid == 0`. Artifact hashes, restart markers and the reproduction procedure are listed below. Scope limit: this is distro-level cold start on WSL2 (shared kernel, continuous uptime), not a physical power-cycle, and no production node has run it.

Artifacts under test: `packages/node-agent/dist/node-agent.pyz` (sha256 `b2b2acea…`, 225,102 B) and `packages/bootstrap/assets/ghostfleet-managed.service` (sha256 `2b54d05d…`, 948 B).

本文件记录**真实 systemd** 上测到的值，用于 ADR §12 验收矩阵里那些不能由 synthetic PASS 冒充的行。所有主机名/标识都是合成的（`.invalid` 域、示例 node uid），不含任何真实节点、endpoint 或凭据。

测量环境：Windows 11 + WSL2，发行版 Ubuntu-24.04（systemd 255），非特权 managed 账户 + systemd user manager + `enable-linger`。被测制品：

| 制品 | sha256 | 大小 |
| --- | --- | --- |
| `packages/node-agent/dist/node-agent.pyz` | `b2b2acea9d5a99c30f18a2169a8f7709807742ab64c2d8a8f42dd5c95ccc609f` | 225,102 B |
| `packages/bootstrap/assets/ghostfleet-managed.service` | `2b54d05d38c32082e5dbf63035bb03e64da0e7b7332f5504a0e512ba1acd8e58` | 948 B |

## 1. 生命周期与真实进程

`systemctl --user show`（由 unit 的 `MainPID` 读出，不是脚本自报）：

| 阶段 | ActiveState/SubState | MainPID | NRestarts | ActiveEnterTimestamp |
| --- | --- | --- | --- | --- |
| 安装后（控制面不可达） | `active/running` | 720 | 0 | 02:05:31 |
| 100 s 后（仍不可达） | `active/running` | 720 | 0 | 02:05:31 |
| distro 冷启动后（无登录） | `active/running` | 274 | 0 | 02:07:37 |

```
main_pid_comm=python3
main_pid_exe=/usr/bin/python3.12
main_pid_cmdline=/usr/bin/python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz run
main_pid_uid=1003                     # managed 账户的 uid，与本轮 distro 分配一致；换机器会不同
```

服务是常驻 `Type=notify` 进程（发出 `READY=1` 后才算 started），不是 oneshot，也不是空壳心跳：同一 PID 在 100 s 采样间隔后不变，冷启动后由新的 user manager 拉起新的 PID 且 `NRestarts=0`（说明不是崩溃重启兜底，而是 enable+linger 的正常启动）。

## 2. 沙箱内视图（隐式 `PrivateUsers`）

沙箱视图**必须**用 `nsenter -t <MainPID> -U -m --preserve-credentials --` 采集；直接 `stat /proc/<pid>/root/...` 得到的是宿主 UID 视图。

```
sandbox_view=nsenter-preserve-credentials
sandbox_uid_map=      1003       1003          1|
sandbox_root_mount_opts=ro,nosuid,relatime
sandbox_config_stat=65534:65534:644        # host root 的文件在 ns 内是 overflowuid
sandbox_capstatus_stat=65534:65534:644     # 能力投影同理
sandbox_token_stat=1003:1004:600
sandbox_state_dir_stat=1003:1004:700
sandbox_config_dir_stat=1003:1004:700
host_overflowuid=65534
```

即：mount 类硬化在 per-user instance 里隐式启用 `PrivateUsers=`，进程只映射自身 UID，`/` 以 `ro` 挂载。ADR §12 的信任判据（反查 `uid_map`；未映射则要求 overflowuid + 只读挂载 + 不可写）就是为了在这个视图下仍然能信任 `root:root 0644` 的 `/etc` 配置与投影文件。

## 3. 离线稳定（控制面故意不可达）

控制面地址是保留的 `.invalid` 域，DNS 必然失败；两次采样间隔 100 s：

```
phase=before_restart         : active_state=active nrestarts=0 watchdog_timestamp=Fri 2026-11-13 02:05:31 CST
phase=before_restart_stable  : active_state=active nrestarts=0 watchdog_timestamp=Fri 2026-11-13 02:07:11 CST
journal_watchdog_timeouts=0 journal_watchdog_result=0 journal_sigabrt=0
journal_notify_leak=0 journal_config_untrusted=0 journal_credential_permissive=0
journal_state_dir_loose=0 journal_config_dir_warning=0
```

失败重试的退避阶梯实测为 4 s → 8 s → 32 s → 61 s（`backoff_s` 依次 3.788 / 8.781 / 32.255 / 61.023，抖动后封顶 60 s 附近），全程 `active`；`WatchdogTimestamp` 由 20 s 周期的看门狗线程推进（两次采样间前进 100 s，与采样间隔一致），证明喂狗不依赖主循环成功（ADR §6）。journal 中没有 `reception only permitted for main PID`，即子进程没有继承 `NOTIFY_SOCKET`。

## 4. 开机恢复：无登录自动拉起

判定「distro 真的冷启动」用的是 distro 本地事实，而不是内核事实：`/run` 下 tmpfs 标记文件消失（fresh tmpfs）+ PID-1 namespace inode 变化。辅证 `InvocationID`、`MainPID`、`ActiveEnterTimestamp`。

```
restart_check: marker=absent recorded_pid1_ns=pid:[4026532236] current_pid1_ns=pid:[4026532237]
kernel_boot_id=02648dce-a9a6-4582-a781-f971e93cc829   # 三个阶段不变
kernel_uptime_s=7021.46 -> 7121.65 -> 7146.35          # 内核持续运行，没有重启
phase=after_restart
user_manager_invocation=b2b47b47346440989aca416585a3753e   # 冷启动前 862f21bb…
service_active_enter=Fri 2026-11-13 02:07:37 CST (= 冷启动时刻)
active_state=active substate=running main_pid=274 nrestarts=0
managed_user_state=lingering sessions=                     # 没有任何登录会话
loginctl_users= … ghostfleet-managed yes lingering;
```

解读：**共享的内核没有重启**（uptime 连续、`kernel_boot_id` 三个阶段相同），只有发行版实例冷启动；在这样的前提下 user manager 由 `logind` + `Linger` 拉起，`sessions=` 为空说明不存在任何人类登录会话，服务仍在冷启动后数秒内到达 `active`。这就是 ADR §12「开机恢复」行要的证明。

> 语义边界：这不是物理机断电重启的证明，也不是「机器重启后自动恢复」的全量证明。这里证明的是 **distro/会话管理器冷启动 + linger 自启** 路径；物理机级 reboot、只读根、时钟跳变等场景仍未证明（见 ADR §14）。

## 5. 停机预算：SIGTERM 后不得再发起请求（真机 before/after）

装置：loopback 上的慢控制面（每个 `/v0/nodes/*` 请求先 hold 4 s 再回 2xx），agent 启动 1.5 s 后、**在一条心跳正在途中**发 `systemctl --user stop`。同一台 Ubuntu-24.04 / systemd 255 上跑两版制品：

| 指标 | before（pyz `20ef4f8a…`, 204,946 B） | after（pyz `b2b2acea…`, 225,102 B，冻结版） |
| --- | --- | --- |
| signal 之后服务端收到的请求数 | 1（signal 后 2.5 s 又发了一条 poll） | **0** |
| 停到 inactive 的墙钟 | 6.54 s | **2.55 s**（≈ 在途请求剩余时间） |
| unit 结果 | `Result=timeout` 风险（超 `TimeoutStopSec=30` 即 SIGKILL） | `ExecMainStatus=0` / `Result=success` |
| `NRestarts` | — | 0（不重启） |
| journal watchdog/timeout 计数 | — | 0 / 0 |

after 的 journal 顺序（节选）：

```
02:08:03 {"event":"signal_received","signal":15}
02:08:05 {"event":"iteration_stopped_before_poll"}      # 在途心跳返回后立刻停，不再 poll
02:08:05 {"event":"agent_stopped","reason":"signal","elapsed_s":0.0,"outbox_depth":0,"sent":0,"rejected":0}
```

停机预算是三段显式值之和而不是经验值：`STOP_SLICE_S` = 1 s（睡眠按 ≤1 s 切片、每片检查 stop 事件）+ `request_timeout_s` 默认 10 s（在途 HTTP 不可中途 abort，只能由请求超时封顶）+ `SHUTDOWN_FLUSH_BUDGET_S` = 8 s（尽力送达已完成的 result）= 19 s < unit 的 `TimeoutStopSec=30`，余量 11 s。这个和由 `packages/node-agent/tests/` 里的静态断言测试守着，常量从模块导入、不硬抄。

## 6. 安全边界（负向）

```
managed_sudo_probe=sudo: a password is required
managed_groups=ghostfleet-managed
config_mode=root:root:644   token_mode=ghostfleet-managed:ghostfleet-managed:600
```

managed 账户没有 sudo、没有特权组；token 是 `0600` 且与配置目录 `0700` 一致；`ConfigurationDirectoryMode=0700` 与 `StateDirectoryMode=0700` 让每次启动不再出现 `ConfigurationDirectory 'ghostfleet' already exists but the mode is different` 或 state 目录过宽告警（`journal_config_dir_warning=0`、`journal_state_dir_loose=0`）。沙箱内信任判据的负向臂（`/etc` 可写或非只读挂载 → 拒绝启动且不联网）由 `tests/test_trust.py` 与 `test_cli_once.py` 的注入式用例覆盖。

## 7. 可复现性与跨版本测试

- **payload 可复现**：在 LF 检出（`core.autocrlf=false` 的新鲜 clone）里跑 `python3 packages/node-agent/tools/build_pyz.py --out /tmp/rebuild.pyz`，重建结果与仓库内 `dist/node-agent.pyz` **逐字节相同**（`b2b2acea…`, 225,102 B）。在 CRLF 检出里重建会多出每文件一个 CR（本机实测 `ea5c624c…`），此时 `npm run verify:node-agent-pyz` 失败是**正确 fail-closed**；CI 的 Linux checkout 是 LF，不受影响。
- **agent 套件**：LF clone 上 `python3 -m pytest packages/node-agent -q` = **531 passed**（Python 3.12.3 / root，无 skip，本机 95.09 s；提交者自报 96.50 s，同一 HEAD）。
- **runtime 套件**：同一环境 `python3 -m pytest packages/runtime-python -q` = **131 passed, 1 skipped**。
- **被跳过的 31 条 JS 用例**都不是「未测」：它们要求 root/特权/TTY/真实信号，由三个 Linux root disposable CI job（`bootstrap-capability-disposable`、`chain-acceptance-disposable`、`privileged-disposable`）覆盖。
- **跨版本矩阵**：同一 HEAD 在 Python 3.12.3（Ubuntu-24.04）上 531 passed（95.09 s）、在 3.13.5（Debian）上 531 passed（42.77 s）；除测试装置外零第三方依赖。

## 8. 复现（手工步骤）

在 disposable Linux（独占 VM，不要和并行的验收共享一台 WSL：共享会让 Linger、`systemctl --user` 与账号状态互相污染，产生假红/假绿）上：

1. **安装阶段**（root）：按 capability lane 的落点装制品 —— `pyz` 到 `/usr/local/libexec/ghostfleet/node-agent.pyz` `root:root 0755`；`/etc/ghostfleet/node-agent.json` `root:root 0644`，键集合为 `control_plane_origin` / `heartbeat_interval_s` / `heartbeat_interval_min_s` / `heartbeat_interval_max_s` / `allowed_units`（多一个键会被 agent 的 `CONFIG_UNKNOWN_KEY` 拒绝）；以 managed 身份写 `%h/.config/ghostfleet/node-token` `0600` 与 `node.json`；unit 装到 `%h/.config/systemd/user/`；然后 `loginctl enable-linger` + `systemctl --user enable --now`。
2. **采样**：`systemctl --user show` 记 `ActiveState/SubState/MainPID/NRestarts/Restart/WatchdogTimestamp`，`loginctl show-user` 记 `Linger`；等 ≥100 s（此间控制面必须不可达）再采第二次。
3. **冷启动**：重启该实例（例如 `wsl --terminate <distro>`），**不要**登录，**不要**手动 start。
4. **观测阶段**（root）：等 `systemctl is-system-running` 落到 `running|degraded`，再记录同一组字段 + `loginctl list-users` + `sessions=`。
5. **停机预算（可选但推荐）**：把控制面换成本机慢桩（每请求 hold 4 s），启动 1.5 s 后 `systemctl --user stop`，统计「signal 之后服务端收到的请求数」必须为 0，并记 `ExecMainStatus`/`Result`/`NRestarts`。

判定标准：必须同时满足「`/run` 下的 tmpfs 标记文件消失」（fresh tmpfs）与「PID-1 namespace inode 变化」（fresh init namespace），否则该轮不算重启证据；`kernel boot_id` 与 kernel uptime 在 WSL2 里是共享内核事实，**不能**用来判 distro 重启。

本轮用的采集脚本是 WSL 专用的一次性 harness（`nsenter --preserve-credentials` 读沙箱视图、`--since` 限定 journal 计数、`runuser` 切 managed 身份），未入库；可复用的 disposable 验收 harness 是本仓库的 `scripts/test-node-agent-lifecycle-disposable-linux.sh`（其中 S6c 用慢控制面 + 服务端 `received_at` 复现本节第 5 步，断言从服务端侧计数），运行方法见 `docs/CHAIN-ACCEPTANCE-RUNBOOK.md`。

## 9. 未被本文件证明的事

- 生产节点上的行为，以及真实控制面（Cloudflare Worker + Access）下的端到端链路。
- 结果词汇、入站鉴权、队列修剪等控制面行：由 `test/control-plane/node-agent.test.js` 与验收 harness 覆盖，不依赖本文件的真机证据。
- 物理机重启、只读根文件系统、CPU/内存压力下的看门狗行为。
- 跨发行版差异：只在 Ubuntu-24.04（systemd 255）与 Debian（python 3.13）上测过；systemd 249/252 等旧版本未验（ADR §14 已列为风险）。

## 10. 官方验收跑（独立装置、冻结字节）

上面 §1–§7 的机器是我自己的 WSL Ubuntu-24.04。为避免「被测装置自己出题自己判卷」，另一次正式跑由独立验收 lane 在**另一台** Debian（systemd 257 / Python 3.13.5 / root / 真 `systemd --user`）上，用仓库内 harness 对**同一冻结字节**跑两轮：

| 项 | 值 |
| --- | --- |
| 验收分支 head | `8fd4876`（把冻结 tuple 的 integration head `a1dac97` 合入；唯一冲突 `docs/architecture/NODE_AGENT_V0.md` 取集成侧） |
| 冻结 payload | `b2b2acea9d5a99c30f18a2169a8f7709807742ab64c2d8a8f42dd5c95ccc609f` / 225,102 B（fixture 由 `git archive HEAD` 重建后用 `build_pyz.py` 复现，字节一致） |
| 冻结 unit | `2b54d05d38c32082e5dbf63035bb03e64da0e7b7332f5504a0e512ba1acd8e58` / 948 B |
| 执行字节 | lifecycle 脚本 sha256 `806e7721…8c9b`（2805 行）、控制面 harness `94f700cd…c5` |
| 全量跑（默认开关） | **PASS**，EXIT 0，墙钟 560 s，OK 88 / EVIDENCE 296 / NOT_RUN 7 / FAIL 0 |
| S6c 跑（`GHOSTFLEET_ACCEPTANCE_SLOW_PLANE=1`） | **PASS**，EXIT 0，墙钟 563 s，OK 91 / EVIDENCE 306 / NOT_RUN 6 / FAIL 0 |

S6c 的三个硬断言（本文件 §5 的服务端侧复核，慢控制面对 `/v0/nodes/*` 每请求 hold 3500 ms）：

```
slow_plane.delay_ms=3500   in_flight_at_signal=1   requests_after_signal=0
stop_seconds=4   ExecMainStatus=0   Result=success   NRestarts unchanged
journal_request_events_after_signal=0   journal_lines_before_signal=1263  after_signal=4
```

journal 顺序（该跑原样摘录，unit `_UID=1011`）：

```
{"event":"signal_received","level":"info","signal":15,"ts":"2026-11-12T18:26:26Z"}
ghostfleet-managed.service: Sent signal SIGTERM to main process 99745 (python3) on client request.
{"event":"iteration_stopped_before_poll","level":"info","ts":"2026-11-12T18:26:30Z"}
{"elapsed_s":0.0,"event":"agent_stopped","level":"info","outbox_depth":0,"reason":"signal","rejected":0,"sent":0,"ts":"2026-11-12T18:26:30Z"}
```

同一跑的旁证：unit 的 SIGTERM 臂 `exec_main_status=0` / `result=success` / 12 s 无重启窗口 / `NRestarts` 不变；S6b 离线 240 s（24 采样 `non_active=0`、`WatchdogTimestamp` 前进 240 s、watchdog journal 0 行、NOTIFY 拒绝 0 行）；S3c 沙箱 `uid_map "1011 1011 1"`、配置视图 `65534:65534:644`、token `1011:1011:600`、state 目录 `1011:1011:700`、`/` 只读；S9 三个拒绝码（`NODE_NONCE_REPLAY` / `NODE_SEQ_REGRESSION` / `NODE_NONCE_REPLAY`）+ 幂等 200 + `TASK_RESULT_CONFLICT` 409 + 崩溃栅栏恰好一条 `UNKNOWN`；未投影节点心跳被接受且 `capability_digest` 为 null、0 条 `NODE_REQUEST_INVALID`。

这一跑的 7（S6c 跑为 6）条 NOT_RUN 都写在运行手册的通过条件里，主干是：真实 tailnet 远端 operator 跳、真实 Cloudflare Worker 部署、真实 OMV8 硬件、真实 PAM `su`/`sudo` 交互、真实内核重启 + 凭据轮换 + 多节点租约竞争、需要 courier 行的正向 `capability-status.json`。**这些都不由本文件的真机证据替代，也不由 synthetic PASS 冒充。**
