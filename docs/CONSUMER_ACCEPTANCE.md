# 消费者验收契约 / Consumer acceptance contract

artifact: `CONSUMER_ACCEPTANCE_CONTRACT`
artifact_version: `1.2.0`
status: `ACTIVE`
owner: `youling/ghostfleet`

## 中文

本契约用于判定**某一个具名 consumer 是否真正接管了某一个既有节点身份**。它刻意**不是**第二套节点生命周期：它引用一个 `NodeIdentity`，从不 mint 新身份，也从不修改 `NodeLifecycle`。

<!-- topic:boundary -->

核心 admission 与 consumer acceptance 是两件不同的事。核心 `ACTIVE` 仅表示"本控制面自身的 admission 检查通过"，它**不**意味着任何外部 consumer 已经能列出、认证、路由并操作该节点。

这条边界来自一次真实故障：某次 canary 把 `control.canary` 记为 PASS，而它使用的 SSH backend 实际位于执行 agent 自己的机器上；该会话结束后凭据随之消失，而那份 terminal 仍显示 7/7 PASS。本契约的存在，就是为了让这种情况**在结构上无法被记为通过**。

```text
核心 ACTIVE            != consumer 已纳管
tunnel 健康             != consumer 已纳管
一次 SSH 调用成功        != consumer 已纳管
一次 typed 调用成功      != consumer 已纳管
Human 维护面可用         != consumer 已纳管
```

`evaluateConsumerAcceptance` 以"节点已处于 `ACTIVE`"作为前置条件，但核心 `ACTIVE` 只计入入场，**永远不计入证据**。缺少任一必需证据时记录停留在 `PENDING`，不会变成 `ACCEPTED`。

### 状态机（已冻结）

只有两条合法迁移，其余全部拒绝：

```text
PENDING  --evaluate(证据齐备 且 custody 可证明持久)-->  ACCEPTED
ACCEPTED --completeConsumerRollback(精确集合匹配)-->  ROLLED_BACK   (终态)
```

`ROLLED_BACK` 是终态：已回滚的记录**不能**被重新 evaluate 回 `ACCEPTED`，也不能再追加证据或信号。重新接入必须**新建一条 acceptance 记录**，而不是复活旧记录。`REJECTED` 因为没有可达迁移而被移除，避免留下没有 owner 的语义空洞。

<!-- topic:elements -->

每条 acceptance 记录必须提供九项证据，全部齐备才会 `ACCEPTED`：

| 元素 | 含义 |
| --- | --- |
| `identity.reference` | 精确的被接纳 `NodeIdentity` 引用，必须与记录自身的 `node_uid` 一致 |
| `consumer.identity` | consumer / adapter 身份，加上当前 source 与 config revision |
| `control_path.binding` | 控制路径绑定引用 |
| `custody.durability` | 凭据托管的持久性，含属主与部署 attestation（见下节） |
| `authority.positive` | 一次被授权操作的**肯定**结果与 receipt |
| `authority.negative` | 一次未授权操作被**拒绝**的否定结果与 receipt |
| `call_route.readback` | 针对**同一个** `node_uid` 的实际调用路由回读 |
| `executor.independence` | 执行者无关性证据（见下节） |
| `rollback.plan` | 回滚**计划**：声明本 consumer 引入的绑定集合与旧路径恢复契约 |

元素集合是封闭的：传入未知元素会被 `EVIDENCE_ELEMENT_UNKNOWN` 拒绝，所以"拿某个真实观察冒充某项证据"在结构上做不到。

两个 revision 都是**provider-neutral 的有界 opaque 不可变引用**。`source_revision` **可以**是 Git SHA（那同样满足此形状），但 `config_revision` 不要求是 Git 对象——部署与 provider 的配置版本号并非 Git 对象。

```js
const record = controller.openConsumerAcceptance({
  node_uid, consumer_ref: "adapter.alpha",
  source_revision, config_revision, control_path_ref,
  custody: {
    custody_class: "PROVIDER_NATIVE_SECRET",
    custody_ref: "deployment-secret/alpha",
    owner_ref: "owner/platform-team",
    attestation_ref: "attestation/deployment-alpha/custody-v1",
  },
  origin_executor_ref: "executor-original-run",
});
```

