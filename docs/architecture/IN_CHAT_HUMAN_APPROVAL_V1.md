# In-chat Human approval v1 / 对话内人工审批 v1

status: `TARGET_DECIDED / WEB_POC_REQUIRED / NATIVE_MOBILE_BLOCKED_FOR_CUSTOM_MCP`
owner: GhostFleet owns the generic interaction contract; `youling/ai-hub` owns the private issuer, Durable Object ledger, credentials and deployment bindings.
parent: [GhostFleet #69](https://github.com/youling/ghostfleet/issues/69)
baseline: `youling/ghostfleet@4dae64b16298d28f938d73d72771c1b88bc0ada8`
last_updated: 2026-11-10

## 中文

<!-- topic:decision -->
### 1. 产品裁决

`IN_CHAT_HUMAN_APPROVAL = PRIMARY`。

人工审批的正常路径必须发生在当前 ChatGPT 对话中。Cloudflare Access / Operator 页面仅作为明确的恢复与灾难备用路径，不是每次审批的默认跳转目标。

本规范是 GhostFleet 的可选 ChatGPT MCP App 集成合同，不改变 AI-client-neutral core，也不把 ChatGPT、OAuth 或 Cloudflare 变成核心运行依赖。

沿用现有 GhostFleet #69 与私有 `ai-hub#300` 实现 lineage：

- 不创建第二套审批账本、签发器或管理员权限层。
- 私有 `AdminApprovalLedgerDO`、现有 issuer、Ed25519 租约及节点 V4 Helper 仍由 `ai-hub` 部署 owner 持有。
- GhostFleet 只定义可复用的 UI、MCP 工具、认证边界和验收合同。
- 普通执行身份不因接入 UI 或 OAuth 而获得管理员权限。

### 2. 平台能力与限制

截至本文件日期，OpenAI 官方资料确认：

- ChatGPT Web 支持自定义 MCP Server 和 MCP App 交互界面。
- 自定义 MCP Server 连接及完整 MCP 写操作当前要求 Business 或 Enterprise/Edu 工作区；具体账户和工作区权限仍须实测。
- 官方帮助中心明确表示自定义 MCP Server 连接目前仅支持 Web，不支持原生 ChatGPT Mobile。
- MCP OAuth 支持 OAuth 2.1、按工具声明 `securitySchemes`、scope 授权及服务端逐次验证。
- ChatGPT 可在额外 scope 需要时重新授权；`id_token_hint` 只是可选的登录上下文延续机制。
- ChatGPT 对写操作的确认提示由应用权限和动作上下文决定，不能当作不可伪造的密码学用户点击证明。

官方参考：
- OpenAI Help Center: “Connecting custom MCP servers in ChatGPT”
- OpenAI Developer Docs: “Add UI to your MCP server”
- OpenAI Developer Docs: “Authentication”

因此，平台状态必须分别记录：

| Surface | 状态 | 规则 |
| --- | --- | --- |
| ChatGPT Web custom MCP App | `WEB_POC_REQUIRED` | 可开发；必须完成真实 Host Bridge、OAuth 和 UI 点击验收 |
| Native ChatGPT Mobile custom MCP App | `BLOCKED_BY_HOST_PLATFORM` | 官方当前不支持；禁止假设 Web App 自动可用 |
| Existing Fleet DCR on native mobile | `UNVERIFIED` | 独立实测；不能由 custom MCP 文档推断其能力 |
| Cloudflare Access / Operator fallback | `RECOVERY_ONLY` | 仅在用户明确选择恢复路径时使用 |

若原生移动端没有受信的审批交互路径，移动端特权执行必须 fail closed。不得把聊天文字“批准”、模型生成文本或普通工具确认降级为审批凭据。

### 3. 身份与信任模型

必须区分：

| Principal | 含义 | 权限 |
| --- | --- | --- |
| Agent/workload principal | 发起命令申请的模型、Agent 或自动化工作负载 | 可创建、查询、取消申请；不能批准或签发 |
| Human approver principal | 通过独立认证与审批授权的真实操作员主体 | 可对精确待审批请求作出一次批准或拒绝 |
| Node execution principal | 节点专用 ops 身份及 root Helper | 只消费已签名、节点绑定、未过期的一次性租约 |

不能仅用 `requester_user_id !== human_approver_user_id` 定义主体隔离。真正需要隔离的是 Agent/workload principal 与 Human approver principal。发起业务工作的同一位人类用户可以亲自批准该工作，但审批必须由独立的人类认证上下文完成，不能由 Agent bearer 自批。

OAuth `sub` 只能证明当前令牌代表哪个身份；scope 只能证明令牌被授予什么权限。二者都不能单独证明此刻有人点击了批准。

**UI 可见性不是授权边界，OAuth scope 也不是用户在场证明。**

### 4. MCP App 交互合同

模型可见工具：

- `fleet_admin_request_command`：创建不可变的 PENDING 请求。
- `fleet_admin_review_pending`：只读返回权威请求快照。
- `fleet_admin_command_status`：只读查询同一请求状态。
- `fleet_admin_command_execute`：执行已批准的同一请求；服务端重新验证完整状态和租约。

App-only 决策工具：

- `fleet_admin_human_decide`：只供审批卡片按钮调用，声明 `_meta.ui.visibility: ["app"]`。
- 只接受 `request_id`、请求摘要/版本及 `approve | deny` 等最小必要输入。
- 不接受调用方自报的 Human 身份、批准布尔值、租约、私钥或签名材料。
- 服务端仍须独立认证 Human approver principal、审批角色和当前授权 scope。

审批卡片必须从服务端返回的权威快照渲染，不信任模型生成的命令摘要。至少展示：

- 请求 ID、目标节点、发起 Agent/Work；
- 完整 argv、cwd、环境摘要、执行器摘要及外部输入风险；
- 目的、风险、副作用、回滚计划；
- TTL、最大运行时间、输出策略和到期时间。

卡片提供明确的 Approve / Deny 操作。窄屏优先展示关键风险与摘要，展开后可查看完整命令细节。卡片渲染本身绝不能触发审批或执行。

### 5. OAuth、用户在场与服务端仲裁

推荐先验证按工具 scope 的 OAuth 方案，例如 `fleet.admin.approve`：

1. 普通 Agent 工具只拥有普通请求/查询/执行所需 scope。
2. `fleet_admin_human_decide` 单独声明审批 scope。
3. 使用 MCP OAuth 资源服务器元数据和 per-tool `securitySchemes`；按官方要求配置授权服务器发现、PKCE、resource、issuer identification 和 scope。
4. 服务端每次请求验证签名、`iss`、`aud/resource`、`exp/nbf`、scope、撤销状态和主体映射。
5. 必须实测 Host 是否为 UI 决策调用提供独立、仅含审批 scope 的授权上下文；不能假定模型工具 token 与 UI token 自动隔离。
6. 若 Host 无法提供足以区分 Agent 与 Human 的授权上下文，必须增加独立 Human step-up（可评估 WebAuthn/passkey），或保持审批关闭。不得自行发明 Host 签名的“用户点击证明”。

审批决定必须绑定：

`request_id + request_digest + ledger_version + expiry + one_time_nonce + approver_principal`

现有 DO 账本使用原子 CAS，只允许一个终态决定胜出。批准后由现有受保护 signer 签发节点 V4 可消费的一次性 Ed25519 租约。签名私钥不能进入浏览器 iframe、widgetState、localStorage、模型参数或普通 Agent/Worker 可读空间。

不得把 30 天 bearer 或可复用审批 token 放在客户端。短期 OAuth access token 由 Host 按授权协议管理；任何 refresh/session policy 均由服务端控制，具备撤销与重新认证策略。

### 6. 时序与状态图

```mermaid
sequenceDiagram
    participant A as Agent
    participant S as Private MCP / API
    participant D as Existing DO Ledger
    participant UI as In-chat Approval Card
    participant H as Human Approver
    participant K as Protected Signer
    participant N as Node V4 Helper

    A->>S: request exact command
    S->>D: create immutable PENDING
    D-->>S: request snapshot + version
    S-->>UI: render authoritative snapshot
    H->>UI: explicit Approve / Deny click
    UI->>S: app-only human_decide + approval auth
    S->>S: verify Human principal, scope, digest, expiry
    S->>D: CAS PENDING -> APPROVED / DENIED
    D-->>S: authoritative terminal decision
    opt Approved
        S->>K: sign exact one-use lease
        K-->>S: signed lease
        S-->>A: same request is APPROVED
        A->>S: execute same request_id
        S->>N: dispatch signed lease once
        N-->>S: receipt / status
        S->>D: consume and persist outcome
    end
    S-->>UI: authoritative status readback
```

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> APPROVED: Human CAS decision
    PENDING --> DENIED: Human CAS decision
    PENDING --> EXPIRED: TTL reached
    APPROVED --> CONSUMED: one-use lease dispatch fence committed
    APPROVED --> REVOKED: explicit revoke before dispatch
    APPROVED --> EXPIRED: lease expired
    CONSUMED --> SUCCEEDED: terminal receipt proves success
    CONSUMED --> FAILED: terminal receipt proves failure
    CONSUMED --> UNKNOWN: outcome cannot be proven
    UNKNOWN --> SUCCEEDED: same-request reconciliation proves success
    UNKNOWN --> FAILED: same-request reconciliation proves failure
    UNKNOWN --> RECONCILE_REQUIRED: evidence remains incomplete
    RECONCILE_REQUIRED --> SUCCEEDED: later evidence proves success
    RECONCILE_REQUIRED --> FAILED: later evidence proves failure
    DENIED --> [*]
    EXPIRED --> [*]
    REVOKED --> [*]
```

`UNKNOWN` 不允许创建新请求来掩盖旧请求，也不允许盲目重复派发。所有恢复都沿用原 request/lease 进行对账。

### 7. Phase 与验收门

| Phase | 交付 | 通过条件 |
| --- | --- | --- |
| 0A | Web Host feasibility | 实测 App resource、Host Bridge `tools/call`、App-only visibility、per-tool OAuth scope 和真实按钮交互 |
| 0B | Mobile feasibility | 独立验证现有 Fleet DCR 是否有原生移动端受信审批 UI；custom MCP mobile 当前按官方限制视为 blocked |
| 1 | GhostFleet generic contract | 通用审批卡片、工具 schema、窄屏布局、服务端状态回读和双语文档 |
| 2 | Private ai-hub integration | 复用现有 DO CAS、issuer、Ed25519 和 Cloudflare Access recovery，不新增账本/签发器 |
| 3 | Canary | Web 路径验收通过后才允许创建一笔真实 PENDING；用户在卡片明确点击；同一请求执行一次并终态回读 |

必须覆盖的负向测试：

- Agent principal 直接调用 app-only 决策工具；
- 缺失、错误或被撤销的审批 scope；
- Human 与 Agent 主体混淆；
- 请求摘要、账本版本、节点或命令被替换；
- 过期、重复点击、nonce 重放和并发 CAS；
- UI 自动渲染触发动作；
- Host token 刷新、重新授权和账号切换；
- 派发后响应丢失、UNKNOWN 和同请求恢复；
- Web 与原生移动端分别验收，不能互相代替。

### 8. 当前状态

截至 2026-11-10：

- 产品裁决：`IN_CHAT_HUMAN_APPROVAL = PRIMARY`。
- 客户端 HAST 30 天：`REJECTED`。
- ChatGPT Web MCP App：`WEB_POC_REQUIRED`。
- Native ChatGPT Mobile custom MCP：`BLOCKED_BY_HOST_PLATFORM`。
- Existing Fleet DCR native mobile：`UNVERIFIED`。
- ThinkPad approved-admin production canary：已验收。
- JG node preflight：已验收为 READY FOR ONE BOUNDED CANARY；尚无新审批请求、Human 决定或执行。
- JG canary：`HOLD_UNTIL_IN_CHAT_APPROVAL_USABLE`。
- OMV8：继续冻结，不能由本方案解锁。

任何源码合并、合成测试通过或 Host 预检通过，都不能替代 UI、真实身份和单笔金丝雀验收。

## English

<!-- topic:decision -->
### 1. Product ruling

`IN_CHAT_HUMAN_APPROVAL = PRIMARY`.

The normal approval journey must take place inside the current ChatGPT conversation. The Cloudflare Access / Operator page is an explicit recovery and disaster fallback, not the routine destination for every approval.

This is an optional ChatGPT MCP App integration contract. It does not change the AI-client-neutral core or make ChatGPT, OAuth, or Cloudflare a mandatory core dependency.

Continue the existing GhostFleet #69 / private `ai-hub#300` lineage:

- Do not create a second approval ledger, issuer, or administrator permission tier.
- The private `AdminApprovalLedgerDO`, existing issuer, Ed25519 lease and node V4 Helper remain owned by the private `ai-hub` deployment owner.
- GhostFleet owns only the reusable UI, MCP tool, authentication-boundary and acceptance contracts.
- Ordinary execution identity does not gain administrator authority merely by using the UI or OAuth.

### 2. Platform capabilities and limitations

As of this document date, official OpenAI documentation confirms:

- ChatGPT Web supports custom MCP servers and interactive MCP App interfaces.
- Custom MCP server connections and full MCP write actions currently require Business or Enterprise/Edu workspaces; account and workspace permissions still need verification.
- The Help Center explicitly says custom MCP server connections are currently Web-only and are not supported in native ChatGPT Mobile.
- MCP OAuth supports OAuth 2.1, per-tool `securitySchemes`, scope authorization and per-request server verification.
- ChatGPT can reauthorize when additional scopes are needed; `id_token_hint` is an optional login-context optimization.
- ChatGPT write-action confirmation prompts depend on app permissions and action context. They are not cryptographic proof of a user click.

Official references:
- OpenAI Help Center: “Connecting custom MCP servers in ChatGPT”
- OpenAI Developer Docs: “Add UI to your MCP server”
- OpenAI Developer Docs: “Authentication”

Track platform status independently:

| Surface | Status | Rule |
| --- | --- | --- |
| ChatGPT Web custom MCP App | `WEB_POC_REQUIRED` | Buildable; real Host Bridge, OAuth and UI-click acceptance required |
| Native ChatGPT Mobile custom MCP App | `BLOCKED_BY_HOST_PLATFORM` | Not currently supported by official documentation; do not assume Web Apps work natively |
| Existing Fleet DCR on native mobile | `UNVERIFIED` | Test independently; do not infer its capability from custom MCP documentation |
| Cloudflare Access / Operator fallback | `RECOVERY_ONLY` | Use only when the user explicitly chooses the recovery path |

If native mobile has no trusted approval interaction, privileged execution from mobile must fail closed. Chat text saying “approved”, model-generated text, or ordinary tool confirmation must never become an approval credential.

### 3. Principals and trust model

Distinguish three principals:

| Principal | Meaning | Authority |
| --- | --- | --- |
| Agent/workload principal | Model, Agent or automation workload requesting a command | May create, inspect and cancel requests; cannot approve or sign |
| Human approver principal | Authenticated operator with independent approval authority | May approve or deny one exact pending request |
| Node execution principal | Node-specific ops identity and root Helper | Consumes only a signed, node-bound, unexpired one-use lease |

Do not define separation solely as `requester_user_id !== human_approver_user_id`. The security boundary is between the Agent/workload principal and the Human approver principal. The same human who initiated the business work may approve it, but the decision must use an independent human-authentication context; an Agent bearer must never self-approve.

OAuth `sub` proves which identity a token represents. A scope proves which permission was granted. Neither alone proves that a person clicked Approve at that moment.

**UI visibility is not an authorization boundary, and an OAuth scope is not proof of user presence.**

### 4. MCP App interaction contract

Model-visible tools:

- `fleet_admin_request_command`: create an immutable PENDING request.
- `fleet_admin_review_pending`: read the authoritative request snapshot.
- `fleet_admin_command_status`: read the same request's status.
- `fleet_admin_command_execute`: execute the same approved request after complete server-side state and lease validation.

App-only decision tool:

- `fleet_admin_human_decide`: callable by the approval-card button only, declared with `_meta.ui.visibility: ["app"]`.
- Accept only the minimum required inputs, such as `request_id`, request digest/version and `approve | deny`.
- Never accept caller-asserted Human identity, approval booleans, leases, private keys or signing material.
- The server must independently authenticate the Human approver principal, approval role and current authorization scope.

Render the card from the authoritative server snapshot, not a model-generated command summary. Show at least:

- Request ID, target node, requesting Agent/Work;
- Exact argv, cwd, environment summary, executable digest and external-input risks;
- Purpose, risk, side effects and rollback plan;
- TTL, maximum runtime, output policy and expiry.

Provide explicit Approve / Deny actions. On narrow screens, show key risks and a compact summary first, with full command details expandable. Rendering the card must never trigger approval or execution.

### 5. OAuth, user presence and server-side arbitration

Prototype per-tool OAuth scopes first, for example `fleet.admin.approve`:

1. Ordinary Agent tools receive only the scopes required for normal request/read/execute operations.
2. `fleet_admin_human_decide` declares the approval scope separately.
3. Use MCP OAuth resource-server metadata and per-tool `securitySchemes`; configure discovery, PKCE, resource, issuer identification and scopes as required by the official contract.
4. On every request, verify signature, `iss`, `aud/resource`, `exp/nbf`, scope, revocation state and principal mapping.
5. Test whether the Host supplies an independent approval-only authorization context to UI decisions. Never assume the model tool token and UI token are automatically isolated.
6. If the Host cannot provide sufficient separation between Agent and Human authorization contexts, require independent Human step-up (WebAuthn/passkey may be evaluated) or keep approval disabled. Never invent a Host-signed “user clicked” assertion.

Bind every decision to:

`request_id + request_digest + ledger_version + expiry + one_time_nonce + approver_principal`

The existing DO ledger uses atomic CAS so only one terminal decision wins. After approval, the existing protected signer issues a one-use Ed25519 lease consumable by the node V4 path. Signing private keys must never enter the browser iframe, widgetState, localStorage, model arguments or ordinary Agent/Worker-readable storage.

Do not store a 30-day bearer or reusable approval token on the client. The Host manages short-lived OAuth access tokens under the authorization protocol; any refresh/session policy remains server-controlled with revocation and reauthentication.

### 6. Sequence and state diagrams

```mermaid
sequenceDiagram
    participant A as Agent
    participant S as Private MCP / API
    participant D as Existing DO Ledger
    participant UI as In-chat Approval Card
    participant H as Human Approver
    participant K as Protected Signer
    participant N as Node V4 Helper

    A->>S: request exact command
    S->>D: create immutable PENDING
    D-->>S: request snapshot + version
    S-->>UI: render authoritative snapshot
    H->>UI: explicit Approve / Deny click
    UI->>S: app-only human_decide + approval auth
    S->>S: verify Human principal, scope, digest, expiry
    S->>D: CAS PENDING -> APPROVED / DENIED
    D-->>S: authoritative terminal decision
    opt Approved
        S->>K: sign exact one-use lease
        K-->>S: signed lease
        S-->>A: same request is APPROVED
        A->>S: execute same request_id
        S->>N: dispatch signed lease once
        N-->>S: receipt / status
        S->>D: consume and persist outcome
    end
    S-->>UI: authoritative status readback
```

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> APPROVED: Human CAS decision
    PENDING --> DENIED: Human CAS decision
    PENDING --> EXPIRED: TTL reached
    APPROVED --> CONSUMED: one-use lease dispatched and reconciled
    APPROVED --> REVOKED: explicit revoke before dispatch
    APPROVED --> EXPIRED: lease expired
    CONSUMED --> UNKNOWN: outcome cannot be proven
    UNKNOWN --> CONSUMED: same-request reconciliation proves effect
    UNKNOWN --> RECONCILE_REQUIRED: evidence remains incomplete
    DENIED --> [*]
    EXPIRED --> [*]
    REVOKED --> [*]
```

`UNKNOWN` must not be hidden by creating a new request, and must never trigger blind redispatch. Recovery reconciles the original request/lease.

### 7. Phases and acceptance gates

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| 0A | Web Host feasibility | Real App resource, Host Bridge `tools/call`, app-only visibility, per-tool OAuth scope and button interaction |
| 0B | Mobile feasibility | Independently verify whether existing Fleet DCR has a trusted native mobile approval UI; custom MCP mobile remains blocked under current official guidance |
| 1 | Generic GhostFleet contract | Reusable approval card, tool schemas, narrow-screen layout, server status readback and bilingual docs |
| 2 | Private ai-hub integration | Reuse existing DO CAS, issuer, Ed25519 and Cloudflare Access recovery; add no second ledger or issuer |
| 3 | Canary | Only after Web acceptance, create one real PENDING request; require explicit card click; execute once and read back terminal status |

Required negative tests:

- Agent principal directly calls the app-only decision tool;
- Missing, incorrect or revoked approval scope;
- Human/Agent principal confusion;
- Request digest, ledger version, node or command substitution;
- Expiry, duplicate click, nonce replay and concurrent CAS;
- UI rendering triggers an action;
- Host token refresh, reauthorization and account switching;
- Lost response after dispatch, UNKNOWN and same-request recovery;
- Separate Web and native mobile acceptance; neither substitutes for the other.

### 8. Current status

As of 2026-11-10:

- Product ruling: `IN_CHAT_HUMAN_APPROVAL = PRIMARY`.
- Client-side 30-day HAST: `REJECTED`.
- ChatGPT Web MCP App: `WEB_POC_REQUIRED`.
- Native ChatGPT Mobile custom MCP: `BLOCKED_BY_HOST_PLATFORM`.
- Existing Fleet DCR native mobile: `UNVERIFIED`.
- ThinkPad approved-admin production canary: accepted.
- JG node preflight: accepted as READY FOR ONE BOUNDED CANARY; no new approval request, Human decision or execution exists.
- JG canary: `HOLD_UNTIL_IN_CHAT_APPROVAL_USABLE`.
- OMV8: remains frozen and is not unblocked by this design.

Source merges, synthetic test passes and Host preflight do not substitute for UI, real identity and single-request canary acceptance.
