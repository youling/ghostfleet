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

**Tailscale 一次性授权保护**：现有完成 checkpoint 匹配时直接零差异退出；若本机留下不完整的 enrollment checkpoint、完成报告或 `/run/fleet/ts-authkey`，即使 Tailscale 显示 `NeedsLogin`、`NoState`、`Self=null`，也不得把它当作新设备再次纳管。已安装但无法证明身份的 Tailscale 客户端一律先走原身份 ADOPT/REPAIR 对账。仅对已证实的全新节点，在首次调用 `tailscale up --authkey=file:` **之前**写入 root 所有、不含授权密钥的 `CONVERGE/RECONCILE_REQUIRED` 栅栏；失败、退出、重启或返回不明时保持原 enrollment/node 关联并禁止第二次消费。CLI 只非交互运行、隐藏登录链接与敏感输出，明确提示对账，不能自动重新签发/复用单次密钥。本修复只保护边界，不假装已经完成真正的接管与恢复流程。具体一次性密钥语义以 Tailscale 官方 auth-key 文档为准。

每次收敛先核对主机、外部状态和当前提供方身份；升级已有软件包需要单独计划。派发前持久化防重复记录，未知 join 不重试，取得新鲜独立证明后才写自己拥有的描述和检查点。保留 `lifecycle_promoted:false`。实际零差异要求立即重复执行，并证明所有副作用范围都没有变化。提供方纳管标签须由部署方显式配置 `GHOSTFLEET_ENROLL_TAG`，缺少时拒绝，不携带旧实例标签。

任务、交互会话和特权辅助程序作为包资源提供，保留旧协议/存储 ABI。部署方显式安装程序、配置 SHA、授权与权限；默认导入和 CI 不安装辅助程序到设备。

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

**One-off Tailscale auth protection:** a complete checkpoint whose actual host state still matches exits with zero changes. An incomplete checkpoint, prior completion report or leftover `/run/fleet/ts-authkey` must never be interpreted as a fresh device. An installed Tailscale client with `Self=null`, `NeedsLogin` or `NoState` remains UNKNOWN until its prior identity is reconciled; do not mint a new node by default. Before the **first** authenticating `tailscale up` on a proven clean node, write a root-owned, credential-free `CONVERGE / RECONCILE_REQUIRED` attempt fence bound to the original enrollment/node. Any rejection, lost reply, restart or uncertain result refuses automatic second use/reissuance. The CLI runs non-interactively with auth links and output suppressed; a trusted ADOPT/REPAIR workflow is still required and is NOT implemented by this guard. The Tailscale official auth-key documentation defines the one-off key lifetime.

Every invocation validates host, foreign state and current provider. Package upgrades need a separate plan. Persist a fence before dispatch, never retry an ambiguous join, and write owned descriptor/checkpoint only after fresh independent proof. `lifecycle_promoted:false` remains explicit. Actual zero delta requires immediate repeat and no changes across all effect surfaces.

Job/session/privileged helpers are packaged resources preserving legacy protocol/storage ABI. Deployment owners explicitly install helpers and configure helper SHA/authority or root privilege; package imports and default CI install none.

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
