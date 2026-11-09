# Approved administrator command v1 / 经批准的管理员命令 v1

## 中文

<!-- topic:boundary -->
### 能力与信任边界

这是 Linux 的可选 **command-effect/status-only** 实现：部署方提供可信 Human 审批签发器后，专用 ops SSH 入口可以接收一份签名的精确命令，快速返回启动回执，再通过原租约查询或撤销。它没有生产签发器、Human 审批界面、MCP 工具注册、交互 shell 或诊断输出读取。源码合入、配置校验或 `STARTED` 都不代表任一真实设备已拥有管理员运维能力。Windows 管理员后端不在本阶段范围内。

权限仍分 `NORMAL` 与 `HUMAN_APPROVED_ADMIN`。普通 `fleet.exec`、普通 SSH 身份和网络可达性不授予管理员权限。通用管理员命令由 Human 审批具体 `argv/cwd/env` 和副作用；产品不把它改造成逐个业务命令的永久 allowlist。V2/V3 的 `root-probe`、`android-udev-access` 保留原协议和行为。

**批准的 root 命令是受信任的管理员代码。** systemd/cgroup 管理进程生命周期，不把恶意 root 程序沙箱化。被批准的 root 可以更改系统配置、创建服务或损坏本地账本；本机制不能抵抗已完全失陷的 root。TTL/撤销终止受管进程，不会撤销已经发生的文件、账户、网络或持久服务变更。每份审批必须附 `rollback_ref`；真实回滚需要针对操作另行执行和验收，回执固定 `persistent_effects_rolled_back:false`。

### 代码位置

- 节点入口：`fleet_privctl.py` 的 V4 分流；`fleet_admin_command.py` 的签名、持久账本和 systemd 后端。
- 配置事务：`fleet_admin_install.py`；基础 ops 安装器仅安装模块，缺少 V4 配置时不启用能力。
- 控制端：`runApprovedAdminCommand` 可选库接口，从可信 `ControlActor` 计算主体；不接受工具输入声称的 actor，不提供默认执行后端。
- 信任根：root 管理的配置、Ed25519 公钥、已安装的节点身份/代际、独立 ops SSH 身份。签发私钥不得放在普通执行节点或自动化普通身份可读位置。

<!-- topic:wire -->
### 审批和协议

线协议 `youling-fleet-privileged-operations/v4` 仅有六个字段：`schema, action, node_uid, actor_ref, lease_b64, signature_b64`。`action` 是 `execute/status/cancel`。签名是 Ed25519，消息为 `b"ghostfleet-approved-admin-command/v1\0" + exact_decoded_lease_bytes`；不重序列化收到的签名载荷。Base64 必须规范编码；拒绝重复 JSON 字段、未知字段、无效 UTF-8、NaN、超限值和缺失字段。实现调用 `cryptography`，不自写签名算法。

租约 `ghostfleet-approved-admin-lease/v1` 的必填字段如下。

| 字段 | 含义 |
| --- | --- |
| `lease_id, request_id, operation_id` | 稳定审批、请求和操作引用；租约 ID 是一次性执行围栏 |
| `operation, issuer_id` | `admin.command` 与 root 配置认可的签发公钥 ID |
| `node_uid, subject_ref, audience_ref` | 节点、已认证主体摘要、固定受众 `ghostfleet-approved-admin-command/v1` |
| `generation, profile_generation` | 当前专用 ops 安装和授权配置代际 |
| `work_ref, purpose, approval_ref, rollback_ref` | 工作、目的、Human 审批和回滚依据 |
| `issued_at, not_before, expires_at` | 整数 Unix 秒；最大 TTL 为节点配置上限且不超过 900 秒 |
| `max_uses, max_runtime_seconds` | 使用次数固定为 1；运行预算为 1–900 秒且受节点上限约束 |
| `command` | 精确 `argv, cwd, env, executable_sha256, output` |

