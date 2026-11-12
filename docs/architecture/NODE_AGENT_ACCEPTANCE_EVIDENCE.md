# Node Agent 验收证据（REQ-01 / v0）

## 0. English abstract

Measured evidence for the REQ-01 acceptance rows that must not be faked by a synthetic PASS: the managed node agent runs as a real `Type=notify` systemd user unit, stays `active` through a 100 s+ outage of the control plane with a live watchdog, stops on `SIGTERM` without issuing a single further request while a request is in flight, and is auto-started by `logind` + `Linger` after the distribution instance cold-starts, with no login session present. The host namespace view (`nsenter -U -m --preserve-credentials`) is recorded because mount hardening implicitly enables `PrivateUsers` for per-user instances; `host root` files appear as `overflowuid` there, which is exactly why the ADR requires an inverse `uid_map` lookup instead of trusting `st_uid == 0`. Artifact hashes, restart markers and the reproduction procedure are listed below. Scope limit: this is distro-level cold start on WSL2 (shared kernel, continuous uptime), not a physical power-cycle, and no production node has run it.

Artifacts under test: `packages/node-agent/dist/node-agent.pyz` (sha256 `8dd4d943…`, 213,929 B) and `packages/bootstrap/assets/ghostfleet-managed.service` (sha256 `2b54d05d…`, 948 B).

本文件记录**真实 systemd** 上测到的值，用于 ADR §12 验收矩阵里那些不能由 synthetic PASS 冒充的行。所有主机名/标识都是合成的（`.invalid` 域、示例 node uid），不含任何真实节点、endpoint 或凭据。

测量环境：Windows 11 + WSL2，发行版 Ubuntu-24.04（systemd 255），非特权 managed 账户 + systemd user manager + `enable-linger`。被测制品：

| 制品 | sha256 | 大小 |
| --- | --- | --- |
| `packages/node-agent/dist/node-agent.pyz` | `8dd4d9437cc452e5b4677d5449fd29c6355fe154c832ca83e6e326fddde3abda` | 213,929 B |
| `packages/bootstrap/assets/ghostfleet-managed.service` | `2b54d05d38c32082e5dbf63035bb03e64da0e7b7332f5504a0e512ba1acd8e58` | 948 B |

## 1. 生命周期与真实进程

`systemctl --user show`（由 unit 的 `MainPID` 读出，不是脚本自报）：

