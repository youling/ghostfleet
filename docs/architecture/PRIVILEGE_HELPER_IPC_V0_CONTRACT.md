# Privilege Helper IPC v0 Contract / 节点提权 Helper IPC v0 契约

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:boundary -->
### 边界

节点侧 Privilege Helper 是唯一允许跨越 OS privilege boundary 的通用组件。Agent Runtime 只通过本地 authenticated IPC 提交 typed operation；Helper 不暴露 root shell。

```text
Agent Runtime
    |
    | authenticated local IPC
    v
Privilege Helper
    |
    | lease validation + typed adapter
    v
OS privileged API
```

<!-- topic:request -->
### 请求

```yaml
request_id: request-...
lease_id: lease-...
operation_id: typed.operation.name
target_resource_ref: resource/...
parameters: schema-validated public-safe parameters
execution_ref: effect-unique-ref
```

Helper 不接受 raw shell command 作为 generic operation。

<!-- topic:validation -->
### 执行前验证

Helper 必须通过 Lease Validator 检查：

- trusted issuer / authenticity；
- subject / audience / node identity；
- request digest / policy / approval currentness；
- time window / max uses；
- exact operation / scope / parameter constraints；
- execution/effect fence 未被消费。

有副作用操作必须在执行前原子 reserve effect fence。任何 precondition 不满足都 `DENY`，零 side effect。

<!-- topic:forbidden -->
### 禁止接口

v0 Helper 不暴露：

- arbitrary shell；
- unrestricted sudo/root shell；
- root SSH access；
- credential export；
- privileged file browser；
- security-control bypass；
- 未注册 typed contract 的 operation。

Typed adapter 内部可以调用 OS command/API，但 command implementation 不是 Agent 可控的 authority surface。

<!-- topic:receipt -->
### Receipt / uncertainty

每次拒绝或执行都产出 receipt。执行中如果 side effect 可能已发生但结果未确认，Helper 返回 `RECONCILE_REQUIRED`，保留 effect ref，禁止换 nonce/lease 盲重试。

## English

<!-- topic:boundary -->
### Boundary

The node-side Privilege Helper is the only generic component crossing the OS privilege boundary. Agents submit typed operations over authenticated local IPC; the Helper never exposes a root shell.

<!-- topic:request -->
### Request

Requests bind a lease, typed operation, exact resource, validated public-safe parameters, and a unique execution/effect reference. Raw shell commands are not a generic operation.

<!-- topic:validation -->
### Validation

Before execution the Helper verifies lease authenticity/currentness, subject/audience/node binding, request digest, policy/approval authority, time/use limits, operation/scope/parameters, and replay/effect fences. Failed preconditions deny with zero side effects.

<!-- topic:forbidden -->
### Forbidden interfaces

No arbitrary shell, unrestricted sudo/root shell, root SSH, credential export, privileged file browser, security bypass, or unregistered operation surface.

<!-- topic:receipt -->
### Receipts and uncertainty

Every denial or execution emits a receipt. If effects may have occurred but cannot be confirmed, the result is `RECONCILE_REQUIRED`; blind retries with a new nonce or lease are forbidden until reconciliation.
