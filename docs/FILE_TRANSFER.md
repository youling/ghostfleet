# Optional file transfer contract / 可选文件传输合同

## 中文

<!-- topic:boundary -->
### 分层、状态与信任边界

`fleet.file.transfer` 是节点基础能力的可选合同，归 [#36 Artifact workstream](https://github.com/youling/ghostfleet/issues/36)；[#34](https://github.com/youling/ghostfleet/issues/34) 已合并到该工作流。Tailscale、Cloudflare 等提供连接；现有 Fleet 身份、权限、SSH 和任务设施提供受控执行；rsync-over-SSH 和将来的 SFTP adapter 处理数据。rsync 不是第三种远控网络，也不是备份、快照或历史版本系统。大文件在获准节点的数据会话中传输，不经 MCP stdout 或 Worker body 转运。

本次交付仅是 `packages/typed-control` 的纯函数：严格输入校验、rsync 参数计划、完整 manifest 和回执逻辑核验。导入不安装软件、不创建目录、不连接 SSH、不运行进程、不增加 MCP 工具、不新建任务库。`SOURCE_PLAN_ONLY` 不能代表部署或验收成功。SFTP 只有合同枚举和替换边界，尚无执行 adapter；不能宣称具备 rsync 的块增量语义。

普通传输使用获准目录的普通 OS 身份。工具安装、受保护目录和管理员操作沿现有权限路径单独授权。文件用途、保存和删除由业务 owner 决定；这里没有新增中央工头审批角色。未安装 rsync 只影响该传输后端，不阻止节点整体被 Fleet 纳管。

`FileTransferPlanningContext` 和 observer 回执来自**可信 runtime**，不能成为 Agent 可填写的工具参数。库只核对已认证事实之间的一致性，不验证签名、SSH 指纹真实性、路径 ACL 或观测时间的真实性。接线方须复用现有 node UID、actor、policy、transport proof、job/receipt 与 dispatch state，并在执行前重新核对有效性。对完整规划上下文和计划生成摘要用于对账；原始路径、SSH 配置、文件名和完整回执按部署数据受保护，不能因是计划就公开。

<!-- topic:contract -->
### V1 合同与普通文件 profile

`validateFileTransferIntent` 要求显式 schema、capability、operation、actor、work、policy、source/destination 的 node UID、root reference 和相对路径、direction、backend、profile、source version、manifest SHA-256，以及 `overwrite: "deny"`、`delete_source: false`、`delete_extraneous: false`。未知字段、任意 shell command/options、错身份、不同批准摘要、过期批准和策略漂移都拒绝。批准摘要由已认证的现有授权流程提供，不要求所有文件新走一个特权审批角色。

`portable-files-v1` 只表示普通文件字节与显式目录。manifest 列出每个文件的大小和 SHA-256、每个目录、完整文件数/目录数/总字节数，并绑定稳定源版本。父目录必须显式列出；空文件、空目录受支持。条目按路径排序后采用 UTF-8、对象键排序的 JSON 计算 manifest 摘要。输入被复制、冻结；accessor、非 JSON 值、循环、重复名字和额外字段拒绝。上限为十万条目、4096 字符相对路径、255 字符路径分量和安全整数总字节数。

跨平台路径必须为 NFC、相对 `/` 分隔路径，拒绝绝对路径、盘符/UNC、穿越、空分量、控制字符、孤立 UTF-16 代理、Windows 保留名/字符、尾部点或空格；合法 emoji 等代理对仍可用。采用保守的大写折叠拒绝大小写碰撞，并核对父路径的精确拼写。`.ghostfleet-transfer` 与 `.ghostfleet-partial` 分量保留给执行器。这个保守 profile 不保证所有文件系统的 Unicode/长路径语义；接收端还必须实际验收。

symlink、Windows reparse point、设备/套接字等特殊项和未知元数据拒绝。V1 不复制 ACL、owner/group、POSIX mode、xattr、ADS、hardlink 关系或源时间，不使用 `-a`。接收所有者是目标授权身份，需独立验收；文件权限由接收目录与安全创建策略决定。这适合普通内容产物，不是完整系统迁移或磁盘恢复。

V1 只向**不存在的新目标子目录**发布，`destination.relative_path` 不能为 `.`。不覆盖已有目标树，即使其中部分文件相同。增量/续传仅在同一逻辑 transfer 的私有 staging 内使用；向已有项目树合并、基于历史版本的增量、批准覆盖和删除需要后续独立合同，不能通过传递 rsync 选项绕过。

<!-- topic:backend -->
### rsync 计划、Windows 与限制身份

`planRsyncFileTransfer(intent, manifest, trustedContext)` 返回固定 program、argv、NUL 分隔 stdin、清洁环境要求、context/plan 摘要和待验收发布路径。它不会执行计划。源和目标只能有一端是 remote，发起者身份必须匹配 push/pull。只有 Linux remote peer 被接受；Windows 上本机发起方必须是获准 MSYS2 rsync + 同一 MSYS2 SSH 工具环境，并使用 `/c/...` 形式的本地盘路径。V1 要求 `rsync[.exe]` 和 `ssh[.exe]` 位于同一个以 `/usr/bin` 结束的目录，拒绝 native Windows OpenSSH 或不同 MSYS2 根的混配；实际构建归属仍由可信 runtime 验证。

目录操作数允许字母、数字、组合标记、空格和有限路径标点；其中的 shell 元字符拒绝。实际条目名称通过 `--from0 --files-from=-` 的 NUL stdin 传输，不拼接到 SSH 命令中。使用 `--no-recursive --dirs --relative` 和全量显式清单，避免列出一个目录时顺带复制未授权的子文件。程序与 SSH 配置路径采用无空格、无 shell 元字符的 POSIX token；SSH 使用批准的 alias/config digest、已有 `pinned_host_key` proof、严格 host key 检查、batch/identity 约束，并关闭 agent/端口转发和 TTY。未验证能力拒绝，不猜测主机、pin 或凭据。

这里不按版本号推断安全性。local/peer 都必须提供**精确发行版 package/build、安全 baseline reference、已验证的 `from0`、`files-from-no-recursion`、`remote-arg-escaping`、`partial-dir` 能力**。例如发行版可回移植补丁。runtime 必须验证这些记录对应实际执行文件和依赖、固定远端 `rsync` 解析与 SSH 配置、禁止不受控 shell startup 文件影响执行、检查配置摘要，并只向子进程传入批准环境；不能把整个父进程环境原样合并。MSYS2 的系统变量如确实必需，也要显式白名单。计划设置 `RSYNC_OLD_ARGS=0`、`RSYNC_PROTECT_ARGS=0`，不会自动启用隐藏参数模式。

SFTP-only 账户无法执行远端 rsync。Linux 的 `rrsync` 可把密钥限制到目录/读写范围，但必须验收具体 wrapper、shell、目录权限和竞态防护。`rrsync` 要检查 server 参数，因此这里不使用 `-s` / `--protect-args`；`-no-overwrite` 与 partial-dir 不兼容，遇到该配置直接拒绝，不悄悄移除保护。根据读写职责配置 `-ro` 或 `-wo`、`-no-del` 等限制，并单独验收。计划从不添加 `--delete`、删源、`--inplace` 或 daemon 模式。

Windows native sshd 接收端状态明确为 **NOT_VERIFIED**。Microsoft 的 `ChrootDirectory` 只支持 SFTP 会话；它不证明 rsync shell 在目录内受限。MSYS2 默认 symlink 行为、Windows ACL/inheritance、大小写、路径转换、锁定文件、实际 SSH shell 参数、进程环境和 `rrsync` 的非 Linux 竞态保护均需独立验证。不能因 Windows 本机计划通过就宣称 Windows/Linux 双向服务端传输通过。

<!-- topic:verification -->
### staging、独立观测与 UNKNOWN

目标根下的 staging 固定为 `.ghostfleet-transfer/<intent digest>/incoming`；partial 使用内部 `.ghostfleet-partial`。runtime 在派发前负责以正确 owner、安全 ACL/umask 创建目录，防止其他身份写入，验证整条路径及内容没有 symlink/reparse point，核对源 snapshot/稳定版本，并保证目标仍不存在。`new` 必须证明 staging 为空；`resume-matching` 必须证明属于同一 operation/intent/manifest/source version，且内容是已核验的子集。仅传入布尔标记不是 OS 安全证明。

执行中的状态沿现有任务/传输系统保存，不能额外维护一份 transfer 任务真相。可能已经派发时记录 `UNKNOWN` 或 `MAY_HAVE_EXECUTED`，先对账原 operation、进程、partial 和目标；此时 planner 拒绝新计划。`canChangeFileTransferBackend` 只对有可信未派发证据的 `NOT_DISPATCHED` 返回 true；这不授予替换后端的权限，换 backend 后的完整 intent 仍要重新绑定批准。超时和断网不能证明没有副作用。

传输结束后，可信 no-follow observer 必须扫描完整 staging，独立读取文件计算 SHA-256，并证明没有遗漏/多余项、同尺寸篡改、名称碰撞或源版本变化。源版本必须来自不可变快照或有实质保证的稳定性验证，不是照抄调用者字符串。残留 partial 元数据不能出现在发布清单中；runtime 应在核对归属后处理，再重新扫描。`verifyFileTransferManifest` 核对完整清单及总数/字节数，不能自行证明输入就是全量扫描结果。

runtime 随后还要以经过平台验收的 **no-replace** 原子发布机制防止目标竞态覆盖，重新验收 owner、内容与发布证据，再形成受保护回执。复制成功和目录 rename 都不自动等于跨文件系统原子发布；本库不实现发布。`verifyFileTransferReceipt` 只有在 operation/intent/actor/work/policy/nodes/backend 全部匹配、exit 0、完整 manifest 相等、源版本稳定、owner 匹配且 no-replace 发布证据齐全时才返回 `verified: true`。单独 rsync exit 0、文件大小或 rsync 自身 checksum 不够。FAILED/UNKNOWN 的结果要求对账，不自动重试。

<!-- topic:lifecycle -->
### 接线、版本管理和验收矩阵

后续 runtime 要接入现有授权、job 生命周期与凭据托管，实现源 snapshot/扫描、root resolver、安全 staging、deadline/cancel、执行状态持久化、observer、no-replace 发布与回执；这些接口尚未接到默认 MCP。清理/删除旧 staging 也要有同一 owner/operation 的证据和明确策略。真实连接层健康、权限与数据层成功分别验收。

| 场景 | 本次源码覆盖 | 真实环境状态 |
| --- | --- | --- |
| Linux 发起 push/pull，Linux rsync 或 rrsync peer | 合同与 argv/清单负例测试 | NOT_RUN |
| Windows MSYS2 本机发起 push/pull，Linux peer | 路径/身份/计划测试 | NOT_RUN |
| native Windows sshd 作为 rsync peer | 明确拒绝，不宣称可用 | NOT_VERIFIED |
| SFTP adapter、块增量或后端切换执行 | 只有合同 seam，无 adapter | NOT_IMPLEMENTED |
| 断网续传、partial 对账、SHA-256 独立扫描 | 验证逻辑与合成回执测试 | NOT_RUN |
| 接收 ACL/owner、symlink 竞态、无覆盖发布 | 可信证据边界与拒绝路径 | NOT_RUN |

源码测试命令为 `npm --prefix packages/typed-control test`，类型检查为 `npm --prefix packages/typed-control run check`。这些只证明相应源码/测试结果，不能替代以上真机验收。Windows CI 上运行纯函数测试同样不证明 Windows sshd 传输。

工具发现应报告缺失/可用/未验证，记录 package/build、依赖、能力探测与安全 baseline。升级前验证新构建的协议、rrsync 选项、路径/ACL/恢复矩阵，再发布到节点；回滚只允许仍满足安全 baseline 的完整可回溯构建。MSYS2 是滚动发行版，应遵循完整系统升级流程，不能只复制单个旧 exe。备份仍需独立快照、历史版本、离机副本和恢复演练。

官方依据（2026-11-07 观察，不是永久最新版本策略）：[rsync 发布说明](https://ftp.samba.org/pub/rsync/NEWS.html) 记录 2026-11-04 的 3.5.2 安全修复；[MSYS2 rsync](https://packages.msys2.org/packages/rsync) 当时为 3.5.2-1。实现限制见 [rsync 手册](https://rsync.samba.org/ftp/rsync/rsync.1)、[rrsync 手册](https://rsync.samba.org/ftp/rsync/rrsync.1)、[rrsync v3.5.2 源码](https://github.com/RsyncProject/rsync/blob/v3.5.2/support/rrsync)、[MSYS2 路径](https://www.msys2.org/docs/filesystem-paths/)、[symlink](https://www.msys2.org/docs/symlinks/)、[升级](https://www.msys2.org/docs/updating/)、[Microsoft OpenSSH 配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration) 和 [Windows 文件命名](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)。

## English

<!-- topic:boundary -->
### Layers, status and trust boundary

`fleet.file.transfer` is an optional node capability under the [#36 Artifact workstream](https://github.com/youling/ghostfleet/issues/36), which incorporates [#34](https://github.com/youling/ghostfleet/issues/34). Tailscale, Cloudflare and other networks provide connectivity; existing Fleet identity, authority, SSH and jobs provide controlled execution; rsync-over-SSH and a future SFTP adapter carry data. rsync is neither another remote-control network nor a backup, snapshot or version-history system. Authorized node data sessions carry large files without forwarding their contents through MCP stdout or Worker bodies.

This delivery contains pure functions in `packages/typed-control`: strict validation, an rsync argument plan, and complete manifest/receipt consistency verification. Importing creates no directories, installs nothing, connects to no host, starts no process, registers no MCP tool and creates no second task database. `SOURCE_PLAN_ONLY` is not deployment or acceptance. SFTP has a contract enum and replacement seam, but no execution adapter or claimed rsync block-delta semantics.

Ordinary transfers use an authorized directory's normal OS identity. Installation, protected paths and administrator actions follow existing privileged authorization. The business owner decides file purpose and retention; this capability adds no mandatory central foreman role. Missing rsync disables that backend, not overall node enrollment.

The **trusted runtime** supplies `FileTransferPlanningContext` and observer receipts. They must not be Agent-controlled tool arguments. The library checks consistency; it does not authenticate signatures, host pins, ACLs or observation times. Integration reuses current node UID, actor, policy, transport proof, jobs/receipts and dispatch state, and rechecks currentness before execution. Context/plan digests support reconciliation. Raw plans contain protected deployment paths, config and file names; they are not automatically safe public telemetry.

<!-- topic:contract -->
### V1 contract and ordinary file profile

`validateFileTransferIntent` requires explicit schema/capability/operation/actor/work/policy, source/destination node UID and root references with relative paths, direction/backend/profile, stable source version, manifest SHA-256, `overwrite: "deny"`, `delete_source: false` and `delete_extraneous: false`. Unknown fields, raw commands/options, identity mismatch, changed approval digest, expired approval and policy drift fail closed. Approval binding comes from existing authenticated authority; it does not introduce a new privileged approval role for every file.

`portable-files-v1` represents ordinary file bytes and explicit directories. The manifest records every file's size and SHA-256, every directory, complete file/directory counts and total bytes, and a stable source version. Parents must be explicit; empty files/directories work. Entries sort by path; UTF-8 JSON with sorted object keys gives the manifest digest. Inputs are detached and frozen. Accessors, non-JSON values, cycles, duplicate names and extra fields fail. Limits are 100,000 entries, 4,096 characters per relative path, 255 per component and safe-integer total bytes.

Portable names use NFC and relative `/` separators. Absolute/drive/UNC paths, traversal, empty components, controls, lone UTF-16 surrogates, Windows reserved names/characters and trailing dots/spaces are rejected; valid astral pairs such as emoji remain supported. Conservative uppercase folding rejects case collisions; parent spelling must also match exactly. `.ghostfleet-transfer` and `.ghostfleet-partial` components are executor-reserved. This conservative profile cannot prove every filesystem's Unicode or long-path behavior; receiver acceptance remains necessary.

Symlinks, Windows reparse points, devices/sockets and unknown metadata fail. V1 does not preserve ACLs, owner/group, POSIX modes, xattrs, ADS, hardlink relationships or source timestamps, and does not use `-a`. The destination owner is the authorized receiving identity, independently verified; receiving directory and safe creation policy determine permissions. This is ordinary content transfer, not complete system migration or disk recovery.

V1 publishes only to an **absent new destination child**; destination `.` is invalid. It does not merge into an existing final tree, even if some content matches. Delta/resume is limited to private staging for the same logical transfer. Existing project-tree merges, previous-version delta bases, approved replacement and deletion require a later explicit contract, not extra rsync options.

<!-- topic:backend -->
### rsync planning, Windows and restricted identities

`planRsyncFileTransfer(intent, manifest, trustedContext)` returns fixed program/argv, NUL-delimited stdin, clean-environment requirements, context/plan digests and a pending publication path. It never executes. Exactly one endpoint is remote; initiator identity matches push/pull. Only Linux peers are accepted. A Windows initiator uses approved MSYS2 rsync and SSH with local drive paths such as `/c/...`. V1 requires `rsync[.exe]` and `ssh[.exe]` in the same directory ending in `/usr/bin`, rejecting native Windows OpenSSH or mixed MSYS2 roots. The trusted runtime still verifies actual build provenance.

Directory operands permit letters, numbers, combining marks, spaces and limited path punctuation; shell metacharacters in these operands fail. Actual entry names travel in NUL stdin using `--from0 --files-from=-`, never in the SSH command. `--no-recursive --dirs --relative` and a full explicit list prevent directory entries from selecting unapproved children. Executable/config paths use POSIX tokens without spaces or shell syntax. SSH uses the approved alias/config digest and existing `pinned_host_key` proof, strict host checks, batch/identity restrictions, and disabled agent/port forwarding and TTY. Unknown capabilities fail; endpoints, pins and credentials are never guessed.

Safety is not inferred from a version-number threshold. Both ends require the **exact distribution package/build, security baseline reference, and tested `from0`, `files-from-no-recursion`, `remote-arg-escaping`, `partial-dir` capabilities**. Distribution backports may satisfy a baseline. The runtime verifies actual binaries/dependencies, fixed remote `rsync` resolution and SSH config, prevents uncontrolled shell startup files, checks the config digest and supplies an explicitly approved child environment. It must not merge the entire parent environment. Necessary MSYS2/Windows system variables also need an explicit allowlist. Plans set `RSYNC_OLD_ARGS=0` and `RSYNC_PROTECT_ARGS=0`; concealed arguments are not silently enabled.

SFTP-only accounts cannot execute remote rsync. Linux `rrsync` can restrict a key to a directory and access direction, subject to acceptance of its exact wrapper, shell, permissions and race defenses. It must inspect server arguments, so this plan does not use `-s` / `--protect-args`. Its `-no-overwrite` conflicts with partial-dir; that combination fails instead of removing a protection. Configure and test `-ro` or `-wo`, `-no-del` and other appropriate restrictions separately. Plans never add deletion, source removal, `--inplace` or daemon mode.

Native Windows sshd receiver status is **NOT_VERIFIED**. Microsoft's `ChrootDirectory` applies to SFTP, not rsync shell confinement. MSYS2 symlink defaults, Windows ACL inheritance, case/path conversion, locked files, SSH shell quoting/environment and non-Linux `rrsync` race protection require separate validation. Passing Windows initiator plans does not establish bidirectional Windows/Linux server acceptance.

<!-- topic:verification -->
### Staging, independent observation and UNKNOWN

Staging is fixed under the destination root at `.ghostfleet-transfer/<intent digest>/incoming`, with internal `.ghostfleet-partial` directories. Before dispatch the runtime creates it with the correct owner and restrictive ACL/umask, prevents other identities writing, checks the full path and contents for symlinks/reparse points, verifies a stable source snapshot/version and checks that the final target is still absent. `new` requires empty staging; `resume-matching` requires the same operation/intent/manifest/source version and a verified subset inventory. A supplied boolean is not OS evidence.

Existing jobs/transports retain execution state; do not create a second transfer task authority. If dispatch may have happened, persist `UNKNOWN` or `MAY_HAVE_EXECUTED`, reconcile that operation/process/partial/target first, and reject a new plan. `canChangeFileTransferBackend` returns true only for trusted `NOT_DISPATCHED` evidence. It does not authorize the replacement: a changed backend produces a new intent that must be rebound to authority. Timeout or disconnect never proves absence of side effects.

After transfer an authenticated no-follow observer scans all staging content and independently reads every file to compute SHA-256. It proves no missing/extra entries, same-size corruption, name collisions or source-version change. Source version must denote an immutable snapshot or meaningful stability verification, not an echoed caller string. Residual partial metadata cannot enter the published manifest; the runtime reconciles ownership, handles it, and rescans. `verifyFileTransferManifest` compares complete inventories/counts/bytes but cannot itself prove that its input came from an exhaustive scan.

The runtime then needs an accepted **no-replace** atomic publication mechanism to prevent destination races, followed by owner/content/publication verification and a protected receipt. A successful copy or directory rename alone does not establish atomic cross-filesystem publication. The library does not publish. `verifyFileTransferReceipt` returns `verified: true` only for matching operation/intent/actor/work/policy/nodes/backend, exit zero, a complete matching manifest, stable source version, correct destination owner and no-replace publication evidence. Exit zero, sizes or rsync's own checksums alone are insufficient. FAILED/UNKNOWN require reconciliation, not automatic retry.

<!-- topic:lifecycle -->
### Integration, version management and acceptance matrix

Runtime integration still needs existing authorization/jobs and credential custody, source snapshots/scanning, root resolution, secure staging, deadlines/cancellation, persistent dispatch state, observers, no-replace publication and receipts. None is wired to default MCP by this delivery. Old staging cleanup also needs same-owner/operation evidence and explicit policy. Connection health, authorization and data success remain separately verified.

| Scenario | Source coverage here | Real environment status |
| --- | --- | --- |
| Linux push/pull with Linux rsync or rrsync peer | Contract, argv and inventory rejection tests | NOT_RUN |
| Local Windows MSYS2 push/pull with Linux peer | Path, identity and plan tests | NOT_RUN |
| Native Windows sshd as rsync peer | Explicit rejection | NOT_VERIFIED |
| SFTP adapter, block-delta or backend replacement execution | Contract seam only, no adapter | NOT_IMPLEMENTED |
| Disconnect/resume, partial reconciliation, independent SHA-256 scan | Logic and synthetic receipt tests | NOT_RUN |
| Receiver ACL/owner, symlink races, no-replace publication | Evidence boundary and rejection paths | NOT_RUN |

Run source tests with `npm --prefix packages/typed-control test` and type checks with `npm --prefix packages/typed-control run check`. Source checks do not replace the real acceptance above. Running pure functions in Windows CI does not test Windows sshd transfers.

Discovery reports missing/available/unverified tools and records package/build, dependencies, capability probes and security baseline. Before rollout, test the new build's protocol, rrsync options, paths/ACLs and recovery matrix. Roll back only to a traceable complete build still satisfying the security baseline. MSYS2 is rolling-release software; follow its full-system upgrade procedure instead of copying an old executable. Backups still require independent snapshots, history, offline copies and restore exercises.

Primary references (observed 2026-11-07, not a perpetual latest-version policy): [rsync NEWS](https://ftp.samba.org/pub/rsync/NEWS.html) records 3.5.2 security fixes dated 2026-11-04; the [MSYS2 rsync package](https://packages.msys2.org/packages/rsync) was 3.5.2-1. See the [rsync manual](https://rsync.samba.org/ftp/rsync/rsync.1), [rrsync manual](https://rsync.samba.org/ftp/rsync/rrsync.1), [rrsync v3.5.2 source](https://github.com/RsyncProject/rsync/blob/v3.5.2/support/rrsync), MSYS2 [paths](https://www.msys2.org/docs/filesystem-paths/), [symlinks](https://www.msys2.org/docs/symlinks/) and [updates](https://www.msys2.org/docs/updating/), [Microsoft OpenSSH configuration](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration), and [Windows file naming](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