<!-- topic:custody -->

托管凭据的持久性是一个**独立于证据载荷**的判定，由记录自身在创建时分类。关键点是：**durable class 只是一个声明，不是证明。** 仅选择 enum 值无法得到 `DURABLE`。

```text
PROVIDER_NATIVE_SECRET          + owner_ref + attestation_ref  -> DURABLE
HOST_OWNED_PROTECTED_ARTIFACT   + owner_ref + attestation_ref  -> DURABLE
EXECUTOR_WORKSPACE                                             -> EXECUTOR_BOUND
SESSION_LOCAL                                                  -> EXECUTOR_BOUND
AGENT_ARTIFACT                                                 -> EXECUTOR_BOUND
UNRESOLVED                                                     -> UNRESOLVED
```

durable class 缺少 `owner_ref` 或 `attestation_ref` 时不会降级为"较弱的 durable"，而是直接以 `CUSTODY_DURABILITY_UNPROVEN` 失败。`attestation_ref` 表示"这是哪个 deployment owner 以哪份当前配置确认过的 custody"这一 opaque 引用；public core 不需要理解任何具体 provider 或文件系统，但它确保调用方无法仅靠选择 enum 拿到 durable 结论。

`EXECUTOR_BOUND` 与 `UNRESOLVED` 保持在 `evaluate` 阶段产生 `CUSTODY_NOT_DURABLE` 阻断项，并且**证据载荷无法洗白**——即使证据声称 `DURABLE`，判定仍然读记录自身的分类。解析不出持久性时一律 fail closed。

契约只保存**不透明的引用元数据**，绝不保存机密本身。`custody_ref` / `owner_ref` / `attestation_ref` 必须是受限字符集的 opaque reference；PEM 头、JWT 形状、provider key 形状、长 base64 块都会被 `CUSTODY_REFERENCE_SECRET_SHAPED` 拒绝。契约里若出现 `private_key`、`bearer`、`api_token` 这类字段名，会被既有的 `assertPublicSafe` 拦下。具体的凭据机制由各 deployment adapter 负责证明。

<!-- topic:independence -->

控制路径**不能**只在原始执行者的 session / workspace 里成立。必须由一个与原始执行者无依赖的全新上下文，重发出等价的被授权操作，才算通过：

```js
{
  fresh_context_ref: "executor-fresh-context",
  origin_executor_ref: "<记录自身的 origin_executor_ref>",
  dependency_free: true,
  result: "PASS",
}
```

`origin_executor_ref` 是**创建时必填**的可判定输入，不是可选项。否则"fresh context 不得等于 original executor"这一检查会完全失效，只剩调用方自报 `dependency_free: true`。因此 `executor.independence` 证据的**两端**都与记录绑定校验：`origin_executor_ref` 必须等于记录的值，`fresh_context_ref` 必须不等于它。`dependency_free` 不为 `true`、结果不为 `PASS`、两端不匹配、或原执行者给自己背书，都会被拒绝。

更关键的是：独立性的含义是"fresh context **重放了同一个被授权 operation** 并产生了**自己的 receipt**"。所以：

- `authority.positive` 必须携带**可判定的 operation identity**（有界 opaque token）；
- `executor.independence` 必须绑定**同一个 operation identity**；
- fresh context 必须携带**独立的 `receipt_ref`**，且不得等于 baseline 的 `receipt_ref`；
- 还必须携带独立的 `readback_ref`，用于表明这次重放确实落到了同一身份，而不只是"声称发起过一次调用"；
- `operation` / `receipt_ref` / `readback_ref` / 等价性 任一缺失或不匹配，一律 fail closed。

也就是说，**仅仅重写一个 PASS 形状的 payload 无法证明独立性**——这正是本契约要防的那类"证据只声明结果结构、不证明事实"。

这一项是 consumer acceptance 的证据，**不是**新的核心 enrollment 证据类型。

<!-- topic:rollback -->

