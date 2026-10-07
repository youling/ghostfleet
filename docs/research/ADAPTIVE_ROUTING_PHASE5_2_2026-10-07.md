# Adaptive Routing — Phase 5-2 Evidence Lifecycle & Explainable Ranking（#41）

- Issue: https://github.com/youling/ghostfleet/issues/41
- 前置：Phase 5-1 Decision Contract ACCEPTED（fc8b0c1），#36 Contract FROZEN。
- 日期：2026-10-07
- 状态：研究草稿，不实现评分与自动切换，不改真实节点。

## 1. Evidence 生命周期

```
产生（provider/dispatch 观测） → 验证（格式/签名/时效） → 存储（evidence_ref） → 过期（TTL/冲突出失效） → 冲突处理（新证据覆盖旧证据不产生 authority）
```

规则：
- 任何 evidence 过期或冲突，不自动提升为 authority 或 health score
- 多源冲突时保留最新观测，但 Decision 层仍以最保守 reason_code 为准（如 UNKNOWN 优先 reconcile）
- evidence_ref 仅引用，不嵌入 raw 观测本体

## 2. Candidate ↔ evidence_refs 关联模型

```
CandidateSummary { candidate_ref, plane, endpoint_kind, ... }
  ↔ evidence_refs: string[]
```

Eligible 计算：
- AuthorityValidity.valid
- EffectState.dispatch_state==NOT_DISPATCHED
- required_tags⊆runtime_tags
- TransportHealth.healthy（若有）

不满足则从 eligible 剔除并标注 reason_code。

## 3. Explainable Ranking 规则空间（不落地算法）

仅在 eligible 集合内排序：

```
Policy Filter → Candidate Set → Explainable Ranking → Human Gate
```

禁止：单一综合 score、跨 purpose fallback、基于连接失败推断 target down。

## 4. 冲突回放用例

覆盖：
- health 新旧观测冲突；
- tag 漂移与 authority 过期叠加。

均为影子决策，不执行链路。

## 5. 与 provider-neutral contract 对齐

candidate 均来自 #36 gate 的 CandidateSummary，仅本层按 Evidence 过滤，不新增 provider 细节。

## 6. 人类门禁

本阶段不启用自动评分/切换/生产替换/真实节点变更，请求 Architect review。
