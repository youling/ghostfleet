# Optional packages and platforms / 可选包与平台

## 中文

<!-- topic:install -->
### 包、依赖和安装

| 包 | 入口和依赖 | 当前定位 |
| --- | --- | --- |
| `packages/typed-control` | Node.js 22+、TypeScript；主入口和可选 `./cloudflare`、`./authorization`；Microsoft SSH、buffer、Zod、jose | 受限策略、目标、回执及显式后端 |
| `packages/bootstrap` | Node.js 22+；bootstrap/convergence 载荷生成器 | 无内置提供方根凭据；由调用方提供部署配置 |
| `packages/runtime-python` | Python 3.10+、PyYAML；测试扩展为 pytest，可选 Android 扩展为 uiautomator2 | 校验器、收敛及受限平台/辅助程序机制 |

```sh
npm ci
npm run check:typed
npm run test:typed
npm run build:typed
npm run check:bootstrap
npm run test:bootstrap
python -m pip install -e "packages/runtime-python[test]"
python -m pytest packages/runtime-python/tests
python scripts/verify-python-artifact.py
```

安装产物检查构建 wheel，并在仓库外的临时虚拟环境核对导入、配置、schema 和辅助程序资源，不安装、纳管或重启设备。
只读 Linux 依赖检查器 `prereq_check.py` 默认只检查 `enrollment`。备份、Docker 和管理端 Ansible 通过 `--group` 单独选择，显式 `--all-groups` 才检查全部。控制节点的工具不能错算作 NAS 宿主必需依赖，输出也不能被误认作实机安装已完成。

仅在需要 Android 集成时显式安装 Android 扩展。各包清单定义实际检查与导出接口；源码安装不等于已经发布到 npm/PyPI。`./authorization` 提供配置与注册权限上限重验、PKCE、绑定来源的 v2 所有者同意和 JWT 校验等可选机制，具体见 [授权机制](AUTHORIZATION.md)；签发方存储、生产 OAuth 和调用方切换仍由部署集成者提供并单独验收。

<!-- topic:linux -->
### Linux 纳管、收敛和辅助程序

`ghostfleet-converge --config <ABSOLUTE_PRIVATE_CONFIG>` 默认只读规划，要求 Linux root 核对主机和配置。只有明确增加 `--apply` 才执行限定的初始纳管差异。配置绑定精确清单、机器/提供方/投影/配置代次、回滚和恢复引用、精确软件包版本、独立证明适配器与可选受保护交接。无法读取守护进程或身份时规划不完整，不是准入 PASS。

纳管 CLI 只允许三种受保护输入之一：`--ticket-file`、`--ticket-stdin` 或 `--interactive`。真实一次性 URL 和短码不放命令行参数。文件须为绝对路径、root 所有、0600、可信无符号链接父目录；文件或管道 JSON 最多 16 KiB，仅含 `one_time_url` 和 `short_code`。管道不能是交互终端，隐藏输入不能回退为回显。

```sh
# Effectful enrollment: execute only under the deployment owner's current authority.
ghostfleet-enroll --ticket-file <ABSOLUTE_PROTECTED_TICKET_FILE>
```

公共 Linux shell courier 在 APT/服务修改前先确认只读 Phase0、已有 Tailscale 身份和实际终端。PATH 固定包含 `/usr/sbin:/usr/bin:/sbin:/bin`。若发现现有未核验的 Tailscale 身份，会在**任何安装效果前**拒绝重新 join，要求走由控制面/部署方核验的 ADOPT/REPAIR；这不是“已支持无感接管”的声明。OMV 配置、SSH 用户规则、存储及业务服务从不归 shell courier 管理；真实 OMV8 接入需在专用管理路径内验收。Phase 0 还必须验证 SSH 主机公钥指纹（优先 Ed25519，其次 ECDSA/RSA）；缺少公钥或 ssh-keygen 验证失败时，必须在安装、服务启动和 provider claim 前停止，禁止空指纹回执。