consumer 回滚是**节点范围**的，不只是版本范围的。关键是分两层，语义不能倒置：

- **acceptance 阶段**只要求 `rollback.plan`：声明本 consumer 引入的绑定集合，以及旧路径恢复契约（`prior_path_restoration_contract_ref`）。此时新路径必须仍然在位。
- **实际回滚结果**只在 `completeConsumerRollback` 时验证：`removed_bindings` 必须与计划的声明集合**精确相等**——既不能遗漏，也不能有多余。
- 回滚结果必须**显式**声明 `result: "PASS"`，**不提供缺省 PASS**：省略它就是没有证明任何事，默认成成功等于把沉默当结论。
- 必须携带 provider-neutral 的 `rollback_receipt_ref`（等价于 removal evidence ref）与 `prior_path_readback_ref`（等价于恢复证明）。两者都是有界 opaque reference，且不得指向同一个引用。
- 两个 proof ref 会保留在 durable decision 与事件里，供后续审计回读。

```text
code/version rollback alone   != 节点范围回滚完成
声明绑定仍然存活               != 节点范围回滚完成
声称删除了未声明的对象          != 节点范围回滚完成
```

要求"先完成回滚才允许 accept"会把语义倒置：那样一来，`ACCEPTED` 时新路径反而可能已经不存在了。计划与结果分离正是为了避免这一点。

声明集合与移除集合都要经过 public-safe、有界 opaque ref、去重校验（上限 64 项，重复项以 `ROLLBACK_BINDINGS_DUPLICATE` 拒绝）。

provider-neutral 契约必须允许"该 consumer 明确声明自己没有引入任何 node-specific binding"这一合法情况。因此**显式空集是合法的、可完成的回滚**（`declared_bindings: []` 配 `removed_bindings: []`）；而"根本没有声明"是由缺失 `rollback.plan` 元素来区分的，两种状态不会混淆。

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

它们通过 `recordConsumerSignal` 记录，落在 `signals` 而不是 `evidence` 里，因此结构上不可能满足任何一项必需元素。事件流同样保持这一区分：信号写入 `CONSUMER_ACCEPTANCE_SIGNAL_RECORDED`，只有真正的证据变更才发 `CONSUMER_ACCEPTANCE_EVIDENCE_UPDATED`——不会让 signal 在事件层面又被叫回 evidence。`evaluate` 的判定结果会显式回报 `non_admitting_signals_ignored`，让审计者能看见"这些信号在场，但被有意忽略"。`recordConsumerSignal` 只接受这个封闭列表，未知信号名会被 `SIGNAL_UNKNOWN` 拒绝。

## English

This contract decides whether one named consumer has really adopted one existing node identity. It is deliberately **not** a second node lifecycle: it references a `NodeIdentity`, never mints one, and never changes `NodeLifecycle`.

<!-- topic:boundary -->

Core admission and consumer acceptance are different things. Core `ACTIVE` means only that this control plane's own admission checks passed. It does **not** mean that any external consumer can list, authenticate, route to and operate the node.

This boundary exists because of a real failure. A control canary once reported `control.canary` PASS while the SSH backend it used lived in the executing agent's own machine; when that session ended the credential disappeared, and the terminal still read 7/7 PASS. This contract exists so that situation **cannot be structurally recorded as a pass**.

```text
core ACTIVE             != consumer admitted
healthy tunnel          != consumer admitted
one SSH call succeeded  != consumer admitted
one typed call succeeded != consumer admitted
Human maintenance surface usable != consumer admitted
```

`evaluateConsumerAcceptance` takes an already-`ACTIVE` node as a precondition, but core `ACTIVE` never counts as evidence. If any required element is missing the record stays `PENDING` and never becomes `ACCEPTED`.

### State machine (frozen)

Exactly two transitions are legal; everything else is rejected:

```text
PENDING  --evaluate(elements complete and custody provably durable)-->  ACCEPTED
ACCEPTED --completeConsumerRollback(exact set match)--------------->  ROLLED_BACK   (terminal)
```

