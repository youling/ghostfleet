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

## 4. 冲突回放用例（已补齐，影子决策不执行链路）

### 用例 D — health 观测冲突（新旧 healthy 覆盖）

- 背景：同一 tailnet candidate 先后产生两条 TransportHealthObservation
  - T1: healthy=true, observed_at=T0, evidence_ref=ev-health-tailnet-1
  - T2: healthy=false, observed_at=T0+30s, evidence_ref=ev-health-tailnet-2（覆盖 T1，不产生 authority）
- Input: purpose=machine-control, dispatch_state=NOT_DISPATCHED, candidates=[tailnet], health_evidence=[ev-2]
- 决策：eligible=[]（因最新 healthy=false），reason_code=health_unavailable，evidence_refs=[ev-health-tailnet-2]
- 约束：旧 healthy=true 已过期，不参与决策；不因“曾健康”误判可达

### 用例 E — tag 漂移与 authority 过期叠加

- 背景：candidate 的 required_tags=[tag:fleet-ssh-target]，runtime 观测先后
  - O1: runtime_tags=[tag:fleet-ssh-target], observed_at=T0
  - O2: runtime_tags=[], observed_at=T0+60s（漂移）
  - AuthorityValidity: valid=false（policy_revision 过期）
- Input: purpose=machine-control, dispatch_state=NOT_DISPATCHED, candidates=[tailnet], evidence=[O2, authority_invalid]
- 决策：eligible=[]，reason_code 先取 tag_policy_unsatisfied（tag 层）与 authority_mismatch 均记录于 evidence_refs，不推出 node down
- 约束：多层同时失败，Decision 层以最保守 reason_code 为准，evidence_refs 完整可审计

## 5. 与 provider-neutral contract 对齐校验

- candidate 均来自 #36 gate 的 CandidateSummary，仅本层按 Evidence 过滤，不新增 provider 细节
- ranking 仅在 eligible 内按规则可解释排序，未引入分数或自动切换

## 6. 人类门禁

本阶段不启用自动评分/切换/生产替换/真实节点变更，已达门禁条件，请求 Architect 对 Phase 5-2 review。
