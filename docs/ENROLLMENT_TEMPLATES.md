# Enrollment Templates v0（中文优先 / English summary）

本文档定义 GhostFleet Enrollment Template v0 的契约：字段语义、version/generation/binding、extends/overlay 规则、normalization/digest 约定、secret 安全规则、UNKNOWN fail-closed 行为，以及与 EnrollmentAttempt 的 immutable binding。实现细节见 `packages/enrollment-template/src/invariants.md` 与 `src/schema.js`。

> English summary: see the final section. This page is Chinese-first.

## 1. 字段表

| 字段 | 类型 | 必填 | immutable | 说明 |
| --- | --- | --- | --- | --- |
| `template_id` | string | 是 | 是 | 稳定、唯一、非空；不得携带 secret/真实节点/拓扑信息 |
| `version` | semver struct | 是 | 是 | `{major, minor, patch, prerelease?, build?}`，三段为非负整数 |
| `generation` | positiveInteger | 是 | 是 | 同一 `template_id` 下单调递增；任何语义变更必须 bump |
| `platform` | enum | 是 | 否 | `linux \| windows \| android \| macos` |
| `roles` | array(enum) | 是 | 否 | 非空，取值 `server \| workstation \| edge \| phone \| iot` |
| `capabilities` | array(string) | 是 | 否 | 管理能力列表，如 `remote_shell`、`file_transfer` |
| `transport` | string | 是 | 否 | provider-neutral 的 transport 引用或 adapter id |
| `provider_options` | object | 是 | 否 | provider option 引用对象，值必须是引用形态，不含 secret 值 |
| `overridable_options` | array(string) | 是 | 否 | 用户/overlay 可覆盖 key 的 allowlist |
| `privilege_broker_required` | boolean | 是 | 否 | 特权操作是否必须经 Privilege Broker |
| `helper` | object \| null | 是 | 否 | helper 需求描述对象或 null |
| `humangate` | enum | 是 | 否 | `required \| optional \| none` |
| `recovery` | enum \| object | 是 | 否 | break-glass/recovery 要求 |
| `acceptance` | enum | 是 | 否 | `strict \| standard \| minimal` |
| `bootstrap` | object | 是 | 否 | bootstrap requirements（仅引用，无内联 secret） |
| `extends` | string \| null | 是 | 否 | 单父引用：`template_id@generation` 或 `template_id#sha256:<hex>` |

## 2. version / generation / binding 语义

- `version` 是模板自身的语义版本结构；`generation` 是同一 `template_id` 下的单调计数器。语义无关的格式变化不 bump generation；任何影响管理姿态的变更必须 bump generation。
- 每个 approval / EnrollmentAttempt 记录必须捕获创建时所依据模板的 `template_id + generation + digest`（immutable binding，见 `ATTEMPT_BINDING_RULE`）。
- 模板变更后（generation 提升或 digest 漂移），旧 approval/attempt **不可静默继承**，必须重新显式绑定；比较记录 binding 与当前 normalized digest，不一致即 stale 并 fail closed。

## 3. extends / overlay 规则

- `extends` 只允许**单父引用**（`template_id@generation` 或 `template_id#sha256:<hex>`）；多父（逗号/分号分隔）一律拒绝；循环检测由 Runtime 负责，发现环即拒绝。
- overlay **不得修改 immutable fields**（`template_id` / `version` / `generation`）。
- overlay 的 key 必须是父模板 `overridable_options` 之内；命中 `OVERLAY_FORBIDDEN_TOP_LEVEL_KEYS`（含 `extends`、`digest`、`attempt_binding`）一律拒绝。
- overlay 不能静默扩权：`provider_options` 新增 allowlist 之外的 key、把 `humangate` 从 `required` 降为 `none`、把 `extends` 改指向别的模板，均必须拒绝并返回 `OVERLAY_*` 类错误。
- overlay 扩权仍受 provider/deployment policy 约束，不得借 overlay 越权授予 provider authority / root authority。
- private overlay 的具体默认值不得进入 public example 的真实默认值。

## 4. normalization / digest 约定