**Tailscale 一次性授权保护**：现有完成 checkpoint 匹配时直接零差异退出；若本机留下不完整的 enrollment checkpoint、完成报告或 `/run/fleet/ts-authkey`，即使 Tailscale 显示 `NeedsLogin`、`NoState`、`Self=null`，也不得把它当作新设备再次纳管。已安装但无法证明身份的 Tailscale 客户端一律先走原身份 ADOPT/REPAIR 对账。仅对已证实的全新节点，在首次调用 `tailscale up --authkey=file:` **之前**写入 root 所有、不含授权密钥的 `CONVERGE/RECONCILE_REQUIRED` 栅栏；失败、退出、重启或返回不明时保持原 enrollment/node 关联并禁止第二次消费。CLI 使用 `--timeout=90s` 上限非交互运行，隐藏登录链接与敏感输出；达到超时也视为效果未知并要求对账，不会自动重新签发/复用单次密钥。本修复只保护边界，不假装已经完成真正的接管与恢复流程。具体一次性密钥语义以 Tailscale 官方 auth-key 文档为准。

每次收敛先核对主机、外部状态和当前提供方身份；升级已有软件包需要单独计划。派发前持久化防重复记录，未知 join 不重试，取得新鲜独立证明后才写自己拥有的描述和检查点。保留 `lifecycle_promoted:false`。实际零差异要求立即重复执行，并证明所有副作用范围都没有变化。提供方纳管标签须由部署方显式配置 `GHOSTFLEET_ENROLL_TAG`，缺少时拒绝，不携带旧实例标签。

特权 Linux 安装器 `managed-linux-privileged-operations.sh` 明确使用 Debian 管理路径（包含 sbin），支持现有 RSA/ECDSA 和 Ed25519 公钥。`--check` 核对现存 `authorized_keys` 必须是 root 所有、0600、唯一受限强制命令、可信家目录/0700 SSH 目录与可解析公钥；不会因为出现某段匹配前缀就错误地报告已配置。在 OMV8 系统上额外只读输出 `OMV_SSH_GROUP=MEMBER|NOT_MEMBER|ACCOUNT_ABSENT|UNKNOWN_GROUP`，供首次预检识别 `_ssh` 账户接纳缺项。只在明确授权的初次 root `--apply` 阶段，在确认 `_ssh` 已存在后，把专用非特权 GhostFleet 账户幂等加入该组；`--check` 不修改。不会创建/重写 OMV 组或 sshd、不会给普通账户 sudo/Docker 组权限。安装或账户权限调整只能在明确授权下执行，本静态契约检查不代替 OMV8 真实 SSH 试验。 GitHub-hosted 一次性 Ubuntu CI 虚拟机将实际验证专用账户、sudoers、Ed25519 强制命令公钥、重复安装、拒绝非法换钥，以及在合成 OMV 标识下检验 `_ssh` 组缺失拒绝与专用账户加入；不冒充真实 OMV8 SSH、user systemd、真正一键纳管或 NAS 的验收。

任务、交互会话和特权辅助程序作为包资源提供，保留旧协议/存储 ABI。部署方显式安装程序、配置 SHA、授权与权限；默认导入和 CI 不安装辅助程序到设备。

