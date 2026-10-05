# Typed operations reference / 类型化操作参考

## 中文

<!-- topic:install -->
### 安装并运行合成示例

从当前已评审的公开预览分支或提交版本取得源码，再安装、检查和构建：

```sh
npm ci
npm run check:typed
npm run test:typed
npm run build:typed
node examples/typed-control-synthetic.mjs
```

[示例源码](../examples/typed-control-synthetic.mjs) 调用包的实际导出接口，使用独立生成的策略、源版本、节点身份和模拟后端。它检查两个可信调用主体、缺少调用主体的拒绝结果，以及未配置默认后端的拒绝结果；不使用真实凭据，不连接 SSH 或网络，也不启动子进程。两个调用主体标签不等于两个 AI 客户端的兼容性证明；实际 MCP 客户端验证使用 `npm run verify:ai-client-neutral`。

本文中，actor 指由认证入口确认的调用主体，policy 指服务端策略，receipt 指可追溯的操作回执，deadline 指覆盖连接和执行的整次操作截止时间。生产环境的集成者在已认证入口中安装调用主体、固定的公开源版本、策略与精确目标。工具请求只能提供允许的操作字段，不能自选这些可信输入。示例中的无效密钥标签和模拟主机指纹不能用作生产凭据。

<!-- topic:inputs -->
### 输入、风险和权限范围

普通操作均包含 `operation`、`node_uid` 和 `timeout_seconds`。超时范围为 1–120 秒；同一个截止时间约束连接和执行。结束本地等待不会撤销远程副作用。

| 操作 | 额外输入 | 风险与权限范围 | 服务端限制 |
| --- | --- | --- | --- |
| `node.inspect` | `observation`: `identity/disk/memory/uptime` | R0 / `fleet.read` | 观察项必须在节点策略中声明 |
| `service.status` | `service_key` | R0 / `fleet.read` | 服务单元由服务端策略选择 |
| `service.restart` | `service_key` | R1 / `fleet.operate` | 仅普通权限 Linux 用户服务，且 `restart_allowed` 为真 |
| `shell.exec` | `command` | R2 / `fleet.exec` | 显式高权限；默认 MCP/Console 不提供设备执行入口 |
| `job.rpc` | `job`，动作 `start/status/read/cancel` | `start/cancel` 为 R2 / `fleet.exec`，观察为 R0 | 普通权限 Linux；绑定辅助程序 SHA、规格、句柄和代次 |
| `session.rpc` | `session`，动作 `create/status/read/input/close` | `create/input/close` 为 R2 / `fleet.exec`，观察为 R0 | 普通权限 Linux；绑定辅助程序 SHA、输入序号和载荷限制 |
| `runPrivilegedOperation` | 独立的 `execute/status` 输入 | `fleet.privileged` | 独立策略、登录主体和密钥；不从 `fleet.exec` 继承 |

保留旧 `fleet.*` 权限名称是协议兼容要求。普通执行授权可包含普通观察/操作，但永不包含特权授权。权限范围满足后，仍需核对目标、策略、源版本和执行权限；调用方不能自行声称已经获得授权。

<!-- topic:results -->
### 回执、错误和不确定结果

| `outcome` | 含义 | 后续处理 |
| --- | --- | --- |
| `NOT_DISPATCHED` | 尚未进入可能派发的阶段，或已明确证明派发前失败 | 修复输入、授权或配置，仅按契约重试 |
| `SUCCEEDED` | 本次操作回执成功，不代表后台任务或节点准入全部成功 | 核对绑定的回执和实际状态 |
| `FAILED` | 已明确的执行失败 | 读取副作用和状态，不能默认没有副作用 |
| `UNKNOWN` | 可能已派发，或结果不完整、超时、变更回执无效 | 保留原身份和防重复记录，只读查询/对账，不重新提交变更 |

普通回执包含 `schema_version`、`operation_id`、`node_uid`、`operation`、`risk`、`execution_privilege`、`actor_ref`、`policy_revision`、开始/完成时间、`outcome`、`retry_safe`、`reconcile_required`、`exit_code`、`stdout/stderr`、`truncated`、`error` 和可选的 `job/session` 数据。公开摘要不能输出原始 stdout 或设备清单；完整回执留在责任方受控存储。

