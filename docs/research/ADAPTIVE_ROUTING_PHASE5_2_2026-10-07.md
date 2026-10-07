# Adaptive Routing — Phase 5-2 Evidence Lifecycle & Explainable Ranking（#41）

- Issue: https://github.com/youling/ghostfleet/issues/41
- 前置：Phase 5-1 Decision Contract ACCEPTED（fc8b0c1），#36 Contract FROZEN。
- 日期：2026-10-07
- 状态：研究草稿，不实现评分与自动切换，不改真实节点。

## 1. Evidence 生命周期

```
产生 → 验证 → 存储(evidence_ref) → 过期 → 冲突处理
```

规则：Evidence 过期或冲突不会自动产生 authority 或 health score；多源冲突采用最保守 reason_code；evidence_ref 仅引用，不嵌入 raw 观测。

## 2. Candidate ↔ evidence_refs

CandidateSummary 通过 evidence_refs 关联决策消费的 Evidence 子集。Eligible 计算要求 authority/effect/tag/health 约束满足，不满足则移除并记录 reason_code。

## 3. Explainable Ranking

仅在 eligible 集合内排序：

Policy Filter → Candidate Set → Explainable Ranking → Human Gate

禁止综合 score、跨 purpose fallback、从连接失败推断节点失效。

## 4. 冲突回放

覆盖：
- health 新旧观测冲突；
- tag 漂移与 authority 过期叠加。

均为影子决策，不执行链路。

## 5. 人类门禁

不启用自动评分/切换/生产替换/真实节点变更。请求 Architect review。
