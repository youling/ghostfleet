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

## 4. 离线回放素材（下一步细化）

- 超时 / 链路失败 → 应保持 eligible 为空或 reason=health_unavailable，不跨权限面切
- 节点重启 / UNKNOWN 恢复 → 必须 reconcile_required，不自动重试
- provider tag 漂移 → tag_policy_unsatisfied
- credential 过期 → authority_mismatch
- Tunnel/TAILNET 异常 → failure_domain 标注，不推出 node down

将基于已有 receipt / dispatch_state / failure domain / provider observation 做影子决策回放。

## 5. 下一步

- 细化 health_evidence schema 与 evidence_ref 引用方式
- 给出 3 个回放用例的输入/输出示例
- 与 #36 契约的 candidate summary 对齐，不引入 provider 细节
