# ADR 003 — AI 原生权限代理、审批与租约验证 / AI-native Privilege Broker, Approval, and Lease Validation

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
  -> [HumanApprovalRequest -> HumanApprovalRecord when required]
  -> PrivilegeLease
  -> Lease Validator / Node Privileged Helper
  -> Typed OS Action
  -> PrivilegeReceipt
```

关键裁决：

1. **Policy Engine 只做决策，不直接等价于 authority。** 它输出 `AUTO_APPROVE | HUMAN_REQUIRED | REJECT` 与约束；Broker/issuer 只有在决策前提满足后才能签发 lease。
2. **Agent 不提供具有权威性的 risk。** 风险由 canonical operation policy、scope、impact、secret/identity involvement 与 recovery 条件推导；调用方声明不得降低结果。
3. **Capability != shell。** Lease 只能授权 typed operation + exact scope/parameter constraints，不提供 arbitrary shell、unrestricted sudo、root SSH 或 credential export。
4. **Human approval 绑定 exact normalized request digest。** PolicyDecision 需要 Human 时先生成 `HumanApprovalRequest`，Human 决策后形成 `HumanApprovalRecord`。Human 看到 target、intent、typed operations、scope、所有会改变 effect 的 public-safe 参数、duration/max-use、impact、recovery、为何需要 Human；secret 值只显示 opaque reference。任何字段变化都产生新 digest/新审批，旧 approval 不可复用。
5. **Recovery 是显式语义，不是假设所有动作都可回滚。** `recovery_mode = NONE | ROLLBACK | COMPENSATING | IRREVERSIBLE`。若 operation policy 要求 recovery 而请求缺失，直接 `REJECT`；`IRREVERSIBLE` 只能走显式 Human acceptance，不能靠“升风险”自动放行。
6. **Lease 是短时 capability token，不含 secret plaintext。** 必须绑定 issuer、subject/requester、audience/helper、node identity、request digest、policy revision、authority/approval reference、typed operations、scope、time window、max uses 与 replay/effect fence。
7. **Lease Validator fail closed。** 验证 authenticity、issuer/audience/target/subject、request digest、policy/approval currentness、time、use count、operation/scope/parameter match 与 replay fence。缺失/未知/过期/漂移均拒绝。
8. **Mutation 默认 one-shot。** 对有副作用的 v0 lease 默认 `max_uses=1`；重复 effect fence 不重放。若执行结果不确定，receipt 为 `RECONCILE_REQUIRED`，禁止 blind retry。
9. **低风险不等于一定需要 privilege lease。** 普通 agent 权限已经覆盖的 observation 直接走原只读 capability；只有确实跨 OS privilege boundary 时才进入 Broker。
10. **Approval 不转移 secret custody。** Human 点击批准只批准 normalized capability request；deployment secret/key custody 仍由 deployment owner 管理。
11. **Transport 与 privilege 分离。** 长期 authenticated transport 可以存在，但 transport/session identity 只获得 ordinary channel policy；没有有效 lease 时 privileged operation 必须 DENY。Routine root authority 不通过可复用 root SSH key/sudo password 向 Agent 分发。
12. **Credential classes 显式分离。** 至少区分 `TRANSPORT_IDENTITY / NODE_IDENTITY / LEASE_SIGNING_AUTHORITY / NODE_HELPER_TRUST_ROOT / SECRET_REFERENCE / BREAK_GLASS_RECOVERY_AUTHORITY`；任何 credential 不得静默跨 class 复用。
13. **Break-glass 是独立 Human recovery plane。** 它不是 super-lease、不是 AUTO policy outcome、不是普通 Agent fallback；恢复成功也不能自动关闭 consumer acceptance 或 broker trust。


### Counterexamples / 反例判定

| 反例 | 必须结果 |
| --- | --- |
| Caller 把 `credential.rotate` 自报为 LOW | 忽略 caller risk；按 registry 派生 CRITICAL/HUMAN |
| Human 批准 digest A 后 Agent 扩大 scope | 旧 approval 无效；新 digest 重新审批 |
| Lease 的 node/audience/subject 与现场不匹配 | DENY，零 side effect |
| operation policy 要求 rollback/compensating，但没有 plan ref | REJECT |
| 同一 effect fence 第二次提交 | 不重放 mutation；DENY 或按已有状态 reconcile |
| RPC timeout 后 side effect 可能已发生 | `RECONCILE_REQUIRED`，禁止 blind retry |
| 普通权限已可完成只读 observation | 不签 privilege lease，走原只读 capability |
| Human 点击批准 | 不获得/搬运 secret；只产生 digest-bound approval record |
| 普通 transport/SSH session 有效但没有 lease | privileged op DENIED |
| 普通 transport identity 被窃取 | 不自动获得 helper/root/lease signing authority；ordinary principal 也不得存在 passwordless elevation / root-equivalent daemon/socket 等 Broker bypass |
| transport 仍在线但 lease 已 expired/revoked | privileged op DENIED |
| Agent 请求 break-glass 作为普通 fallback | DENY；只能进入独立 Human recovery gate |
| 普通 caller 通过 Helper API 请求导出 private authority | DENY；无 generic export surface |
| root-owned Helper 本体已被完全攻陷 | 视为 trust-boundary incident；停止普通 acceptance，进入 rebuild/re-key/recovery，不虚假宣称协议仍能约束已获 root 的攻击者 |
| 一个 universal controller key 同时承担 transport/root/signer/recovery | 架构非法，必须拆分 credential classes |

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

成本：需要 canonical operation registry、policy revision、approval record、lease issuer/validator、effect-fence store 与 audit ledger；deployment 还需单独选择真实 transport、signing/custody 与 break-glass 实现，并维护这些 credential class 的独立生命周期。

<!-- topic:compatibility -->
### Compatibility

本 ADR 不改变现有默认只读 MCP、NodeIdentity lifecycle 或 consumer acceptance。GhostFleet 只冻结 transport-neutral 的 authority separation，不规定 SSH/Tailscale SSH/mTLS 等具体 transport 是否默认开启；这些属于 deployment policy。ThinkPad 只是 Fleet 私有 deployment 的首个候选 consumer，不能把真实节点/credential/provider topology 写入公共 GhostFleet。现有五个 direct-main 文档在本 ADR/PR 通过前均视为 provisional source；其历史保留，不重写。

## English

<!-- topic:context -->
### Context

GhostFleet needs bounded privileged actions without giving Agents permanent root authority or repeatedly asking Humans to transport sudo/SSH passwords. The direct-main commits `ed10d875`, `10d6bc4`, `e2e5cea`, `76f4d844`, and `b45a7c4` are preserved as historical/provisional design input; presence on `main` does not itself make them accepted architecture.

<!-- topic:decision -->
### Decision

GhostFleet defines `PrivilegeRequest -> PolicyDecision -> optional HumanApprovalRequest/HumanApprovalRecord -> PrivilegeLease -> Lease Validator/Helper -> typed OS action -> PrivilegeReceipt`. Risk is derived from canonical policy rather than trusted from the caller. Leases authorize typed operations and exact scope, never unrestricted shell access. Human approval binds an exact normalized request digest. Recovery is explicit as `NONE | ROLLBACK | COMPENSATING | IRREVERSIBLE`. Missing required recovery fails closed. Leases bind issuer, subject, audience, node, request digest, policy/approval references, operations, scope, validity, use limits, and replay/effect fences. Mutating v0 leases default to one use. Unknown or uncertain outcomes do not permit blind retry. Stable transport identity is explicitly separate from JIT privilege: a valid SSH/RPC/tailnet session without a valid lease cannot authorize privileged execution. The contract distinguishes transport identity, node identity, lease-signing authority, helper trust root, secret references, and break-glass recovery authority. Break-glass is a separate Human-gated recovery plane, never an ordinary Agent fallback.


### Counterexamples

Caller risk cannot downgrade a registered operation; scope drift invalidates an approval; node/audience/subject mismatch denies execution; missing required recovery rejects the request; replayed effect fences do not repeat mutations; uncertain effects require reconciliation; unprivileged reads bypass the broker; Human approval never transfers secret custody; valid transport without a lease cannot elevate; ordinary transport principals cannot retain passwordless/root-equivalent bypass surfaces; ordinary transport credentials cannot become helper/root/signing authority; private-authority export via the Helper API is denied; full compromise of the root-owned Helper is treated as an incident requiring rebuild/re-key/recovery rather than falsely claimed fail-closed containment; break-glass cannot be invoked as an ordinary Agent fallback.

<!-- topic:alternatives -->
### Alternatives

Permanent root authority, recurring password transport, caller-controlled risk, mandatory Human approval for every action, and pretending every operation has a literal rollback are rejected for the reasons stated above.

<!-- topic:consequences -->
### Consequences

The model requires an operation registry, policy revisioning, approval records, lease issuance/validation, effect fences, and an audit ledger, while preserving deployment-owned secret custody.

<!-- topic:compatibility -->
### Compatibility

This ADR does not change the default read-only MCP surface, NodeIdentity lifecycle, or consumer-acceptance semantics. GhostFleet remains transport-neutral and does not mandate Tailscale SSH, SSH, or any other transport default. ThinkPad remains a private Fleet deployment concern and no private topology or credential material enters the public contract.
