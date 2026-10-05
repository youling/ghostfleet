# Linux receipt adapter / Linux receipt 适配器

## 中文

<!-- topic:contract -->
`src/adapters/linux/` 提供真实 Linux 集成试验的**回执消费边界**。它读取既有 Fleet 类型化控制、Linux 收敛器和重启独立观察器的结果，将已核验回执映射为五项公共证据；不复制收敛器、不引入 shell API、不执行 mint/join/reboot，也不创建或晋升身份。

公开交付是可复用契约与校验器，**默认不提供真实设备后端**。受保护的单节点集成已验证，但不证明通用生产后端、第二独立设备或其他平台已完成验收。公开确定性测试全部使用明确标记的合成样本；这些测试本身不证明 Linux 真机已完成纳管、控制、零差异收敛或重启恢复。

### 私有责任方提供什么

责任方安装可信绑定：精确的 GhostFleet 尝试、其 `PROVISIONAL` 节点的 `node_uid`、初始纳管的 `enrollment_id`、适配器和独立观察器标识、不透明的凭据托管引用、已验收的 Fleet 源码版本、机器/提供方/当前启动代次摘要、到期时间及最多 300 秒的证据有效窗口。绑定不能由节点或请求者选择；私有运行时必须先核对控制面的实际对象及已退役身份禁用约束。

验证设备重启时，责任方须在派发前持久化计划检查点和一次派发的防重复记录，将两者的不透明引用及重启前的启动代次摘要绑定到本次观察。派发结果不确定时不得再次重启。

私有后端提供五个固定只读方法：

| 方法 | 消费的真实结果 |
| --- | --- |
| `readTransportReceipt(binding)` | 节点外观察到已认证传输、固定主机指纹和 `Running` 提供方 |
| `readBootstrapReceipt(binding)` | 受保护的完成状态对账及报告/检查点摘要 |
| `readControlReceipt(binding)` | 已验收的类型化 `node_inspect` R0 回执 |
| `readConvergenceReceipt(binding)` | 既有 Fleet 收敛引擎实际立即重复执行的回执 |
| `readRebootReceipt(binding)` | 精确计划检查点和派发后的新启动代次与恢复结果 |

方法返回 `ghostfleet-linux-receipt/v1` 严格信封，仅含不透明引用、摘要、限定事实和 `SUCCEEDED | FAILED | UNKNOWN`。私有后端消费既有已验收机制，不把人工填写的 PASS 转成回执。执行授权、提供方凭据、SSH 登录主体/指纹/定位信息、原始硬件证据、受保护报告和防重复派发记录均由私有责任方托管。

### 独立观察器验证与时效

必须提供 `verifyReceipt({ receipt, receipt_digest, binding, nonce })`。它通过私有且已认证的独立观察器解析回执引用，核对已存储回执和当前目标，返回精确摘要、nonce、观察器/托管/源码绑定、最新观察及当前对象。函数不能回显请求后便声称验证通过。nonce 只绑定本次只读验证，不提供执行授权；SHA256 只绑定内容，不提供签名或身份认证。

公开校验器拒绝尝试/UID/纳管/适配器/托管/源码不匹配、机器/提供方/启动代次冲突、过期或来自未来的观察、未知字段及原始凭据或定位信息。验证完成后再次核对绑定期限和时效。成功重启必须匹配预先绑定的检查点与派发记录，独立观察到启动代次改变，并确认传输、控制和身份恢复。

### 实际重复收敛

`convergence.zero_delta` 要求既有引擎的**实际执行**回执：`repeat=true`、`execution_verified=true`、`material_delta=[]`、执行前后的受管状态摘要相同、`lifecycle_promoted=false`。支持显式选择的 `fleet-linux-converger/v1` 和既有 `fleet-enroll-bootstrap/v2-r1`；私有运行器必须绑定实际执行的源码版本和摘要。后者的独立观察器必须亲自执行匹配源码的初始纳管程序，核对不含凭据的合规退出结果，并比较受管文件的内容、mtime、所有权、服务代次和提供方身份，不能仅凭 `stdout` 生成空差异。后端状态摘要须覆盖引擎的全部副作用范围；仅比较静态快照、退出码为 0 或看起来已安装均不满足本项。

### 控制面接线

私有运行器用 `LinuxReceiptAdapter.collect(type)` 取得结果，经既有已授权证据接口保存 `result.evidence`。成功返回 `OBSERVED` 和 `PASS`；`FAILED`、`UNKNOWN`、无效回执或观察器错误返回 `RECONCILE_REQUIRED`，不泄露原始后端输出，也不内部重试。必须保存最新 `FAIL/UNKNOWN` 以使旧 `PASS` 失效，不能跳过失败结果后执行 accept。

整个 collect 使用最多 30 秒的绝对观察期限，覆盖后端与验证器两个阶段，并向两者传递 AbortSignal。超时返回 `UNKNOWN`，迟到的只读结果不会生成可接受证据。后端与验证器必须响应 signal 并关闭自己拥有的资源；适配器不重试。

适配器不调用 controller 的 `accept`。实例中 Assets 责任方的验收、恢复和授权等准入条件仍由既有责任方契约决定；`PROVISIONAL` 投影不等于已验收的 Assets 关联，也不授予操作权限。尚未被 Assets 责任方接受的候选保持未绑定，核心不要求凭空添加非空 `asset_ref`。核心身份/目录证据仍由实际控制面存储生成。当前访问令牌和 API 允许操作员直接写证据，因此集成方必须限制真实准入的写入口或使用可信运行器；这份校验器没有强制覆盖所有 API 调用方。