命令最多 64 个参数、共 8192 UTF-8 字节，执行器必须是绝对路径。节点校验执行器 SHA-256、执行器及其所有父目录的 root 所有权和不可被 group/other 写入；cwd 也必须由 root 保护。配置、状态和账本拒绝符号链接；系统执行器允许 root 保护且目标路径同样受保护的符号链接。环境重新构建，拒绝 `PATH/HOME/LD_*/PYTHON*` 等加载器和身份覆盖。`output` 仅接受 `discard`，stdin/stdout/stderr 不连接调用方。

**argv 摘要不等于所有外部输入内容被固定。** 例如 `python /writable/script.py`、`sh -c 'source ...'`、包管理器配置或命令参数中的文件会由受信任的 root 命令继续解释。审批者必须核验这些外部依赖的所有权和内容，或将所需逻辑放在已批准的字面参数、单独核验的不可变制品中。本版本自动哈希首个执行器，不宣称自动固定任意参数引用、动态链接库、解释器模块或全部系统配置。

节点配置只绑定一个 `subject_ref`。控制端必须保持独立的 ops key/target，并设置 `CONTROL_APPROVED_ADMIN_POLICY_JSON`，映射 `node_uid` 到 `generation, profile_generation, subject_ref, issuer_ids`。节点再次验签和核对本地身份；控制端的 policy 投影不能替代节点信任根。多主体授权、正式签发/撤销服务和 UI 仍需独立交付。

引用字段约束：租约中的 `approval_ref` 使用有界 ref 标识符，不是自由文本；不要传入带 `#` fragment 的 GitHub 评论 URL。可选请求字段应由部署签发端按当前 request ID 生成合规引用；人类可读链接放在 `work_ref/purpose`。签发端必须将 TTL/runtime 限制在节点 Host 配置上限内，而不是要求节点放宽上限。详见[生产节点纳管与特权金丝雀 runbook](PRODUCTION_NODE_ONBOARDING_AND_ADMIN_CANARY_V1.md)。

<!-- topic:execution -->
### 执行、撤销和不确定性

配置目录内的生命周期锁将安装 `apply/rollback` 和 Executor/child 的最终准入串行化，统一按 authority→lease 顺序加锁；Executor 每次请求均在锁内重读当前配置。等待命令完成或 OS stop 时释放这些锁，但持久化 UNKNOWN/revoked 会阻止安装器越过未完成操作。状态目录首次纳管后不可改变，卸载再安装也保留原账本和租约 tombstone。

同一租约使用 root 私有目录中的 `flock` 和 fsync/原子替换账本。签名失败不预留执行。成功预留后，即使 SSH 断开或执行结果不明，也不再次执行；更换 `request_id/operation_id` 不能绕过原 `lease_id` 的一次性约束。重复状态可回读，冲突载荷拒绝。

systemd 250+、统一 cgroup v2、root 管理且含签名库的 Python 缺一不可。缺失、只读 cgroup、未知停止结果均 fail closed。后端先建立绝对到期计时器，再启动固定 `system.slice` 中的瞬态 unit；`RuntimeMaxSec` 取签名运行预算与剩余期限的较小值，额外保存单调时钟期限。即使控制连接断开，OS 运行时限继续生效。unit 只接收 root 管理的包装器、配置路径和租约摘要，命令本体留在 root 私有账本中。

原 SSH 入口有 30 秒 RPC 上限，因此 execute 不同步等待命令结束。`STARTED` 表示已提交受管执行，控制端返回 `RUNNING`；只有子包装器观察命令退出且本 cgroup 无其它进程后才写 `SUCCEEDED/FAILED`。`setsid` 子进程仍属于该 cgroup。最终撤销检查和 `Popen` 共享账本锁：取消先获得锁则不再启动新命令；启动先获得锁则取消随后停止整个 unit。