**模板所选能力在同一次 root 纳管中安装**：`packages/bootstrap` 渲染的公开 courier 不再只做 preflight、Tailscale 接入与完成上报，而是把模板选中的受控能力接进**同一次**首轮 root ceremony。能力选择是只读数据块（`ghostfleet-selected-capability/v2`）：schema、版本、模板摘要、选择摘要、运行账户与特权账户名，以及每个产物的 SHA-256、权限和内容；未请求即不渲染任何产物。v1 选择不声明 `privileged_account`，无法证明账户隔离，因此 courier 直接拒绝并提示按 v2 重新渲染，不猜测默认值。**普通人类身份**由 Console 生成的一条命令在提权前从内核捕获（`id -un`），校验为安全账户名后，作为受控脚本的第一个位置参数穿过 `env -i`；bootstrap 再校验其存在性、非 root、uid ≥ 1000 后才把它用于 helper 的准入用户。它不进入环境变量表、不是路径、不用于命令拼接。三种身份职责明确且不得混用：**专用运行身份**（模板 `control_account`）是 user unit 与 Linger 的 owner，被纳管的运行时只继承它的权限，因此它必须是**最小权限**的专用账户——UID 在 1000–59999 之间、shell 为 nologin/false、口令锁定、home 与同名组存在，不带 sudo，也不属于任何 root 等价组（`root/sudo/wheel/admin/docker/lxd/libvirt/libvirtd/incus/incus-admin/podman/disk/shadow`）；**特权运维身份**（模板新增的 additive 字段 `privileged_account`，由部署侧从被审 installer 渲染，当前为 `ghostfleet-ops`）由被审 installer provision，持有指向 `fleet-privctl` 的受限 NOPASSWD 规则与 forced-command SSH 入口，**绝不可**与运行身份相同；**普通人类账户**只是 helper 的 admission user（`FLEET_CONTROL_ORDINARY_USER`），不会被用来拥有任何长期运行的服务。三者也都不允许为 root。校验时序如实区分：selection 的格式与一致性（schema、字段、摘要、产物固定）在渲染通道于**任何**效果之前校验，claim 通道在 claim 之后、写一次性凭据与 join 之前校验；而**账户本身的最小权限证明发生在 apply 阶段**——账户不存在时在同一次 ceremony 内创建，已存在时原样采纳且绝不修改，两者都必须先通过上述判据，否则 fail closed 并指出具体风险（如"sudo 授权无法证明不存在""属于 docker 组""UID 是系统账户"）。因此"格式合法但指向错误账户"不会被格式校验发现：它会在账户证明阶段被拒；若名字与 installer 自己写下的 `control.json::ops_user` 不一致，会在交叉核对时被拒（`CAPABILITY_PRIVILEGED_ACCOUNT_MISMATCH`）。该交叉核对**与是否使用 unit/Linger lane 无关**：helper-only 模板同样执行；installer 刚 apply 完、以及 helper 报 `COMPLIANT` 的零差异路径上，该记录是**必需**的——缺失或无法解析即 `[CAPABILITY_PRIVILEGED_ACCOUNT_UNVERIFIED]` fail closed，而不是报告已收敛（因为 installer 的 `--check` 不读该文件，COMPLIANT 不能证明记录存在）。两种情况都不产生任何 unit/Linger 效果。账户隔离在同一次已授权的首轮 root ceremony 内闭合，不需要第二条手工 root 命令，也不新增人类可见的权限层级：`control_account == privileged_account` 在任何安装效果前拒绝；运行账户不存在时用 `useradd --create-home --user-group --shell /usr/sbin/nologin` 创建（不加 sudo、不加任何附加组、口令保持锁定），创建动作一旦发生即记录所有权并立刻复核；**受控 installer 以 root 运行之后，同一负向会再证明一次**，只有通过才会把 unit 装进该账户、启用 Linger 并写入 state。该负向在每次运行（含零差异路径）都重新执行，所以账户事后被加入 sudo 或特权组时节点不会报告 `already converged`。回滚只删除本次 run 创建的账户/unit/Linger，预先存在的账户一律保留。**v1 迁移**：v1 选择把 unit/Linger 落在特权账户下，从 v1 升级的节点会同时存在两套 lane，因此 courier 在 schema 校验之前检测特权账户名下的 unit、`default.target.wants` 链接与 Linger——存在即 fail closed 并打印 decommission 步骤；只有当本机记录的选择自身声明该账户为 unit owner（即本产品早先创建）时，才先**停止并证明该旧服务已停**（`sudo -iu <account> systemctl --user stop`，`is-active` 必须为 `inactive`/`failed`，且该账户名下不再有 `ExecStart` 二进制的进程），再删除这三条具体路径、最后才删 record；任一环节无法证明已停（无 user manager、命令失败、仍 active、仍有进程）即 fail closed 并保留 unit 与 record，打印精确的人工 stop/确认步骤。升级顺序因而是：先 decommission v1 的 unit/Linger（或让记录证明其来源），再以 v2 运行。操作员仍然只运行 Console 给出的那一条命令（无需手工 export，也不需要第二条 root ceremony）；唯一的例外是 v1 迁移：那一次必须先按上面的 decommission 步骤清理旧 lane，属于一次性清理而不是第二条授权。两条通道都遵守同一 fail-closed 规则：缺产物、未固定 installer 或准入公钥、摘要格式非法、模板要求能力却未交付、或模板未要求却交付，一律拒绝且零安装。通过校验后，在身份/join fence 满足之后、完成上报之前把产物写入 root 私有暂存目录（`$CHECKPOINT_DIR`，0700）、逐个复核 SHA-256，按 `--check`/`--apply`/`--check` 调用受控 installer，再安装 user unit、启用 Linger 并复核摘要与状态。一次性 ticket URL 通过 root 私有 curl 配置文件传入，**不进入 argv**（同机非特权 uid 可读 `/proc/<pid>/cmdline`）；一次性 auth key 以 0600 + root 所有权落到 `/run/fleet`（0700）并在 join 后立即删除。首轮成功会把已审阅选择记录在 `capability-selection.txt`，后续运行据此重新证明并只修复真实 drift，不需要新 claim、新凭据或人工删除 `/var/lib/fleet`。旧版本 courier 写下的 checkpoint 只有 capability components 而没有该记录：这类节点不会被永久卡住，而是被识别为 legacy 状态并在**下一次已授权的一次性 claim** 中重新取回选择、完成收敛（不会铸造第二个身份、不会重新 join）；只有在该节点尚无已审阅记录且防线无法自证时才会拒绝上报零变更。模板未请求时只报告 `NOT_REQUESTED`：不安装、不启用、不写状态。任何部分安装只留下未完成状态并拒绝上报完成；经审阅的对账步骤清除栅栏后才重试，且按 NEW / ADOPT / REPAIR 只补真实差异，重复执行必须零差异。`capability-state.json`（含 `selection_digest`）、`capability-selection.txt` 与 checkpoint 的 `components` 记录实际结果；完成上报同样带 `capability_version`、`capability_mode` 与 `capability_selection_digest`。