首次身份落地、持久化重读、对账、五项真实证明、可用时已验收的 Assets 关联、控制台/API/只读 MCP 的身份一致性和既有访问路径保留，均需对应集成验收。受保护单节点集成的历史结果不能自动证明新的部署通过。`ACTIVE` 和七项证据只证明本控制面准入，不证明独立调用方的目录、认证、路由、权限或回滚已切换。Cloudflare 或本地进程重启不等于设备重启；本适配器不改变控制台托管或部署状态。

## English

<!-- topic:contract -->
`src/adapters/linux/` is a proof-consumption boundary for real Linux canaries. It consumes existing typed-control, convergence and reboot-observer results and maps verified receipts to five public evidence types. It copies no convergence engine, exposes no shell API, performs no mint/join/reboot, and creates or promotes no identity. Public delivery is a reusable contract and validator with no real-device backend enabled by default. A protected single-node integration has been validated; it does not establish a universal production backend, an independent second device or other platforms. Public deterministic tests use explicitly labeled synthetic fixtures and do not themselves prove real Linux admission, control, zero-delta convergence or reboot recovery.

### Trusted private binding

Owners install exact attempt, PROVISIONAL node_uid, bootstrap enrollment_id, adapter/observer identity, opaque credential custody reference, accepted source revision, machine/provider/current-boot digests, expiry and an evidence window no longer than 300 seconds. Callers/nodes cannot choose the binding. Verify actual control-plane objects and retired-identity exclusions before use. Reboot binding additionally persists a scheduled checkpoint, one-dispatch fence and before-boot digest before dispatch. Unknown dispatch must not reboot again.

| Backend method | Consumed result |
| --- | --- |
| readTransportReceipt(binding) | Independently authenticated transport, fixed host pin and Running provider |
| readBootstrapReceipt(binding) | Protected completion reconciliation and report/checkpoint digest |
| readControlReceipt(binding) | Accepted typed node_inspect R0 receipt |
| readConvergenceReceipt(binding) | Actual immediate repeat from an accepted convergence engine |
| readRebootReceipt(binding) | New boot/recovery after the exact scheduled checkpoint and dispatch |

Methods return strict `ghostfleet-linux-receipt/v1` envelopes with opaque references, digests, bounded facts and SUCCEEDED/FAILED/UNKNOWN. Backends consume accepted mechanisms, not manually filled PASS values. Execution authority, provider credentials, SSH principals/pins/locators, raw hardware evidence, protected reports and dispatch fences remain privately controlled.

### Independent observer and freshness

`verifyReceipt({receipt,receipt_digest,binding,nonce})` independently resolves the protected receipt and observes the current target. It verifies exact digest/nonce, observer/custody/source identity, freshness and subject. Echoing the request is not verification. Nonces bind read verification, not execution authority. SHA binds content, not identity authentication.

Reject mismatched attempt/UID/enrollment/adapter/custody/source/machine/provider/boot, stale/future observations, unknown fields and raw credentials/locators. Recheck expiry/freshness after verification. Reboot succeeds only with the bound pre-dispatch checkpoint/fence, changed boot and recovered transport/control/identity.

### Actual convergence repeat

Zero delta requires actual accepted-engine execution with repeat=true, execution_verified=true, material_delta=[], equal before/after managed-state digest and lifecycle_promoted=false. Supported engines are `fleet-linux-converger/v1` and `fleet-enroll-bootstrap/v2-r1`; bind the actual source revision/digest. A bootstrap observer executes the matching source, checks credential-free compliant exit and compares file contents/mtime/ownership, service generation and provider identity. Static snapshots, exit=0 or installed-package checks alone are insufficient. State digests cover all engine effect surfaces.

### Control-plane integration and limits

Use `LinuxReceiptAdapter.collect(type)` and an authorized evidence seam to save result.evidence. Valid success returns OBSERVED/PASS; failure, UNKNOWN, invalid receipts or observer errors return RECONCILE_REQUIRED without raw backend output or internal retries. Persist the latest FAIL/UNKNOWN to invalidate old PASS before admission.

The entire collect has an absolute deadline of at most 30 seconds, including backend and verifier. Both receive AbortSignal and must close their resources. Timeout produces UNKNOWN and late read results cannot become acceptance evidence.

The adapter never calls controller accept. Instance Assets acceptance, recovery and authority gates remain owner-defined. A PROVISIONAL projection is not an accepted Assets join or operational authority; unaccepted candidates remain unbound, with no invented universal nonempty asset_ref gate. Core generates identity/catalog evidence from actual stored projections. Current operator API can directly write evidence, so integrations must enforce a trusted writer or restricted real-admission seam; this validator is not compulsory security coverage for every API caller.

First materialization, durable reload/reconcile, five real proofs, accepted Assets joins when available, same Console/API/read-only MCP identity and preserved previous access require corresponding hardware integration acceptance. Historical protected single-node results do not automatically establish acceptance of a new deployment. `ACTIVE` and seven evidence types establish admission in this control plane only, not independent consumer catalog/authentication/route/permission/rollback cutover. Restarting Cloudflare/local processes is not a device reboot. This adapter changes neither Console hosting nor deployment status.