`cancel` 先持久化 revoked，再请求 OS 停止。仅 `ActiveState=failed/inactive` 或 `MainPID=0` 不够，必须核验固定 cgroup 的 `populated=0` 以及全部子 cgroup 的 `cgroup.procs` 为空，或确认 cgroup 已消失。无法证明时返回 `UNKNOWN`，重复取消不能把不确定性当成已停止。到期、取消与状态查询沿用原签名租约；不会自动签发替代租约。`NOT_FOUND/RESERVED/UNKNOWN` 都不能证明无副作用，`retry_safe` 固定为 false。

<!-- topic:installation -->
### 安装、验收与回滚

首次安装必须有已经合法取得的独立 root 通路。普通 SSH 会话、旧失效恢复凭据和源码本身不能创造 root 权限。先按 [运维文档](../OPERATIONS.md) 建立专用 `ghostfleet-ops` 入口、独立 SSH key、forced command、限定 sudoers 和当前代际；没有 sudo/基础入口时应交付 bootstrap 待办，不伪报安装完成。基础安装器的 `--check/--apply` 仍须部署方明确提供普通身份、专用公钥及代际值。

部署方先在受保护路径放置已审查源码，并为 `/usr/bin/python3 -I` 以及配置选择的 Python 安装并核验 `cryptography==50.0.2`。`runtime-python[admin]` 声明该依赖，但给用户级 Python 安装 extra 不会自动使系统入口 Python 获得依赖。安装器的 check/verify 分别检查固定系统入口解释器和配置中的子进程解释器，要求签名库版本为 50.0.2；只给 venv 安装库不能通过系统入口检查。配置检查只验证现有依赖，不自动联网安装软件。基础安装器将 V4 模块复制到 `/usr/local/libexec/youling-fleet/fleet_admin_command.py`。

在 root 私有位置准备候选 JSON，字段如下；尖括号必须替换为部署方已验收的真实值，不能直接把模板当授权。

```json
{
  "schema": "ghostfleet-approved-admin-config/v1",
  "node_uid": "<canonical-node-uid>",
  "subject_ref": "<sha256-of-authKind-colon-authenticated-userId>",
  "audience_ref": "ghostfleet-approved-admin-command/v1",
  "generation": "<64-lowercase-hex-current-ops-generation>",
  "profile_generation": "sha256:<64-lowercase-hex-current-profile>",
  "issuer_keys": {"human-issuer-v1": "<base64-of-raw-32-byte-Ed25519-public-key>"},
  "state_dir": "/var/lib/youling-fleet/privileged-operations/admin-command",
  "python_executable": "/usr/bin/python3",
  "helper_path": "/usr/local/libexec/youling-fleet/fleet_admin_command.py",
  "node_report_path": "/var/lib/fleet/enrollment-report.json",
  "control_state_path": "/etc/youling-fleet/privileged-operations/control.json",
  "max_ttl_seconds": 300,
  "max_runtime_seconds": 120
}
```

在独立 root 会话中，用已审源码中的 `fleet_admin_install.py`：

```sh
/usr/bin/python3 -I fleet_admin_install.py check --config-source /root/admin-command-candidate.json
/usr/bin/sha256sum /root/admin-command-candidate.json
/usr/bin/python3 -I fleet_admin_install.py apply --config-source /root/admin-command-candidate.json --expected-source-sha256 <reviewed-source-sha256> --expected-current-sha256 ABSENT
/usr/bin/python3 -I fleet_admin_install.py verify
```

`apply` 校验精确源文件摘要与当前配置摘要，保存原配置字节和安装清单，再写 root:root 0600 配置；state 为 0700。已有配置时，把 `ABSENT` 替换为审查过的当前摘要。保留账本，不能通过清空账本或更换状态目录重置使用次数。存在未解决的 RESERVED/STARTED/UNKNOWN 时须先对账。`verify` 的 `live_approval_execution:NOT_RUN` 明确表示尚未验收真实命令。