**选择从哪里来**：能力选择只由服务端从 ticket 记录（`template_id`/摘要/代次）派生：claim 响应新增 `capability_required` 与 `capability_selection`（后者是 shell 可直接解析的紧凑文本的 base64，含 pinned 版本与每个产物的 SHA-256，并与该 ticket 的 `template_digest` 绑定）。客户端请求体、query、argv 或环境变量都无法扩大它；claim 响应是显式 allowlist，materializer 额外字段会被丢弃。模板要求能力而未配置受控产物时，节点在身份 join 与任何能力效果之前拒绝继续，而不是静默少装。courier 自身**不再**通过 sudo/su 重新提权：不是 root 时直接拒绝并指向 Console 生成的一键命令（该命令已用干净环境提权），避免继承调用方 PATH/TMPDIR。

**证据边界**：合成端到端测试执行**发布版** `BOOTSTRAP_SH` 全文（claim → identity join → 所选能力安装 → 完成上报），覆盖 NEW/ADOPT/REPAIR、部分中断后的恢复、重复执行零差异、缺依赖时在任何效果之前 fail closed，以及模板未请求时零安装；合成 broker/installer 不能替代真实节点。GitHub-hosted 一次性 Ubuntu 上仍由真实 `managed-linux-privileged-operations.sh` 证明受控 installer 在真实 root 下可用。真实 NAS/OMV 的 Linger、user systemd 激活与 OMV8 SSH 接纳仍为 NOT_RUN。

**面板一键纳管的阶段边界（可验证）**：从 `console/` 选择公开模板或经审查的私有模板后，`installation_plan` 列出系统/身份、主通道、控制账户、SSH 接纳、用户级 systemd 与 Linger、所选 Helper、独立消费者和恢复依赖。预览由 `packages/bootstrap/src/management-plan.js` 提供，仅枚举待核验能力，不声明该节点已经符合。宿主事实未读取一律 `UNKNOWN`；只有经受权的宿主只读 Phase0 核对全部依赖后，才可形成 NEW / ADOPT / REPAIR 的受审差异计划。既有 UID、通道及不属于安装器的资源必须保留。任何 `PLAN_READY` 也不授权执行，也不证明消费者接线完成。

OMV8 应作为 Debian 系统与独立受管理存储设备同时处理：管理员须验证 OMV 管理的 SSH 用户/配置与配置再生成边界，不得让通用安装器编辑 OMV 拥有的配置或全量调用 `omv-salt deploy`。前置只读检查包括管理账户、PATH、主机指纹、user bus、Linger、Helper 产物/哈希与业务资源隔离。对 OMV 新增 `omv_config_owner` / `omv_storage_isolation` 守护项；未证明两者的计划不可标记零差异或安装完成。首次 root 后免重复密码必须通过专用非业务 canary 实测，不能由模型内的计数字段证明。

<!-- topic:windowsandroid -->
### Windows 和 Android

公开源码包含 Windows 预检、纳管、收敛及通用控制资源。它们核对受管身份、提供方状态、OpenSSH 功能/服务/防火墙和配置。实际执行有平台副作用，需要当前操作员授权、精确投影与回滚；Linux 验收不能代替 Windows 验收。默认不依赖 ChatGPT 专用辅助程序。

Android 将策略、动作、观察、探测、追踪和验证器与可选 uiautomator2 适配器分离。root、解锁、重新配置、设备定位和敏感应用状态留在部署方。模拟系统测试能证明机制，不能证明真实 ADB、权限或交互已可用。

