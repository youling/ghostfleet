# Adaptive Routing — Decision Contract 预研（#41 Phase 5-1）

- Issue: https://github.com/youling/ghostfleet/issues/41
- 前置：#36 Phase 4（0163893）FROZEN/ACCEPTED，生产 router 未替换，HOLD。
- 日期：2026-10-07
- 状态：研究草稿，不实现评分算法与自动切换，不改真实节点。

## 1. Decision Contract 边界

只回答“在当前约束下，哪些候选可考虑”，不负责连接、provider 细节、评分。

```
Input {
  node_uid,
  purpose,
  authority_snapshot_ref,  // scope + policy_revision
  dispatch_state,          // NOT_DISPATCHED | MAY_HAVE_EXECUTED | UNKNOWN (durable)
  candidates: CandidateSummary[] // 来自 provider-neutral contract 的过滤集合
  health_evidence?: TransportHealthObservation[] // 仅观测，不产生 authority
}

Output {
  eligible: CandidateRef[]          // 经 Policy Filter 后仍合法的
  recommendation?: CandidateRef     // 可解释排序后的首选，可为空
  reason_code: "ok" | "reconcile_required" | "authority_mismatch" | "tag_policy_unsatisfied" | "no_candidate_for_purpose"
  confidence?: "high" | "low"       // 仅基于证据完整度，不作分数
  evidence_refs: string[]           // 引用的 health / failure domain / dispatch 证据
}
```

## 2. Evidence 五分层（不压成 score）

```
Transport Health        — 链路/plane 是否可观测（如 binding 可解析）
Target Reachability     — 目标是否可达（probe 结果，≠ health）
Target Identity Proof   — pinned host identity / provider binding 是否可验证
Authority Validity      — authority scope/purpose 是否一致、policy 是否过期
Effect State            — NOT_DISPATCHED 才允许考虑；否则一律 reconcile
```

任何一层失败，只影响 eligible 过滤与 reason_code，不跨层推断。

## 3. Ranking 预研（可解释优先）

```
Policy Filter (purpose → allowed planes, authority.scope==purpose, required_tags⊆runtime_tags)
  ↓
Candidate Set (provider-neutral gate 已过滤)
  ↓
Explainable Ranking (规则优先，如 machine-control 优先 cloudflare-vpc，其次 tailnet；人类可审计)
  ↓
Human/Policy Approval (本阶段不自动切换)
```

黑盒评分、自动切换、provider fallback 均 HOLD。

## 4. Health Evidence Schema（与 evidence_ref 引用）

`health_evidence` 仅观测，不产生 authority；每条带 `evidence_ref` 供 Output 引用。

```
TransportHealthObservation {
  plane, binding_ref, healthy: bool, failure_domain?, observed_at
}
TargetReachabilityObservation {
  candidate_ref, reachable: bool, probe_method, observed_at
}
TargetIdentityProofObservation {
  candidate_ref, method, verified: bool, digest_ref
}
AuthorityValidityObservation {
  scope, policy_revision, valid: bool, reason?
}
EffectStateObservation {
  dispatch_state, persisted: bool, evidence_ref
}
```

Output 的 `evidence_refs` 仅收敛已消费的观测，不新增推断。

## 5. 离线回放用例（影子决策，不执行链路）

用例均以 #36 的 `candidate summary` 为输入候选，验证不跨权限面、不误判 UNKNOWN。

### 用例 A — Tailscale 断连，machine-control 双候选

- Input: purpose=machine-control, dispatch_state=NOT_DISPATCHED, candidates=[cloudflare-vpc, tailnet], health=[tailnet unhealthy]
- Gate 已按 purpose 保留两者；Decision 层按 health 过滤后 eligible=[cloudflare-vpc]，recommendation=cloudflare-vpc，reason_code=ok，confidence=high
- 约束：不因 tailnet 失败自动切到 human-maintenance/recovery；不推出 target down

### 用例 B — 节点重启后 UNKNOWN 恢复

- Input: purpose=machine-control, dispatch_state=UNKNOWN（持久化缺失，保守重建）, candidates=[tailnet]
- 决策：eligible=[]，reason_code=reconcile_required，recommendation 为空，confidence=low，evidence_refs 指向 EffectStateObservation
- 约束：UNKNOWN≠NOT_DISPATCHED，禁止自动重试与换链，需先 reconcile

### 用例 C — provider tag 漂移

- Input: purpose=machine-control, dispatch_state=NOT_DISPATCHED, candidates=[tailnet with required_tags=[tag:fleet-ssh-target], runtime_tags=[]]
- 决策：eligible=[]，reason_code=tag_policy_unsatisfied，evidence_refs 指向 TargetIdentityProof/Tag 观测
- 约束：不因“连接失败”改推 node down；不回退到其他 purpose 的候选

## 6. 与 #36 契约对齐

- candidate 仍来自 provider-neutral gate 的 `candidate summary`（plane/endpoint_kind/locator_kind/required_target_proof/failure_domain），本层不引入 provider 细节
- 排序仅在 eligible 集合内可解释进行，本阶段不落地自动切换与评分算法

## 7. 人类门禁（Human Gate）

本阶段完成后请求 Architect review，门禁前不启用：

- 自动评分 / 自动切换
- 生产默认路由替换
- 真实节点/provider mutation
- 跨权限面 fallback
