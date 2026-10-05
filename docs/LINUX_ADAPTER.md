# Linux receipt adapter / Linux receipt 适配器

## 中文

<!-- topic:contract -->
<!-- topic:contract -->
<!-- topic:contract -->
`src/adapters/linux/` 提供真实 Linux canary 的 **回执 消费边界**。它读取既有 Fleet typed control、Linux converger 和 reboot 独立观察器 的结果，再将已核验结果映射为五项公共 证据；不复制 converger，不引入 shell API，不执行 mint/join/reboot，不创建或晋升身份。

当前实现是可复用 contract 与校验器，**尚未接入真实设备 后端**。确定性测试全部使用明确标记的 合成 fixtures。通过这些测试不证明 Linux 已完成纳管、控制、零差异收敛或重启恢复。

### 私有 责任方 提供什么

责任方 安装 trusted 绑定：exact GhostFleet attempt、其 PROVISIONAL `node_uid`、bootstrap `enrollment_id`、adapter/独立观察器 标识、opaque 凭据 托管 reference、accepted Fleet 源代码 revision、machine/提供方/当前 boot digest、期限及最多 300 秒的证据有效窗口。绑定 不能由节点或请求者选择；私有 运行时 必须先核对控制面真实对象及 retired 身份 禁用约束。

若验证 reboot，责任方 在 dispatch 前持久化 scheduled checkpoint 与一次 dispatch fence，将两者 opaque reference 和 before-boot digest 绑定到本次观察。未知 dispatch 不重新 reboot。

私有 后端 提供五个固定只读方法：

| 方法 | 消费的真实结果 |
| --- | --- |
| `readTransportReceipt(binding)` | 节点外观察到已认证 传输、fixed 主机 pin 和 Running 提供方 |
| `readBootstrapReceipt(binding)` | 受保护 completion 对账及 report/checkpoint digest |
| `readControlReceipt(binding)` | accepted typed `node_inspect` R0 回执 |
| `readConvergenceReceipt(binding)` | 既有 Fleet 收敛 engine 的实际 immediate repeat 回执 |
| `readRebootReceipt(binding)` | exact scheduled checkpoint/dispatch 后的新 boot 与恢复结果 |

方法返回 `ghostfleet-linux-receipt/v1` strict envelope，内容仅包含 opaque refs、digests、限定 facts 和 `SUCCEEDED | FAILED | UNKNOWN`。私有 后端 消费既有 accepted mechanism；它不是把人工填写的 PASS 转成 回执 的工具。执行权限、提供方 凭据、SSH principal/pin/locator、原始硬件证据、受保护报告及 dispatch fence 均留在 私有 责任方 托管。

### 独立 独立观察器 验证

必须提供 `verifyReceipt({ receipt, receipt_digest, binding, nonce })`。它通过私有已认证 独立观察器 解析 回执 reference，核对 stored 回执/current target，然后返回 exact digest、nonce、独立观察器/托管/源代码 绑定、fresh observation 和 current subject。函数不得直接回显请求并声称 verified。nonce 只绑定本次只读 verification，不提供执行 授权；SHA256 只绑定内容，不提供签名或身份认证。

公开 validator 拒绝不同 attempt/UID/enrollment/adapter/托管/源代码、machine/提供方/boot 冲突、陈旧或未来观测、未知字段和 raw 凭据/locator。verification 完成时再次核对 绑定 期限与 freshness。成功 reboot 必须对齐预先绑定的 checkpoint/dispatch，观察到 changed boot，同时恢复 传输/control/身份。

`convergence.zero_delta` 需要既有 engine 的 **实际执行** 回执：`repeat=true`、`execution_verified=true`、`material_delta=[]`、before/after managed-状态 digest 相同、`lifecycle_promoted=false`。支持 opt-in `fleet-linux-converger/v1`，以及已发布的 `fleet-enroll-bootstrap/v2-r1`，私有 runner 必须绑定实际执行的 源代码 revision/digest。后者的 独立观察器 必须亲自执行匹配源代码的 bootstrap，核对其 凭据-free compliant exit，并比较管理文件内容、mtime、ownership、服务 代次 和 提供方 身份；不能只凭 `stdout` 生成空 delta。后端 的 状态 digest 应覆盖该 engine 的所有 effect surfaces；只比较静态快照、exit=0 或“看起来已安装”不满足本项。

### 控制面接线

私有 runner 用 `LinuxReceiptAdapter.collect(type)` 获取结果，再经已授权的 existing 证据 seam 保存 `result.evidence`。成功返回 `OBSERVED` 和 PASS；FAILED、UNKNOWN、invalid 回执 或 独立观察器 错误返回 `RECONCILE_REQUIRED`，错误不泄露 raw 后端 输出，不内部重试。必须保存最新 FAIL/UNKNOWN，以使旧 PASS 失效；不能在失败后跳过结果并执行 accept。

整个 collect 使用最多 30 秒的绝对观察期限，覆盖 后端 和 verifier 两阶段，并将 AbortSignal 传给两者。超时返回 UNKNOWN；迟到的只读结果不会生成可接受证据。后端/verifier 必须消费 signal 来关闭自身资源，adapter 不重试。

adapter 不调用 controller `accept`。私有 instance 的 Assets 责任方 acceptance、恢复/授权 等准入条件仍由现有 责任方 contract 保持；PROVISIONAL projection 不是 accepted Assets join 或 operational 授权。未被 Assets 责任方 接受的候选保持 unbound，core 不要求凭空添加非空 asset_ref。core 身份/catalog 证据 仍由真实控制面存储生成。当前 bearer/API 允许 操作员 直接写 证据，因此集成方必须限制真实 acceptance 的写入口或可信 runner，不能把这份校验器称为已经强制覆盖全部 API caller 的安全边界。

first materialization、durable reload、对账、真实五项 proof、可用时的 accepted Assets join、Console/API/读取-only MCP 一致性与旧 Fleet access preservation 都仍需 live canary。Cloudflare/本地进程重启不等于设备 reboot；本适配器不改变 Console hosting 或部署状态。

## English

<!-- topic:contract -->
`src/adapters/linux/` is a proof-consumption boundary for real Linux canaries. It consumes existing typed-control, convergence and reboot-observer results and maps verified receipts to five public evidence types. It copies no convergence engine, exposes no shell API, performs no mint/join/reboot, and creates or promotes no identity. Public tests use synthetic fixtures; a protected single-node integration does not make this validator a universal deployed backend.

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

First materialization, durable reload/reconcile, five real proofs, accepted Assets joins when available, same Console/API/read-only MCP identity and preserved previous access require hardware integration acceptance. Restarting Cloudflare/local processes is not a device reboot. This adapter does not move hosting to Pages.