| 环境 | 默认自动检查 | 未覆盖的实机条件 |
| --- | --- | --- |
| Linux CI | Node/TypeScript/Python 合成检查、wheel 资源、本地 workerd、MCP 客户端 | 指定真机、root/提供方/SSH 托管、重启和第二独立节点 |
| Windows CI | Node/TypeScript/Python 合成检查、wheel 资源、MCP 客户端 | Linux 专用原生测试明确跳过；Windows 实机安装/服务权限另验 |
| Android | 模拟适配器与策略测试 | uiautomator2 扩展、实际设备、ADB、应用权限和平台试验 |

CI 的跳过结果不计为通过相应实机能力；每个平台都需要自己的可信后端和硬件验收。

<!-- topic:limitations -->
### 迁入不等于默认启用

通用校验器、传输、控制、授权基础模块和平台运行时已作为可选源码迁入。默认 MCP 只读；Console/HTTP 可由操作员令牌管理控制面记录、纳管和 HumanGate，但没有默认设备执行后端，也不因此授予 `fleet.exec/fleet.privileged`。

生产提供方代理、真实实例清单与凭据托管、签发方存储与调用方切换、工单调度及硬件专属恢复由实例责任方负责。旧协议标记和存储路径因兼容保留，不代表复制了真实实例配置。[迁移表](MIGRATION.md) 和导出清单逐项记录未迁机制的技术原因与下一步。编译、安装资源、模拟 SSH 或一次受保护单机试验不证明通用生产远程控制。

## English

<!-- topic:install -->
### Packages, dependencies and installation

| Package | Entry/dependencies | Current role |
| --- | --- | --- |
| `packages/typed-control` | Node.js 22+, TypeScript; main and optional `./cloudflare`, `./authorization`; Microsoft SSH, buffer, Zod, jose | Bounded policy/target/receipt and explicitly injected backend library |
| `packages/bootstrap` | Node22; bootstrap/convergence payload generators | No embedded provider/root credential; caller supplies deployment configuration |
| `packages/runtime-python` | Python3.10+, PyYAML; pytest test extra; uiautomator2 Android extra | Validators, convergence and bounded platform/helper mechanisms |

```sh
npm ci
npm run check:typed
npm run test:typed
npm run build:typed
npm run check:bootstrap
npm run test:bootstrap
python -m pip install -e "packages/runtime-python[test]"
python -m pytest packages/runtime-python/tests
python scripts/verify-python-artifact.py
```

The artifact check builds a wheel and validates import/profiles/schemas/helper resources in a temporary venv outside the checkout; it does not install, enroll or reboot hardware.
The read-only Linux prerequisite checker defaults to the `enrollment` group. Backup, Docker and controller-side Ansible are selected separately with `--group` or explicitly with `--all-groups`. They are not mandatory for basic NAS enrollment, and observation is not installation acceptance.

 Install the Android extra only for a selected supported integration. Node workspace checks/builds are defined by root scripts and package manifests. Source installation does not mean a package has been published to a registry. `./authorization` provides optional profile/registered scope-ceiling revalidation, PKCE, origin-bound v2 owner consent and JWT validation; see [Authorization](AUTHORIZATION.md). Integrators still provide issuer storage, production OAuth and consumer cutover, with separate acceptance.

<!-- topic:linux -->
### Linux convergence and helpers

`ghostfleet-converge --config <ABSOLUTE_PRIVATE_CONFIG>` defaults to a read-only plan and requires Linux root to validate host/config; only explicit `--apply` executes bounded primary changes. Configuration binds the exact manifest/machine/provider/projection/profile generation, rollback/recovery references, exact package version, independent proof adapter and optional protected handoff. A plan with an unreadable daemon/identity is incomplete, not admission PASS.

Enrollment CLI accepts exactly one protected input: `--ticket-file`, `--ticket-stdin` or `--interactive`. Never put the actual one-time URL or short code in command arguments. Files require absolute paths, root ownership, mode 0600 and trusted nonsymlink ancestors. File/pipe JSON is at most 16 KiB and contains only `one_time_url` and `short_code`. Pipes cannot be interactive terminals; hidden input cannot fall back to echo.

```sh
# Effectful enrollment: execute only under the deployment owner's current authority.
ghostfleet-enroll --ticket-file <ABSOLUTE_PROTECTED_TICKET_FILE>
```

Deployments explicitly configure `GHOSTFLEET_ENROLL_TAG`; missing tags fail closed, with no embedded previous private-instance tag.

