# Consumer acceptance contract

artifact: `CONSUMER_ACCEPTANCE_CONTRACT`
artifact_version: `1.0.0`
status: `ACTIVE`
owner: `youling/ghostfleet`

This contract decides whether one named consumer has really adopted one existing node identity. It is deliberately **not** a second node lifecycle: it references a `NodeIdentity`, never mints one, and never changes `NodeLifecycle`.

## 中文

<!-- topic:boundary -->

核心 admission 与 consumer acceptance 是两件事。核心 `ACTIVE` 的含义仅仅是"本控制面自己的 admission 检查通过了"，它**不**表示任何外部 consumer 已经能列出、认证、路由并操作这个节点。历史上出现过一次真实故障：某次 canary 的 `control.canary` 走的是执行 agent 自己机器上的临时 SSH backend，会话结束后凭据随之消失，而那份 terminal 当时被记为 7/7 PASS。本契约就是为了让这种情况**在结构上无法被记为通过**。

```text
核心 ACTIVE          != consumer 已纳管
tunnel 健康           != consumer 已纳管
一次 SSH 调用成功      != consumer 已纳管
一次 typed 调用成功    != consumer 已纳管
Human 维护面可用       != consumer 已纳管
```

`evaluateConsumerAcceptance` 的前置条件是"该节点已经是 `ACTIVE`"，但核心 `ACTIVE` 只是入场条件，**永远不计入证据**。缺任何一项必需证据，记录就停在 `PENDING`，不会变成 `ACCEPTED`。

<!-- topic:elements -->

每条 acceptance 记录必须提供九项证据，全部齐备才会 `ACCEPTED`：

| 元素 | 含义 |
| --- | --- |
| `identity.reference` | 精确的被接纳 `NodeIdentity` 引用，必须与记录自身的 `node_uid` 一致 |
| `consumer.identity` | consumer / adapter 身份，加上当前 source 与 config revision |
| `control_path.binding` | 控制路径绑定引用 |
| `custody.durability` | 凭据托管的持久性（见下节） |
| `authority.positive` | 一次被授权操作的**肯定**结果与 receipt |
| `authority.negative` | 一次未授权操作被**拒绝**的否定结果与 receipt |
| `call_route.readback` | 针对**同一个** `node_uid` 的实际调用路由回读 |
| `executor.independence` | 执行者无关性证据（见下节） |
| `rollback.node_scoped` | 节点范围的回滚计划与结果（见下节） |

元素集合是封闭的。传入未知元素会被 `EVIDENCE_ELEMENT_UNKNOWN` 拒绝，所以"用某个真实观察冒充某项证据"在结构上做不到。

```js
const record = controller.openConsumerAcceptance({
  node_uid, consumer_ref: "adapter.alpha",
  source_revision, config_revision, control_path_ref,
  custody: { custody_class: "PROVIDER_NATIVE_SECRET", custody_ref: "deployment-secret/alpha" },
});
```

<!-- topic:custody -->

托管凭据的持久性是一个**独立于证据载荷**的判定，由记录自身在创建时分类。`custody_class` 决定 `durability`：

```text
PROVIDER_NATIVE_SECRET            -> DURABLE
HOST_OWNED_PROTECTED_ARTIFACT     -> DURABLE
EXECUTOR_WORKSPACE                -> EXECUTOR_BOUND
SESSION_LOCAL                     -> EXECUTOR_BOUND
AGENT_ARTIFACT                    -> EXECUTOR_BOUND
UNRESOLVED                        -> UNRESOLVED
```

只有 `DURABLE` 才能通过。任何 `EXECUTOR_BOUND` 或 `UNRESOLVED` 都会在 `evaluate` 阶段产生 `CUSTODY_NOT_DURABLE` 阻断项，并且**证据载荷无法把它洗白**——即使证据声称 `durability: DURABLE`，判定仍然读记录自身的分类。解析不出持久性时一律 fail closed。

