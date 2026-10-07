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
  ↔ evidence_refs: string[]  // 指向本决策消费的 5 层观测子集

Eligible 计算：
  for each candidate:
    require AuthorityValidity.valid && EffectState.dispatch_state==NOT_DISPATCHED
    && required_tags⊆runtime_tags (来自 Target Identity/Tag 观测)
    && TransportHealth.healthy (若有)
  不满足则从 eligible 剔除并标注对应 reason_code
```

关联保持可审计：每个 eligible 决策可回溯到具体 evidence_ref。

## 3. Explainable Ranking 规则空间（不落地算法）

仅在 eligible 集合内，按可解释规则排序，示例规则（研究用，不冻结）：

```
IF purpose==machine-control:
  prefer cloudflare-vpc over tailnet when both healthy
  else remaining healthy candidate
IF purpose==human-maintenance:
  only tailnet
IF purpose==recovery:
  only native-lan

Tie-break: 更近期 health_evidence 优先；仍平局则保持原 candidate 顺序，不引入随机/分数
Human gate: 任何 recommendation 需携带 evidence_refs 供人工复核
```

禁止：单一综合 score、跨 purpose fallback、基于连接失败推断 target down。

## 4. 下一步（至人类门禁）

- 给出 2 个带 evidence 生命周期冲突的回放用例
- 与 provider-neutral contract 的 candidate summary 对齐校验
- 完成后请求 Architect 对 Phase 5-2 门禁 review