- canonical JSON 规则：UTF-8；object keys 字典序排序（递归）；无空白；禁尾部逗号、`NaN`、`Infinity`；array 顺序保留、元素递归 canonical 化。
- digest：对 normalized template 的 canonical JSON 字符串取 sha256，输出小写 hex（64 位），惯用 `sha256:<hex>`。
- normalizer 是**纯函数**：同输入 → 同 canonical JSON → 同 digest。同语义模板的两份等价输入（key 顺序/空白不同）digest 必须相等；任一字段语义变化 digest 必须变化。digest 漂移视为 contract 违规。

## 5. secret 安全规则

- secret 字段只允许**引用形态**：`secret://…`、`ref:…`、`env:…`（见 `SECRET_REF_PREFIXES`）。
- 明文 secret 形态（`password: hunter2`、`api_key: xxxx`、`-----BEGIN … PRIVATE KEY-----`、`token:`、`Bearer …`、`xox*-…` 等，见 `SECRET_PATTERNS`）一律拒绝。
- 渲染/输出路径只展示引用，绝不展开 secret 值。

## 6. UNKNOWN fail-closed

- 未知 provider option key 必须拒绝（`UNKNOWN` / `UNKNOWN_PROVIDER_OPTION` 类 code），不得忽略、不得降级为默认值。
- 未知 enum/platform/role/humangate/recovery/acceptance 值、缺字段、类型错误、generation 非正整数、extends 非法引用、provider-option mismatch：一律拒绝。
- schema 谓词：`isUnknownOption(knownKeys, key) === true` 时必须 fail closed。

## 7. 明确不属于 template 的内容

- risk / risk floor / risk_hint
- provider authority / root authority
- secret value（只允许引用）
- 真实 node / account / topology 信息

## 8. 与 EnrollmentAttempt 的 immutable binding

- 模板 generation/digest 与 EnrollmentAttempt 是不可变绑定：attempt 记录里的 `template_id`/`generation`/`digest` 与当前模板不一致时，该 attempt 不继承当前模板，必须重新绑定（含相应错误/digest 不匹配）。
- 该绑定使模板版本漂移在审批面可检测，阻止"改了模板、旧审批继续吃"的静默继承。

## 9. 并行 lane 兼容说明

- 本工单与并行的 Contract Builder（schema/invariants）、Runtime Builder（resolver/validator/digest 实现）为单 writer 划分：schema.js/invariants.md 归 Contract、src/index.js 归 Runtime、test/*.test.js 与本 docs 归 Counterexample/Docs。
- 合并时以冻结的 schema 常量与 invariants 为仲裁；本测试文件仅依赖已公布的 API 名（`normalizeTemplate`、`templateDigest`、`resolveTemplate`、`validateTemplate`、`isUnknownOption`、`looksLikePlaintextSecret`、`OVERLAY_IMMUTABLE_FIELDS`）。
- 若 `src/index.js` 尚未由 Runtime lane 落地，`node --test` 会因 `ERR_MODULE_NOT_FOUND` 失败——属预期状态，待 Runtime 合入后复跑应转绿或暴露真实语义差异。

## English summary

Enrollment Template v0 is a lifecycle-neutral, provider-neutral contract: stable `template_id`, semver `version`, monotonic `generation`; platform/role constraints; capability list; transport + provider-option *references*; an `overridable_options` allowlist; privilege-broker/helper requirement; HumanGate, recovery, and acceptance posture; bootstrap references; and single-parent `extends` with overlays restricted to overridable keys (never immutable identity fields, never silent scope expansion). Normalization is a pure function producing canonical JSON (sorted keys, no whitespace, UTF-8) with a sha256 hex digest; secrets appear only as `secret://` / `ref:` / `env:` references and plaintext-shaped secrets are rejected. Unknown provider options, unknown enum values, provider-option mismatches, and overlay privilege escalation fail closed. Every approval/EnrollmentAttempt immutably binds `template_id + generation + digest`; template drift invalidates silent inheritance. Risk scores, provider authority, secret values, and real node/account/topology details are explicitly out of scope.
