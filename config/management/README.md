# Locked configuration profiles / 固定配置投影

The compiler assembles a versioned baseline, one platform adapter, capability layers, and an optional per-UID override. Run it on the approved Linux controller against project inputs held by the deployment owner. It reads local files and emits input for the existing identity gate and execution plan.

编译器组合版本化基线、目标平台、能力层和可选的单 UID 覆盖。获准控制端在 Linux 原生文件系统读取部署 owner 持有的项目输入。输出供后续身份门禁、计划和写后读回使用。

~~~sh
python3 -I config/management/compile_profiles.py \
  --lock config/management/examples/lab/project.lock.json \
  --node-uid "$NODE_UID" \
  --platform debian13-amd64
~~~

Use `wsl-debian13-amd64` for the WSL adapter. The general example also describes `windows-amd64` in observation mode and illustrates tool version pins. Fill the target UID in a private copy of the instance override template, then pin that copy under the UID in the project lock. `examples/lab/rollback.lock.json` selects mode `0750` on the same lab directory, with the same file bytes. The shipped `README.txt` is the synthetic content asset. The example destination is neutral. In a disposable fixture, pin an explicit local scope mapping to the fixture user's approved directory before compiling. The general examples use illustrative package versions.

## Lock and projection / 锁和投影

- `ghostfleet-project-lock/v1` carries `version`, `matrix_sha256`, a `baseline` reference, and `platforms`. Each platform selects one `profile` reference, ordered `layers`, and optional `path_aliases`. Its optional `overrides` map is keyed by canonical node UID. A reference is a relative JSON path plus SHA-256 of its original bytes.
- Baseline, platform and capability files use `ghostfleet-config-layer/v1` with exact `type`, `name`, `version`, allowed `platforms` and `resources`. Layers add claims. A `ghostfleet-config-override/v1` names the exact `target` and patches `desired` fields on existing managed resource IDs. Ownership and resource identity remain part of the original layer.
- The `ghostfleet-target/v1` projection carries the UID and platform, locked input versions and digests, sorted claims, and `projection_sha256`. The digest covers compact UTF-8 JSON with sorted keys and no newline, excluding `projection_sha256`. `--expected-sha256` verifies an approved projection. Invalid, conflicting or drifted input exits 2 with one bounded error code on stderr.
- The `controller` record supplies the same `ghostfleet-config:<node_uid>` lock intent across configuration and recovery versions. Use the existing controller and target guard for actual exclusion. Multiple machines need common coordination from their owner. A projection provides neither a lease nor authorization.

项目锁定原文件字节、矩阵和所选能力。层只能添加声明。实例覆盖准确匹配 UID 和平台，只修改已有管理资源的 `desired`。控制端在每次执行前重新编译并与获准摘要对比。实际目标、访问授权、跨控制端排他和审计仍走现有入口。

## Ownership matrix / 资源归属矩阵

Claims record `id`, `kind`, `scope`, resource `key`, `owner`, `mode`, `consumers`, and a `recovery` label. Managed claims include typed `desired`. Observe claims request no writes. Recovery labels reference the owner's approved plans. Keep private artifacts and credentials with their authorized sources.

| Owner | Write surface | Consumers, update and recovery |
| --- | --- | --- |
| GhostFleet | Reporter identity and state, its systemd units and signed updates | Adopt and update through the existing installer and signed channel. Keep the UID and approved release and state recovery points. |
| Ansible | Approved host configuration and selected system packages | The approved controller executes on demand. File modes and data digests travel in the projection. Runner actions may cover a subset of the declaration matrix. Recompile the approved rollback lock and reuse the same write guard. |
| Linux Converger | Optional existing enrollment engine, pinned Tailscale package, descriptor and checkpoint | Select the existing Converger and its authority gate. A managed Tailscale package shares host apt/dpkg ownership with other package installers. Use its existing enrollment recovery contract. |
| K3s | Workloads, datastore, routes and published ports | Use the approved workload revision and datastore recovery. Host server and agent activation are exclusive. |
| Tailscale and Cloudflare | Their own service, credentials, connector and provider policy | Use existing provider tooling and keep independent SSH and approved rollback. Observe stock and alternate units together. The two configured activation alternatives are exclusive for one Linux runtime. |
| Windows and WSL | Windows native settings and WSL lifecycle stay with Windows. WSL owns its userspace. | Windows Ansible actions are outside the supported path. A WSL consumer requires separate Fleet enrollment and authorization before acquiring an independent writer or controller role. Follow the existing host exchange and rebuild contract. |
| OCI | Image/workload lifecycle and approved volume and port exposure | Use the existing image digest and owner volume recovery. Declare shared mounts and published ports explicitly. |

`package-db` is an ownership claim with no standalone action. A system claim uses `key: apt/dpkg` and `desired.state: managed`. Linux package writes implicitly claim the database and its state trees, even for distinct package names. The signed GhostFleet updater claims the separate `isolated-apt` namespace. A provider or Converger cannot independently write the system database when another engine already owns it.

资源归属以原 owner 为准。Ansible、Linux Converger、GhostFleet 安装器和 provider 工具各自负责原更新及回退。Windows 管原生配置和 WSL 生命周期，WSL 管用户态，K3s 与 OCI 分别沿工作负载和镜像合同。可用 `observe` 读取其他 owner 资源。

## Overlap normalization / 资源重叠

- Paths use absolute lexical names. Windows case, drive syntax and separators normalize to one key. Cross-domain mounts use explicit `path_aliases` entries with `from` and `to`, each specifying `{scope, path}`. Use the existing host-resolved exchange and mount contract. Ambiguous aliases and claims on an ancestor of an aliased mount fail. The executing owner verifies actual parents, symlinks, mounts and permissions.
- A path overlaps contained paths. A Linux systemd unit claims its standard unit file and drop-in paths. Filesystem-backed credential and store claims reserve their paths. One owner may declare a directory and a child file, provided the parent remains a directory.
- Ports use `protocol/[address/]port[-port]`. An absent address or `*` is a wildcard. IPv6 unspecified binding is considered dual-stack. Port overlap checks host, guest and published container listeners together. Routes compare normalized network ranges in the target network.
- The matrix rejects duplicate writers, overlapping distinct owners and attempts to manage an owner's reserved path, package or unit. It also rejects conflicting active runtime families, including the legacy and next-generation reporters, even if both have the same owner.

编译器在连接前检查声明的包、目录、unit、端口、路由、凭据、存储和生命周期冲突。实际目标、授权、挂载和状态仍由执行及恢复门禁验证。
