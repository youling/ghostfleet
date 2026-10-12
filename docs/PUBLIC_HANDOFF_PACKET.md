# Public Handoff Packet / 公共移交包

Canonical contract for `youling/ghostfleet#11`. Consolidates the valid
first-use worksheet, signing, and real-vs-synthetic safeguards from PR #46
(`docs/HANDOFF_PACKET.md` @ `20cd122`) into the PR #47 library-backed
contract; PR #46 is to be closed as superseded only after this successor is
validated, preserving its provenance and review history.

## 中文

<!-- topic:packet -->
### 移交包是什么

`PUBLIC_HANDOFF_PACKET` 是父级 Work 公共侧的耐久**声明容器**，不是证明：它把
exact head、已合并基线引用、**上报的**合成计数组、public/private 责任划分，以
及明确**未完成**的真实首次使用待办绑定在一起。实现见
[src/control-plane/handoff-packet.js](../src/control-plane/handoff-packet.js)。

<!-- topic:packet -->
### 声明等级

本契约只签发 `UNVERIFIED_CLAIMS_ONLY`。`validateHandoffPacket()` 只检查形状、
边界与尽力而为的秘密卫生，**永远不**据此得出“可移交”或“合成 PASS 已证实”。
证明 = 指定 exact head 的 CI 运行 + Architect 在验收时的外部回读。任何 40 位
十六进制都可以通过形状检查，调用方可以虚构计数，因此包内计数必须以后续
exact-head 回读为准。

<!-- topic:evidence -->
### 证据语义与复现记录

- `synthetic.suites` 必须全部 `fail === 0` 且总 `pass > 0`，否则拒绝建包。
- `baseline.merged_refs` 为全长度 commit SHA，`open_prs` 为当前值，
  `no_production_change` 必须为 `true`（该字段是声明/元数据，不是授权）。
- 每次复现必须按以下模板逐条记录，未记录的计数视为不可复现：

```text
source_commit: <full-40-hex-sha-of-tested-source>
environment: <os + node + python>
command: <exact command>
result: PASS | FAIL | SKIP
detail: <counts, skipped items, failure excerpt>
```

复现命令（与 [Testing](./TESTING.md) 一致）：

```sh
npm ci
npm test
npm run check:all
npm run test:typed
npm run test:bootstrap
npm run test:python
npm run verify:ai-client-neutral
```

合成 PASS 只证明公共契约可复现，不证明真实凭据、部署或真机验收。

<!-- topic:boundary -->
### 安全边界与覆盖声明

- 自由文本面（suite 名、责任陈述、待办）长度受限并扫描原始 secret 形态值
  （token 前缀、私钥块、凭据赋值、URL userinfo）；这是尽力卫生，不是无秘密
  证明，残余风险已如实标注。
- 未知字段 fail closed，任何未评审的授权或声明都无法静默混入。
- 建包不授予生产部署、provider 开通、root 或破坏性动作权限。
- 覆盖矩阵（合成契约 vs 真实世界）：

```text
synthetic contract: COVERED
real credential custody: NOT_COVERED
real deployment: NOT_COVERED
real device operation: NOT_COVERED
second independent device: NOT_COVERED
production pages or oauth: NOT_COVERED
```

<!-- topic:acceptance -->
### 真实首次使用工作表（9 元素，占位待补证）

下表为全合成占位，须由 Human / 私有 owner 用不透明引用补证后才有效。
`ACTIVE` 不等于独立消费者验收；消费者验收仍走独立的
[Consumer Acceptance](./CONSUMER_ACCEPTANCE.md)，首次纳管体验见
[Provider Setup Experience](./PROVIDER_SETUP_EXPERIENCE.md)。

| 元素 | 证据引用 | 状态 | 备注 |
| --- | --- | --- | --- |
| identity.reference | <opaque-ref> | 待补 | 消费者身份 |
| consumer.identity | <opaque-ref> | 待补 | 消费者主体 |
| control_path.binding | <opaque-ref> | 待补 | 控制路径绑定 |
| custody.durability | <opaque-ref> | 待补 | owner + attestation |
| authority.positive | <opaque-ref> | 待补 | 正向授权 |
| authority.negative | <opaque-ref> | 待补 | 反向授权 |
| call_route.readback | <opaque-ref> | 待补 | 调用路由回读 |
| executor.independence | <opaque-ref> | 待补 | fresh 上下文独立重放 |
| rollback.plan | <opaque-ref> | 待补 | 计划不等于已执行回滚 |

<!-- topic:acceptance -->
### 事件与签署

控制器真实事件序列（见 `src/core/model.js` 与
`src/control-plane/controller.js`）：

```text
ConsumerAcceptanceOpened -> ConsumerAcceptanceEvidenceUpdated -> ConsumerAcceptanceDecided
(optional, separate) -> ConsumerRollbackCompleted
```