Before any APT or service mutation, the public Linux shell courier checks read-only Phase0 facts, an existing Tailscale identity and the required terminal; PATH includes standard Debian sbin paths. A foreign/unverified existing identity stops before effects and must enter a verified ADOPT/REPAIR integration rather than minting a second identity. This safety guard does **not** mean the legacy courier itself can adopt an existing machine. OMV-managed SSH/user configuration, storage and workloads remain out of the public courier's effect scope. Phase 0 also requires a verifiable SSH host public key/fingerprint (Ed25519, then ECDSA/RSA); missing or invalid identity evidence stops before package, service or provider effects.

**One-off Tailscale auth protection:** a complete checkpoint whose actual host state still matches exits with zero changes. An incomplete checkpoint, prior completion report or leftover `/run/fleet/ts-authkey` must never be interpreted as a fresh device. An installed Tailscale client with `Self=null`, `NeedsLogin` or `NoState` remains UNKNOWN until its prior identity is reconciled; do not mint a new node by default. Before the **first** authenticating `tailscale up` on a proven clean node, write a root-owned, credential-free `CONVERGE / RECONCILE_REQUIRED` attempt fence bound to the original enrollment/node. Any rejection, lost reply, restart or uncertain result refuses automatic second use/reissuance. The CLI runs non-interactively with `--timeout=90s`, auth links and output suppressed; timeout is UNKNOWN rather than permission to retry. A trusted ADOPT/REPAIR workflow is still required and is NOT implemented by this guard. The Tailscale official auth-key documentation defines the one-off key lifetime.

Every invocation validates host, foreign state and current provider. Package upgrades need a separate plan. Persist a fence before dispatch, never retry an ambiguous join, and write owned descriptor/checkpoint only after fresh independent proof. `lifecycle_promoted:false` remains explicit. Actual zero delta requires immediate repeat and no changes across all effect surfaces.

The managed-Linux privileged installer uses standard Debian administrative PATH entries (including sbin), accepts RSA/ECDSA and Ed25519 keys, and verifies the *entire* root-owned mode-0600 `authorized_keys` forced-command entry, including root-owned protected parent directories, during read-only `--check`. Merely finding an option prefix is not proof that the actual SSH identity is safe. For OMV8 the read-only result also includes `OMV_SSH_GROUP` based on the dedicated account's `_ssh` membership, so an installed key is not confused with proven SSH admission. Only during the explicitly authorized root `--apply` ceremony, the installer verifies OMV's `_ssh` group exists and idempotently adds its dedicated non-root GhostFleet service account. Read-only `--check` does not mutate groups; no OMV sshd configuration or ordinary-user sudo/Docker privilege is changed. Real OMV SSH login and post-regeneration acceptance remain separately gated. A disposable GitHub-hosted Ubuntu CI VM exercises actual account/sudoers/key setup, read-only checks, repeat apply, denied key rotation and a synthetic OMV-marker `_ssh` admission branch. This is not real OMV8 SSH admission, user-systemd or the full one-click root ceremony.

Job/session/privileged helpers are packaged resources preserving legacy protocol/storage ABI. Deployment owners explicitly install helpers and configure helper SHA/authority or root privilege; package imports and default CI install none.