`ROLLED_BACK` is terminal: a rolled-back record **cannot** be re-evaluated to `ACCEPTED`, and accepts no further evidence or signals. Re-admission requires a **new** acceptance record, never revival of the old one. `REJECTED` was removed because it had no reachable transition, which would have left a semantic hole with no owner.

<!-- topic:elements -->

Each acceptance record must supply nine evidence elements. Only a complete set yields `ACCEPTED`:

| Element | Meaning |
| --- | --- |
| `identity.reference` | Exact accepted `NodeIdentity` reference, equal to the record's own `node_uid` |
| `consumer.identity` | Consumer / adapter identity plus current source and config revision |
| `control_path.binding` | Control-path binding reference |
| `custody.durability` | Credential custody durability, including owner and deployment attestation (see below) |
| `authority.positive` | **Positive** result and receipt for one authorized operation |
| `authority.negative` | **Denial** result and receipt for one unauthorized operation |
| `call_route.readback` | Actual call-route readback against the **same** `node_uid` |
| `executor.independence` | Executor-independence evidence (see below) |
| `rollback.plan` | Rollback **plan**: declared binding set plus prior-path restoration contract |

The element set is closed. An unknown element is rejected with `EVIDENCE_ELEMENT_UNKNOWN`, so passing off some other real observation as acceptance evidence is structurally impossible.

Both revisions are **provider-neutral bounded opaque immutable references**. `source_revision` **may** be a Git SHA (which also satisfies this shape), but `config_revision` is not required to be a Git object — deployment and provider config revisions are not Git objects.

```js
const record = controller.openConsumerAcceptance({
  node_uid, consumer_ref: "adapter.alpha",
  source_revision, config_revision, control_path_ref,
  custody: {
    custody_class: "PROVIDER_NATIVE_SECRET",
    custody_ref: "deployment-secret/alpha",
    owner_ref: "owner/platform-team",
    attestation_ref: "attestation/deployment-alpha/custody-v1",
  },
  origin_executor_ref: "executor-original-run",
});
```

<!-- topic:custody -->

Custody durability is decided by the record itself at creation time, **independently of the evidence payload**. The key point: **a durable class is a claim, not a proof.** Selecting an enum value alone cannot yield `DURABLE`.

```text
PROVIDER_NATIVE_SECRET          + owner_ref + attestation_ref  -> DURABLE
HOST_OWNED_PROTECTED_ARTIFACT   + owner_ref + attestation_ref  -> DURABLE
EXECUTOR_WORKSPACE                                             -> EXECUTOR_BOUND
SESSION_LOCAL                                                  -> EXECUTOR_BOUND
AGENT_ARTIFACT                                                 -> EXECUTOR_BOUND
UNRESOLVED                                                     -> UNRESOLVED
```

A durable class missing `owner_ref` or `attestation_ref` does not degrade to a "weaker durable"; it fails outright with `CUSTODY_DURABILITY_UNPROVEN`. `attestation_ref` is the opaque reference meaning "which deployment owner confirmed this custody under which current configuration". The public core need not understand any concrete provider or filesystem, but it does ensure a caller cannot reach a durable conclusion by enum selection alone.

`EXECUTOR_BOUND` and `UNRESOLVED` produce a `CUSTODY_NOT_DURABLE` blocker at evaluation time, and **the evidence payload cannot launder it** — even when the evidence claims `DURABLE`, the decision reads the record's own classification. When durability cannot be resolved the gate fails closed.

The contract stores **opaque reference metadata only**, never secret material. `custody_ref` / `owner_ref` / `attestation_ref` must be bounded opaque references; PEM headers, JWT shapes, provider-key shapes and long base64 blobs are rejected with `CUSTODY_REFERENCE_SECRET_SHAPED`. Secret-shaped field names such as `private_key`, `bearer` or `api_token` are rejected by the existing `assertPublicSafe` gate. Proving the concrete custody mechanism remains the deployment adapter's responsibility.

<!-- topic:independence -->

A control path must not hold only inside the original executor's session or workspace. An equivalent authorized operation must be re-issued from a fresh context with no dependency on the original executor:

