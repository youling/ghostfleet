# Transport Namespace & Adaptive Link Layer — Phase 3 契约研究（provider-neutral contract 候选）

- Issue: https://github.com/youling/ghostfleet/issues/36
- 前置：Phase 1（fleet `issue33-transport-namespace`）、Phase 2（ghostfleet `feat/issue33-transport-namespace`），Architect 已冻结 10 个最小事实维度，名词/枚举/scheme/算法继续 HOLD。
- 日期：2026-10-07
- 状态：候选，不冻结，不写生产代码，不实现 adaptive router。

## 1. 最小对象关系图

```
NodeIdentity (node_uid, registry-bound)
  └── owns N × PlaneBinding { plane, provider, provider_ref, tags }
        └── each PlaneBinding resolves via
              Locator { kind: binding_name | provider_ref | magicdns | explicit_ip }   (runtime only)
              Endpoint { kind: tailscale_ssh | native_sshd | cloudflared_forwarded_sshd, port? }
              TargetProof { method: pinned_host_key | provider_binding_tag | jiti_host_key }
Caller { auth: oauth | tailscale_acl | openssh_pubkey, actor_ref }
Authority { scope: machine-control | human-maintenance | recovery, policy_revision }
Purpose → allowed Planes (per policy)
DispatchState { NOT_DISPATCHED | MAY_HAVE_EXECUTED | UNKNOWN }   (fence above routing)
FailureDomain { worker_vpc | tailnet | lan | provider }          (health evidence only)
```

核心约束：`Locator` 永不单独成为 authority；`TargetProof` 独立于 `Caller`；`Purpose` 在选链之前。

## 2. 现有实现逐字段映射

### Python `TransportResolutionRequest/Candidate/Resolver`

| 冻结维度 | 现有字段 | 备注 |
| --- | --- | --- |
| Node Identity | `request.node_uid` | 已符合 |
| Provider/Plane | `TransportCandidate.provider`（"tailscale"） | 单 provider，缺 cloudflare/native |
| Locator | `TransportCandidate.locator` / `locator_kind` / `name_hint` | runtime only，符合 |
| Endpoint | 隐式（Tailscale SSH 或 native OpenSSH，RUNBOOK 层） | 未进 schema，Phase 3 候选补齐 |
| Caller Auth | Fleet Control Worker OAuth（fleet 侧） | 未进 resolver request，符合 "authority 不在 transport 内" |
| Authority | `management_path`/`management_profile`/`provider_ref` 校验 + service tag | NORMAL vs LEGACY_CANARY 双平面 |
| TargetProof | `PinnedIdentityVerifier` + `tag:fleet-ssh-target` + JIT ssh_known_hosts | 已有抽象 |
| Purpose | 隐式（全部视为 machine-control） | 缺字段，候选补齐 |
| DispatchState | `SshDispatchState` 在 sshClient 层 | 候选：上抬到 resolver 输入 |
| FailureDomain | 无显式字段 | 候选补齐 |

### TS `ControlTarget / transport_mode`

| 冻结维度 | 现有字段 | 备注 |
| --- | --- | --- |
| Node Identity | `nodeUid` key | 符合 |
| Provider/Plane | `transport_mode: mesh_hostname/direct_tunnel/local_ssh` | enum 把 plane 压扁，Phase 3 候选需拆层 |
| Locator | `controlHostname(nodeUid)` / `127.0.0.1` / binding name | runtime only，符合 |
| Endpoint | 隐式（socket 目标） | 候选补齐 |
| Caller Auth | Worker OAuth + scope | 在 controlPolicy，不在 transport，符合 |
| Authority | `NODE_<uid>` binding + pinned host key | 缺 provider_ref/tag 维度（TS 侧无 Tailscale provider_ref 字段） |
| TargetProof | pinned host key（SHA256） | 符合 |
| Purpose | `ControlTarget` 未含 purpose | 候选补齐 |
| DispatchState | `SshExecutionError.dispatchState` | 已在 SSH client 内，候选上抬 |
| FailureDomain | `CONTROL_VPC_BINDING_MISSING` 等错误码 | 未归类 failure domain |

