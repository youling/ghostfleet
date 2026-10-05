# AGENTS.md — GhostFleet 最低项目规则

任何进入 `youling/ghostfleet` 的 Agent 必须先遵守 current `youling/ai-use`，再应用本文件。

1. **本仓是通用远控产品的 canonical implementation owner。** Core/API/MCP/Console、Enrollment/NodeIdentity/Capability/HumanGate/Evidence/Event、consumer acceptance、typed-control/jobs/sessions/reconcile、通用 Linux/Windows/Android runtime 与可选客户端适配的后续开发进入本仓。
2. `youling/fleet` 是礼宏的 PRIVATE deployment / instance owner，不是本仓的第二实现：真实 inventory、provider/account locator、credential/secret、private policy、生产 deployment、host-specific recovery、真实设备 evidence 只留 Fleet/相应私有 owner。
3. 从私有 Fleet 发现问题时先分类：
   - reusable product bug / generic protocol / generic UX / generic adapter -> GhostFleet 修复；
   - private binding / deployment / account / device-specific state -> Fleet 修复；
   - mixed -> GhostFleet 先完成 generic seam，Fleet 再做 thin deployment integration。
4. 禁止把真实节点名/IP/endpoint/account ID、secret value、private key/token、私有策略、原始日志/拓扑复制到公开仓。公开证据必须 synthetic 或经过脱敏/边界审查。
5. `ACTIVE` / core admission != independent consumer cutover。消费者必须独立完成 durable custody、auth/config/call route、positive+negative authority、executor-independence 与 node-scoped rollback acceptance。
6. Capability != Authority；tool description != security boundary；generic implementation merge != production deployment authority。
7. 不直接写受保护的 `main`。用 branch + PR；语义/安全边界变化绑定 exact-head Review。历史 Fleet 代码只能作为 migration/provenance 输入，不得无审查整包搬入。
8. 主流程保持 AI-client-neutral。ChatGPT/OpenAI/Tailscale/Cloudflare 可以是可选/reference integration，但不得成为 core 必需依赖或把某个私有部署事实硬编码进协议。
9. 新 generic feature 默认必须有 deterministic tests、fail-closed UNKNOWN/reconcile 行为、秘密泄漏检查和中英文公共文档；真机/生产证明另行记录，不能由 synthetic PASS 冒充。
10. 当本仓与 Fleet 的 ownership 文本冲突时，以 Human 2026-10-05 ruling + Fleet ADR-009 + current GhostFleet public boundary 为准，随后修正文档漂移，不建立双 SSOT。
