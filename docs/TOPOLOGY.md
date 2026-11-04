# Topology and Origin Enforcement / 拓扑策略与发起来源约束

## 中文

<!-- topic:compatibility -->
### 源码纯净性与选择性兼容

`packages/typed-control` 中的拓扑策略与发起来源约束是一项显式开启（opt-in）的服务端安全机制，仅在类型化控制库层面实施，并不代表整个系统已完成全部网络或 API 隔离。

1. **缺省保持旧消费者兼容**：在可信环境中，当 `CONTROL_TOPOLOGY_MODE` 与 `CONTROL_TOPOLOGY_JSON` 均未定义（严格为 `undefined`）时，系统处于 Legacy 模式，保持与旧有消费者及调用方式的完全兼容。
2. **确定性 Fail-Closed 规则**：
   - 若注入了 `CONTROL_TOPOLOGY_JSON` 配置，但未显式指定 `CONTROL_TOPOLOGY_MODE`，系统将确定性报错拒绝配置（`TOPOLOGY_MODE_REQUIRED`），绝不隐式或静默回退至 Legacy。
   - 若指定了模式但不是 `'legacy'` 或 `'enforced'`（包括空字符串），系统直接拒绝（`INVALID_TOPOLOGY_MODE`）。
   - 若模式设为 `'legacy'` 却同时注入了任何 `CONTROL_TOPOLOGY_JSON`（包括空字符串），系统拒绝该冲突配置（`TOPOLOGY_CONFIG_REJECTED`）。
   - 在 `'enforced'` 模式下，必须提供有效的拓扑 JSON（`TOPOLOGY_POLICY_NOT_CONFIGURED`），任何格式错误或未绑定的来源版本均直接失败闭包。

<!-- topic:schema -->
### 精确主体绑定与目标 Schema

拓扑策略使用严格的 Zod Schema 校验，限制配置尺寸与对象字段，杜绝未知属性注入：

- **版本与来源绑定**：`schema_version: 1`，以及 `source: { repository, revision }`。拓扑配置必须同 `CONTROL_POLICY_SOURCE_REPOSITORY` 与 `CONTROL_POLICY_SOURCE_REVISION` 完全一致，即便在独立特权通道入口（Privileged Lane）中，源码版本漂移或缺失也必须立即拒绝执行。
- **不可变节点角色映射**：`nodes` 将不可变的节点 UID 映射为显式角色：
  - `CONTROLLER_CAPABLE`：具备作为控制器发起源能力的节点。
  - `MANAGED_ONLY`：纯受管被控节点，只能作为被控目标，绝对禁止作为任何控制操作的发起源。
- **显式认证主体绑定**：`bindings` 数组定义经可信认证的主体规则：
  - `auth_kind`：`'oauth'` 或 `'break_glass'`。
  - `user_id`：认证用户身份字符串（上限 256 字符）。
  - `origin_node_uid`：绑定的来源节点 UID。`null` 仅表示显式配置的受保护中央主体；非空值必须在 `nodes` 中存在。`MANAGED_ONLY` 来源可以记录在策略中，但每次管理调用都会被拒绝。
  - `allowed_targets`：允许控制的目标节点 UID 列表。
- **查找与拒绝规则**：
  - 主体查找必须同时匹配 `auth_kind` 与 `user_id`，杜绝主体歧义或重复绑定。
  - 发起源为 `MANAGED_ONLY` 的主体**绝不可作为可用控制器**：即便配置了目标列表、声称拥有管理角色、或持有特权/执行权限，也必须在连接建立前硬性拒绝（`TOPOLOGY_ORIGIN_NOT_CONTROLLER`）。
  - 控制器角色但目标列表为空的主体不授予任何目标的控制权（`TOPOLOGY_TARGET_NOT_ALLOWED`）。
  - `listControlNodes` 保持完全同步查验，不依赖异步主体哈希计算；在 enforced 模式下严格将节点目录过滤为仅包含允许的目标节点，杜绝拓扑资产泄漏。

<!-- topic:axes -->
### 相互独立的两套正交权限轴

本设计严格隔离了两个相互独立的权限判定轴，二者不得相互推导或隐式转换：

1. **第一轴：拓扑发起源与目标准入轴（Topology Axis）**
   - 解决“谁（认证主体 + 发起源节点）被允许与哪个目标节点建立控制通道”。
   - 由服务端部署的可信拓扑配置在发派前强行判定。
2. **第二轴：本机 OS 权限，仅两个用户可见层级**
   - `NORMAL` 是真实普通 OS 用户；通用命令能否读取设备或文件，由该账户实际 OS 权限决定，不为每条诊断命令新增产品白名单。
   - `HUMAN_APPROVED_ADMIN` 是 Human 明确批准、绑定主体和目标、有期限的 sudo 等效管理权限。普通账户不得永久变成 root。
   - 既有 scopes、R0/R1/R2 和可选 typed 操作继续表达内部协议与能力，不是额外用户权限层级。高 scope 不能越过拓扑；允许的目标也不自动授予管理员权限。本次不实现 #63 的通用临时管理员会话。