## 3. Durable config vs Runtime observation

| 字段 | 归属 |
| --- | --- |
| node_uid、PlaneBinding（provider/provider_ref/tags）、policy_revision、pinned host key 摘要、endpoint 声明 | durable config（registry/profile） |
| locator 解析结果、Tailscale peer 快照、health probe 结果、dispatch state 观测、failure domain 判定 | runtime observation（不进 durable） |
| receipt（operation_id/outcome/actor_ref/sanitized artifact_ref） | durable evidence（已有 sanitize 规则） |

## 4. Provider adapter boundary

| Provider | adapter 负责 | 禁止泄漏到公共 contract |
| --- | --- | --- |
| Cloudflare | VPC binding 解析、`cf1:network` connect、cloudflared service 事实 | Workers socket API、binding 名格式细节 |
| Tailscale | `tailscale status` peer 快照、provider_ref 精确匹配、tag 校验、JIT host key 管理 | Tailscale CLI 参数、DERP/直连探测细节 |
| native OpenSSH | pinned host key 校验、native sshd 可达性、recovery 路径声明 | sshd_config 细节、LAN 拓扑 |

公共 contract 只表达：`resolve(node_uid, purpose, caller, dispatch_state) → candidates[]`，返回 `(plane, endpoint, target_proof_method, locator_kind)` 的摘要，不返回 runtime locator 本体。

## 5. Compatibility plan（保持现有节点可运行）

1. 现有 `TransportMode.NORMAL` 语义不变：provider_ref + service tag + pinned verifier 仍是 authority 路径。
2. TS `ControlTarget.transport_mode` 保持旧 enum 可读，新字段（plane/purpose/endpoint/target_proof）以 optional 叠加；新老字段校验由 contract adapter 统一做。
3. `LEGACY_CANARY` 继续作为显式 opt-in 路径，不扩大范围。
4. 新增 `purpose` 时，缺省值 `machine-control` 与现有行为等价。
5. 新增 `dispatch_state` 入参时，缺省 `NOT_DISPATCHED`，与现有 sshClient 语义对齐。
6. 任何新字段缺失时解析器 fail closed，不做隐式 fallback。

## 6. Adaptive routing contract 草案（不实现算法）

```
input:  node_uid, purpose, caller_authority, dispatch_state, health_evidence?
output: {
  candidates: [ { plane, endpoint_kind, target_proof_method, locator_kind, failure_domain } ],
  recommended: candidate_ref?,
  reason: string                     // 为什么推荐/为什么空
}
```

约束（与 Architect 冻结项一致）：
- dispatch_state != NOT_DISPATCHED ⇒ candidates 必须为空且 reason=reconcile_required。
- purpose 之外的 plane 不得出现在 candidates。
- health_evidence 只能描述 failure domain，不得推断 node down。
- 不实现评分/优先级/探测周期/切换算法（HOLD）。

## 7. 与 #35 研究成果的边界（cross-cutting input，不接管）

- enrollment credential ≠ transport locator：credential 只入 registry，不参与 transport selection。
- caller authentication ≠ authority：OAuth/Access token 证明"谁"，scope/ACL 决定"能做什么"。
- provider credential ≠ target identity proof：Tailscale OAuth/auth key 是入网凭证，pinned host key/provider_ref+tag 才是目标身份证明。
- credential currentness ≠ adaptive routing signal：tag 被改、credential 过期是 registry/control 事实，不是链路健康信号。

## 8. Phase 3 交付清单

- [x] 最小对象关系图（§1）
- [x] Python/TS 逐字段映射（§2）
- [x] durable vs runtime 归属（§3）
- [x] provider adapter boundary（§4）
- [x] compatibility plan（§5）
- [x] adaptive routing 输入/输出 contract 草案（§6）
- [ ] Architect review → 决定是否 **contract freeze**
