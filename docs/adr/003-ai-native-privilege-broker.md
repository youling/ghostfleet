# ADR 003 — AI-native 权限代理、审批与租约验证 / AI-native Privilege Broker, Approval, and Lease Validation

状态：Proposed  
来源 Issue：#9

## 中文

<!-- topic:context -->
### Context

GhostFleet 需要让 Agent 在不长期持有 root、不反复要求 Human 输入 sudo/SSH 密码的前提下执行受限提权动作。此前 `ed10d875`、`10d6bc4`、`e2e5cea`、`76f4d844`、`b45a7c4` 直接进入 `main`，这些内容仅作为历史/provisional 设计输入，不因位于 `main` 自动成为已接受架构。

问题的核心不是“如何给 Agent root”，而是如何把 Human/Policy 对**意图与 typed capability** 的授权，转成短时、受限、可审计、可防重放的机器 authority，同时让节点 helper 能 fail closed 地验证。

<!-- topic:decision -->
### Decision

GhostFleet 定义以下通用对象链：

```text
Agent Intent
  -> PrivilegeRequest
  -> PolicyDecision
  -> [HumanApprovalRecord when required]
  -> PrivilegeLease
  -> Lease Validator / Node Privileged Helper
  -> Typed OS Action
  -> PrivilegeReceipt
```

关键裁决：

1. **Policy Engine 只做决策，不直接等价于 authority。** 它输出 `AUTO_APPROVE | HUMAN_REQUIRED | REJECT` 与约束；Broker/issuer 只有在决策前提满足后才能签发 lease。
2. **Agent 不提供具有权威性的 risk。** 风险由 canonical operation policy、scope、impact、secret/identity involvement 与 recovery 条件推导；调用方声明不得降低结果。
3. **Capability != shell。** Lease 只能授权 typed operation + exact scope/parameter constraints，不提供 arbitrary shell、unrestricted sudo、root SSH 或 credential export。
4. **Human approval 绑定 exact normalized request digest。** Human 看到 target、intent、typed operations、scope、duration/max-use、impact、recovery、为何需要 Human；任何字段变化都产生新 digest/新审批，旧 approval 不可复用。
5. **Recovery 是显式语义，不是假设所有动作都可回滚。** `recovery_mode = NONE | ROLLBACK | COMPENSATING | IRREVERSIBLE`。若 operation policy 要求 recovery 而请求缺失，直接 `REJECT`；`IRREVERSIBLE` 只能走显式 Human acceptance，不能靠“升风险”自动放行。
6. **Lease 是短时 capability token，不含 secret plaintext。** 必须绑定 issuer、subject/requester、audience/helper、node identity、request digest、policy revision、authority/approval reference、typed operations、scope、time window、max uses 与 replay/effect fence。
7. **Lease Validator fail closed。** 验证 authenticity、issuer/audience/target/subject、request digest、policy/approval currentness、time、use count、operation/scope/parameter match 与 replay fence。缺失/未知/过期/漂移均拒绝。
8. **Mutation 默认 one-shot。** 对有副作用的 v0 lease 默认 `max_uses=1`；重复 effect fence 不重放。若执行结果不确定，receipt 为 `RECONCILE_REQUIRED`，禁止 blind retry。
9. **低风险不等于一定需要 privilege lease。** 普通 agent 权限已经覆盖的 observation 直接走原只读 capability；只有确实跨 OS privilege boundary 时才进入 Broker。
10. **Approval 不转移 secret custody。** Human 点击批准只批准 normalized capability request；deployment secret/key custody 仍由 deployment owner 管理。

<!-- topic:alternatives -->
### Alternatives

**A. Agent 获得长期 root/sudo/SSH authority。** 拒绝：authority 范围与任务不绑定，难以撤销、审计和最小化。

**B. 每次提权都让 Human 输入密码。** 拒绝：把 credential transport 当 approval UX，既低效又扩大 secret 暴露面。

**C. 让 Agent 自报 LOW/MEDIUM/HIGH 决定审批。** 拒绝：调用方可以低报风险；风险必须由 canonical policy 推导。

**D. 所有 privileged operation 一律 Human。** 拒绝：会把可安全自动授权的 bounded capability 退化成人工瓶颈；v0 允许 canonical policy 对明确 operation 做 AUTO_APPROVE。

**E. 所有动作都强制 literal rollback。** 拒绝：credential rotation、trust-root change 等并不总能安全恢复旧状态；需要 `COMPENSATING` / `IRREVERSIBLE` 语义。

<!-- topic:consequences -->
### Consequences

收益：authority 绑定具体 operation/scope/time/use；Human 审批不再等价密码搬运；节点 helper 能独立验证；policy auto-approval 与 Human gate 共存；replay/uncertain effect 有统一 fail-closed 语义。

成本：需要 canonical operation registry、policy revision、approval record、lease issuer/validator、effect-fence store 与 audit ledger；deployment 还需单独选择真实 signing/custody 实现。

<!-- topic:compatibility -->
### Compatibility

本 ADR 不改变现有默认只读 MCP、NodeIdentity lifecycle 或 consumer acceptance。ThinkPad 只是 Fleet 私有 deployment 的首个候选 consumer，不能把真实节点/credential/provider topology 写入公共 GhostFleet。现有五个 direct-main 文档在本 ADR/PR 通过前均视为 provisional source；其历史保留，不重写。

## English

<!-- topic:context -->
### Context

GhostFleet needs bounded privileged actions without giving Agents permanent root authority or repeatedly asking Humans to transport sudo/SSH passwords. The direct-main commits `ed10d875`, `10d6bc4`, `e2e5cea`, `76f4d844`, and `b45a7c4` are preserved as historical/provisional design input; presence on `main` does not itself make them accepted architecture.

<!-- topic:decision -->
### Decision

GhostFleet defines `PrivilegeRequest -> PolicyDecision -> optional HumanApprovalRecord -> PrivilegeLease -> Lease Validator/Helper -> typed OS action -> PrivilegeReceipt`. Risk is derived from canonical policy rather than trusted from the caller. Leases authorize typed operations and exact scope, never unrestricted shell access. Human approval binds an exact normalized request digest. Recovery is explicit as `NONE | ROLLBACK | COMPENSATING | IRREVERSIBLE`. Missing required recovery fails closed. Leases bind issuer, subject, audience, node, request digest, policy/approval references, operations, scope, validity, use limits, and replay/effect fences. Mutating v0 leases default to one use. Unknown or uncertain outcomes do not permit blind retry.

<!-- topic:alternatives -->
### Alternatives

Permanent root authority, recurring password transport, caller-controlled risk, mandatory Human approval for every action, and pretending every operation has a literal rollback are rejected for the reasons stated above.

<!-- topic:consequences -->
### Consequences

The model requires an operation registry, policy revisioning, approval records, lease issuance/validation, effect fences, and an audit ledger, while preserving deployment-owned secret custody.

<!-- topic:compatibility -->
### Compatibility

This ADR does not change the default read-only MCP surface, NodeIdentity lifecycle, or consumer-acceptance semantics. ThinkPad remains a private Fleet deployment concern and no private topology or credential material enters the public contract.