回滚调用 `rollback --expected-current-sha256 <applied-config-sha256>`，仅恢复**首次纳管前**保存在清单中的精确配置前像，不是撤销最近一次升级；如果安装前不存在 V4 配置，则移除该配置。保留执行回执，普通控制身份和 V2/V3 不变。此回滚只撤销 V4 配置安装，不回滚已批准 root 命令的副作用。升级模块、轮换签发 key 或代际仍需部署方在无进行中操作的维护窗口独立验收。

<!-- topic:verification -->
### 证据层级与尚未交付部分

`python -m unittest discover -s packages/runtime-python/tests -p test_approved_admin_command.py -v` 验证真实 Ed25519、六进程持久锁、取消/启动竞争、配置前像与回滚等。单元测试中的 systemd/cgroup 后端为确定性替身，不证明 OS root 执行。TS 测试验证已认证主体绑定、独立凭据入口、启动/完成区别以及不确定响应处理。

`approved-admin-disposable` workflow 只在无 secret、只读仓库权限的 GitHub-hosted Ubuntu runner 中运行。它复制已审模块到 root 保护的临时目录，使用一次性测试签发 key 和真实 systemd/cgroup v2，验证 root 效果、拒绝条件、一次性执行、cancel 和断开后的 TTL，包括 `setsid` 后代。实际通过的 run 才能作为相应源码版本的 OS 证据；云开发容器缺少 systemd 时应拒绝运行，不能替代通过结果。该验收直接调用真实节点后端，**不是生产 SSH、Human 签发/UI、真实设备安装的端到端验收**。

本阶段没有自动回收终态 transient unit/timer。部署方应在维护中按终态回执和精确 unit 名清理它们，并核对 cgroup 空状态；保留账本和租约 tombstone，不删除 UNKNOWN 记录来重试。长期自动回收仍待后续实现。

后续交付包括生产 Human 审批签发与 key 保管、入口工具/Console、受授权诊断输出或 artifact 读取、交互 session、跨主体策略、设备首次 root bootstrap 和逐节点部署验收。ChatGPT 对话内审批的可选客户端合同、身份分离、OAuth、移动端限制与验收门见[对话内人工审批 v1](IN_CHAT_HUMAN_APPROVAL_V1.md)。当前版本没有这些能力，不应据此宣称“一般管理员运维已全部可用”。

## English

<!-- topic:boundary -->
### Capability and trust boundary

This optional Linux implementation provides **command-effect/status-only** execution. After a deployment supplies a trusted Human approval issuer, the dedicated ops SSH entry accepts an exactly signed command, promptly returns its admission receipt, and supports status/cancel with the original lease. It has no production issuer, Human approval UI, MCP registration, interactive shell or diagnostic-output retrieval. Merged source, configuration verification and `STARTED` do not prove administrator access on a real device. A Windows administrator backend is outside this tranche.

The two authority tiers remain `NORMAL` and `HUMAN_APPROVED_ADMIN`. Ordinary `fleet.exec`, ordinary SSH identity and network reachability do not grant administrator authority. A Human approves the exact general command and its effects; the product does not turn general administration into a permanent per-business-command allowlist. Existing V2/V3 `root-probe` and `android-udev-access` retain their protocols and behavior.

**Approved root commands are trusted administrator code.** systemd/cgroup bounds process lifecycles; it does not sandbox hostile root. Approved root code can change system configuration, create services or corrupt the local ledger. A fully compromised root is outside this trust boundary. TTL/cancellation does not undo completed file, account, network or persistent-service changes. Every approval carries a `rollback_ref`; actual rollback needs operation-specific execution and acceptance. Receipts always say `persistent_effects_rolled_back:false`.

### Source locations

- Node entry: the V4 branch in `fleet_privctl.py`; signature, persistent ledger and systemd backend in `fleet_admin_command.py`.
- Configuration transactions: `fleet_admin_install.py`. The base ops installer copies the module but does not enable V4 without its configuration.
- Controller: the optional `runApprovedAdminCommand` library seam derives the subject from a trusted `ControlActor`. It accepts no caller-asserted actor and supplies no default execution backend.
- Trust roots: root-managed configuration, Ed25519 public keys, installed node identity/generations and a separate ops SSH identity. Issuer private keys must not be readable by ordinary automation identities or placed on ordinary execution nodes.

