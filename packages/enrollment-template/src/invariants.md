# Enrollment Template v0 — Invariants / Contract（中文优先）

本文件冻结 `packages/enrollment-template` 的 lifecycle-neutral contract。
实现（resolver / validator / normalizer / digest）由 Runtime 层负责；
反例与测试由 Counterexample 层负责。纯数据描述、常量与轻量判断函数见 `src/schema.js`。

英文小结见文末。

## 1. 身份与版本（immutable identity/version）

- `template_id`：稳定、唯一、非空；不得携带 secret、真实节点/账号/拓扑信息。
- `version`：semver 结构 `{major, minor, patch, prerelease?, build?}`，三段均为非负整数。
- `generation`：正整数（>= 1），同一 `template_id` 下单调递增。
- 上述三个字段为 **immutable fields**，任何 overlay 不得修改；修改即必须是新的
  template lineage（新 id 或由 Runtime 判定为新 generation）。

## 2. 平台与角色约束

- `platform` ∈ `linux | windows | android | macos`。
- `roles` 为非空枚举列表，取值来自 `server | workstation | edge | phone | iot`。

## 3. 能力与选项

- `capabilities`：management capability 列表（纯字符串，如 `remote_shell`、`file_transfer`）。
- `transport`：transport 引用（provider-neutral 名称或 adapter id）。
- `provider_options`：provider option 引用对象；只能是引用形态，不含 secret 值。
- `overridable_options`：用户/overlay 可覆盖的 key allowlist。
- `privilege_broker_required`（boolean）+ `helper`（描述对象或 null）：privilege-broker/helper 要求。
- `humangate` ∈ `required | optional | none`。
- `recovery`：break-glass/recovery 要求（`required | optional | none` 或等价描述对象）。
- `acceptance`：consumer-acceptance posture（`strict | standard | minimal`）。
- `bootstrap`：bootstrap requirements（仅引用，无内联 secret）。

## 4. extends / overlay 语义

- `extends` 只允许 **单父引用**，形如 `template_id@generation` 或 `template_id#sha256:<hex>`；
  多父（逗号/分号分隔等）一律拒绝。
- overlay **不得修改 immutable fields**（`template_id` / `version` / `generation`）。
- overlay 的 key 必须是父模板 `overridable_options` 内的 key；
  命中 `OVERLAY_FORBIDDEN_TOP_LEVEL_KEYS`（含 `extends`、`digest`、`attempt_binding`）一律拒绝。
- overlay 作用域只能是 `overridable_options` 之内；任何"在 allowlist 之外扩权"都构成静默扩权，必须 fail closed。
- overlay 扩权仍受 provider/deployment policy 约束，不得越权授予 provider authority / root authority。
- private overlay 的具体默认值不得进入 public example 的真实默认值。
- extends 链必须无环（cycle 检测由 Runtime 负责，发现环即拒绝）。

## 5. 确定性 normalization + digest 接口约定

canonical JSON 规则（`CANONICAL_JSON_RULES`）：

- UTF-8 编码；
- object keys 字典序排序（递归）；
- 无空白（无空格、无换行）；
- 不允许尾部逗号、`NaN`、`Infinity`；
- array 顺序保留，元素递归 canonical 化。

digest 约定（`DIGEST_CONTRACT`）：

- 输入：normalized template 的 canonical JSON 字符串；
- 算法：sha256；输出：小写 hex（64 位），惯用 `sha256:<hex>`；
- normalizer 必须是 **纯函数**：同输入同 canonical JSON，同 digest；
- digest 漂移（同语义不同字节）视为 contract 违规。

## 6. Secret-safe rendering / reference

- secret 字段只能是 **引用**：`secret://…`、`ref:…`、`env:…`（见 `SECRET_REF_PREFIXES`）。
- 明文 secret 形态（`password:`、`token:`、`-----BEGIN … PRIVATE KEY-----`、`api_key=`、`Bearer …`、`xox*` 等，见 `SECRET_PATTERNS`）必须被 schema 判定为 **拒绝**。
- 渲染/输出路径必须只展示引用而不展开 secret 值。

## 7. UNKNOWN / provider-option mismatch fail closed

- 未知 provider option key：`isUnknownOption(knownKeys, key) === true` 时必须 **拒绝**，不得忽略或静默丢弃。
- 未知 enum/platform/role/humangate/recovery/acceptance 值一律拒绝。
- 模板缺字段、类型错误、generation 非正整数、extends 非法引用：一律拒绝。
- 不得把 unknown 降级为默认值或"放行"。

## 8. EnrollmentAttempt / approval 的 immutable binding

- 每个 approval / EnrollmentAttempt 记录必须捕获创建时所依据模板的
  `template_id + generation + digest`（见 `ATTEMPT_BINDING_RULE`）。
- 模板发生变更（generation 提升或 digest 变化）后，旧 approval/attempt
  **不可静默继承**；必须重新显式绑定，否则 fail closed。
- currentness 判定：比较记录中的 binding 与当前 normalized digest，不一致即 stale 并拒绝复用。

## 9. 明确不属于 template 的内容

- risk / risk floor / risk_hint；
- provider authority / root authority；
- secret value；
- 真实 node / account / topology。

## English summary

Enrollment Template v0 freezes a provider- and lifecycle-neutral posture schema:
immutable `template_id`/semver `version`/`generation`; platform/role constraints;
capabilities; transport & provider option *references*; `overridable_options` allowlist;
privilege-broker/helper requirement; HumanGate posture; recovery/break-glass;
consumer acceptance; bootstrap requirements; single-parent `extends` with overlays
restricted to overridable keys (never immutable identity fields); canonical JSON
(sorted keys, no whitespace, UTF-8) + sha256 hex digest via a pure normalizer;
secrets only as `secret://`-style refs, plaintext-shaped secrets rejected;
unknown provider options fail closed; and every approval/attempt binds
`template_id + generation + digest` so template changes invalidate silent inheritance.