<!-- topic:custody -->
### 凭据保管、网络隔离与无中继假设

纯源码层的拓扑校验是纵深防御的一环，无法单靠自身防御中心凭据被盗或物理内网横向移动：

- **主体必须按来源隔离**：该库匹配可信入口提供的 `(authKind, userId)`，不检测实际网络位置。部署必须为不同来源提供可区分、不可自行声明的认证主体；不能将跨节点共享的用户令牌映射成受保护中央主体，随后声称已有来源证明。入口无法证明凭据归属时必须先拒绝。
- **受管节点不得持有控制凭据**：`MANAGED_ONLY` 节点不能持有跨节点 SSH 私钥、Operator 令牌、审批签名或 provider 管理凭据。允许该节点本机维护的授权不能用于控制别的节点。
- **网络层 ACL 与独立凭据**：部署方必须在网络层、反向代理、Cloudflare Access 或防火墙上配置独立 ACL，结合固定 SSH 主机指纹，保证物理与网络层面的单向控制。
- **无任意代理与中继**：控制通道为端到端直接连接，类型化控制库不提供或允许受管节点作为跳板转发（No Relay）对其他受管节点发起控制。

<!-- topic:rollout -->
### 灰度推广、安全回滚与未覆盖边界

- **部署推广流程**：
  1. 在部署环境中配置 `CONTROL_POLICY_SOURCE_REPOSITORY` 与 `CONTROL_POLICY_SOURCE_REVISION`。
  2. 在隔离集成环境验证凭据归属、全部入口和负测，不把 library PASS 当作生产网络隔离证明。
  3. 经单独发布批准，将有效 JSON 与 `CONTROL_TOPOLOGY_MODE=enforced` 原子接入部署；不要先把 JSON 注入仍为 `legacy` 的生产配置。
- **安全回滚规则**：
  - 已启用隔离的部署应回滚到上一份有效的 `enforced` 策略；没有可信版本时保持拒绝，例如在有效策略中清空 `bindings`，而非静默关闭守卫。
  - 不能通过切换 `legacy` 重新打开被管节点权限。确需撤除本层时，必须先独立证明相关来源凭据已撤销、其他入口和网络限制仍拒绝横向控制，并取得单独批准。移除环境变量本身不构成安全回滚。
- **明确的未覆盖边界（Remaining Scope）**：
  - 本次变更仅覆盖 `packages/typed-control` 库内部的操作分发、节点目录和特权通道边界。
  - 核心 HTTP 服务、OAuth Issuer 发卡端、Linux 一键纳管引导（Bootstrap）、Console 前端及底层的物理/网络层报文过滤，均属于独立边界，不在此库的自动保证范围内。

---

## English

<!-- topic:compatibility -->
### Source-only Nature and Opt-in Compatibility

The topology policy and origin enforcement in `packages/typed-control` is an explicit opt-in server-side authorization mechanism in the typed control library. It does not claim to complete all network or API credential isolation across the system.

1. **Preserving Legacy Consumers by Default**: When both `CONTROL_TOPOLOGY_MODE` and `CONTROL_TOPOLOGY_JSON` are truly absent (`=== undefined`) in the trusted environment, the system remains in Legacy mode, fully preserving backward compatibility with existing callers.
2. **Deterministic Fail-Closed Rules**:
   - If `CONTROL_TOPOLOGY_JSON` is provided without an explicit `CONTROL_TOPOLOGY_MODE`, configuration evaluation fails closed (`TOPOLOGY_MODE_REQUIRED`), never silently falling back to Legacy.
   - If a mode string is provided that is neither `'legacy'` nor `'enforced'` (including an empty string), the configuration is rejected (`INVALID_TOPOLOGY_MODE`).
   - If mode is explicitly `'legacy'` while any `CONTROL_TOPOLOGY_JSON` is supplied, including an empty string, configuration is rejected (`TOPOLOGY_CONFIG_REJECTED`).
   - In `'enforced'` mode, valid JSON must be present (`TOPOLOGY_POLICY_NOT_CONFIGURED`); malformed JSON or stale source revisions fail closed immediately.

<!-- topic:schema -->
### Exact Actor Binding and Target Schema

The topology policy enforces strict Zod schema validation with bounded sizes and disallows unknown fields:

- **Schema Version and Source Binding**: Requires `schema_version: 1` and `source: { repository, revision }`. The topology source must strictly agree with `CONTROL_POLICY_SOURCE_REPOSITORY` and `CONTROL_POLICY_SOURCE_REVISION`; missing or mismatched source revisions reject execution even on privileged entrypoints.
- **Immutable Node Roles**: The `nodes` mapping binds immutable node UIDs to explicit roles:
  - `CONTROLLER_CAPABLE`: Nodes permitted to host controller origins.
  - `MANAGED_ONLY`: Managed worker nodes that can only be controlled as targets and are strictly forbidden from acting as controller origins.
