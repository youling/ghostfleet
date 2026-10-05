# 人类审批载荷 v0 / Human Approval Payload v0

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:payload -->
### 载荷目标

Human approval payload 是**给人看的授权请求投影**，不是 shell prompt，也不是 secret transport。它必须绑定 Policy Engine 已规范化的请求，使 Human 批准的是一份机器可判的 capability contract。

最小结构：

```yaml
approval_request_id: approval-...
request_id: request-...
normalized_request_digest: sha256:...
node_uid: node-...
requester_ref: agent/...
intent: 安装并启用已批准服务
operations:
  - operation_id: systemd.unit.create
    scope_ref: service/cloudflared
    material_parameters:
      unit_name: cloudflared.service
      # secret-bearing values are represented only by opaque references
policy_revision: policy/...
derived_risk: HIGH
decision_reason_codes:
  - HUMAN_REQUIRED_BY_OPERATION_POLICY
lease_bounds:
  ttl_seconds: 900
  max_uses: 1
impact:
  persistent_change: true
  affected_resources:
    - service/cloudflared
recovery:
  mode: ROLLBACK
  plan_ref: rollback/...
approval_requirements:
  human_required: true
created_at: timestamp
expires_at: timestamp
```

<!-- topic:binding -->
### Digest 绑定

`normalized_request_digest` 必须覆盖至少：target identity、requester、typed operations、scope、parameter constraints、requested lease bounds、policy revision、impact/recovery facts。Human approval 只对该 digest 有效。

如果 Human 想缩短 TTL、删掉 operation、缩小 scope 或改变 recovery，系统必须重新规范化并产生**新的 digest**；不能在旧 approval 上原地改字段。

Approval record：

```yaml
approval_record_id: approval-record-...
approval_request_id: approval-...
normalized_request_digest: sha256:...
approver_ref: human/...
decision: APPROVE|DENY
decided_at: timestamp
```

v0 不提供“永久批准”按钮。Approval 只服务本次 normalized request / lease issuance。

Approval Request 生命周期固定为：

```text
PENDING -> APPROVED | DENIED | EXPIRED | SUPERSEDED
```

任何终态都不可复活；request digest 改变时旧 approval request 进入 `SUPERSEDED`，必须创建新 id。

<!-- topic:ux -->
### Human 应看到什么

Human 默认看到：

- 哪个节点；
- 哪个 Agent/任务请求；
- 想完成什么意图；
- 哪些 typed operations；
- 精确影响范围；
- 所有会改变实际 effect 的 public-safe material parameters；secret-bearing 参数只显示 opaque reference；
- 最长多久、最多几次；
- 是否改持久状态；
- recovery mode 与计划；
- 为什么 policy 不能自动批准。

Human 不应被要求理解或搬运：sudo 密码、SSH private key、provider token、原始 shell command、secret plaintext。

<!-- topic:decision -->
### 审批结果

- `APPROVE`：只表示 Human 接受该 digest；不直接赋予 Agent root，也不转移 secret custody。
- `DENY`：Broker 不得为该 request 签发 lease。
- 请求过期、policy revision 失效或 digest 漂移：旧 approval 失效，必须重新审批。

AUTO policy path 不伪造 Human approval record；它使用可审计的 `PolicyDecision` 作为 authority reference。

<!-- topic:security -->
### 安全约束

- payload 与 approval record 必须 public-safe，不含 secret plaintext；
- Human-facing wording 可以本地化，但 canonical digest 不依赖自然语言文案；
- UI 不得用“批准命令”掩盖 typed operation/scope；
- 不能用模糊 summary 隐藏会改变 effect 的 material parameter；
- approval 不能扩大 operation registry 已允许的 scope；
- Human approval 与 production/deployment authority 仍按各自 gate 分离。

## English

<!-- topic:payload -->
### Payload purpose

The Human approval payload is a human-facing projection of a normalized capability request. It is not a shell prompt or secret transport surface.

<!-- topic:binding -->
### Digest binding

Approval binds the exact normalized request digest covering target, requester, operations, scope, parameter constraints, lease bounds, policy revision, impact, and recovery facts. Any scope/TTL/operation/recovery change creates a new digest and requires a new approval.

<!-- topic:ux -->
### Human presentation

The Human sees target, requester/intent, typed operations, exact scope, all public-safe material parameters that change the effect, duration/use limits, persistence impact, recovery, and why Human approval is required. Secret-bearing parameters are shown only as opaque references. The Human is not asked to transport passwords, private keys, provider tokens, secret plaintext, or opaque shell commands.

<!-- topic:decision -->
### Decision

`APPROVE` authorizes only the bound digest; `DENY` forbids lease issuance. Expired, stale-policy, or digest-mismatched approval is invalid. Auto-policy decisions remain policy records rather than fake Human approvals. Approval-request states are `PENDING -> APPROVED | DENIED | EXPIRED | SUPERSEDED`; terminal requests are never revived.

<!-- topic:security -->
### Security

Approval records are public-safe metadata, do not transfer secret custody, and cannot expand the canonical operation registry or bypass separate deployment/production gates.