```js
{
  fresh_context_ref: "executor-fresh-context",
  origin_executor_ref: "<the record's own origin_executor_ref>",
  dependency_free: true,
  result: "PASS",
}
```

`origin_executor_ref` is a **create-time required** decidable input, not optional. Without it the "fresh context must differ from the original executor" check is entirely inert, leaving only the caller self-reporting `dependency_free: true`. Therefore **both ends** of the `executor.independence` evidence are validated against the record: `origin_executor_ref` must equal the record's value and `fresh_context_ref` must differ from it. A `dependency_free` that is not `true`, a non-`PASS` result, mismatched ends, or the original executor certifying itself are all rejected.

More importantly, independence means the fresh context **replayed the same authorized operation** and produced **its own receipt**. Therefore:

- `authority.positive` must carry a **decidable operation identity** (a bounded opaque token);
- `executor.independence` must bind to **the same operation identity**;
- the fresh context must carry an **independent `receipt_ref`**, which must not equal the baseline `receipt_ref`;
- it must also carry an independent `readback_ref`, showing the replay actually landed on the same identity rather than merely claiming a call was made;
- any missing or mismatched `operation` / `receipt_ref` / `readback_ref` / equivalence fails closed.

In other words, **merely restating a PASS-shaped payload cannot prove independence** — which is exactly the "evidence that only asserts a result shape rather than proving the fact" failure this contract exists to prevent.

This is consumer acceptance evidence, **not** a new core enrollment evidence type.

<!-- topic:rollback -->

Consumer rollback is **node-scoped**, not merely version-scoped. The key is that it is layered, and the semantics must not invert:

- The **acceptance** stage requires only `rollback.plan`: the declared binding set this consumer introduced, plus the prior-path restoration contract (`prior_path_restoration_contract_ref`). At this point the new path must still be in place.
- The actual rollback **result** is verified only at `completeConsumerRollback`: `removed_bindings` must be an **exact set match** against the plan's declared set — no omissions and no extras.
- The rollback result must state `result: "PASS"` **explicitly**; there is **no default PASS**. Omitting it proves nothing, and defaulting would turn silence into a conclusion.
- It must carry a provider-neutral `rollback_receipt_ref` (equivalent to a removal evidence ref) and a `prior_path_readback_ref` (equivalent to a restoration proof). Both are bounded opaque references and must not be the same reference.
- Both proof refs are retained in the durable decision and the event so they can be audited later.

```text
code/version rollback alone    != node-scoped rollback complete
declared binding still live    != node-scoped rollback complete
claiming removal of undeclared objects != node-scoped rollback complete
```

Requiring a completed rollback before acceptance would invert the meaning: `ACCEPTED` would then imply the new path may already be gone. Separating plan from result exists precisely to prevent that.

Both the declared and removed sets are validated as public-safe, bounded opaque references, deduplicated (cap of 64 entries; duplicates rejected with `ROLLBACK_BINDINGS_DUPLICATE`).

The provider-neutral contract must permit the legitimate case of a consumer that **explicitly declares it introduced no node-specific bindings**. An **explicitly empty set is therefore a legal, completable rollback** (`declared_bindings: []` with `removed_bindings: []`), while "never declared at all" is distinguished by the missing `rollback.plan` element. The two states are never conflated.

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

They are recorded through `recordConsumerSignal` into `signals` rather than `evidence`, so they are structurally incapable of satisfying a required element. The event stream preserves the same distinction: signals emit `CONSUMER_ACCEPTANCE_SIGNAL_RECORDED`, and only real evidence mutations emit `CONSUMER_ACCEPTANCE_EVIDENCE_UPDATED` — a signal is never renamed back into evidence at the event layer either. The evaluation decision explicitly reports `non_admitting_signals_ignored`, so an auditor can see they were present and deliberately disregarded. `recordConsumerSignal` accepts only this closed list; an unknown signal name is rejected with `SIGNAL_UNKNOWN`.

## Scope

This contract is provider-neutral. It contains no deployment topology, provider identifiers or credential material, and it adds no default privilege to the read-only MCP surface. Consumer acceptance is reported through the controller and durable store; no MCP tool is added for it.