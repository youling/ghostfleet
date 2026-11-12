# Node Agent 验收证据（REQ-01 / v0）

## 0. English abstract

Measured evidence for the REQ-01 acceptance rows that must not be faked by a synthetic PASS: the managed node agent runs as a real `Type=notify` systemd user unit, stays `active` through a 100 s+ outage of the control plane with a live watchdog, and is auto-started by `logind` + `Linger` after the distribution instance cold-starts, with no login session present. The host namespace view (`nsenter -U -m --preserve-credentials`) is recorded because mount hardening implicitly enables `PrivateUsers` for per-user instances; `host root` files appear as `overflowuid` there, which is exactly why the ADR requires an inverse `uid_map` lookup instead of trusting ``st_uid == 0``. Artifact hashes, restart markers and the reproduction procedure are listed below. Scope limit: this is distro-level cold start on WSL2 (shared kernel, continuous uptime), not a physical power-cycle, and no production node has run it.

Artifacts under test: `packages/node-agent/dist/node-agent.pyz` (sha256 `20ef4f8a…`, 204,946 B) and `packages/bootstrap/assets/ghostfleet-managed.service` (sha256 `2b54d05d…`, 948 B).

本文件记录**真实 systemd** 上测到的值，用于 ADR §12 验收矩阵里那些不能由 synthetic PASS 冒充的行。所有主机名/标识都是合成的（`.invalid` 域、示例 node uid），不含任何真实节点、endpoint 或凭据。

测量环境：Windows 11 + WSL2，发行版 Ubuntu-24.04（systemd 255），非特权 managed 账户 + systemd user manager + `enable-linger`。被测制品：

| 制品 | sha256 | 大小 |
| --- | --- | --- |
| `packages/node-agent/dist/node-agent.pyz` | `20ef4f8adb4bfbbd3d9c8f7a9f7d57eecda5ec445ffb4eecf0355c6aa6a49e94` | 204,946 B |
| `packages/bootstrap/assets/ghostfleet-managed.service` | `2b54d05d38c32082e5dbf63035bb03e64da0e7b7332f5504a0e512ba1acd8e58` | 948 B |

## 1. 生命周期与真实进程

`systemctl --user show`（由 unit 的 `MainPID` 读出，不是脚本自报）：

```
active_state=active substate=running main_pid=997 nrestarts=0 restart=on-failure linger=yes enabled=enabled
main_pid_comm=python3
main_pid_exe=/usr/bin/python3.12
main_pid_cmdline=/usr/bin/python3 -I /usr/local/libexec/ghostfleet/node-agent.pyz run
main_pid_uid=1002
```

服务是常驻 `Type=notify` 进程（发出 `READY=1` 后才算 started），不是 oneshot，也不是空壳心跳：同一进程在 100 s 采样间隔后仍是 `main_pid=997 / nrestarts=0`。

## 2. 沙箱内视图（隐式 `PrivateUsers`）

沙箱视图**必须**用 `nsenter -t <MainPID> -U -m --preserve-credentials --` 采集；直接 `stat /proc/<pid>/root/...` 得到的是宿主 UID 视图。

```
sandbox_view=nsenter-preserve-credentials
sandbox_uid_map=      1002       1002          1|
sandbox_root_mount_opts=ro,nosuid,relatime
sandbox_config_stat=65534:65534:644        # host root 的文件在 ns 内是 overflowuid
sandbox_token_stat=1002:1003:600
sandbox_state_dir_stat=1002:1003:700
sandbox_config_dir_stat=1002:1003:700
host_overflowuid=65534
```

即：mount 类硬化在 per-user instance 里隐式启用 `PrivateUsers=`，进程只映射自身 UID，`/` 以 `ro` 挂载。ADR §12 的信任判据（反查 `uid_map`；未映射则要求 overflowuid + 只读挂载 + 不可写）就是为了在这个视图下仍然能信任 `root:root 0644` 的 `/etc` 配置与投影文件。

## 3. 离线稳定（控制面故意不可达）

控制面地址是保留的 `.invalid` 域，DNS 必然失败；两次采样间隔 100 s：

```
phase=before_restart         : active_state=active nrestarts=0 watchdog_timestamp=23:59:15
phase=before_restart_stable  : active_state=active nrestarts=0 watchdog_timestamp=00:00:55
journal_watchdog_timeouts=0 journal_watchdog_result=0 journal_sigabrt=0
journal_notify_leak=0 journal_config_untrusted=0 journal_credential_permissive=0
```

退避按 4 s → 8 s → 30 s → 60 s 增长且服务始终 `active`；`WatchdogTimestamp` 由 20 s 周期的看门狗线程推进，证明喂狗不依赖主循环成功（ADR §6）。journal 中没有 `reception only permitted for main PID`，即子进程没有继承 `NOTIFY_SOCKET`。