<!-- topic:wire -->
### Approval and protocol

The `youling-fleet-privileged-operations/v4` envelope contains exactly `schema, action, node_uid, actor_ref, lease_b64, signature_b64`. Actions are `execute/status/cancel`. Ed25519 signs `b"ghostfleet-approved-admin-command/v1\0" + exact_decoded_lease_bytes`; received signed payloads are never reserialized for signature verification. Base64 must be canonical. Duplicate JSON keys, unknown/missing fields, invalid UTF-8, NaN and out-of-bound inputs are rejected. Verification uses `cryptography`, not a custom cryptographic implementation.

Required fields of `ghostfleet-approved-admin-lease/v1`:

| Fields | Meaning |
| --- | --- |
| `lease_id, request_id, operation_id` | Stable approval/request/operation references; the lease ID is the one-use fence |
| `operation, issuer_id` | `admin.command` and a public-key ID trusted by root configuration |
| `node_uid, subject_ref, audience_ref` | Node, authenticated-subject digest and fixed audience `ghostfleet-approved-admin-command/v1` |
| `generation, profile_generation` | Current dedicated ops installation and authorization-profile generations |
| `work_ref, purpose, approval_ref, rollback_ref` | Work, purpose, Human approval and rollback references |
| `issued_at, not_before, expires_at` | Integer Unix seconds, bounded by the configured TTL and at most 900 seconds |
| `max_uses, max_runtime_seconds` | Exactly one use; 1–900 seconds runtime, bounded by node configuration |
| `command` | Exact `argv, cwd, env, executable_sha256, output` |

Commands have at most 64 arguments and 8192 total UTF-8 bytes. The executable path is absolute. The node verifies its SHA-256 and root ownership/non-group-or-other-writability of the executable and every ancestor; cwd must also be protected by root. Configuration/state/ledger paths reject symlinks. System executable symlinks are accepted only when both original and resolved paths are root-protected. The environment is rebuilt, with loader/identity overrides such as `PATH/HOME/LD_*/PYTHON*` denied. Only `output:discard` is accepted; stdin/stdout/stderr do not connect to the caller.

**An argv digest does not freeze all external inputs.** Examples include `python /writable/script.py`, `sh -c 'source ...'`, package-manager configuration and file arguments interpreted by the trusted command. The approver must verify their ownership and contents, or use approved literal arguments and separately verified immutable artifacts. This version automatically hashes the first executable, not arbitrary file arguments, dynamic libraries, interpreter modules or all system configuration.

Node configuration binds one `subject_ref`. The controller retains independent ops credentials/targets and sets `CONTROL_APPROVED_ADMIN_POLICY_JSON`, mapping node UID to `generation, profile_generation, subject_ref, issuer_ids`. The node separately verifies signature/local identity; the controller projection does not replace node trust roots. Multiple-subject authorization, a production issuance/revocation service and UI remain separate work.

Reference fields are bounded protocol identifiers, not free-form text: do not put a GitHub comment URL containing a `#` fragment in `approval_ref`. The deployment issuer should generate a compliant reference from the current request ID when the optional request field is omitted; readable links belong in `work_ref/purpose`. The issuer must clamp TTL/runtime to the node Host-configured limits instead of asking the node to relax them. See the [production node onboarding and admin canary runbook](PRODUCTION_NODE_ONBOARDING_AND_ADMIN_CANARY_V1.md).

<!-- topic:execution -->
### Execution, cancellation and uncertainty

