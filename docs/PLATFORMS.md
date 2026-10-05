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

安装产物检查构建 wheel，并在仓库外的临时虚拟环境核对导入、profile、schema 和辅助程序资源，不安装、纳管或重启设备。仅在需要 Android 集成时显式安装 Android 扩展。各包清单定义实际检查与导出接口；源码安装不等于已经发布到 npm/PyPI。

<!-- topic:linux -->
### Linux 纳管、收敛和辅助程序

`ghostfleet-converge --config <ABSOLUTE_PRIVATE_CONFIG>` 默认只读规划，要求 Linux root 核对主机和配置。只有明确增加 `--apply` 才执行限定的初始纳管差异。配置绑定精确 manifest、机器/提供方/投影/配置代次、回滚和恢复引用、精确软件包版本、独立证明适配器与可选受保护交接。无法读取 daemon 或身份时规划不完整，不是准入 PASS。

纳管 CLI 只允许三种受保护输入之一：`--ticket-file`、`--ticket-stdin` 或 `--interactive`。真实一次性 URL 和短码不放命令行参数。文件须为绝对路径、root 所有、0600、可信无符号链接父目录；文件或管道 JSON 最多 16 KiB，仅含 `one_time_url` 和 `short_code`。管道不能是交互终端，隐藏输入不能回退为回显。

```sh
# Effectful enrollment: execute only under the deployment owner's current authority.
ghostfleet-enroll --ticket-file <ABSOLUTE_PROTECTED_TICKET_FILE>
```

每次收敛先核对主机、外部状态和当前提供方身份；升级已有软件包需要单独计划。派发前持久化防重复记录，未知 join 不重试，取得新鲜独立证明后才写自己拥有的描述和检查点。保留 `lifecycle_promoted:false`。实际零差异要求立即重复执行，并证明所有副作用范围都没有变化。提供方纳管标签须由部署方显式配置 `GHOSTFLEET_ENROLL_TAG`，缺少时拒绝，不携带旧实例标签。

任务、交互会话和特权辅助程序作为包资源提供，保留旧协议/存储 ABI。部署方显式安装程序、配置 SHA、授权与权限；默认导入和 CI 不安装辅助程序到设备。

<!-- topic:windowsandroid -->
### Windows 和 Android

Windows 公开预检、纳管、收敛及通用控制资源。它们核对受管身份、提供方状态、OpenSSH capability/service/firewall 和配置。实际执行有平台副作用，需要当前操作员授权、精确投影与回滚；Linux 验收不能代替 Windows 验收。默认不依赖 ChatGPT 专用辅助程序。

Android 将策略、动作、观察、探测、trace 和 verifier 与可选 uiautomator2 适配器分离。root、解锁、重新配置、设备定位和敏感应用状态留在部署方。模拟系统测试能证明机制，不能证明真实 ADB、权限或交互已可用。

| 环境 | 默认自动检查 | 未覆盖的实机条件 |
| --- | --- | --- |
| Linux CI | Node/TypeScript/Python 合成检查、wheel 资源、本地 workerd、MCP 客户端 | 指定真机、root/provider/SSH 托管、重启和第二独立节点 |
| Windows CI | Node/TypeScript/Python 合成检查、wheel 资源、MCP 客户端 | Linux 专用 native tests 明确 skip；Windows 实机安装/服务权限另验 |
| Android | 模拟适配器与策略测试 | uiautomator2 扩展、实际设备、ADB、应用权限和平台试验 |

CI 的 skip 不计为通过相应实机能力；每个平台都需要自己的可信后端和硬件验收。

<!-- topic:limitations -->
### 迁入不等于默认启用

通用校验器、传输、控制、授权基础模块和平台运行时已作为可选源码迁入。默认 MCP 只读；Console/HTTP 可由操作员令牌管理控制面记录、纳管和 HumanGate，但没有默认设备执行后端，也不因此授予 `fleet.exec/fleet.privileged`。

生产提供方 broker、真实实例清单/凭据托管、签发方存储与调用方切换、工单调度及硬件专属恢复留在实例责任方。旧协议标记和存储路径因兼容保留，不代表复制了真实实例配置。[迁移表](MIGRATION.md) 和导出清单逐项记录未迁机制的技术原因与下一步。编译、安装资源、模拟 SSH 或一次私有单机试验不能称为通用生产远控。

## English

<!-- topic:install -->
### Packages, dependencies and installation

| Package | Entry/dependencies | Current role |
| --- | --- | --- |
| `packages/typed-control` | TypeScript/Node22; main and optional Cloudflare export; Zod, Microsoft SSH, buffer | Bounded policy/target/receipt and explicitly injected backend library |
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

The artifact check builds a wheel and validates import/resources in a temporary venv outside the checkout; it does not install, enroll or reboot hardware. Install the Android extra only for a selected supported integration. Node workspace checks/builds are defined by root scripts and package manifests. Source installation does not mean a package has been published to a registry.

<!-- topic:linux -->
### Linux convergence and helpers

`ghostfleet-converge --config <ABSOLUTE_PRIVATE_CONFIG>` defaults to a read-only plan and requires Linux root to validate host/config; only explicit `--apply` executes bounded primary changes. Configuration binds the exact manifest/machine/provider/projection/profile generation, rollback/recovery references, exact package version, independent proof adapter and optional protected handoff. A plan with an unreadable daemon/identity is incomplete, not admission PASS.

Enrollment CLI accepts exactly one protected input: `--ticket-file`, `--ticket-stdin` or `--interactive`. Never put the actual one-time URL or short code in command arguments. Files require absolute paths, root ownership, mode 0600 and trusted nonsymlink ancestors. File/pipe JSON is at most 16 KiB and contains only `one_time_url` and `short_code`. Pipes cannot be interactive terminals; hidden input cannot fall back to echo.

```sh
# Effectful enrollment: execute only under the deployment owner's current authority.
ghostfleet-enroll --ticket-file <ABSOLUTE_PROTECTED_TICKET_FILE>
```

Deployments explicitly configure `GHOSTFLEET_ENROLL_TAG`; missing tags fail closed, with no embedded previous private-instance tag.

Every invocation validates host, foreign state and current provider. Package upgrades need a separate plan. Persist a fence before dispatch, never retry an ambiguous join, and write owned descriptor/checkpoint only after fresh independent proof. `lifecycle_promoted:false` remains explicit. Actual zero delta requires immediate repeat and no changes across all effect surfaces.

Job/session/privileged helpers are packaged resources preserving legacy protocol/storage ABI. Deployment owners explicitly install helpers and configure helper SHA/authority or root privilege; package imports and default CI install none.

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