## 4. 开机恢复：无登录自动拉起

判定「distro 真的冷启动」用的是 distro 本地事实，而不是内核事实：`/run` 下 tmpfs 标记文件消失（fresh tmpfs）+ PID-1 namespace inode 变化。辅证 `InvocationID`、`MainPID`、`ActiveEnterTimestamp`。

```
restart_check: marker=absent recorded_pid1_ns=pid:[4026532237] current_pid1_ns=pid:[4026532236]
kernel_boot_id=a1956f6d-78ef-443c-94e5-428455a6c319   # 三个阶段不变
kernel_uptime_s=289.46 -> 389.62 -> 409.97            # 内核持续运行，没有重启
phase=after_restart
user_manager_invocation=c197324e2ccc4dd5b6e03291684d8dc4   # 重启前 0089e6fa…
service_active_enter=Fri 2026-11-13 00:01:16 CST (= 冷启动时刻)
active_state=active substate=running main_pid=270 nrestarts=0
managed_user_state=lingering sessions=                     # 没有任何登录会话
loginctl_users= … ghostfleet-managed yes lingering
```

解读：**共享的内核没有重启**（uptime 连续、`kernel_boot_id` 不变），只有发行版实例冷启动；在这样的前提下 user manager 由 `logind` + `Linger` 拉起，`sessions=` 为空说明不存在任何人类登录会话，服务仍然在 1 秒内到达 `active`。这就是 ADR §12「开机恢复」行要的证明。

> 语义边界：这不是物理机断电重启的证明，也不是「机器重启后自动恢复」的全量证明。这里证明的是 **distro/会话管理器冷启动 + linger 自启** 路径；物理机级 reboot、只读根、时钟跳变等场景仍未证明（见 ADR §14）。

## 5. 安全边界（负向）

```
managed_sudo_probe=sudo: a password is required
managed_groups=ghostfleet-managed
config_mode=root:root:644   token_mode=ghostfleet-managed:ghostfleet-managed:600
```

managed 账户没有 sudo、没有特权组；token 是 `0600` 且与配置目录 `0700` 一致；`ConfigurationDirectoryMode=0700` 让每次启动不再出现 `ConfigurationDirectory 'ghostfleet' already exists but the mode is different` 告警（`journal_config_dir_warning=0`）。

## 6. 复现（两阶段，手工步骤）

在 disposable Linux（独占 VM，不要和并行的验收共享一台 WSL：共享会让 Linger、`systemctl --user` 与账号状态互相污染，产生假红/假绿）上：

1. **安装阶段**（root）：按 capability lane 的落点装制品 —— `pyz` 到 `/usr/local/libexec/ghostfleet/node-agent.pyz` `root:root 0755`；`/etc/ghostfleet/node-agent.json` `root:root 0644`，键集合为 `control_plane_origin` / `heartbeat_interval_s` / `heartbeat_interval_min_s` / `heartbeat_interval_max_s` / `allowed_units`（多一个键会被 agent 的 `CONFIG_UNKNOWN_KEY` 拒绝）；以 managed 身份写 `%h/.config/ghostfleet/node-token` `0600` 与 `node.json`；unit 装到 `%h/.config/systemd/user/`；然后 `loginctl enable-linger` + `systemctl --user enable --now`。
2. **采样**：`systemctl --user show` 记 `ActiveState/SubState/MainPID/NRestarts/Restart/WatchdogTimestamp`，`loginctl show-user` 记 `Linger`；等 ≥100 s（此间控制面必须不可达）再采第二次。
3. **冷启动**：重启该实例（例如 `wsl --terminate <distro>`），**不要**登录，**不要**手动 start。
4. **观测阶段**（root）：等 `systemctl is-system-running` 落到 `running|degraded`，再记录同一组字段 + `loginctl list-users` + `sessions=`。

判定标准：必须同时满足「`/run` 下的 tmpfs 标记文件消失」（fresh tmpfs）与「PID-1 namespace inode 变化」（fresh init namespace），否则该轮不算重启证据；`kernel boot_id` 与 kernel uptime 在 WSL2 里是共享内核事实，**不能**用来判 distro 重启。

本轮用的采集脚本是 WSL 专用的一次性 harness（`nsenter --preserve-credentials` 读沙箱视图、`--since` 限定 journal 计数、`runuser` 切 managed 身份），未入库；可复用的 disposable 验收 harness 见验收分支的 `scripts/test-node-agent-lifecycle-disposable-linux.sh`。

## 7. 未被本文件证明的事

- 生产节点上的行为，以及真实控制面（Cloudflare Worker + Access）下的端到端链路。
- 结果词汇、入站鉴权、队列修剪等控制面行：由 `test/control-plane/node-agent.test.js` 与验收 harness 覆盖，不依赖本文件的真机证据。
- 物理机重启、只读根文件系统、CPU/内存压力下的看门狗行为。