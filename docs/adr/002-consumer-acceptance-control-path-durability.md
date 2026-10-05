# ADR 002 — 消费者验收与控制路径持久性 / Consumer acceptance and control-path durability

状态：Accepted  
来源 Issue：#4

## 中文

### Context

GhostFleet 已经把核心设备准入与独立消费者接入区分开：`NodeIdentity.ACTIVE` 与七类核心 evidence 只证明设备通过本控制面的准入要求，不证明某个独立消费者已经完成目录发现、鉴权配置、调用路由、操作权限与回滚验收。

ThinkPad 的历史 7/7 canary 真实证明了核心生命周期、稳定身份、证据驱动晋升、立即重复零差异、一次真实重启恢复，以及 Console/HTTP/MCP 对同一身份的一致读取。但后续复核发现，当时用于控制 canary 的凭据和控制路径依附于执行者环境，没有形成 deployment-owned durable custody。执行者环境消失后，控制路径随之消失。

因此，问题不是核心 `ACTIVE` 定义错误，也不是缺少另一套 enrollment lifecycle；问题是消费者验收缺少足够强的机器可判 contract，导致一次成功调用曾被错误外推为持久消费者接入。

### Decision

GhostFleet 将消费者验收定义为**独立于核心 Node lifecycle 的一等 integration contract**，但不创建第二套 `NodeIdentity`、第二 enrollment state machine 或第二 SSOT。

消费者验收必须至少绑定：

- 已接受的同一 `NodeIdentity`；
- consumer / adapter identity 及其 current source/config revision；
- control-path binding reference；
- opaque durable custody reference；
- 正向 authority test；
- 越权/缺权负测；
- 实际调用路由与同一身份 readback；
- executor-independence evidence；
- node-scoped rollback plan/result；
- 最终 consumer acceptance state。

对依赖特权凭据的消费者接入，增加 fail-closed custody gate：

- executor/session/workspace-local key、path 或临时文件不得满足验收；
- 可接受的 custody 必须解析为 deployment-owned durable reference，例如 provider-native secret，或由部署方声明并证明的 host-owned protected artifact；
- GhostFleet 只保存和验证引用、类别与证据，不保存 secret plaintext；
- 无法证明 custody durability 时，consumer acceptance 不得 PASS。

executor-independence 必须由事实证明：初次成功后，从一个不依赖原 builder/session/workspace 的新执行上下文重新完成等价授权调用。没有这项证据，不得把控制路径视为持久接入。

consumer rollback 采用**节点级语义**：适配器/集成必须声明并移除该节点引入的 policy、target、routing 或等价 binding，并证明此前已验收路径恢复。仅回退代码、镜像或 Worker 版本，不足以构成节点回滚。

核心 `ACTIVE`、成功 tunnel、单次 SSH、单次 typed call 或 Human 维护通道，均不得交叉关闭 consumer acceptance。

### Alternatives

**方案 A：把核心 `ACTIVE` 继续视为完整纳管完成。**  
拒绝。它会把控制面身份准入和独立消费者实际可用性混成同一个状态，无法表达目录、鉴权、路由、权限和回滚失败。

**方案 B：为消费者接入再建立一套 NodeIdentity / enrollment lifecycle。**  
拒绝。这会制造第二身份和第二真值轨道，破坏现有核心 identity ownership，并增加迁移、恢复和一致性成本。

**方案 C：允许 executor-local key，只要 canary 当次成功即可。**  
拒绝。它证明的是执行者当时能调用，不是部署在执行者消失后仍可调用。

**方案 D：把 Human 维护 SSH surface 作为机器控制路径的默认 fallback。**  
拒绝。Human maintenance authority 与机器控制 authority 是不同边界，不能因可达性而互相替代。

### Consequences

收益：

- core admission 与 consumer acceptance 的语义边界可被机器验证；
- 持久控制路径不再依赖某一次 Builder/Agent 会话；
- rollback 从“版本退回”提升为“节点绑定真正撤销”；
- public core 保持 provider-neutral，不吸收 Cloudflare、Tailscale、JG 或具体私有拓扑。

成本：

