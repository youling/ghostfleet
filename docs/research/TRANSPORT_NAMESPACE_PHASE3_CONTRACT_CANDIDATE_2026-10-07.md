# Transport Namespace & Adaptive Link Layer — Phase 3 契约研究（provider-neutral contract freeze candidate）

- Issue: https://github.com/youling/ghostfleet/issues/36
- 前置：Phase 1 / Phase 2 事实研究；Phase 2 已由 #36 comment 6036252158 通过。
- 日期：2026-10-07
- 状态：Architect-corrected contract-freeze candidate；只冻结 provider-neutral 语义关系与安全不变量，不冻结最终类名、枚举、URI scheme、listener 端口或 adaptive-routing 算法。最终接受以 #36 Architect exact-head review / merge 为准。

## 1. 最小对象关系图

以下名称只用于说明；**冻结的是关系和边界，不是最终 TypeScript/Python 类型名。**

```text
NodeIdentity { node_uid }
  └── owns N × PlaneBinding
        {
          plane_class,
          provider?,
          provider_ref?,
          required_tags?,          // durable policy expectation, not observed provider state
          endpoint_policy?,
          target_proof_policy,
          policy_revision
        }

OperationContext
  {
    operation_id,
    purpose,                       // explicit semantic purpose
    actor_ref,
    authn_class,                   // metadata/ref only; no raw bearer credential
    authority_snapshot_ref,
    policy_revision,
    effect_state                   // NOT_DISPATCHED | MAY_HAVE_EXECUTED | UNKNOWN
  }

ProviderAdapter(PlaneBinding + runtime provider observation)
  ├── LocatorObservation           // runtime only
  ├── ResolvedEndpoint             // runtime resolution of endpoint policy
  ├── ObservedTargetProof
  └── HealthEvidence / FailureDomainObservation

Resolver(NodeIdentity + OperationContext + PlaneBindings + runtime evidence)
  └── CandidateSummary[]
        {
          candidate_ref,
          plane_class,
          endpoint_kind,
          locator_kind,
          required_target_proof,
          failure_domain?
        }
```

核心约束：

- `node_uid` 是关联根，但不是 locator。
- Provider / network plane / locator / endpoint 必须分层。
- durable `required_tags` 是**期望策略**；provider 当前实际 tags 是 runtime observation，不得混成同一字段。
- Caller Authentication 与 Authority 分离；resolver 只接受 authenticated ingress 生成的 actor/authn/authority **引用或安全快照元数据**，不得接受 raw bearer token、OAuth client secret、SSH private key。
- Target Identity Proof 独立于 caller auth 与 provider credential。
- Purpose 在选链之前明确，并进入 operation 的可审计事实。
- Dispatch / Effect State 位于 routing 之上；未知不得解释成未执行。
- Locator 与 health evidence 只参与运行时解析/选择，不能单独产生 authority。

## 2. 现有实现逐字段映射

### Python `TransportResolutionRequest / Candidate / Resolver`

| 冻结维度 | 当前实现 | freeze 后兼容方向 |
| --- | --- | --- |
| Node Identity | `request.node_uid` | 已符合；继续作为关联根 |
| Provider / Plane | `TransportCandidate.provider`，当前 normal path 主要是 Tailscale | provider 与 plane 语义拆层；旧字段由 compat adapter 精确映射 |
| Locator | `candidate.locator / locator_kind / name_hint` | 保持 runtime-only；不得写成 authority |
| Endpoint / Listener | 当前主要隐式落在 Tailscale SSH / native OpenSSH 行为 | 新 contract 表达 endpoint policy/kind；实际 resolved endpoint 属 runtime |
| Caller Authentication | 当前 resolver 不接 caller；caller 在上层 ingress/control | 新 contract 只接 actor_ref/authn_class 等安全元数据，不接 raw auth credential |
| Authority | `management_path / management_profile / provider_ref` 与 required service tag 共同约束 normal path | authority snapshot/policy revision 与 plane policy 显式绑定；provider 名称本身不产生 authority |
| TargetProof | `PinnedIdentityVerifier` + exact provider_ref/tag correlation | 保留；proof 与 locator/caller auth 分离 |
| Purpose | 当前隐式偏 machine-control | 新 contract 显式要求；仅 legacy adapter 在已知入口可安全派生 |
| Dispatch / Effect State | resolver 本身没有；执行层另有 effect-state 语义 | 由 operation orchestration 上抬到 routing fence |
| Failure Domain / Health | 只有 typed transport status/error，未形成独立 domain | runtime observation，不能推出 node-down 或 authority |

### TypeScript typed-control