正常路径为 `PENDING -> ACCEPTED`；`ACCEPTED -> ROLLED_BACK` 仅经显式
`completeConsumerRollback` 到达。`rollback.plan` 是必需证据，不等于已执行
回滚。break-glass 签署是独立可选 Human 授权恢复门，不是合成移交或正常
ACCEPTED 的前置条件。

## English

<!-- topic:packet -->
### What the packet is

`PUBLIC_HANDOFF_PACKET` is the durable public-side **claim container** of a
parent Work, not proof: it binds the exact head, merged baseline refs, the
**reported** synthetic counters, the public/private responsibility split, and
the real first-use todos explicitly **not** claimed as done. Implementation:
[src/control-plane/handoff-packet.js](../src/control-plane/handoff-packet.js).

<!-- topic:packet -->
### Claim class

This contract only ever issues `UNVERIFIED_CLAIMS_ONLY`.
`validateHandoffPacket()` checks shape, bounds, and best-effort secret
hygiene, and **never** concludes "handoff-ready" or "synthetic PASS proved"
from that predicate. Proof is the CI run for the stated exact head plus the
external Architect readback at acceptance. Any 40-hex string passes the shape
check and callers can invent counters, so in-packet counts are claims until a
later exact-head readback confirms them.

<!-- topic:evidence -->
### Evidence semantics and reproduction records

- Every entry of `synthetic.suites` must have `fail === 0` with total
  `pass > 0`, otherwise packet construction is rejected.
- `baseline.merged_refs` are full-length commit SHAs, `open_prs` is the
  current value, and `no_production_change` must be `true` (an
  assertion/metadata, never a grant).
- Each reproduction must be recorded entry by entry with this template;
  unrecorded counts count as unreproducible:

```text
source_commit: <full-40-hex-sha-of-tested-source>
environment: <os + node + python>
command: <exact command>
result: PASS | FAIL | SKIP
detail: <counts, skipped items, failure excerpt>
```

Reproduction commands (same as [Testing](./TESTING.md)):

```sh
npm ci
npm test
npm run check:all
npm run test:typed
npm run test:bootstrap
npm run test:python
npm run verify:ai-client-neutral
```

A synthetic PASS only proves the public contract is reproducible; it proves
nothing about real credentials, deployment, or live-node acceptance.

<!-- topic:boundary -->
### Security boundary and coverage statement

- Free-text surfaces (suite names, responsibility statements, todos) are
  length-capped and scanned for raw secret-shaped values (token prefixes,
  private-key blocks, credential assignments, URL userinfo); this is
  best-effort hygiene, not proof of secret-freedom, and the residual risk is
  labeled as such.
- Unknown fields fail closed, so no unreviewed authority or claim can be
  smuggled in silently.
- Producing a packet grants no production deployment, provider provisioning,
  root, or destructive-action authority.
- Coverage matrix (synthetic contract vs the real world):

```text
synthetic contract: COVERED
real credential custody: NOT_COVERED
real deployment: NOT_COVERED
real device operation: NOT_COVERED
second independent device: NOT_COVERED
production pages or oauth: NOT_COVERED
```

<!-- topic:acceptance -->
### Real first-use worksheet (9 elements, placeholders pending evidence)

The table below is fully synthetic placeholder content; it becomes valid only
after the Human / private owner backfills it with opaque references.
`ACTIVE` is not independent consumer acceptance; consumer acceptance stays on
its independent path in [Consumer Acceptance](./CONSUMER_ACCEPTANCE.md), and
the first-run enrollment experience is described in
[Provider Setup Experience](./PROVIDER_SETUP_EXPERIENCE.md).

| Element | Evidence ref | Status | Note |
| --- | --- | --- | --- |
| identity.reference | <opaque-ref> | pending | consumer identity |
| consumer.identity | <opaque-ref> | pending | consumer principal |
| control_path.binding | <opaque-ref> | pending | control-path binding |
| custody.durability | <opaque-ref> | pending | owner + attestation |
| authority.positive | <opaque-ref> | pending | positive authority |
| authority.negative | <opaque-ref> | pending | negative authority |
| call_route.readback | <opaque-ref> | pending | call-route readback |
| executor.independence | <opaque-ref> | pending | fresh-context independent replay |
| rollback.plan | <opaque-ref> | pending | plan is not executed rollback |

<!-- topic:acceptance -->
### Events and signing

True controller event sequence (see `src/core/model.js` and
`src/control-plane/controller.js`):

```text
ConsumerAcceptanceOpened -> ConsumerAcceptanceEvidenceUpdated -> ConsumerAcceptanceDecided
(optional, separate) -> ConsumerRollbackCompleted
```

The normal path is `PENDING -> ACCEPTED`; `ACCEPTED -> ROLLED_BACK` is
reachable only through an explicit `completeConsumerRollback`.
`rollback.plan` is required evidence, not executed rollback. Break-glass
signing is an independent optional Human-authorized recovery gate, not a
precondition for synthetic handoff or a normal ACCEPTED.