- consumer adapter 需要提供更多 integration evidence；
- deployment 必须明确凭据 custody owner 与可验证引用；
- release/cutover tests 增加 fresh-context executor-independence 与 node-scoped rollback 验证；
- 历史 evidence 需要按真实证明范围重新解释，不能再用“一次 canary 成功”外推完整消费者接入。

### Compatibility / historical interpretation

ThinkPad 历史 7/7 canary 保留为 GhostFleet **核心准入能力**的有效证据；不重写、不删除，也不降级现有 `NodeIdentity.ACTIVE`。

该历史 canary 不再被解释为某个 active consumer 的持久接入证明。任何消费者完成状态必须按本 ADR 的 contract 单独验收。

部署实例中的 Cloudflare/Tailscale/SSH 端口、账号、节点绑定与生产发布门仍由 deployment owner 管理，不进入公共 GhostFleet canonical model。

## English

### Context

GhostFleet already separates core device admission from independent consumer integration: `NodeIdentity.ACTIVE` and the seven core evidence types establish admission under this control plane, not catalog discovery, authentication configuration, call routing, operational authority, or rollback acceptance in an independent consumer.

The historical ThinkPad 7/7 canary genuinely established core lifecycle behavior, stable identity, evidence-driven promotion, immediate zero-delta repetition, one real reboot recovery, and consistent Console/HTTP/MCP reads of the same identity. A later review established that the credential and control path used for the control canary were bound to the executor environment rather than durable deployment-owned custody. When the executor environment disappeared, the control path disappeared with it.

The defect is therefore not the core `ACTIVE` definition and not the absence of another enrollment lifecycle. The missing element is a sufficiently strong machine-decidable consumer acceptance contract.

### Decision

GhostFleet defines consumer acceptance as a first-class integration contract separate from the core Node lifecycle, without creating a second `NodeIdentity`, enrollment state machine, or SSOT.

Consumer acceptance must bind at least:

- the same accepted `NodeIdentity`;
- consumer/adapter identity and current source/config revision;
- a control-path binding reference;
- an opaque durable custody reference;
- positive authority testing;
- negative authority testing;
- actual call routing and same-identity readback;
- executor-independence evidence;
- node-scoped rollback plan/result;
- final consumer acceptance state.

For privileged control credentials, acceptance fails closed unless custody resolves to a deployment-owned durable reference. Executor/session/workspace-local keys, paths, or temporary files cannot satisfy acceptance. GhostFleet stores and validates references, classes, and evidence rather than secret plaintext.

Executor independence must be demonstrated by reissuing an equivalent authorized operation from a fresh execution context that has no dependency on the original builder/session/workspace.

Consumer rollback is node-scoped: integrations must remove the node-specific policy, target, routing, or equivalent bindings they introduced and prove restoration of the previously accepted path. Reverting only code, an image, or a Worker version is insufficient.

Core `ACTIVE`, a successful tunnel, one SSH call, one typed call, or a Human maintenance surface cannot cross-close consumer acceptance.

### Alternatives

**A. Treat core `ACTIVE` as complete managed admission.**  
Rejected because it conflates control-plane identity admission with actual consumer usability.

**B. Create another NodeIdentity/enrollment lifecycle for consumers.**  
Rejected because it creates a parallel identity/truth track and increases migration, recovery, and consistency cost.

**C. Accept executor-local credentials when the canary succeeds.**  
Rejected because that proves only executor-local capability, not durable deployment control.

**D. Use a Human maintenance SSH surface as the default machine-control fallback.**  
Rejected because Human maintenance authority and machine-control authority are distinct boundaries.

### Consequences

Benefits include machine-verifiable separation between core and consumer admission, executor-independent control durability, node-scoped rollback, and continued provider-neutral public core semantics.

Costs include additional adapter evidence, explicit custody ownership, fresh-context acceptance tests, and stricter interpretation of historical canary evidence.

### Compatibility / historical interpretation

The historical ThinkPad 7/7 canary remains valid evidence for GhostFleet core admission behavior. Existing `NodeIdentity.ACTIVE` is preserved.

That canary is not interpreted as durable acceptance of any independent active consumer. Each consumer must be accepted separately under this ADR.

Deployment-specific Cloudflare/Tailscale/SSH port choices, account coordinates, node bindings, and production deployment gates remain deployment-owned and are not part of the public GhostFleet canonical model.
