# 原生传输实例验收 / Native transport instance acceptance

| 字段 / Field | 值 / Value |
| --- | --- |
| 文档性质 / Classification | `DERIVED`：原生传输的可复用验收模板，不是实例状态表 / Reusable native-transport acceptance template, not an instance status register |
| `source_pointer` | [当前产品与实施入口 / Current product and implementation](https://github.com/youling/ghostfleet/issues/11)；[ADR004](adr/004-lightweight-enrollment-presence.md)；[原生传输指南 / Native transport guide](REMOTE_ACCESS.md) |
| 实际状态 / Actual status | 读取 #11 最新裁决及其引用的实例回执，不从本模板推断 / Read the latest #11 disposition and linked instance receipts; do not infer status from this template |
| 使用版本 / Version under test | 每次执行填写实际提交、版本和实例记录 / Record the actual commit, versions and instance record for each execution |
| 模板修订 / Template revision | `2026-11-18`：补充 Cloudflare SSH 客户端前置条件、SSH/TCP route 区分和分层诊断；不表示执行了下表测试 / Added Cloudflare SSH client prerequisites, SSH/TCP route distinction and layered diagnostics; does not imply these tests were run |
| 空白结果 / Blank results | `NOT_RUN` 是未填写的模板占位，不覆盖已接受的现场证据 / `NOT_RUN` is an unfilled template value and does not supersede accepted live evidence |

## 1. 使用与证据 / Use and evidence

本页只验收原生网络与 SSH 传输。面板、票据、心跳、系统级安装和受保护浏览器首次使用按 [PRESENCE](PRESENCE.md) 与 [阶段交付](DELIVERY.md) 分别记录。心跳在线不替代本页任何连接测试；已接受的连接证据也不替代面板首次使用。

This page covers native network and SSH transport only. Record panel, ticket, heartbeat, system installation and protected-browser first use separately through [PRESENCE](PRESENCE.md) and [staged delivery](DELIVERY.md). Presence does not replace a transport test, and accepted transport evidence does not establish panel first-use acceptance.

本页可以直接用于已有授权范围内的实例验收，不新增审批仪式。先填写实际候选提交、实例私有记录指针、版本和测试日期，再逐项填写实测结果。无法执行的项保持 `NOT_RUN` 并说明原因；只配置一路时，另一路填 `NOT_APPLICABLE`，不能宣称双路通过。`PASS` 必须有该实例、该版本的实际证据。

Use this page directly for instance acceptance within existing authorization; it adds no approval ceremony. Record the actual candidate commit, a private instance-record pointer, versions and test date, then enter observed results. Keep unexecuted items `NOT_RUN` with a reason. When only one path is configured, mark the other `NOT_APPLICABLE` and do not claim two-path acceptance. `PASS` requires evidence for the actual instance and version.

公开结果仅需状态、时间、版本和不含敏感数据的证据摘要；原始日志、主机地址、密钥及 provider 详情留在实例 owner 的适当记录中。无需提交原始秘密。静态检查和 CI 只证明其实际覆盖的内容，不能代替真实登录、PAM、账户状态、`authorized_keys` 限制或 `ForceCommand` 的运行结果。

Public results need only status, time, versions and a non-sensitive evidence summary. Raw logs, host addresses, keys and provider details remain in the instance owner's appropriate records; raw secrets are never required. Static checks and CI establish only what they actually cover, not live login, PAM, account state, `authorized_keys` restrictions or `ForceCommand` behavior.

```text
candidate_commit: NOT_RECORDED
instance_record: NOT_RECORDED (private/opaque reference; do not publish identifiers)
owner: NOT_RECORDED
tested_at: NOT_RUN
os_openssh_cloudflared_tailscale_versions: NOT_RECORDED
configured_paths: NOT_RECORDED
result: NOT_RUN
```

## 2. 两路必须分别检查真实上下文 / Check each path's actual context

服务端配置须先通过 `sshd -t`，再用 `sshd -T -C` 检查每一路的有效配置；`Match` 取决于连接上下文。仓库验证脚本是辅助检查，不是另一个 OpenSSH 认证实现。不要用默认 loopback 上下文代替所有 Tailscale 连接，或把未知的模式、PAM 和 key options 假定为已经验证。

Check server syntax with `sshd -t`, then inspect each path's effective configuration with `sshd -T -C`; `Match` depends on the connection context. The repository verifier is an aid, not a parallel OpenSSH authentication implementation. Do not substitute the default loopback context for every Tailscale connection or assume that unknown patterns, PAM and key options have been verified.

| 上下文 / Context | 要填的实际值 / Actual values to supply |
| --- | --- |
| Cloudflare 后端 / Cloudflare backend | 参考为本机 `cloudflared` → `127.0.0.1:22`，按 sshd 实际看到的源/目的地址检查；若后端变为 IPv6 或远端地址则相应修改 / Reference: local `cloudflared` → `127.0.0.1:22`; use source/destination addresses actually seen by sshd, adjusting for an IPv6 or remote backend |
| Tailscale 路径 / Tailscale path | `addr` 为 sshd 看到的客户端地址；`laddr` 为目标监听地址；不能照抄 CF loopback / `addr` is the client source seen by sshd, and `laddr` the local listening address; do not copy the CF loopback context |
| 两路 / Both paths | `user` 为实际 OS 账户；`host` 为服务端用于匹配的源主机名；按实例填 `lport` 等字段 / `user` is the actual OS account; `host` is the source hostname used for matching; fill `lport` and other applicable fields from the instance |

[OpenSSH `sshd` 手册](https://man.openbsd.org/sshd) 定义这些字段与测试模式。检查完整有效值及实际准入条件；例如只见 `PermitRootLogin yes` 或 `prohibit-password`，都不能单独证明当前账户仅通过公钥登录。检查全部认证路径、允许/拒绝规则，并通过后续真实会话确认。

The [OpenSSH `sshd` manual](https://man.openbsd.org/sshd) defines these context fields and test modes. Inspect complete effective values and actual admission conditions. Neither `PermitRootLogin yes` nor `prohibit-password` alone proves that the account is public-key-only. Check all authentication alternatives and allow/deny rules, then confirm with real sessions.

## 3. 新会话、主机身份与配置生效 / Fresh sessions, host identity and configuration changes

两路别名共享该节点唯一的 `HostKeyAlias`，不同节点使用不同值；先按 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) 带外核验并登记主机身份。以下命令均在操作者客户端执行。`ControlPath=none` 避免复用现有 master 连接，确保这次测试实际建立所选路径的新连接；同时显式关闭新 master 创建。示例别名需替换为实例配置值。

Both aliases share a `HostKeyAlias` unique to that node; different nodes use different values. Verify and enroll host identity out of band as described in [REMOTE_ACCESS.md](REMOTE_ACCESS.md). Run the commands below on the operator's client. `ControlPath=none` prevents reuse of an existing master connection, while `ControlMaster=no` explicitly disables creating a new master, so the selected path is tested with a fresh connection. Substitute the instance's configured aliases.

```sh
# Inspect client configuration; this does not connect.
ssh -G -o ControlPath=none -o ControlMaster=no node-cf
ssh -G -o ControlPath=none -o ControlMaster=no node-ts

# Open a fresh interactive shell on each configured path.
ssh -o ControlPath=none -o ControlMaster=no node-cf
ssh -o ControlPath=none -o ControlMaster=no node-ts

# Run an explicit harmless exec check; root reference profile returns 0.
ssh -o ControlPath=none -o ControlMaster=no node-cf 'id -u'
ssh -o ControlPath=none -o ControlMaster=no node-ts 'id -u'

# Open the native SFTP subsystem; use a disposable test directory.
sftp -o ControlPath=none -o ControlMaster=no node-cf
sftp -o ControlPath=none -o ControlMaster=no node-ts
```

连接复用与主机别名语义见 [OpenSSH `ssh_config` 手册](https://man.openbsd.org/ssh_config)。在新会话前检查 `ssh -G` 的用户、身份文件、`HostKeyAlias`、`StrictHostKeyChecking`、`ProxyCommand` 和连接复用结果。CF 应使用所选 Cloudflare 代理路径；TS 应使用所选 Tailscale 地址，并核对没有从通配配置继承意外代理。

See the [OpenSSH `ssh_config` manual](https://man.openbsd.org/ssh_config) for connection multiplexing and host-alias semantics. Before connecting, inspect `ssh -G` for user, identity file, `HostKeyAlias`, `StrictHostKeyChecking`, `ProxyCommand` and multiplexing settings. CF should use the selected Cloudflare proxy path; TS should use the selected Tailscale address without an unintended proxy inherited from wildcard configuration.

应用服务端配置时，保留现有可用会话和带外恢复入口。先核对配置来源与可恢复版本，并让语法及两路有效配置检查通过，再使用该 OS/服务单元支持的 reload/apply；reload 后分别建立新会话确认，再结束旧会话。不要假定 reload 已有会话就能证明新配置可登录。systemd 的 `daemon-reload` 重新读取 unit 定义，不等于 SSH 服务配置 reload；具体操作依实际服务单元与 [systemctl 文档](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)。

When applying server configuration, retain a working session and an out-of-band recovery entry. Establish the configuration source and a recoverable version, pass syntax and both context checks, then use the reload/apply supported by that OS and service unit. Confirm fresh sessions on each path before closing the old session. An existing session surviving reload does not prove that new logins work. systemd `daemon-reload` reloads unit definitions, not the SSH service's configuration; use the actual unit and [systemctl documentation](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html).

OMV 使用 UI 支持的 SSH 配置来源和受支持的额外选项调整；核对最终生成配置，避免只改会被平台覆盖的生成文件。[OMV 官方说明](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html) 的常规建议与本项目选择的 root 公钥参考配置有区别，不能直接照搬用户/组规则并假定 root 已获准入。UI 的 apply 同样需要保留恢复入口并验证新的真实会话。

For OMV, adjust the SSH source through supported UI settings and extra options, then inspect the generated result; avoid relying on edits to generated files that the platform may replace. [OMV's official guidance](https://docs.openmediavault.org/en/8.x/administration/services/ssh.html) differs from this project's selected root public-key reference profile, so do not copy user/group rules and assume root admission. Retain a recovery entry through UI apply and verify fresh live sessions afterward.

## 4. 可填写的验收矩阵 / Fill-in acceptance matrix

下表所有结果均为模板，不表示本轮已执行测试。`evidence` 记录可复核摘要或私有证据的不透明引用；不用公开地址或原始日志填满表格。

Every result below is a template, not a claim of execution in this round. Record a reproducible summary or opaque private evidence reference; do not fill the public table with real addresses or raw logs.

| ID | 检查与通过条件 / Check and pass condition | result | evidence |
| --- | --- | --- | --- |
| A01 | 配置来源、实际候选/版本明确；`sshd -t` 通过；两路真实上下文的完整有效配置符合所选策略：root 仅公钥，普通用户保留 OS 原有认证 / Record source, candidate and versions; pass syntax checks and inspect each real path context: root is public-key-only and ordinary users retain OS-owned authentication | `NOT_RUN` | — |
| A02 | 同节点两路使用同一带外核验主机身份和同一 `HostKeyAlias`；不同节点 alias 唯一；严格主机密钥校验启用 / Share one verified host identity and alias per node across paths; keep aliases unique between nodes and enforce strict host-key checking | `NOT_RUN` | — |
| A03 | CF：确认 Published Route 服务类型；SSH/`ssh://…:22` 必须有客户端 `cloudflared` 可执行文件/版本，`ssh -G` 的 `ProxyCommand` 指向本机二进制并调用 `access ssh`；TCP/`tcp://…` 的 `access tcp` 本地转发不能替代 SSH route 验收。TS：确认私网地址。两路均以关闭连接复用的新会话到达预期原生 sshd；Tailscale SSH 关闭 / CF: confirm the Published Route service type; SSH/`ssh://…:22` requires a client `cloudflared` executable/version and an effective `ssh -G` `ProxyCommand` pointing to that local binary and invoking `access ssh`; TCP/`tcp://…` with `access tcp` local forwarding does not substitute for SSH-route acceptance. TS: confirm the private address. Both paths reach the intended native sshd through fresh non-multiplexed sessions; Tailscale SSH is disabled | `NOT_RUN` | — |
| A04 | 两路分别完成交互 shell；参考 root 配置显示实际 UID 0，未依赖旧连接 / Open an interactive shell on each path; verify UID 0 for the root reference profile without relying on an old connection | `NOT_RUN` | — |
| A05 | 两路分别完成显式 exec（如 `id -u`），记录退出状态与期望输出 / Run an explicit exec such as `id -u` on each path and record exit status and expected output | `NOT_RUN` | — |
| A06 | 两路分别进入 SFTP；在 owner 选定的临时目录上传/下载自备非敏感小文件、比对内容并清理 / Enter SFTP on each path; upload/download a non-sensitive test file in an owner-selected temporary directory, compare contents and clean up | `NOT_RUN` | — |
| A07 | 保留恢复入口，撤销仅用于测试的账户公钥；关闭复用后两路新认证均失败；另记录已建立会话实际行为，不能以旧会话存在判定撤销失败 / Retain recovery access, revoke a test-only account key and confirm new authentication fails on both paths; separately record existing-session behavior | `NOT_RUN` | — |
| A08 | 在既有测试范围内撤销 CF 准入；使用未复用会话、已处理既有 Access 凭据/缓存语义的新请求确认拒绝；配置了 TS 且其策略未变时，确认 TS 新连接仍可用；另记 CF 已建立连接实际结果 / Revoke CF admission within the existing test scope; confirm denial with fresh requests that account for Access credential/cache semantics; when configured with unchanged policy, confirm a new TS connection still works; separately record established CF behavior | `NOT_RUN` | — |
| A09 | 在既有测试范围内撤销 TS 网络准入；确认所选客户端到目标 TCP 22 的新连接被拒绝；配置了 CF 且其策略未变时，确认 CF 新连接仍可用；另记 TS 已建立连接结果 / Revoke TS network admission within the existing test scope; confirm new TCP 22 connections from the selected client are denied; when configured with unchanged policy, confirm a new CF connection still works; separately record established TS behavior | `NOT_RUN` | — |
| A10 | 在可恢复的测试条件下使单一路径中断；另一可用路径以新会话连接；已建立会话不被宣称迁移，结果未知命令不自动重放 / Interrupt one path under recoverable test conditions; connect through the other available path with a new session, without claiming session migration or replaying commands with unknown outcomes | `NOT_RUN` | — |
| A11 | 分别记录已授权测试中的 `cloudflared`、`tailscaled`、OpenSSH 服务恢复和新连接结果；使用实际 upstream unit/OS 恢复方式，不新增守护进程 / Record recovery of cloudflared, tailscaled and OpenSSH and subsequent fresh connections in the authorized test, using actual upstream units/OS facilities without another daemon | `NOT_RUN` | — |
| A12 | 配置检查通过后使用 OS 支持的 reload/apply；旧会话/带外入口保留；两路新会话重新确认；OMV 从支持的来源调整 / Pass configuration checks, use supported reload/apply, retain the old session/recovery entry, recheck fresh sessions and use supported OMV configuration sources | `NOT_RUN` | — |
| A13 | 核对实际服务/安装与旧实例记录，确认无被取代的常驻命令 Agent、Helper、命令队列或旧命令控制面；遗留项由原 owner 收口，源码删除不能替代检查。ADR004 的 oneshot reporter 和 timer 属于当前范围 / Reconcile services/installations and prior records; establish that no superseded resident command agent, Helper, command queue or old command control plane is installed or running. Retain remnants for original-owner closeout; source deletion is insufficient. The ADR004 oneshot reporter and timer remain in scope | `NOT_RUN` | — |
| A14 | 验收后恢复测试用的准入/密钥状态、清理测试文件，记录最终可连接状态和剩余限制 / Restore the intended post-test key/admission state, clean up test files, and record final connectivity and remaining limitations | `NOT_RUN` | — |

## 5. 撤销与恢复的解释边界 / Revocation and recovery interpretation

新连接拒绝、已有网络连接中断、已有 SSH 会话结束是不同结果，分别记录。删除账户公钥通常影响后续认证，不会因此重新认证已建立 SSH 会话；provider 策略传播、既有凭据以及已建立连接的处理则按实际产品、版本与策略验证。不要把“新请求被拒绝”写成“所有已有会话已立即终止”。确有会话终止需求时，由实例 owner 使用已有授权内的原生手段处理并另记结果，不在 GhostFleet 中增加命令监管层。

Denial of a new connection, interruption of an established network connection and termination of an existing SSH session are distinct results. Removing an account key generally affects subsequent authentication; it does not reauthenticate an established SSH session. Verify provider propagation, existing credentials and established connections against the actual product, version and policy. Do not turn “new requests denied” into “all existing sessions terminated immediately.” If session termination is required, the instance owner uses native facilities within existing authorization and records the outcome, without a new GhostFleet command-control layer.

断网恢复检查只使用结果可判断的测试操作。真实操作若在断线时结果未知，先通过新会话检查目标状态，再决定后续操作；不自动重放。服务恢复检查不应从“unit 语法有效”推导出真实二进制、凭据、网络和重启行为都已通过；未实际触发并观察的恢复项保持 `NOT_RUN`。

Use operations with ascertainable outcomes for interruption tests. If real work has an unknown outcome when a connection drops, inspect target state through a new session before deciding what to do next; do not replay it automatically. A syntactically valid unit does not prove the actual binary, credentials, network or restart behavior. Keep recovery cases `NOT_RUN` unless the relevant event was actually exercised and observed.