| 阶段 | ActiveState/SubState | MainPID | NRestarts | ActiveEnterTimestamp |
| --- | --- | --- | --- | --- |
| 安装后（控制面不可达） | `active/running` | 655 | 0 | 00:49:33 |
| 100 s 后（仍不可达） | `active/running` | 655 | 0 | 00:49:33 |
| distro 冷启动后（无登录） | `active/running` | 283 | 0 | 00:51:36 |

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
phase=before_restart         : active_state=active nrestarts=0 watchdog_timestamp=Fri 2026-11-13 00:49:33 CST
phase=before_restart_stable  : active_state=active nrestarts=0 watchdog_timestamp=Fri 2026-11-13 00:51:13 CST
journal_watchdog_timeouts=0 journal_watchdog_result=0 journal_sigabrt=0
journal_notify_leak=0 journal_config_untrusted=0 journal_credential_permissive=0
journal_state_dir_loose=0 journal_config_dir_warning=0
```

失败重试的退避阶梯实测为 4 s → 8 s → 33 s → 60 s（`backoff_s` 依次 3.968 / 8.362 / 32.769 / 60.218），全程 `active`；`WatchdogTimestamp` 由 20 s 周期的看门狗线程推进（两次采样间前进 100 s，与采样间隔一致），证明喂狗不依赖主循环成功（ADR §6）。journal 中没有 `reception only permitted for main PID`，即子进程没有继承 `NOTIFY_SOCKET`。

## 4. 开机恢复：无登录自动拉起

判定「distro 真的冷启动」用的是 distro 本地事实，而不是内核事实：`/run` 下 tmpfs 标记文件消失（fresh tmpfs）+ PID-1 namespace inode 变化。辅证 `InvocationID`、`MainPID`、`ActiveEnterTimestamp`。

```
restart_check: marker=absent recorded_pid1_ns=pid:[4026532238] current_pid1_ns=pid:[4026532233]
kernel_boot_id=02648dce-a9a6-4582-a781-f971e93cc829   # 三个阶段不变
kernel_uptime_s=2463.46 -> 2563.65 -> 2585.42          # 内核持续运行，没有重启
phase=after_restart
user_manager_invocation=8d70e7a3a1b3492cb31a8e2cf810ea4f   # 冷启动前 e0e920fa…
service_active_enter=Fri 2026-11-13 00:51:36 CST (= 冷启动时刻)
active_state=active substate=running main_pid=283 nrestarts=0
managed_user_state=lingering sessions=                     # 没有任何登录会话
loginctl_users= … ghostfleet-managed yes lingering;
```

解读：**共享的内核没有重启**（uptime 连续、`kernel_boot_id` 三个阶段相同），只有发行版实例冷启动；在这样的前提下 user manager 由 `logind` + `Linger` 拉起，`sessions=` 为空说明不存在任何人类登录会话，服务仍在冷启动后数秒内到达 `active`。这就是 ADR §12「开机恢复」行要的证明。

> 语义边界：这不是物理机断电重启的证明，也不是「机器重启后自动恢复」的全量证明。这里证明的是 **distro/会话管理器冷启动 + linger 自启** 路径；物理机级 reboot、只读根、时钟跳变等场景仍未证明（见 ADR §14）。

## 5. 停机预算：SIGTERM 后不得再发起请求（真机 before/after）

装置：loopback 上的慢控制面（每个 `/v0/nodes/*` 请求先 hold 4 s 再回 2xx），agent 启动 1.5 s 后、**在一条心跳正在途中**发 `systemctl --user stop`。同一台 Ubuntu-24.04 / systemd 255 上跑两版制品：

| 指标 | before（pyz `20ef4f8a…`, 204,946 B） | after（pyz `8dd4d943…`, 213,929 B） |
| --- | --- | --- |
| signal 之后服务端收到的请求数 | 1（signal 后 2.5 s 又发了一条 poll） | **0** |
| 停到 inactive 的墙钟 | 6.54 s | **2.54 s**（≈ 在途请求剩余时间） |
| unit 结果 | `Result=timeout` 风险（超 `TimeoutStopSec=30` 即 SIGKILL） | `ExecMainStatus=0` / `Result=success` |
| `NRestarts` | — | 0（不重启） |
| journal watchdog/timeout 计数 | — | 0 / 0 |

after 的 journal 顺序（节选）：

```
00:49:13 {"event":"signal_received","signal":15}
00:49:15 {"event":"iteration_stopped_before_poll"}      # 在途心跳返回后立刻停，不再 poll
00:49:15 {"event":"agent_stopped","reason":"signal","elapsed_s":0.0,"outbox_depth":0,"sent":0,"rejected":0}
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

- **payload 可复现**：在 LF 检出（`core.autocrlf=false` 的新鲜 clone）里跑 `python3 packages/node-agent/tools/build_pyz.py --out /tmp/rebuild.pyz`，重建结果与仓库内 `dist/node-agent.pyz` **逐字节相同**（`8dd4d943…`, 213,929 B）。在 CRLF 检出里重建会多出每文件一个 CR（本机实测 `ea5c624c…`），此时 `npm run verify:node-agent-pyz` 失败是**正确 fail-closed**；CI 的 Linux checkout 是 LF，不受影响。
- **agent 套件**：LF clone / Python 3.12.3 上 `python3 -m pytest packages/node-agent -q` = **513 passed**（本机 72.19 s；提交者自报 68.16 s，同一 HEAD）。以 root 跑时另有两条用例按设计跳过/变形（root 下信任判据真的成立），所以 CI 用非 root。
- **runtime 套件**：同一环境 `python3 -m pytest packages/runtime-python -q` = **131 passed, 1 skipped**。
- **被跳过的 31 条 JS 用例**都不是「未测」：它们要求 root/特权/TTY/真实信号，由三个 Linux root disposable CI job（`bootstrap-capability-disposable`、`chain-acceptance-disposable`、`privileged-disposable`）覆盖。
- **跨版本矩阵**：同一 HEAD 在 Python 3.12.3（Ubuntu-24.04）与 3.13.5（Debian）上均为 513 passed；除测试装置外零第三方依赖。

## 8. 复现（手工步骤）

在 disposable Linux（独占 VM，不要和并行的验收共享一台 WSL：共享会让 Linger、`systemctl --user` 与账号状态互相污染，产生假红/假绿）上：

1. **安装阶段**（root）：按 capability lane 的落点装制品 —— `pyz` 到 `/usr/local/libexec/ghostfleet/node-agent.pyz` `root:root 0755`；`/etc/ghostfleet/node-agent.json` `root:root 0644`，键集合为 `control_plane_origin` / `heartbeat_interval_s` / `heartbeat_interval_min_s` / `heartbeat_interval_max_s` / `allowed_units`（多一个键会被 agent 的 `CONFIG_UNKNOWN_KEY` 拒绝）；以 managed 身份写 `%h/.config/ghostfleet/node-token` `0600` 与 `node.json`；unit 装到 `%h/.config/systemd/user/`；然后 `loginctl enable-linger` + `systemctl --user enable --now`。
2. **采样**：`systemctl --user show` 记 `ActiveState/SubState/MainPID/NRestarts/Restart/WatchdogTimestamp`，`loginctl show-user` 记 `Linger`；等 ≥100 s（此间控制面必须不可达）再采第二次。
3. **冷启动**：重启该实例（例如 `wsl --terminate <distro>`），**不要**登录，**不要**手动 start。
4. **观测阶段**（root）：等 `systemctl is-system-running` 落到 `running|degraded`，再记录同一组字段 + `loginctl list-users` + `sessions=`。
5. **停机预算（可选但推荐）**：把控制面换成本机慢桩（每请求 hold 4 s），启动 1.5 s 后 `systemctl --user stop`，统计「signal 之后服务端收到的请求数」必须为 0，并记 `ExecMainStatus`/`Result`/`NRestarts`。

判定标准：必须同时满足「`/run` 下的 tmpfs 标记文件消失」（fresh tmpfs）与「PID-1 namespace inode 变化」（fresh init namespace），否则该轮不算重启证据；`kernel boot_id` 与 kernel uptime 在 WSL2 里是共享内核事实，**不能**用来判 distro 重启。

本轮用的采集脚本是 WSL 专用的一次性 harness（`nsenter --preserve-credentials` 读沙箱视图、`--since` 限定 journal 计数、`runuser` 切 managed 身份），未入库；可复用的 disposable 验收 harness 见验收分支的 `scripts/test-node-agent-lifecycle-disposable-linux.sh`（其中 S6c 用慢控制面 + 服务端 `received_at` 复现本节第 5 步，断言从服务端侧计数）。

## 9. 未被本文件证明的事

- 生产节点上的行为，以及真实控制面（Cloudflare Worker + Access）下的端到端链路。
- 结果词汇、入站鉴权、队列修剪等控制面行：由 `test/control-plane/node-agent.test.js` 与验收 harness 覆盖，不依赖本文件的真机证据。
- 物理机重启、只读根文件系统、CPU/内存压力下的看门狗行为。
- 跨发行版差异：只在 Ubuntu-24.04（systemd 255）与 Debian（python 3.13）上测过；systemd 249/252 等旧版本未验（ADR §14 已列为风险）。
