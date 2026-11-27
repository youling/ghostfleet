# GhostFleet 0.4 configuration and execution / 配置与执行

## Linux First

通用改动在原生 Linux 或 WSL Debian 的 Linux 文件系统施工。TS/Node、Python、Rust、Git 与静态分析共享项目版本锁。Windows 桌面、设备、驱动、原生构建和调试继续由宿主管理，Windows 原生任务使用固定 PowerShell 脚本。WSL 按独立运行环境核对，不继承 Windows 的节点 UID 或管理权限。

Ordinary builds use Bash and native Linux storage, including in Debian under WSL. Windows keeps native tasks in fixed PowerShell scripts. The runtime identifies the requested OS, shell, distro, user and working directory explicitly. A WSL stopped receipt leaves the distribution stopped. The Windows host owner controls startup and native software.

```mermaid
flowchart LR
    L["Project lock and resource ownership matrix"] --> C["Compile a single target projection"]
    A["Existing controller authority and Fleet identity proof"] --> G["Verify projection, scope and SSH pin"]
    C --> G
    G --> F["Check machine identity and acquire target lock"]
    F --> P["Ansible plan, apply or readback"]
    P --> O["Existing installer or Converger when approved separately"]
    P --> R["Structured receipt and versioned recovery"]
```

## Project compilation and release gate / 项目编译与发布门

Use the [locked profiles and matrix](../../config/management/README.md) to compile a UID and platform selection. Compilation validates immutable layer bytes, explicit cross-domain path aliases, resource types and owners, duplicate writers and relevant overlap. The same check runs before any configuration connection and in CI. A generated inventory lasts one attempt. Real node addresses, UID bindings, account material and authorization remain with the original owner.

项目配置通常由基线、平台适配、能力层和单节点覆盖组成。包、路径、unit、端口、路由、凭据、存储和生命周期在连接前过矩阵。Windows 样例使用观察范围。经批准修改 Debian 或 WSL 的具体文件前，先验证实际挂载与父目录权限。显式别名把中性的项目路径映射到实例 owner 已批准的位置。

## One-target runbook / 单目标运行手册

Use a Linux controller with pinned `ansible-core 2.19.11`, native OpenSSH and Python. Keep the controller inputs in an owner-controlled directory. The owner supplies a short-lived `ghostfleet-config-authority/v1` file, with its existing verified Fleet identity input and gate. The scope binds one node UID and platform, controller UID and machine identity digest, projection digest, allowed operations and expiry. It also binds the target SSH address, login, exact host key and key file reference, target machine identity digest, the target-owned lock file and the exact Ansible entrypoint. See the [authority envelope example](../../config/convergence/authority.example.json) for the exact field names. The host owner provisions the target lock once in an owner-controlled directory. Use the same lock across configuration and recovery attempts for that target.

控制端每次重新编译项目锁，把目标投影和现有授权逐项核对，再通过既有 Fleet 身份门。首次 SSH 使用固定主机密钥。目标核对机身标识和平台后，持有同一个锁到本次结束。等待锁的第二个写者会被拒绝。目标拒绝连接、授权过期或锁会话脱落时，控制端结束当次执行并要求重新观测实际状态。

```sh
python3 -I scripts/ghostfleet_converge.py plan \
  --lock "$PROJECT_LOCK" --authority "$OWNER_AUTHORITY" --asset-directory "$ASSETS"

python3 -I scripts/ghostfleet_converge.py apply \
  --lock "$PROJECT_LOCK" --authority "$OWNER_AUTHORITY" --asset-directory "$ASSETS"

python3 -I scripts/ghostfleet_converge.py verify \
  --lock "$PROJECT_LOCK" --authority "$OWNER_AUTHORITY" --asset-directory "$ASSETS"
```

- For an exact file claim, store its untemplated bytes in the approved asset directory under their lowercase SHA-256. The controller verifies the bytes and the playbook compares remote SHA-256 and mode after applying. Plans report simulated changes and skipped tasks. The apply and verify receipts record actual state. Repeat apply to confirm zero changes.
- Approved root package operations require exact package versions and an existing Python APT module. The playbook checks installed versions and simulates the transaction to refuse removals, upgrades and unrelated installs. Its normal apt lock is distinct from the controller's per-node coordination lock.
- Each optional owner handoff uses a separate attempt and a managed lifecycle claim owned by GhostFleet or the existing Linux Converger. The owner provides its exact private profile and the original pinned runtime. The RC3 owner adapter checks each bootstrap member and calls `install.py plan|apply|status`. The Converger adapter checks the installed module and calls its original plan or explicitly authorized convergence. Converger plan reports plan-only status. Provider setup and identity recovery use their existing owner channels.
- Recover configuration by applying a separately approved previous project lock and then reading it back. Keep the same host pin and lock. Restore signed GhostFleet releases, lifecycle state, credentials and provider configuration through their original recovery mechanisms.

恢复一项文件或权限漂移时，对原授权重新核验并复跑同一配置。回退使用获准的前一项目锁，保留文件摘要、唯一写者与同一私有恢复入口。GhostFleet 自有签名更新、K3s 工作负载、Tailscale/Cloudflare 网络策略、Windows 设置和 WSL 生命周期沿各自 owner。候选未改变现役 0.3.0 安装包或兼容控制面。

## Runtime and exchange / 执行与交换区

```sh
python3 -I scripts/ghostfleet_runtime.py run "$REQUEST"
python3 -I scripts/ghostfleet_runtime.py exchange \
  --host "$HOST_AGENT_PROJECTION" --grant "$TASK_GRANT" --workspace "$TASK_WORKSPACE"
```

A run request has `os`, `shell`, `distro`, `user`, target-native absolute `cwd`, `argv`, `timeout_seconds` and `output_limit_bytes`. Linux and WSL accept `exec` with an executable or `bash` with a fixed script. Windows accepts `powershell` with a native `.ps1` file and a null distro. The output separates stdout, stderr and the child exit code. Use the host-resolved executable and path form for the requested OS, including explicit conversion when an approved exchange file moves between Windows and WSL.

交换区使用现有 HOST_AGENT 的 `paths.exchange.in/out`。一次授权只关联一个任务和文件，包括方向、来源、用途、接收方、字节数、摘要和有效期。交接合成样本副本、报告和制品，读取端核对哈希。凭据、浏览器状态、工作树、运行中数据库、整盘和构建缓存留在原 owner 的执行域。

The exchange command consumes owner-resolved input and output paths. Each grant identifies one task, direction, safe filename, approved source and receiver, expected bytes and expiry. The receiver confirms the stored bytes. Host ACLs enforce input read-only and output ownership. The CLI does not decide who may enroll WSL or operate a production host.

## Acceptance / 验收范围

The configuration fixture uses the same project lock on a disposable native-boot Debian VM and a separate Debian WSL distribution. A scoped path alias selects the approved fixture directory on each instance. Acceptance records initial apply, no-op rerun, one-object drift repair, wrong UID without target contact, concurrent writer refusal, previous-lock recovery, and persistent files and identity after restart. The [checked-in smoke fixture and lock](../../config/management/examples/lab/toolchain) pin Node 22.23.5, TypeScript 5.9.3, Python 3.13.5, Rust 1.85.1 and binutils readelf 2.44. The same inputs produce a synthetic static ELF for inspection on both Linux environments.

0.4.0 的主机试点、生产权限和发行审批沿原 owner。隔离通过后，按现有验收记录实际适用的平台、工具版本和产品边界。交付后以稳定维护、修复和性能工作为主，新的核心组件按独立架构裁决处理。