- **Explicit Authenticated Bindings**: The `bindings` array specifies actor permissions:
  - `auth_kind`: Either `'oauth'` or `'break_glass'`.
  - `user_id`: Authenticated user identity string (max 256 characters).
  - `origin_node_uid`: Bound origin node UID. `null` identifies only an explicitly configured protected central actor. Non-null origins must exist in `nodes`. A `MANAGED_ONLY` origin can be recorded but every management call from it is denied.
  - `allowed_targets`: List of authorized destination node UIDs.
- **Lookup and Denial Invariants**:
  - Actor lookup matches BOTH `auth_kind` and `user_id`; ambiguous or duplicate bindings are rejected.
  - A binding originating from a `MANAGED_ONLY` node is **NEVER a usable controller**, even if `allowed_targets` is populated, scopes claim administrator privileges, or caller metadata requests it (`TOPOLOGY_ORIGIN_NOT_CONTROLLER`).
  - A controller role with an empty `allowed_targets` list grants no access (`TOPOLOGY_TARGET_NOT_ALLOWED`).
  - `listControlNodes` remains synchronous and filters the catalog strictly to authorized targets in enforced mode, preventing topology enumeration.

<!-- topic:axes -->
### Two Independent Authorization Axes

Topology enforcement and operation capability evaluation represent two strictly independent orthogonal axes:

1. **Axis 1: Topology Origin and Destination Axis**
   - Answers: "Which authenticated actor from which origin node is permitted to open a control channel to which target node?"
   - Evaluated strictly before any target resolution, key extraction, RPC preparation, or backend connection.
2. **Axis 2: Local OS privilege, exactly two user-facing tiers**
   - `NORMAL` is the actual ordinary OS user. Native OS permissions govern general commands and diagnostics; do not add a product allowlist for each diagnostic command.
   - `HUMAN_APPROVED_ADMIN` is explicit Human-approved, actor/node-bound, time-limited sudo-equivalent administration. An ordinary account must not become permanently root.
   - Existing scopes, R0/R1/R2 metadata and optional typed conveniences remain internal protocol/capability checks, not additional user-facing tiers. High scopes cannot bypass topology, and an allowed target does not grant admin. This tranche does not implement #63 general temporary admin sessions.

<!-- topic:custody -->
### Credential Custody, Network Isolation, and No-Relay Assumptions

Pure source enforcement is part of defense-in-depth and cannot prevent stolen central credentials or lateral network movement:

- **Origin-specific authenticated principals are required**: The library matches trusted ingress `(authKind, userId)`; it does not observe physical network origin. Deployment ingress must provide distinct, non-self-asserted identities per origin. Do not map a user token shared across nodes to a protected central actor and claim origin proof. Reject credentials whose custody/origin cannot be established before invoking the library.
- **No Control Credentials on Managed Nodes**: `MANAGED_ONLY` hosts must not possess cross-node SSH keys, Operator tokens, approval-signing or provider admin credentials. Authorization to maintain that host locally cannot control peers.
- **Independent Ingress and Firewall ACLs**: Deployment owners must enforce ingress authentication, network ACLs, firewall boundaries, and pinned SSH host keys.
- **No Lateral Relay**: Connections are direct and point-to-point. The typed control library provides no mechanism for managed nodes to act as relay hops to control other nodes.

<!-- topic:rollout -->
### Rollout, Safe Rollback, and Out-of-Scope Boundaries

- **Rollout Process**:
  1. Configure `CONTROL_POLICY_SOURCE_REPOSITORY` and `CONTROL_POLICY_SOURCE_REVISION`.
  2. Verify credential attribution, every ingress and negative cases in isolated integration. Library PASS is not proof of production network isolation.
  3. Under separate release authority, atomically install valid JSON and `CONTROL_TOPOLOGY_MODE=enforced`; do not first inject JSON into a production configuration still set to `legacy`.
- **Rollback Safety**:
  - An isolated deployment should restore the previous valid `enforced` policy. If no trusted version exists, keep access denied, for example with empty `bindings` in a valid policy, rather than disabling the guard.
  - A rollback must not reopen managed-only control. Removing this layer requires independent proof of revoked origin credentials, continuing denial at other ingresses/network boundaries, and separate approval. Removing environment variables alone is not a safe rollback.
- **Remaining Out-of-Scope Boundaries**:
  - This implementation tranche covers `packages/typed-control` operation dispatch, catalog filtering, and privileged lane boundaries only.
  - Core HTTP routing, OAuth issuer token generation/revocation, bootstrap installation payloads, Console UI views, and physical/packet network isolation remain separate deployment concerns.
