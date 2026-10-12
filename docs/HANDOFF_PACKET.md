# 首次使用交接包 / First-use handoff packet

artifact: `FIRST_USE_HANDOFF_PACKET`
artifact_version: `0.1.0`
status: `ACTIVE`
owner: `youling/ghostfleet`

本模板只承载公共合成证据与待填表格，不承载真实凭据、真实拓扑与生产结论。合成通过不等于真机验收。

## 中文

<!-- topic:packet -->

### 交接包定义

每个公共交接包绑定一个精确提交，只回答该提交的合成与契约状态：

```text
packet_ref: synthetic-handoff-example-001
source_commit: <exact-40-hex-sha-of-tested-source>
created_at: 2026-10-13
kind: synthetic-only
```

此处 `source_commit` 必须填入本次实际测试的精确提交，示例占位不得当作已测试证据。源码提交与部署配置版本分离记录：配置版本可以不是 Git 对象。

交接包包含四部分：精确提交绑定、可复现检查记录、覆盖边界声明、真实首次使用空表格。缺少任一部分视为不完整，不得记为可移交。

公共入口与边界见 [消费者验收](CONSUMER_ACCEPTANCE.md)、[测试与证据](TESTING.md)、[迁移](MIGRATION.md)、[Provider 设置体验](PROVIDER_SETUP_EXPERIENCE.md)。

<!-- topic:evidence -->

### 可复现检查记录

在与提交一致的干净检出中运行以下检查，逐项记录通过、失败或跳过。未运行的检查不得记为通过：

```sh
npm ci
npm test
npm run check:all
npm run test:typed
npm run test:bootstrap
npm run test:python
npm run verify:ai-client-neutral
npm run check:docs
npm run check:publication
```

记录模板：

```text
source_commit: <full-sha>
environment: <os + node + python>
command: <exact command>
result: PASS | FAIL | SKIP
detail: <counts, skipped items, failure excerpt>
```

示例合成记录使用固定占位引用，如 `synthetic-test`、`lab-device`、`receipt-baseline-positive`。真实回执引用由部署方在私有域另行签发，不写入本包。

<!-- topic:limits -->

### 覆盖边界声明

本包默认只声明以下能力，超出部分必须留空待私有域补证：

```text
synthetic contract: COVERED
real credential custody: NOT_COVERED
real deployment: NOT_COVERED
real device operation: NOT_COVERED
second independent device: NOT_COVERED
production pages or oauth: NOT_COVERED
```

`ACTIVE` 与核心准入不等于独立消费者切换。合成事件 `EVIDENCE_UPDATED` 与真实回读不可互换。

<!-- topic:signing -->

### 真实首次使用空表格与签署

以下表格由部署方与 Human 在真实环境中逐项填写。引用必须为有界不透明引用，不得填入明文秘密、真实节点名、地址、账号标识、原始日志或拓扑：

| 元素 | 引用 | 回执 | 回读 | 属主与见证 |
| --- | --- | --- | --- | --- |
| identity.reference | <opaque-ref> | — | — | — |
| consumer.identity | <opaque-ref> | — | — | — |
| control_path.binding | <opaque-ref> | — | — | — |
| custody.durability | <opaque-ref> | — | <opaque-ref> | owner + attestation |
| authority.positive | <opaque-ref> | <opaque-ref> | — | — |
| authority.negative | <opaque-ref> | <opaque-ref> | — | — |
| call_route.readback | — | — | <opaque-ref> | — |
| executor.independence | <opaque-ref> | <opaque-ref> | <opaque-ref> | fresh 上下文见证 |
| rollback.plan | <opaque-ref> | — | — | 旧路径恢复契约 |

控制器事件只记录真实事件常量与字段形状，不记录真实值。正常决策路径为 `PENDING -> ACCEPTED`；`ACCEPTED -> ROLLED_BACK` 仅在显式调用 `completeConsumerRollback`（附回执与旧路径回读）时发生。`rollback.plan`（第九项证据）不等于已执行回滚，不得把回滚当作首次使用的必做步骤：

```text
ConsumerAcceptanceOpened -> ConsumerAcceptanceEvidenceUpdated -> ConsumerAcceptanceDecided
(optional, separate) -> ConsumerRollbackCompleted
```

保密审查确认：本包不含真实节点名、地址、账号标识、秘密值、私钥、令牌、私有策略、原始日志或拓扑。公开检查只输出规则、路径与行号。

签署栏：消费者验收与 break-glass 分开签署。acceptance 签署不授予 break-glass 调用权，break-glass 调用不关闭 acceptance 缺口。break-glass 是独立可选的 Human 授权恢复门，不是公共合成移交或正常消费者 ACCEPTED 的前置条件。