A lifecycle lock beside the canonical configuration serializes installer `apply/rollback` with final Executor/child admission. Lock order is authority→lease, and every Executor request reloads current configuration under that lock. Process-completion and OS-stop waits release these locks; durable UNKNOWN/revoked records still block installation across unresolved work. The state namespace is immutable after first management, including rollback/reinstall, preserving consumed-lease tombstones.

The root-private ledger uses `flock` plus fsync/atomic replacement. Invalid signatures never reserve execution. Once reserved, SSH loss or an uncertain dispatch does not allow execution again; changing request/operation IDs cannot bypass the original lease ID. Duplicates are readable; conflicting signed bytes under a consumed lease ID are rejected.

The backend requires systemd 250+, unified cgroup v2 and a root-managed Python with the signature library. Missing dependencies, read-only cgroups and unknown stop outcomes fail closed. An absolute expiry timer is installed before the transient unit in fixed `system.slice`; `RuntimeMaxSec` is the smaller of the signed runtime and remaining deadline, with an additional local monotonic deadline. OS lifetime bounds survive disconnected control requests. The unit receives only the trusted wrapper, config path and lease hash; command contents stay in the root-private ledger.

The existing SSH entry has a 30-second RPC bound, so execute does not wait for completion. `STARTED` means managed execution was submitted and maps to controller `RUNNING`. Only the child wrapper observing command exit and no remaining cgroup processes writes `SUCCEEDED/FAILED`. `setsid` descendants remain in the cgroup. Final revocation/deadline checks and `Popen` share the admission lock: cancellation winning the lock prevents a new command; a start winning the lock is subsequently stopped as a full unit.

Cancellation durably marks revoked before asking the OS to stop. `ActiveState=failed/inactive` or `MainPID=0` alone is insufficient. The backend requires the fixed cgroup's `populated=0` and empty `cgroup.procs` throughout its subtree, or confirmed cgroup disappearance. Unprovable termination is `UNKNOWN`; repeated cancellation does not turn uncertainty into success. Expiry/cancel/status reuse the original signed lease and never mint a replacement automatically. `NOT_FOUND/RESERVED/UNKNOWN` do not prove no effects; `retry_safe` is always false.

<!-- topic:installation -->
### Installation, verification and rollback

First installation requires an independently authorized root path. Ordinary SSH, expired recovery credentials and source code cannot create root authority. First establish the dedicated `ghostfleet-ops` entry, separate SSH key, forced command, scoped sudoers and current generations using [Operations](../OPERATIONS.md). Missing sudo/base ingress is a bootstrap dependency, not a completed installation. The existing base installer's `--check/--apply` still requires deployment-provided ordinary identity, dedicated public key and generation values.

Place reviewed sources in a protected directory. Install and verify `cryptography==50.0.2` for `/usr/bin/python3 -I` and the configured interpreter. The `runtime-python[admin]` extra declares the dependency, but installation into a user Python does not automatically provide it to the system entry interpreter. Installer check/verify separately probe the fixed system ingress interpreter and configured child interpreter, requiring signature-library version 50.0.2; a venv-only installation cannot satisfy the ingress probe. Configuration checks validate existing dependencies and never install packages from the network. The base installer copies the V4 module to `/usr/local/libexec/youling-fleet/fleet_admin_command.py`.

Prepare a root-private JSON candidate:

```json
{
  "schema": "ghostfleet-approved-admin-config/v1",
  "node_uid": "<canonical-node-uid>",
  "subject_ref": "<sha256-of-authKind-colon-authenticated-userId>",
  "audience_ref": "ghostfleet-approved-admin-command/v1",
  "generation": "<64-lowercase-hex-current-ops-generation>",
  "profile_generation": "sha256:<64-lowercase-hex-current-profile>",
  "issuer_keys": {"human-issuer-v1": "<base64-of-raw-32-byte-Ed25519-public-key>"},
  "state_dir": "/var/lib/youling-fleet/privileged-operations/admin-command",
  "python_executable": "/usr/bin/python3",
  "helper_path": "/usr/local/libexec/youling-fleet/fleet_admin_command.py",
  "node_report_path": "/var/lib/fleet/enrollment-report.json",
  "control_state_path": "/etc/youling-fleet/privileged-operations/control.json",
  "max_ttl_seconds": 300,
  "max_runtime_seconds": 120
}
```

 Replace every angle-bracket placeholder with an independently accepted deployment value. Its node report is `/var/lib/fleet/enrollment-report.json`, base control state `/etc/youling-fleet/privileged-operations/control.json`, root-private state directory `/var/lib/youling-fleet/privileged-operations/admin-command`, and standard helper/interpreter paths are shown above. Public-key values are base64 raw 32-byte Ed25519 keys; `subject_ref` is SHA-256 of `authKind + ':' + authenticated userId`. Copying a template does not grant authority.

In an independent root session, run the reviewed `fleet_admin_install.py`:

```sh
/usr/bin/python3 -I fleet_admin_install.py check --config-source /root/admin-command-candidate.json
/usr/bin/sha256sum /root/admin-command-candidate.json
/usr/bin/python3 -I fleet_admin_install.py apply --config-source /root/admin-command-candidate.json --expected-source-sha256 <reviewed-source-sha256> --expected-current-sha256 ABSENT
/usr/bin/python3 -I fleet_admin_install.py verify
```

 `apply` requires both the reviewed source digest and expected current digest (`ABSENT` only for a first install), preserves exact configuration preimage/installation manifest, and writes root:root mode 0600 configuration with mode 0700 state. Preserve the ledger; clearing it or switching state directories must not reset use counts. Unresolved RESERVED/STARTED/UNKNOWN records require reconciliation. `verify` explicitly reports `live_approval_execution:NOT_RUN`.

Rollback uses `rollback --expected-current-sha256 <applied-config-sha256>` and restores only the exact configuration preimage from **before first management**, not the previous upgrade. If V4 configuration did not exist before installation, it removes that configuration. Receipts remain; ordinary control and V2/V3 are unchanged. This rolls back V4 configuration installation, not approved commands' persistent effects. Module upgrades, issuer-key or generation rotation require separate deployment acceptance in a maintenance window without active operations.

<!-- topic:verification -->
### Evidence levels and remaining delivery

`python -m unittest discover -s packages/runtime-python/tests -p test_approved_admin_command.py -v` tests real Ed25519, six-process durable locking, cancellation/start races, configuration preimage and rollback. Its systemd/cgroup backends are deterministic doubles, not proof of OS root execution. TS tests verify authenticated binding, independent ingress credentials, start-versus-completion semantics and uncertain replies.

The `approved-admin-disposable` workflow runs only on a GitHub-hosted Ubuntu runner with no secrets and read-only repository permissions. It copies reviewed modules to a root-protected temporary directory and uses an ephemeral test issuer with real systemd/cgroup v2 to test root effects, denials, one-use fencing, cancellation and disconnected TTL, including `setsid` descendants. Only a successful run is OS evidence for that source revision. A cloud development container without systemd must refuse execution. This test calls the real node backend directly; **it is not end-to-end production SSH, Human issuance/UI or real-device installation acceptance**.

This tranche does not automatically reap terminal transient units/timers. The deployment owner must clean them by exact unit name after terminal-receipt/cgroup verification during maintenance, retaining the ledger and lease tombstones. Deleting UNKNOWN records to retry is prohibited. Automatic long-term reaping remains future work.

Remaining work includes production Human approval issuance/key custody, ingress tools/Console, authorized diagnostic output/artifact retrieval, interactive sessions, multiple-subject policy, first-root bootstrap and individual node deployment acceptance. The optional ChatGPT in-conversation approval contract, principal separation, OAuth, mobile limitation and acceptance gates are documented in [In-chat Human approval v1](IN_CHAT_HUMAN_APPROVAL_V1.md). The current tranche does not implement those and must not be advertised as complete general administrator operations.
