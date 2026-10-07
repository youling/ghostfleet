# Adaptive Routing — State Machine 研究（#41 Phase 5-3）

- Issue: https://github.com/youling/ghostfleet/issues/41
- 前置：Phase 5-2 ACCEPTED（a47f4ad），#36 Contract FROZEN。
- 日期：2026-10-07
- 状态：研究草稿，不实现自动切换与生产路由变更。

## 1. 状态定义

```
HEALTHY      — 至少一个 eligible candidate 且最新 health 均为 healthy
DEGRADED     — 部分 candidate unhealthy，但仍有 eligible 剩余
FAILED       — 全部 eligible 为空（health 不可用 / tag 不满足 / authority 失效）
RECOVERING   — 曾 FAILED，现观测到 healthy 恢复但未过防震荡窗口
RECONCILED   — dispatch_state != NOT_DISPATCHED，需先 reconcile，禁止切链
```

## 2. 转换条件（基于 Evidence 层，不压成 score）

```
HEALTHY --(任一 candidate 变 unhealthy)--> DEGRADED
DEGRADED --(全部 eligible 为空)--> FAILED
FAILED --(观测到 healthy 候选)--> RECOVERING
RECOVERING --(稳定窗口内保持 healthy)--> HEALTHY
RECOVERING --(再次 unhealthy)--> FAILED
* --(dispatch_state==UNKNOWN/MAY_HAVE_EXECUTED)--> RECONCILED
RECONCILED --(reconcile 完成且 dispatch_state==NOT_DISPATCHED)--> HEALTHY/DEGRADED/FAILED 按新观测
```

## 3. 防震荡（flapping）

- 进入 RECOVERING 需满足 N 次连续 healthy（如 3 次）或稳定窗口（如 60s）才晋升 HEALTHY
- 退出 HEALTHY 到 DEGRADED 需阈值（如连续 2 次 unhealthy）
- 任何 UNKNOWN 期间不计入 healthy 计数

## 4. 切换许可表

```
HEALTHY/DEGRADED: 允许在 eligible 内按 Explainable Ranking 产生 recommendation（仍需 Human Gate，本阶段不自动切）
RECOVERING:       仅允许影子推荐（shadow），不自动切
FAILED/RECONCILED: 不允许推荐，仅产出 reason_code + evidence_refs，需人工或 reconcile 后再议
```

## 5. 状态回放用例（影子，不切链）

### 用例 F — 震荡抑制

- 序列：HEALTHY → T1 unhealthy → DEGRADED → T2 healthy → RECOVERING（计数1）→ T3 unhealthy → FAILED → T4 healthy → RECOVERING（重置）→ T5 healthy → T6 healthy（达 3 次）→ HEALTHY
- 约束：RECOVERING 期间虽有 healthy 但不自动推荐，仅影子记录

### 用例 G — UNKNOWN→RECONCILED

- 序列：HEALTHY, dispatch_state=NOT_DISPATCHED → 进程崩溃后 dispatch_state=UNKNOWN → RECONCILED（eligible 强制空，reason=reconcile_required）→ reconcile 完成且 NOT_DISPATCHED → 按新 health 重算 HEALTHY/DEGRADED
- 约束：UNKNOWN 期间所有 healthy 观测不计入晋升计数

## 6. 与 #36 fencing 对齐

- RECONCILED 完全复用 #36 的 dispatch/effect fencing（仅 NOT_DISPATCHED 允许考虑）
- 本机不新增 provider 细节，保持可审计 evidence_ref

## 7. 人类门禁

本阶段不启用自动切换/生产替换/真实节点变更，已达门禁条件，请求 Architect 对 Phase 5-3 review。