| 冻结维度 | 当前实现 | freeze 后兼容方向 |
| --- | --- | --- |
| Node Identity | target map 以 `nodeUid` 为 key | 已符合 |
| Provider / Plane | `transport_mode = mesh_hostname | direct_tunnel | local_ssh` | 旧 enum 作为 compat 输入；不能继续承担 plane+endpoint+authority 的混合语义 |
| Locator | `controlHostname(nodeUid)`、binding name、`127.0.0.1` | runtime resolution；不进入 durable authority |
| Endpoint | socket hostname/port 在 transport 层即时解析 | endpoint policy 可 durable；resolved endpoint runtime-only |
| Caller Authentication | authenticated ingress 构造 `ControlActor` | resolver 只消费 actor_ref/authn_class 元数据 |
| Authority | `ControlActor.scopes` + control policy source revision | 与 routing 分离；network binding 仅用于寻路 |
| TargetProof | pinned SSH host-key algorithm + SHA256 fingerprint | 已符合，保持独立 |
| Purpose | `ControlTarget` 当前无 purpose | 新 contract 显式增加；legacy machine-control wrapper 可精确派生 |
| Dispatch / Effect State | `SshExecutionError.dispatch_state`；exec request 发送动作前从 `NOT_DISPATCHED` 切到 `MAY_HAVE_EXECUTED` | 上抬成 operation fence；缺失值绝不能默认 `NOT_DISPATCHED` |
| Failure Domain / Health | 现有错误码散落在 backend/socket/SSH 层 | adapter 归类为 runtime evidence，不修改原始错误事实 |

## 3. Durable config / operation evidence / runtime observation / secret custody

| 信息 | 归属 |
| --- | --- |
| `node_uid`、plane/provider binding、opaque provider_ref、**required tag policy**、endpoint policy、target-proof policy、policy revision、pinned identity digest | durable config / registry |
| operation_id、explicit purpose、actor_ref/authn_class、authority snapshot/ref、policy revision、effect-state transition、最终 receipt | durable operation/evidence；至少必须在崩溃后可恢复或保守重建 |
| provider 当前 observed tags、resolved locator、MagicDNS/IP、peer snapshot、resolved endpoint、health probe、failure-domain observation | runtime observation；默认不进入 durable registry |
| raw OAuth/access token、SSH private key、Tailscale enrollment auth key、一次性 enrollment credential | secret/transient custody；**不得进入公共 registry、transport contract、日志或 durable evidence** |
| enrollment credential metadata / secret ref / generation / expiry / digest（若业务需要） | 可进入对应私有 authority/custody registry，但永远不作为 transport locator 或 routing score |

特别说明：`effect_state` 不能仅视为进程内 runtime observation。它存在的目的就是在超时、异常、重启后阻止盲目换链/重试，因此 `MAY_HAVE_EXECUTED / UNKNOWN` 必须可靠持久化，或能从 durable receipt/journal **保守**重建。

## 4. Provider adapter boundary

| Provider / plane | adapter 负责 | 禁止泄漏到 provider-neutral contract |
| --- | --- | --- |
| Cloudflare / Workers VPC / Tunnel | binding 解析、socket 建立、cloudflared/VPC health observation、provider-specific target proof materialization | Workers Socket API、binding 命名规则、真实 hostname/IP、Cloudflare account/runtime secret |
| Tailscale / tailnet | peer snapshot、exact provider_ref correlation、observed tag 校验、Tailscale SSH/JIT host-key observation、tailnet health | Tailscale CLI/API 参数、DERP/direct 细节、OAuth/auth key |
| native OpenSSH / recovery plane | explicit recovery source、pinned host identity、native sshd reachability | LAN/provider topology、sshd_config 细节、controller private key |

公共 contract 只定义：

```text
resolve(
  node identity,
  operation context,
  durable plane policy,
  runtime observations
) -> candidate summaries / reconcile-required
```

Provider adapter 不得：
- 自行扩大 purpose；
- 自行生成 authority；
- 把 provider credential 当 target proof；
- 因连接失败自动跨 purpose/authority plane fallback。

## 5. Compatibility plan

1. 当前 Python `TransportMode.NORMAL` 的安全语义不变：exact provider_ref + required service tag + pinned verifier 仍是现有 Tailscale normal path 的准入条件。
2. 当前 TS `ControlTarget.transport_mode` 继续可读；compat adapter 可把 `mesh_hostname | direct_tunnel | local_ssh` 映射为新的 plane/endpoint 候选事实，但旧 enum 不能提升为 authority。
3. `LEGACY_CANARY` 保持显式 opt-in，不扩大范围，不允许 adaptive router 自动进入。
4. **Purpose 无全局默认。** 对现有明确属于 machine-control 的调用入口，compat adapter 可以显式派生 `machine-control`；无法证明用途时 fail closed。
5. **Effect/dispatch state 无 `NOT_DISPATCHED` 缺省。** 只有 operation orchestrator 明确证明尚未 dispatch 时才能传 `NOT_DISPATCHED`；缺失、恢复不明、异常结果必须按 `UNKNOWN / reconcile_required` 处理。
6. 新字段可以从可信 legacy source 精确派生时允许 adapter 填充；不能精确派生时 fail closed。禁止用 hostname/IP/transport_mode/连接失败等启发式补 authority、purpose 或 effect state。
7. 迁移采用 additive + adapter-first：先建立 provider-neutral contract/compat layer，再逐个迁移 Python/TS caller；旧字段在所有调用方完成迁移与反例测试前不删除。