```text
consumer_acceptance_signoff: <name + date>
break_glass_signoff: <name + date>
synthetic_not_live_ack: CONFIRMED
```

## English

<!-- topic:packet -->

### Packet definition

Each public handoff packet binds exactly one commit and reports only synthetic and contract status for that commit:

```text
packet_ref: synthetic-handoff-example-001
source_commit: <exact-40-hex-sha-of-tested-source>
created_at: 2026-10-13
kind: synthetic-only
```

The `source_commit` placeholder must be replaced with the exact commit actually tested; the placeholder itself is not tested evidence. Source commits and deployment config revisions are recorded separately: a config revision need not be a Git object.

A complete packet has four parts: exact-commit binding, reproducible check records, coverage limits, and an empty real first-use table. A packet missing any part is incomplete and must not be recorded as handoff-ready.

Public entry points and boundaries are defined in [Consumer acceptance](CONSUMER_ACCEPTANCE.md), [Testing](TESTING.md), [Migration](MIGRATION.md), and [Provider setup experience](PROVIDER_SETUP_EXPERIENCE.md).

<!-- topic:evidence -->

### Reproducible check records

Run the following checks in a clean checkout matching the bound commit, recording PASS, FAIL, or SKIP per command. An unexecuted check must never be recorded as passing:

```sh
npm ci
npm test
npm run check:all
npm run test:typed
npm run test:bootstrap
npm run test:python
npm run verify:ai-client-neutral
npm run check:docs
npm run check:publication
```

Record template:

```text
source_commit: <full-sha>
environment: <os + node + python>
command: <exact command>
result: PASS | FAIL | SKIP
detail: <counts, skipped items, failure excerpt>
```

Example synthetic records use fixed placeholder references such as `synthetic-test`, `lab-device`, and `receipt-baseline-positive`. Real receipt references are issued separately by the deployment owner in the private domain and are not written into this packet.

<!-- topic:limits -->

### Coverage limits

This packet by default declares only the following capability; anything beyond it stays empty for private-domain evidence:

```text
synthetic contract: COVERED
real credential custody: NOT_COVERED
real deployment: NOT_COVERED
real device operation: NOT_COVERED
second independent device: NOT_COVERED
production pages or oauth: NOT_COVERED
```

`ACTIVE` and core admission are not independent consumer cutover. Synthetic `EVIDENCE_UPDATED` events are not interchangeable with real readback.

<!-- topic:signing -->

### Real first-use table and sign-off

The deployment owner and Human complete the following table in the real environment. References must be bounded opaque references; secret values, real node names, addresses, account identifiers, raw logs, or topology must not be entered:

| Element | Reference | Receipt | Readback | Owner and witness |
| --- | --- | --- | --- | --- |
| identity.reference | <opaque-ref> | — | — | — |
| consumer.identity | <opaque-ref> | — | — | — |
| control_path.binding | <opaque-ref> | — | — | — |
| custody.durability | <opaque-ref> | — | <opaque-ref> | owner + attestation |
| authority.positive | <opaque-ref> | <opaque-ref> | — | — |
| authority.negative | <opaque-ref> | <opaque-ref> | — | — |
| call_route.readback | — | — | <opaque-ref> | — |
| executor.independence | <opaque-ref> | <opaque-ref> | <opaque-ref> | fresh-context witness |
| rollback.plan | <opaque-ref> | — | — | prior-path restoration contract |

Controller events record only real event constants and field shapes, never real values. The normal decision path is `PENDING -> ACCEPTED`; `ACCEPTED -> ROLLED_BACK` happens only on explicit `completeConsumerRollback` with receipt and prior-path readback. `rollback.plan` (the 9th evidence element) is not a performed rollback; rollback must not be made a mandatory first-use step:

```text
ConsumerAcceptanceOpened -> ConsumerAcceptanceEvidenceUpdated -> ConsumerAcceptanceDecided
(optional, separate) -> ConsumerRollbackCompleted
```

Confidentiality attestation: this packet contains no real node names, addresses, account identifiers, secret values, private keys, tokens, private policies, raw logs, or topology. Public checks emit only rule, path, and line numbers.

Sign-off: consumer acceptance and break-glass are signed separately. Acceptance sign-off grants no break-glass invocation authority, and break-glass invocation closes no acceptance gap. Break-glass is an independent optional Human-authorized recovery gate, not a precondition for public synthetic handoff or normal consumer ACCEPTED.

```text
consumer_acceptance_signoff: <name + date>
break_glass_signoff: <name + date>
synthetic_not_live_ack: CONFIRMED
```
