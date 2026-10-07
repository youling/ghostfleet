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

## 5. 下一步至人类门禁

- 给出 2 个状态转换回放用例（震荡抑制与 UNKNOWN→RECONCILED）
- 与 #36 dispatch/effect fencing 对齐校验
