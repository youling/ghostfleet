# AI 原生权限代理 v0 / AI-native Privilege Broker v0

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:model -->
### 模型

```text
Authenticated ordinary Transport / Control Channel
  -> Node Runtime (no ambient root)
  -> Agent Intent
  -> PrivilegeRequest
  -> PolicyDecision
  -> [Human Approval when required]
  -> PrivilegeLease
  -> Lease Validator / Node Privileged Helper
  -> Typed OS Action
  -> PrivilegeReceipt
```

目标不是“让 Agent 获得 root”，而是把特定 intent 转成短时、受限、可审计 capability。

<!-- topic:objects -->
### 对象

- `PrivilegeRequest`：intent、typed operations、scope、requested lease bounds、recovery proposal；
- `PolicyDecision`：derived risk、AUTO/HUMAN/REJECT、reason codes、policy revision、lease bounds；
- `HumanApprovalRequest / HumanApprovalRecord`：对 exact normalized request digest 的待审请求与批准/拒绝；
- `PrivilegeLease`：issuer/subject/audience/node/authority/operation/scope/time/use/effect-fence；
- `PrivilegeReceipt`：deny/success/failure/uncertain effect 的 durable evidence。

<!-- topic:flow -->
### Human 与 Policy 的关系

不是所有 privileged action 都需要 Human。Canonical operation policy 可以对 bounded operation 自动批准；identity/credential/security boundary 默认 Human required。

普通权限已足够的只读 observation 不进入 Broker。Privilege Broker 只处理真正跨 OS privilege boundary 的动作。

长期 transport identity 可以存在，但它只负责连接与普通身份。`valid transport != valid privilege`：即使 SSH/RPC/tailnet session 已认证，缺少有效 PrivilegeLease 时 privileged operation 仍必须拒绝。

<!-- topic:boundaries -->
### 边界

- no recurring sudo password transport；
- no permanent Agent root authority；
- no arbitrary shell lease；
- no secret plaintext in request/approval/lease/receipt；
- no caller-controlled risk authority；
- no blind retry after uncertain side effect；
- public core 不硬编码 ThinkPad、Cloudflare、Tailscale 或其它私有 deployment topology；
- credential classes 明确分为 transport identity、node identity、lease signing authority、helper trust root、secret reference、break-glass recovery authority；
- break-glass 是 Human-gated exceptional recovery，不是普通 Agent capability。

ThinkPad 是 Fleet 私有部署的首个候选 consumer，实例 binding/evidence/credential custody 继续由 Fleet owner 管理。GhostFleet 不裁决 Tailscale SSH/SSH 等 transport 是否默认开启。

## English

<!-- topic:model -->
### Model

The broker sits behind an authenticated ordinary transport/control channel and turns Agent intent into bounded, short-lived, auditable capabilities through request, policy decision, optional Human approval, lease validation, typed privileged execution, and receipts. It does not make the Agent or transport session root.

<!-- topic:objects -->
### Objects

The v0 model consists of `PrivilegeRequest`, `PolicyDecision`, optional `HumanApprovalRequest/HumanApprovalRecord`, `PrivilegeLease`, and `PrivilegeReceipt`, each bound by exact references and currentness rather than shell authority.

<!-- topic:flow -->
### Human and policy

Not every privileged action requires a Human. Canonical policy may auto-approve narrowly bounded operations. Identity/credential/security-boundary changes default to Human approval. Ordinary unprivileged reads bypass the broker. Stable transport identity can be long-lived, but valid transport without a valid lease never authorizes privileged execution.

<!-- topic:boundaries -->
### Boundaries

No recurring password transport, permanent Agent root, arbitrary shell leases, secret plaintext, caller-controlled risk authority, blind retries after uncertain effects, silent credential-class collapse, ordinary-Agent break-glass, or private deployment topology in the public core.
