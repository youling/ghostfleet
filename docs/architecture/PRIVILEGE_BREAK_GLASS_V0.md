# Break-glass 恢复 v0 / Break-glass Recovery v0

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:purpose -->
### 目的

Break-glass 是**日常控制面失效时的异常恢复路径**，不是 Privilege Broker 的“超级 lease”，也不是普通 Agent 的备用 root 通道。

典型触发条件：

- Privileged Helper 无法启动/损坏；
- broker/issuer/trust relation 无法恢复；
- 节点 identity/trust material 严重损坏；
- OS 无法进入正常 control runtime；
- deployment 明确声明的灾备事件。

<!-- topic:authority -->
### Authority

Break-glass 必须满足：

```text
Human explicit recovery gate
+ separate recovery authority/custody
+ exact target
+ bounded recovery intent
+ durable recovery record/receipt
```

普通 Policy Engine / AUTO_APPROVE 不得签发 break-glass authority。普通 Agent/Helper operation registry 不得包含“获取 break-glass secret”“进入 unrestricted recovery shell”等通用 capability。

<!-- topic:custody -->
### Custody

具体 deployment 可以采用：

- local console；
- provider rescue；
- hardware recovery token；
- separately escrowed recovery credential；
- other Human-controlled recovery mechanism。

Public GhostFleet 只保存 class/reference/evidence contract，不保存真实 recovery secret/plaintext。

Break-glass authority 与以下对象必须分离：

- ordinary transport identity；
- Lease signing authority；
- Helper trust root；
- Agent/session/workspace secret；
- routine SSH identity。

如果部署使用可长期保存的 recovery credential，它必须独立 custody、可轮换/撤销，并不进入普通 Agent 可读路径。

<!-- topic:lifecycle -->
### Recovery lifecycle

```text
CLOSED
  -> HUMAN_AUTHORIZED
  -> ACTIVE_RECOVERY
  -> RECOVERED | FAILED | RECONCILE_REQUIRED
  -> CLOSED_WITH_RECEIPT
```

每次 recovery attempt 都是独立记录；终态不可复活。重新尝试必须新建 recovery attempt/id。

<!-- topic:receipt -->
### Durable receipt

Break-glass receipt 至少绑定：

- recovery attempt id；
- target node/reference；
- Human authority reference；
- reason/incident reference；
- recovery method class；
- start/end timestamps；
- actions/effects 的 public-safe refs；
- outcome；
- post-recovery re-enrollment/re-key/reconcile requirement。

如果恢复过程中使用过临时 root/recovery credential，成功后必须显式 retire/revoke/rotate 或证明其仍处于独立 recovery custody；不能悄悄把它转成日常控制凭据。

<!-- topic:return -->
### 回归正常路径

Break-glass 成功只证明恢复完成，不自动恢复 consumer acceptance 或 privilege-broker trust。

回到正常路径前至少需要按受影响范围重新证明：

- NodeIdentity/currentness；
- ordinary transport identity/policy；
- Helper + trust root；
- issuer/lease verification；
- consumer acceptance；
- credential rotation/revocation closure。

<!-- topic:counterexamples -->
### 反例

| 场景 | 必须结果 |
| --- | --- |
| Agent 因 lease 被 DENY 而“升级”到 break-glass | DENY |
| Policy Engine AUTO_APPROVE break-glass | 禁止 |
| 普通 SSH key 同时充当 recovery root key | 非法 class collapse |
| recovery secret 放入 Agent workspace/chat | 禁止 |
| recovery 成功后保留临时 root credential 作为日常通道 | 禁止，必须 retire/rotate |
| break-glass 成功后直接宣布 consumer ACCEPTED | 禁止，重新做受影响 acceptance |

## English

<!-- topic:purpose -->
### Purpose

Break-glass is an exceptional recovery path for failure of the normal control plane. It is not a super-lease or ordinary Agent fallback root channel.

<!-- topic:authority -->
### Authority

Every attempt requires an explicit Human recovery gate, separate recovery authority/custody, an exact target and bounded intent, plus a durable recovery record. Policy auto-approval cannot grant break-glass authority.

<!-- topic:custody -->
### Custody

Deployments may use local console, provider rescue, hardware recovery tokens, separately escrowed credentials, or another Human-controlled mechanism. Public GhostFleet stores only references/evidence, never recovery plaintext. Recovery authority is separate from transport identity, lease signing authority, helper trust roots, and Agent/session secrets.

<!-- topic:lifecycle -->
### Lifecycle

Each recovery attempt moves from closed to Human-authorized active recovery, then to recovered/failed/reconcile-required and a durable closed receipt. Terminal attempts are never revived.

<!-- topic:receipt -->
### Receipt

The receipt binds attempt, target, Human authority, reason/incident, recovery method class, timing, public-safe effect references, outcome, and any required re-enrollment/re-key/reconcile work. Temporary recovery/root credentials must be retired, revoked, rotated, or proven to remain separately escrowed.

<!-- topic:return -->
### Return to normal authority

Recovery success does not automatically restore consumer acceptance or broker trust. Affected identity, transport, helper trust, issuer verification, consumer acceptance, and credential-rotation closure must be re-established as required.

<!-- topic:counterexamples -->
### Counterexamples

Denied leases cannot escalate into break-glass; policy cannot auto-approve it; ordinary transport credentials cannot double as recovery root authority; recovery secrets never enter Agent workspace/chat; temporary root authority cannot become a routine control path; recovery does not auto-close consumer acceptance.