常见拒绝错误包括 `INSUFFICIENT_SCOPE`、`CONTROL_SOURCE_NOT_CONFIGURED/MISMATCH`、`CONTROL_POLICY_INVALID`、`CAPABILITY_NOT_CONFIGURED/ALLOWED`、`TARGET_PLATFORM_MISMATCH`、`CONTROL_BACKEND_NOT_CONFIGURED`、`CONTROL_TRANSPORT_MODE_UNSUPPORTED`、`INVALID_SSH_TIMEOUT` 和 `JOB/SESSION_RESPONSE_IDENTITY_MISMATCH`。未知后端异常转为有限错误码，不打印可能带秘密的原异常。

<!-- topic:jobs -->
### 任务和交互会话的准确绑定

启动任务要求绝对可执行文件路径及参数列表：1–64 个参数，每个最多 4096 字节，合计最多 8192 字节；运行时间不得超过策略值或 14400 秒。请求使用 stdin，不拼入命令参数或 shell。`operation_id` 结合节点和调用主体决定预期句柄；`status/read/cancel` 还必须绑定 `generation`。读取游标最多 4 MiB，每次最多 32768 字节；响应核对游标、下一游标及输出上限。

创建交互会话使用相同的参数和运行时间限制，另有 `rows` 10–200、`cols` 20–400、`cwd_profile:home`。输入文本最多 16384 UTF-8 字节，`control_keys` 最多 16 个且必须属于枚举，`input_seq` 为 1…2³¹−1，禁止空输入。关闭必须提供 `confirm:true`。辅助程序回执绑定操作、规格、调用主体、句柄和代次；待确认的 `pending_input_seq` 或 `UNKNOWN` 需要对账。责任方维护旧协议/存储布局、辅助程序 SHA 和私有代次，不在公开测试样本中复制真实值。

<!-- topic:privileged -->
### 独立的特权通道

`runPrivilegedOperation` 仅接受 `root-probe` 和 `android-udev-access`，不接受 shell 命令。请求绑定 `request_id`、`actor_ref`、`generation`、`profile_generation` 和排序去重后的 `vendor_ids`。`root-probe` 不含厂商 ID；udev 操作要求明确的厂商集合。登录主体和密钥须与普通通道分离，并核对导入后的密钥身份，不能只比较字符串。

通道使用固定命令登录主体、stdin JSON、30 秒整体截止时间和 32768 字节输出上限。`NOT_FOUND/PENDING/UNKNOWN` 仍表示不确定；状态查询传输成功不证明原执行没有副作用。默认后端拒绝执行，普通 MCP/执行目录不注册此入口。真实使用前核对源版本、授权、密钥托管、辅助程序完整性和恢复能力。

## English

<!-- topic:install -->
### Runnable synthetic example

Install dependencies from the current reviewed preview ref, then compile and run the repository example:

```sh
npm ci
npm run check:typed
npm run test:typed
npm run build:typed
node examples/typed-control-synthetic.mjs
```

[examples/typed-control-synthetic.mjs](../examples/typed-control-synthetic.mjs) uses actual exports, synthetic policy/source/Node and a fake backend. It tests two trusted actors, missing-actor denial and default-backend denial, with no SSH/network/subprocess/real credentials. It is not proof of two AI clients; actual MCP multi-client verification uses `npm run verify:ai-client-neutral`.

Production ingress constructs the actor, fixed public source/revision, policy and exact target after authentication; tool input contains only allowed operation fields. Inert key labels and fake pins in the example are not production credentials.

<!-- topic:inputs -->
### Operations, risk and scope

All ordinary inputs contain `operation,node_uid,timeout_seconds`. Timeouts are 1–120 seconds, with one absolute connect/execute deadline; ending local waiting does not undo remote effects.