契约只保存**不透明的引用元数据**，绝不保存机密本身。`custody_ref` 必须是受限字符集的 opaque reference；PEM 头、JWT 形状、provider key 形状、长 base64 块都会被 `CUSTODY_REFERENCE_SECRET_SHAPED` 拒绝。契约里若出现 `private_key`、`bearer`、`api_token` 这类字段名，会被既有的 `assertPublicSafe` 拦下。

具体的凭据机制由各 deployment adapter 负责证明；本契约只校验引用元数据与证据形状。

<!-- topic:independence -->

控制路径**不能**只在原始执行者的 session / workspace 里成立。必须由一个与原始执行者无依赖的全新上下文，重发出等价的被授权操作，才算通过：

```js
{
  fresh_context_ref: "executor-fresh-context",
  origin_executor_ref: "<原始执行者>",
  dependency_free: true,
  result: "PASS",
}
```

`dependency_free` 不为 `true`、结果不为 `PASS`、或 `fresh_context_ref` 与 `origin_executor_ref` 相同（即原执行者给自己背书），都会被拒绝。这一项是 consumer acceptance 的证据，**不是**新的核心 enrollment 证据类型。

<!-- topic:rollback -->

consumer 回滚是**节点范围**的，不只是版本范围的。adapter 必须声明它引入的每一个节点专属绑定，回滚必须移除全部这些绑定并证明先前可接受路径已恢复。只要还有任一声明过的绑定存活，回滚就不算完成——代码或版本回退本身无法满足这一项。

```text
code/version rollback alone   != 节点范围回滚完成
declared binding still live   != 节点范围回滚完成
```

具体会引入哪些绑定（例如某个 provider 的 policy / target / routing 条目）属于 deployment 文档与测试，不写进这个 provider-neutral 契约。

<!-- topic:nonadmitting -->

以下观察都是真实的、有用的，但**单独出现时永远不足以**通过 consumer acceptance：

```text
core_active
core_admission_evidence
transport_tunnel_healthy
single_ssh_call
single_typed_call
human_maintenance_surface
```

它们通过 `recordConsumerSignal` 记录，落在 `signals` 而不是 `evidence` 里，因此结构上不可能满足任何一项必需元素。`evaluate` 的判定结果会显式回报 `non_admitting_signals_ignored`，让审计者能看见"这些信号在场，但被有意忽略"。`recordConsumerSignal` 只接受这个封闭列表，未知信号名会被 `SIGNAL_UNKNOWN` 拒绝。

## English

<!-- topic:boundary -->

Core admission and consumer acceptance are different things. Core `ACTIVE` means only that this control plane's own admission checks passed. It does **not** mean that any external consumer can list, authenticate, route to and operate the node.

This boundary exists because of a real failure. A control canary once reported `control.canary` PASS while the SSH backend it used lived in the executing agent's own machine; when that session ended the credential disappeared, yet the terminal was recorded as 7/7 PASS. This contract exists so that situation **cannot be structurally recorded as a pass**.

```text
core ACTIVE            != consumer admitted
healthy tunnel         != consumer admitted
one SSH call succeeded != consumer admitted
one typed call succeeded != consumer admitted
Human maintenance surface usable != consumer admitted
```

`evaluateConsumerAcceptance` takes an already-`ACTIVE` node as a precondition, but core `ACTIVE` never counts as evidence. If any required element is missing the record stays `PENDING` and never becomes `ACCEPTED`.

<!-- topic:elements -->

Each acceptance record must supply nine evidence elements. Only a complete set yields `ACCEPTED`:

| Element | Meaning |
| --- | --- |
| `identity.reference` | Exact accepted `NodeIdentity` reference, equal to the record's own `node_uid` |
| `consumer.identity` | Consumer / adapter identity plus current source and config revision |
| `control_path.binding` | Control-path binding reference |
| `custody.durability` | Credential custody durability (see below) |
| `authority.positive` | **Positive** result and receipt for one authorized operation |
| `authority.negative` | **Denial** result and receipt for one unauthorized operation |
| `call_route.readback` | Actual call-route readback against the **same** `node_uid` |
| `executor.independence` | Executor-independence evidence (see below) |
| `rollback.node_scoped` | Node-scoped rollback plan and result (see below) |