**Template-selected capability installs inside the same root ceremony:** the published courier rendered by `packages/bootstrap` no longer stops at preflight, Tailscale join and completion reporting. It installs the capability the reviewed template selected inside **the same** first-root ceremony. The selection is a read-only data block (`ghostfleet-selected-capability/v2`): schema, version, template digest, selection digest, the run and privileged account names and, per artifact, the SHA-256, mode and content. A v1 selection declares no `privileged_account`, so account isolation cannot be proved: the courier refuses it and asks for a v2 re-render instead of guessing a default. No artifact is rendered when the template requested nothing. The **ordinary Human identity** rides along with the single Console-generated command: the launcher captures it from the kernel before elevation (`id -un`), validates it as a safe account name, and passes it as the privileged script's first positional parameter through `env -i`; the bootstrap then re-validates existence, non-root and uid >= 1000 before using it as the helper's admission user. The three identities are explicit and never interchangeable: the **dedicated run identity** (the template's `control_account`) owns the user unit and Linger and is the only identity the managed runtime inherits, so it must be a **least-privilege** dedicated account — UID between 1000 and 59999, a nologin/false shell, a locked password, an existing home and same-name group, no sudo, and no membership of a root-equivalent group (`root/sudo/wheel/admin/docker/lxd/libvirt/libvirtd/incus/incus-admin/podman/disk/shadow`); the **privileged operations identity** (the additive `privileged_account` field, rendered by the deployment from the reviewed installer, currently `ghostfleet-ops`) is provisioned by that installer with the bounded NOPASSWD `fleet-privctl` rule and the forced-command SSH entry, and must **never** be the run identity; the **ordinary Human account** is only the helper's admission user (`FLEET_CONTROL_ORDINARY_USER`) and never owns a long-running service. None may be root. Validation timing is stated honestly: the selection's format and consistency (schema, fields, digest, pinned artifacts) are checked before **any** effect on the rendered channel, and after the claim and before the one-time credential and the identity join on the claim channel, while the **account's own least-privilege proof happens in the apply stage** — created inside the same ceremony when absent, adopted as found and never modified when present, and in both cases only after the criteria above hold; otherwise the run fails closed naming the concrete risk ("a sudo grant cannot be proved absent", "member of the docker group", "a system UID"). A well-formed `privileged_account` that points at the wrong account is therefore not caught by format validation: it is rejected at the account proof, and — when the name differs from the one the installer recorded in its own `control.json::ops_user` — by that cross-check (`CAPABILITY_PRIVILEGED_ACCOUNT_MISMATCH`). The cross-check **does not depend on the unit/Linger lane** (a helper-only template runs it too), and it is **mandatory** right after the installer applied and on the zero-delta path whenever the helper reports `COMPLIANT`: a missing or unparseable record fails closed with `[CAPABILITY_PRIVILEGED_ACCOUNT_UNVERIFIED]` instead of reporting convergence, because the installer's `--check` never reads that file. Neither case produces a unit or Linger effect. Account isolation closes inside the **same** authorized first-root ceremony: no second manual root command and no new Human-visible privilege tier. `control_account == privileged_account` is refused before any installation effect; an absent run account is created with `useradd --create-home --user-group --shell /usr/sbin/nologin` (no sudo, no supplementary group, password left locked) and ownership is recorded the moment it exists and re-checked at once; **after the reviewed installer has run as root the same negative is proved again**, and only then is the unit installed into that account, Linger enabled and state written. That negative is re-proved on **every** run including the zero-delta one, so a node whose run account later gains sudo or a root-equivalent group can never answer "already converged". Rollback removes only the account/unit/Linger **this run** created; a pre-existing account is always left in place. **v1 migration:** v1 selections put the unit and Linger under the privileged account, so a node upgraded from one owns two lanes at once. The courier therefore detects the unit, the `default.target.wants` link and Linger inside the privileged account *before* the schema gate: any residue fails closed with the decommission steps, and it is removed only when this node's own recorded selection claims that account as the unit owner (i.e. this product created it) AND the old service is proved stopped first (`sudo -iu <account> systemctl --user stop`, `is-active` must report `inactive` or `failed`, and no process of its `ExecStart` binary may remain under that account), and even then the record goes last; an unprovable stop keeps the unit and the record and prints the exact manual stop/verify steps. The upgrade order is therefore: decommission the v1 unit/Linger (or let the record prove its provenance), then run v2. The Human value and the two account names never become environment variables of their own, paths or command fragments, and they stay strictly separate from one another. The operator still runs exactly the one Console command — no manual export and no second root ceremony; the single exception is a v1 node, which needs the one-time decommission described above (a cleanup, not a second authorization). Both channels share one fail-closed rule: missing artifacts, an unpinned installer or admission key, malformed digests, a template that requires the capability but delivered none, or a selection delivered for a template that requires none are all refused with zero installation. After the identity/join fence is satisfied and before completion is reported it materializes the artifacts into a root-private staging directory, re-verifies every SHA-256, drives the reviewed installer through `--check`/`--apply`/`--check`, then installs the user unit, enables Linger and re-verifies digests and state. A template that requested nothing only reports `NOT_REQUESTED`: nothing is installed, enabled or recorded. A partially applied capability leaves only an incomplete state and refuses completion; only a reviewed reconciliation that clears the fence retries, and it repairs the real NEW / ADOPT / REPAIR delta only. Repeating a converged ceremony must be zero delta. A checkpoint written by an older courier (components recorded, no selection file) is not a dead end: it is detected as legacy state and converged by the next authorized one-time claim, which re-delivers the selection without minting a second identity or re-joining, and the node never reports zero delta for a lane it cannot re-prove. `capability-state.json` (with a `selection_digest`), `capability-selection.txt` and the checkpoint `components` record the actual result, and the completion report carries `capability_version`, `capability_mode` and `capability_selection_digest`.

**Where the selection comes from:** only the server derives it, from the ticket record (`template_id`, digest, generation). The claim response gains `capability_required` and `capability_selection` (the latter is base64 of compact, shell-parsable text carrying the pinned version and every artifact SHA-256, bound to that ticket's `template_digest`). No request body, query, argv or environment variable can widen it: the claim response is an explicit allowlist, so extra materializer fields are dropped. When the template requires the capability but the deployment has no pinned artifacts, the node refuses before the identity join and before any capability effect instead of silently under-installing. The courier **never** re-elevates itself through sudo/su: a non-root run is refused with a pointer to the Console-generated one-shot command, which already elevates with a clean environment.

**Evidence boundary:** the synthetic end-to-end test executes the **published** `BOOTSTRAP_SH` end to end (claim → identity join → selected capability install → completion report) and covers NEW/ADOPT/REPAIR, recovery after a partial interruption, zero-delta repetition, fail-closed ordering when a dependency is missing, and zero installation when the template requested nothing. A synthetic broker/installer is not a real node. A disposable GitHub-hosted Ubuntu VM still proves the real `managed-linux-privileged-operations.sh` runs under real root. Linger and user-systemd activation on a real NAS/OMV, and OMV8 SSH admission, remain NOT_RUN. The disposable root job exercises both the deployment-rendered and the claim-delivered capability lane against the real reviewed installer; the HTTP claim hop itself is covered by deterministic tests.

**Control Panel one-click boundary:** The selected public or deployment-specific template includes an `installation_plan` preview for host compatibility, existing identity, transport, control account, SSH admission, user systemd/Linger, selected helper, independent consumer and recovery. The provider-neutral planner in `packages/bootstrap/src/management-plan.js` is read-only. Missing host observations are `UNKNOWN`; its NEW/ADOPT/REPAIR classification and `PLAN_READY` never grant installation authority or prove consumer acceptance. A host-side trusted preflight and a reviewed minimal-delta plan are required before any effects.

**OMV8:** Treat it as Debian *and* as a managed storage appliance. Verify ownership of OMV-managed SSH configuration and regeneration, protect mounts/volumes/business services, avoid blanket `omv-salt deploy`, and require `omv_config_owner` / `omv_storage_isolation` host evidence before completion. Only a dedicated non-business privilege canary proves the selected post-bootstrap no-recurring-password ability; a model counter cannot do so.

<!-- topic:windowsandroid -->
### Windows and Android

Public Windows preflight/enrollment/convergence logic and resources do not mean every host is integrated. They validate managed identity, provider state, OpenSSH capability/service/firewall and configuration boundaries. Execution has platform effects and requires current operator authority, exact projection and rollback; Linux results cannot establish Windows acceptance.

The Android runtime separates policy/actions/observation/probe/trace/verifier from the optional uiautomator2 adapter. Root/unlock/reprovision, device locators and sensitive application state remain deployment-private. Synthetic fake-adapter tests validate mechanisms, not real ADB, permissions or interaction availability. Each platform requires its own trusted backend and hardware acceptance.

<!-- topic:limitations -->
| Environment | Default automated checks | Hardware conditions not established |
| --- | --- | --- |
| Linux CI | Node/TypeScript/Python synthetic checks, wheel resources, local workerd, MCP clients | Specified hardware, root/provider/SSH custody, reboot and independent second device |
| Windows CI | Node/TypeScript/Python synthetic checks, wheel resources, MCP clients | Explicitly skipped Linux-native tests; actual Windows installation/service authority remains separate |
| Android | Fake-adapter/policy tests | Optional uiautomator2, actual hardware, ADB/application authority and platform canary |

Skipped tests do not establish the corresponding hardware capability. The Windows runtime has no default ChatGPT-specific helper dependency.

### Imported does not mean enabled by default

Generic validators, transport, control and runtime mechanisms are imported as optional source; public MCP remains inspection-only. Console/HTTP allow operator-protected lifecycle/enrollment/HumanGate record mutations but enable no default device execution, fleet.exec or privileged authority. Production provider-mint brokers, OAuth servers, live runtime inventory/credential custody, issue scheduling and hardware-specific recovery/defaults remain with deployment owners, outside the public core. Wire markers and installation paths are preserved compatibility ABI, not copied private instance facts.

The [migration matrix](MIGRATION.md) and machine export manifest record unmigrated mechanisms and concrete next steps. Compilation, wheel resources, fake SSH or one private canary must not be described as universal production remote control.