| Operation | Additional input | Risk/scope | Constraint |
| --- | --- | --- | --- |
| `node.inspect` | observation:identity/disk/memory/uptime | R0/fleet.read | Must be declared in policy observations |
| `service.status` | service_key | R0/fleet.read | Server policy selects the service unit |
| `service.restart` | service_key | R1/fleet.operate | Normal Linux user service with restart_allowed |
| `shell.exec` | command | R2/fleet.exec | Explicit high authority; absent from default MCP/Console |
| `job.rpc` | job:start/status/read/cancel | Start/cancel R2/fleet.exec; reads R0 | Normal Linux, helper SHA, spec/handle/generation |
| `session.rpc` | session:create/status/read/input/close | Create/input/close R2/fleet.exec; reads R0 | Normal Linux, helper SHA, sequence/bounded payload |
| `runPrivilegedOperation` | Separate execute/status input | fleet.privileged | Separate policy/principal/key; never inherited from fleet.exec |

Legacy fleet.* scopes preserve compatibility: an ordinary exec grant may include ordinary observation/operation, never privileged authority. Scopes still require target/policy/source/privilege gates; callers cannot claim their own authorization.

<!-- topic:results -->
### Receipts, errors and UNKNOWN

| Outcome | Meaning | Next step |
| --- | --- | --- |
| NOT_DISPATCHED | No possible-dispatch stage entered or proven pre-dispatch failure | Repair input/authority/configuration and retry only under contract |
| SUCCEEDED | This operation's receipt succeeded, not an entire background job or admission | Check bound receipt/state |
| FAILED | Known execution failure | Inspect effects/state; do not assume absence of effects |
| UNKNOWN | Possible dispatch, incomplete result, timeout or malformed mutation receipt | Keep original identity/fence; read status/reconcile without re-submitting mutation |

Ordinary receipts contain schema_version, operation_id, node_uid, operation, risk, execution_privilege, actor_ref, policy_revision, started/completed_at, outcome, retry_safe, reconcile_required, exit_code, stdout/stderr, truncated, error and optional job/session. Public summaries must not dump stdout/raw device inventory; owners keep full receipts protected.

Common fail-closed errors include INSUFFICIENT_SCOPE, CONTROL_SOURCE_NOT_CONFIGURED/MISMATCH, CONTROL_POLICY_INVALID, CAPABILITY_NOT_CONFIGURED/ALLOWED, TARGET_PLATFORM_MISMATCH, CONTROL_BACKEND_NOT_CONFIGURED, CONTROL_TRANSPORT_MODE_UNSUPPORTED, INVALID_SSH_TIMEOUT and JOB/SESSION_RESPONSE_IDENTITY_MISMATCH. Unknown backend exceptions become bounded codes rather than raw secret-bearing output.

<!-- topic:jobs -->
### Exact job/session binding

Job start requires an absolute executable argv: 1–64 arguments, each ≤4096 bytes, aggregate ≤8192 bytes, runtime within policy and ≤14400 seconds. Requests use stdin, never interpolation into command arguments/shell. operation_id binds node+actor to the expected handle; status/read/cancel also bind generation. Read cursor is ≤4 MiB and max bytes ≤32768; responses must match cursor/next cursor/output caps.

Session creation uses the same argv/runtime limits plus rows 10–200, cols 20–400 and cwd_profile:home. Input text is ≤16384 UTF-8 bytes, control_keys ≤16 from the enum, input_seq 1…2³¹−1, and input cannot be empty. Close requires confirm:true. Helper receipts bind operation/spec/actor/handle/generation; pending_input_seq or UNKNOWN requires reconciliation. Owners maintain wire/storage ABI, helper SHA and private generations/state; public fixtures copy no real values.

<!-- topic:privileged -->
### Separate privileged lane

`runPrivilegedOperation` accepts only the typed root-probe and android-udev-access enum, never shell commands. It binds request_id, actor_ref, generation, profile_generation and sorted unique vendor_ids. Root-probe has no vendor IDs; udev requires an explicit vendor set. Principal/key are separate from ordinary control, verified by imported key identity rather than string difference alone.

The lane uses a forced-command principal, stdin JSON, a 30-second absolute deadline and 32768-byte output cap. NOT_FOUND/PENDING/UNKNOWN receipts remain uncertain; successful status transport does not prove the original execute had no effect. The default backend rejects execution and ordinary MCP/exec catalogs register no privileged ingress. Real use requires source, authority, key custody, helper integrity and recovery acceptance first.