## 6. Adaptive routing I/O contract 草案

```text
input: {
  node_uid,
  operation_id,
  purpose,
  actor_ref,
  authn_class,
  authority_snapshot_ref,
  policy_revision,
  effect_state,
  health_evidence?
}

output: {
  candidates: [
    {
      candidate_ref,
      plane_class,
      endpoint_kind,
      locator_kind,
      required_target_proof,
      failure_domain?
    }
  ],
  recommended: candidate_ref?,
  reason_code
}
```

冻结约束：

- `effect_state != NOT_DISPATCHED` 时，不得产生可执行推荐；`MAY_HAVE_EXECUTED / UNKNOWN` 必须返回 reconcile-required 语义。
- purpose/authority policy 不允许的 plane 不得进入 candidates。
- fallback 只能发生在**同一 explicit purpose + authority policy** 允许的候选集合内。
- health evidence 只能描述链路/failure-domain 观测，不得仅由连接失败推断 node down，也不得生成 authority。
- candidate summary 不包含 raw secret；runtime locator 默认也不成为 durable output。
- `recommended` 只是输出槽位；本 freeze **不定义**评分、优先级、探测周期、自动切换算法或 provider-specific ranking。

## 7. 与 #35 mint-authority 研究的边界

- enrollment credential ≠ transport locator：raw credential 只存在于受保护的 secret/transient custody；registry 至多保存 metadata/ref/generation/expiry/digest，不参与 transport selection。
- caller authentication ≠ authority：OAuth/Access/OpenSSH credential 用于证明 caller；scope/ACL/policy 决定允许做什么。
- provider credential ≠ target identity proof：Tailscale OAuth/auth key 是 enrollment/mint 材料；pinned host identity、exact provider binding/tag correlation 等才属于 target proof。
- credential currentness ≠ adaptive routing signal：credential 过期/撤销属于 authority/custody currentness；observed provider tag drift 属 target/binding currentness。二者都不能仅作为“链路质量”分数使用。
- #35 已关闭；这些内容只是 cross-cutting boundary，不重开 mint implementation，也不接管 Fleet #331。

## 8. Contract freeze 范围

建议冻结以下**语义契约与安全不变量**：

1. Node Identity / Provider / Network Plane / Locator / Endpoint 分层；
2. Caller Authentication / Authority / Target Identity Proof 分层；
3. explicit Purpose 先于 routing selection；
4. effect-state fence 位于 routing 之上，只有 proven `NOT_DISPATCHED` 才能自动考虑换链；
5. durable policy expectation 与 runtime observation 分离，尤其 required tags vs observed tags；
6. raw credential/secret 不进入 provider-neutral transport registry/contract；
7. provider adapter 只负责 provider-specific resolution/observation/proof materialization，不决定跨-purpose authority；
8. provider-neutral resolver 输出 candidate summary/ref，不泄露 runtime locator 作为 durable truth；
9. fallback 只发生在同一 purpose + authority policy 允许的候选集合内；
10. compatibility 必须 adapter-first、fail-closed，不允许用缺省值把 UNKNOWN 变成 NOT_DISPATCHED。

继续 HOLD：

- `TransportIdentity` 等最终类型名；
- purpose / plane / endpoint / failure-domain 的最终枚举和值域；
- `ts:// / cf:// / ssh://` 是否成为正式 URI scheme；
- dedicated listener/port 布局；
- adaptive routing 的评分、优先级、探测周期、provider ranking 与切换算法；
- provider-specific Cloudflare/Tailscale/OpenSSH 实现细节；
- 何时删除现有 `transport_mode` / `TransportMode` 兼容字段。

## 9. Phase 3 交付清单

- [x] 最小对象关系图与边界
- [x] Python/TS 逐字段映射
- [x] durable config / durable operation evidence / runtime observation / secret custody 分层
- [x] provider adapter boundary
- [x] fail-closed compatibility plan
- [x] adaptive routing I/O contract 草案
- [x] cross-cutting mint-authority 边界
- [ ] Architect exact-head review + contract freeze merge
