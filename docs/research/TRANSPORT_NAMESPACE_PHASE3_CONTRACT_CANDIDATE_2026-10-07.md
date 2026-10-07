# Transport Namespace & Adaptive Link Layer — Phase 3 契约研究（provider-neutral contract 候选）

- Issue: https://github.com/youling/ghostfleet/issues/36
- 前置：Phase 1（fleet `issue33-transport-namespace`）、Phase 2（ghostfleet `feat/issue33-transport-namespace`），Architect 已冻结 10 个最小事实维度，名词/枚举/scheme/算法继续 HOLD。
- 日期：2026-10-07
- 状态：Architect-corrected contract-freeze candidate；本文件只冻结 provider-neutral 语义与安全不变量，不写生产代码，不实现 adaptive router。最终接受以 #36 Architect review / PR exact-head 为准。

## 1. 最小对象关系图

以下名称是说明性名称；**冻结的是关系和边界，不是最终 TypeScript/Python 类型名。**

```
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

约束（与 Architect 冻结项一致）：
- effect_state != NOT_DISPATCHED ⇒ 不得产生可执行推荐；`MAY_HAVE_EXECUTED/UNKNOWN` 必须返回 reconcile-required 语义。
- purpose/authority policy 不允许的 plane 不得出现在 candidates；fallback 只能在同一明确 purpose/authority 边界内。
- health_evidence 只能描述观测到的链路/failure-domain 事实，不得仅由连接失败推断 node down，也不得生成 authority。
- `recommended` 只是 contract 输出槽位；本 freeze **不定义**评分、优先级、探测周期、自动切换算法或 provider-specific ranking（继续 HOLD）。

## 7. 与 #35 研究成果的边界（cross-cutting input，不接管）

- enrollment credential ≠ transport locator：raw credential 只存在于受保护的 secret/transient custody；registry 至多保存 metadata/ref/generation/expiry/digest，不参与 transport selection。
- caller authentication ≠ authority：OAuth/Access token 证明"谁"，scope/ACL 决定"能做什么"。
- provider credential ≠ target identity proof：Tailscale OAuth/auth key 是入网凭证，pinned host key/provider_ref+tag 才是目标身份证明。
- credential currentness ≠ adaptive routing signal：tag 被改、credential 过期是 registry/control 事实，不是链路健康信号。

## 8. Contract freeze 范围

本 Phase 3 建议冻结以下**语义契约与安全不变量**：

1. Node Identity / Provider / Network Plane / Locator / Endpoint 分层；
2. Caller Authentication / Authority / Target Identity Proof 分层；
3. explicit Purpose 先于 routing selection；
4. effect-state fence 位于 routing 之上，只有 proven `NOT_DISPATCHED` 才能自动考虑换链；
5. durable policy expectation 与 runtime observation 分离（尤其 required tags vs observed tags）；
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
- [x] adaptive routing 输入/输出 contract 草案
- [x] cross-cutting mint-authority 边界：credential != locator / authority / target proof
- [ ] Architect exact-head review + contract freeze merge
