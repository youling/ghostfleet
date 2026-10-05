# Optional typed control / 可选类型化控制

## 中文

<!-- topic:boundary -->
### 入口与默认权限

`packages/typed-control` 是显式选择的 TypeScript 库，提供 `runControlOperation`、策略/目标/当前有效性校验、任务和交互会话 RPC、特权边界。它不改变主 Console、MCP 或 HTTP API。默认 MCP 仍只有四个只读工具；Console/HTTP 允许经操作员令牌保护的控制面记录变更，但都没有默认设备执行后端。导入库不安装节点、不连接 SSH、不授予权限；后端没有配置时拒绝执行。

主入口为 `.`，Cloudflare 网络与授权基础模块分别使用可选 `./cloudflare` 和 `./authorization`。当前是源码开发包，不是已发布 npm 包。集成者在可信进程安装策略、已认证调用主体、精确目标、秘密托管与后端，再显式调用；这些可信输入不能由 AI 工具参数指定。可运行示例和完整输入/输出表见 [操作参考](OPERATIONS.md)。

<!-- topic:policy -->
### 策略、身份和授权

`ControlEnvironment` 是可信部署配置；操作员安装 `CONTROL_POLICY_JSON`。策略源版本和服务端选择的 `node_uid` 是执行前置。`node.inspect` 选择已声明观察项，`service.status/restart` 选择服务键；`shell.exec` 是独立高权限能力，不是默认 AI 接口。

调用主体的权限范围、平台、执行权限、精确 Node UID、传输通道、固定 SSH 主机指纹和源版本必须同时符合契约，才能开始连接。R0 是受限观察；R1/R2 的批准与风险由契约和源代码定义，不能按命令名字自行降级。任务/会话的启动、取消、输入和关闭变更与状态/读取观察分开。

本控制面中的身份准入不自动将节点登记到独立消费者的目录，也不配置其鉴权或调用路由。每个消费者必须回读同一身份，验证允许与越权调用，并验收切换和回滚；具体步骤见 [迁移](MIGRATION.md)。

旧客户端绑定的契约不能只改名为“通用”就沿用授权。精确客户端配置、重定向、调用主体、权限范围与批准均需重验；操作员控制面令牌不自动成为设备执行或特权授权。

<!-- topic:backend -->
### 后端、截止时间和凭据

`createNativeBackend({connect,execute})` 只核对并冻结注入接口，不进行 I/O。真实后端必须提供已认证传输、固定主机指纹和可中断资源。Cloudflare socket 后端不能代表本地 SSH，拒绝不支持的通道/算法。真实定位信息、登录主体、私钥和提供方根凭据留在部署托管，不放公开源码、调用参数或节点元数据。

一个整体截止时间同时约束连接和执行；迟到的 socket 要关闭，输出有上限。截断回执不是完整证明。可能派发后的传输失败保守记为 `UNKNOWN`；等待超时不撤销远程副作用。`exit=0` 不证明后台任务已经结束或节点已经通过准入。

<!-- topic:receipts -->
### 回执和集成验收

回执区分 `NOT_DISPATCHED/SUCCEEDED/FAILED/UNKNOWN`，绑定操作 ID、精确节点、风险、执行权限、调用主体、策略源版本、时间和对账标志。只有派发前证据能证明没有远程副作用；高风险 UNKNOWN 不自动重试。

先用合成后端测试错误身份、权限、源版本漂移、平台不符、截止时间、任务/会话句柄和代次。真实接入再验证后端、独立观察器、凭据托管/撤销、所有副作用和恢复路径。完整高权限输出只存受保护回执；公开摘要仅保留不敏感引用、摘要和必要状态。MCP/Console 的设备变更入口属于单独安全设计与验收，不能因搬迁库自动开启。

## English

<!-- topic:boundary -->
### Entry points and default authority

`packages/typed-control` is an explicit opt-in TypeScript library providing `runControlOperation`, policy/target/currentness validation, job/session RPC and privileged boundaries. It does not modify the root Console, MCP or HTTP API; default MCP still exposes four read-only tools. Importing it installs no node, opens no SSH connection and grants no authority. The default operation backend rejects execution when unconfigured.

The main export is `.`; select Cloudflare networking through `./cloudflare` and authorization building blocks through `./authorization`. This is a source-development package, not an already published npm package. Integrators install policy, actor, target, secret custody and backend in their trusted process before an explicit call; AI tool arguments must not choose those trust inputs.

<!-- topic:policy -->
### Policy, identity and permission

`ControlEnvironment` is trusted deployment configuration; operators install `CONTROL_POLICY_JSON`. Policy source revision and server-selected node_uid are prerequisites. `node.inspect` selects a declared observation; `service.status/restart` selects a service key. `shell.exec` is a separate high-authority capability, not the default AI surface. Actor scope, platform, execution privilege, exact Node UID, transport lane, fixed SSH host pin and source/currentness checks must all pass before connection.

R0 is bounded observation; determine R1/R2 approval and risk from the contract and source, never downgrade a command by name. Job/session mutations such as start/cancel/write/close are distinct from status/read observation. Admission in this control plane does not register a node in an independent consumer's catalog or configure its authentication/call routes. Each consumer must read back the same identity, validate permitted and unauthorized calls, and accept cutover/rollback; see [Migration](MIGRATION.md).

Renaming a legacy client/profile to “generic” does not preserve authority: exact actor profile, redirect, scopes and approvals need revalidation.

<!-- topic:backend -->
### Backend, deadlines and credentials

`createNativeBackend({connect, execute})` validates and freezes injected interfaces without I/O. Native backends must provide authenticated transport, fixed host pins and cancellable resources. Cloudflare sockets do not implement local SSH and reject unsupported lanes/algorithms. Real locators, principals, private keys and provider roots remain in deployment custody, never public source, caller arguments or Node metadata.

Operations use absolute deadlines for connection and execution and close late sockets. Output is capped; a truncated receipt is not complete evidence. Transport failure after possible dispatch is conservatively UNKNOWN. An `exit=0` does not prove that a background job completed or the node passed lifecycle admission.

<!-- topic:receipts -->
### Receipts and integration acceptance

Receipts distinguish `NOT_DISPATCHED | SUCCEEDED | FAILED | UNKNOWN` and bind operation_id, exact node_uid, risk, privilege, actor_ref, policy revision, times and reconciliation flags. Only a pre-dispatch result proves no remote effect; high-risk UNKNOWN is never automatically retried. First test an injected synthetic backend for wrong identity, scope, source drift, platform mismatch, deadlines, job/session handle/generation and negative authority.

Then validate your real backend, independent observer, credential custody/revocation, every effect surface and recovery path. High-authority output belongs in protected receipt storage; published evidence contains only opaque refs/digests and necessary status. A mutation ingress for MCP/Console requires separate security design and acceptance; importing the library does not enable it.
