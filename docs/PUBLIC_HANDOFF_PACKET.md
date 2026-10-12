# Public Handoff Packet / 公共移交包

## 中文

<!-- topic:packet -->
### 移交包是什么

`PUBLIC_HANDOFF_PACKET` 是父级 Work 公共侧终结时的耐久工件：它把 exact head、已合
并基线引用、可复现的合成证据、public/private 责任划分，以及明确**未完成**的真实
首次使用待办绑定在一起。实现见
[src/control-plane/handoff-packet.js](../src/control-plane/handoff-packet.js)。

<!-- topic:evidence -->
### 证据语义

- `synthetic.suites` 必须全部 `fail === 0` 且总 `pass > 0`，否则拒绝移交。
- `baseline.merged_refs` 为全长度 commit SHA，`open_prs` 为当前值，
  `no_production_change` 必须为 `true`。
- 合成 PASS 只证明公共契约可复现，不证明真实凭据、部署或真机验收。

<!-- topic:boundary -->
### 安全边界

- 移交包不携带 secret 明文；secret 形态字段经公共安全断言直接拒绝。
- 未知字段 fail closed，任何未评审的授权或声明都无法静默混入。
- 移交包的产生不授予生产部署、provider 开通、root 或破坏性动作权限。

<!-- topic:acceptance -->
### 与验收的关系

- `real_first_use_todos` 不能为空：它记录 Human / 私有 owner 仍需完成的真实首次
  使用事项（durable custody、真实证据、独立重放、rollback 演练、OMV8 签署）。
- 消费者验收仍走 [Consumer Acceptance](./CONSUMER_ACCEPTANCE.md) 独立路径，
  首次纳管体验见 [Provider Setup Experience](./PROVIDER_SETUP_EXPERIENCE.md)。

## English

<!-- topic:packet -->
### What the packet is

`PUBLIC_HANDOFF_PACKET` is the durable public-side terminal artifact of a parent
Work: it binds the exact head, merged baseline refs, reproducible synthetic
evidence, the public/private responsibility split, and the real first-use todos
that are explicitly **not** claimed as done. Implementation:
[src/control-plane/handoff-packet.js](../src/control-plane/handoff-packet.js).

<!-- topic:evidence -->
### Evidence semantics

- Every entry of `synthetic.suites` must have `fail === 0` with total `pass > 0`,
  otherwise handoff is rejected.
- `baseline.merged_refs` are full-length commit SHAs, `open_prs` is the current
  value, and `no_production_change` must be `true`.
- A synthetic PASS only proves the public contract is reproducible; it proves
  nothing about real credentials, deployment, or live-node acceptance.

<!-- topic:boundary -->
### Security boundary

- The packet carries no secret plaintext; secret-shaped fields are rejected by
  the public-safety assertion.
- Unknown fields fail closed, so no unreviewed authority or claim can be
  smuggled in silently.
- Producing a packet grants no production deployment, provider provisioning,
  root, or destructive-action authority.

<!-- topic:acceptance -->
### Relationship to acceptance

- `real_first_use_todos` must be non-empty: it records the real first-use items
  still owed by the Human / private owner (durable custody, real evidence,
  independent replay, rollback drill, OMV8 sign-off).
- Consumer acceptance stays on its independent path in
  [Consumer Acceptance](./CONSUMER_ACCEPTANCE.md); the first-run enrollment
  experience is described in
  [Provider Setup Experience](./PROVIDER_SETUP_EXPERIENCE.md).
