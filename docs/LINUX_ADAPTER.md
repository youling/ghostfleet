# Linux receipt adapter

## 中文

`src/adapters/linux/` 提供真实 Linux canary 的 **receipt 消费边界**。它读取既有 Fleet typed control、Linux converger 和 reboot observer 的结果，再将已核验结果映射为五项公共 evidence；不复制 converger，不引入 shell API，不执行 mint/join/reboot，不创建或晋升身份。

当前实现是可复用 contract 与校验器，**尚未接入真实设备 backend**。确定性测试全部使用明确标记的 synthetic fixtures。通过这些测试不证明 Linux 已完成纳管、控制、零差异收敛或重启恢复。

### 私有 owner 提供什么

owner 安装 trusted binding：exact GhostFleet attempt、其 PROVISIONAL `node_uid`、bootstrap `enrollment_id`、adapter/observer 标识、opaque credential custody reference、accepted Fleet source revision、machine/provider/当前 boot digest、期限及最多 300 秒的证据有效窗口。binding 不能由节点或请求者选择；private runtime 必须先核对控制面真实对象及 retired identity 禁用约束。

若验证 reboot，owner 在 dispatch 前持久化 scheduled checkpoint 与一次 dispatch fence，将两者 opaque reference 和 before-boot digest 绑定到本次观察。未知 dispatch 不重新 reboot。

private backend 提供五个固定只读方法：

| 方法 | 消费的真实结果 |
| --- | --- |
| `readTransportReceipt(binding)` | 节点外观察到已认证 transport、fixed host pin 和 Running provider |
| `readBootstrapReceipt(binding)` | 受保护 completion 对账及 report/checkpoint digest |
| `readControlReceipt(binding)` | accepted typed `node_inspect` R0 receipt |
| `readConvergenceReceipt(binding)` | 既有 Fleet convergence engine 的实际 immediate repeat receipt |
| `readRebootReceipt(binding)` | exact scheduled checkpoint/dispatch 后的新 boot 与恢复结果 |

方法返回 `ghostfleet-linux-receipt/v1` strict envelope，内容仅包含 opaque refs、digests、限定 facts 和 `SUCCEEDED | FAILED | UNKNOWN`。private backend 消费既有 accepted mechanism；它不是把人工填写的 PASS 转成 receipt 的工具。执行权限、provider credential、SSH principal/pin/locator、原始硬件证据、受保护报告及 dispatch fence 均留在 private owner custody。

### 独立 observer 验证

必须提供 `verifyReceipt({ receipt, receipt_digest, binding, nonce })`。它通过私有已认证 observer 解析 receipt reference，核对 stored receipt/current target，然后返回 exact digest、nonce、observer/custody/source binding、fresh observation 和 current subject。函数不得直接回显请求并声称 verified。nonce 只绑定本次只读 verification，不提供执行 authority；SHA256 只绑定内容，不提供签名或身份认证。

public validator 拒绝不同 attempt/UID/enrollment/adapter/custody/source、machine/provider/boot 冲突、陈旧或未来观测、未知字段和 raw credential/locator。verification 完成时再次核对 binding 期限与 freshness。成功 reboot 必须对齐预先绑定的 checkpoint/dispatch，观察到 changed boot，同时恢复 transport/control/identity。

`convergence.zero_delta` 需要既有 engine 的 **实际执行** receipt：`repeat=true`、`execution_verified=true`、`material_delta=[]`、before/after managed-state digest 相同、`lifecycle_promoted=false`。支持 opt-in `fleet-linux-converger/v1`，以及已发布的 `fleet-enroll-bootstrap/v2-r1`，私有 runner 必须绑定实际执行的 source revision/digest。后者的 observer 必须亲自执行匹配源代码的 bootstrap，核对其 credential-free compliant exit，并比较管理文件内容、mtime、ownership、服务 generation 和 provider identity；不能只凭 stdout 生成空 delta。backend 的 state digest 应覆盖该 engine 的所有 effect surfaces；只比较静态快照、exit=0 或“看起来已安装”不满足本项。

### 控制面接线

private runner 用 `LinuxReceiptAdapter.collect(type)` 获取结果，再经已授权的 existing evidence seam 保存 `result.evidence`。成功返回 `OBSERVED` 和 PASS；FAILED、UNKNOWN、invalid receipt 或 observer 错误返回 `RECONCILE_REQUIRED`，错误不泄露 raw backend output，不内部重试。必须保存最新 FAIL/UNKNOWN，以使旧 PASS 失效；不能在失败后跳过结果并执行 accept。

整个 collect 使用最多 30 秒的绝对观察期限，覆盖 backend 和 verifier 两阶段，并将 AbortSignal 传给两者。超时返回 UNKNOWN；迟到的只读结果不会生成可接受证据。backend/verifier 必须消费 signal 来关闭自身资源，adapter 不重试。

adapter 不调用 controller `accept`。private instance 的 Assets owner acceptance、recovery/authority 等准入条件仍由现有 owner contract 保持；PROVISIONAL projection 不是 accepted Assets join 或 operational authority。未被 Assets owner 接受的候选保持 unbound，core 不要求凭空添加非空 asset_ref。core identity/catalog evidence 仍由真实控制面存储生成。当前 bearer/API 允许 operator 直接写 evidence，因此集成方必须限制真实 acceptance 的写入口或可信 runner，不能把这份校验器称为已经强制覆盖全部 API caller 的安全边界。

first materialization、durable reload、reconcile、真实五项 proof、可用时的 accepted Assets join、Console/API/read-only MCP 一致性与旧 Fleet access preservation 都仍需 live canary。Cloudflare/本地进程重启不等于设备 reboot；本适配器不改变 Console hosting 或部署状态。

## English

The Linux adapter consumes bounded receipts from accepted Fleet mechanisms. It does not copy the convergence engine or expose shell, enrollment, reboot or admission authority. Private owners install an exact provisional-attempt binding and authenticated observer verifier; raw device/provider facts, coordinates, credentials and effect fences stay private.

Receipt content hashes are not authentication. A mandatory out-of-band verifier must resolve the private receipt and attest its nonce, exact digest, source/custody identity, freshness and current device subject. Unknown effects require reconciliation, not replay. Zero delta needs a real accepted-engine repeat with no effects; reboot needs a pre-dispatch checkpoint and independently observed new boot with recovered paths.

This implementation is not yet connected to hardware. Synthetic tests do not prove live acceptance. Consumers must persist newer FAIL/UNKNOWN results, preserve Assets/recovery/authority gates, and enforce their trusted evidence-write seam before final admission.