The element set is closed. An unknown element is rejected with `EVIDENCE_ELEMENT_UNKNOWN`, so passing off some other real observation as acceptance evidence is structurally impossible.

<!-- topic:custody -->

Custody durability is decided by the record itself at creation time, **independently of the evidence payload**. `custody_class` determines `durability`:

```text
PROVIDER_NATIVE_SECRET            -> DURABLE
HOST_OWNED_PROTECTED_ARTIFACT     -> DURABLE
EXECUTOR_WORKSPACE                -> EXECUTOR_BOUND
SESSION_LOCAL                     -> EXECUTOR_BOUND
AGENT_ARTIFACT                    -> EXECUTOR_BOUND
UNRESOLVED                        -> UNRESOLVED
```

Only `DURABLE` passes. Any `EXECUTOR_BOUND` or `UNRESOLVED` value produces a `CUSTODY_NOT_DURABLE` blocker at evaluation time, and **the evidence payload cannot launder it** — even when the evidence claims `durability: DURABLE`, the decision reads the record's own classification. When durability cannot be resolved the gate fails closed.

The contract stores **opaque reference metadata only**, never secret material. `custody_ref` must be a bounded opaque reference; PEM headers, JWT shapes, provider-key shapes and long base64 blobs are rejected with `CUSTODY_REFERENCE_SECRET_SHAPED`. Secret-shaped field names such as `private_key`, `bearer` or `api_token` are rejected by the existing `assertPublicSafe` gate.

Proving the concrete custody mechanism remains the deployment adapter's responsibility; this contract validates only the reference metadata and the evidence shape.

<!-- topic:independence -->

A control path must not hold only inside the original executor's session or workspace. An equivalent authorized operation must be re-issued from a fresh context with no dependency on the original executor:

```js
{
  fresh_context_ref: "executor-fresh-context",
  origin_executor_ref: "<original executor>",
  dependency_free: true,
  result: "PASS",
}
```

A `dependency_free` that is not `true`, a result that is not `PASS`, or a `fresh_context_ref` equal to `origin_executor_ref` (the original executor certifying its own independence) are all rejected. This is consumer acceptance evidence, **not** a new core enrollment evidence type.

<!-- topic:rollback -->

Consumer rollback is **node-scoped**, not merely version-scoped. The adapter must declare every node-specific binding it introduced; rollback must remove all of them and prove the prior accepted path is restored. While any declared binding remains live the rollback is incomplete — a code or version rollback alone cannot satisfy this element.

```text
code/version rollback alone  != node-scoped rollback complete
declared binding still live  != node-scoped rollback complete
```

Which bindings a given provider introduces (for example policy / target / routing entries) belongs in deployment documentation and tests, not in this provider-neutral contract.

<!-- topic:nonadmitting -->

The following observations are real and useful, but on their own are **never** sufficient for consumer acceptance:

```text
core_active
core_admission_evidence
transport_tunnel_healthy
single_ssh_call
single_typed_call
human_maintenance_surface
```

They are recorded through `recordConsumerSignal` into `signals` rather than `evidence`, so they are structurally incapable of satisfying a required element. The evaluation decision explicitly reports `non_admitting_signals_ignored`, so an auditor can see that these signals were present and deliberately disregarded. `recordConsumerSignal` accepts only this closed list; an unknown signal name is rejected with `SIGNAL_UNKNOWN`.

## Scope

This contract is provider-neutral. It contains no deployment topology, provider identifiers or credential material, and it adds no default privilege to the read-only MCP surface. Consumer acceptance is reported through the controller and durable store; no MCP tool is added for it.