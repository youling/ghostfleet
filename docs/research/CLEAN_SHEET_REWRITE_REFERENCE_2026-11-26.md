---
doc_type: clean-sheet-rewrite-reference-pack
status: CANDIDATE_REFERENCE / SOURCE_ONLY
target_release: 0.3.0-proposed
as_of: 2026-11-26
production_effect: NONE
---

# GhostFleet 下一代完整重构参考包：从零设计，不从零学习

## 0. 人类目标与施工边界

Human 已明确允许下一代以现有源码、真实行为、测试、事故和成熟组件为参考，做完整重构，而非继续在旧候选上打补丁。**旧实现不是约束；产品目标、人类主权、信任边界、身份/数据连续性与实际可用能力是约束。** 不要求复制旧目录、语言、框架、状态机、数据库或错误字符串，也不要求零代码复用。选择使总维护成本最低的架构。现行目标：薄编排、复用 TS/CF/SSH/系统和 K3s 原生能力、非对称不可信架构、自动纳管、产品/节点版本可追溯、批准渠道的周期 pull 更新、独立救援与回退。v0.3.0、APT-first、每日检查均为候选设计，可用证据挑战。

由 Human 新开高推理 Fresh Context，承担下一代专项架构设计和源码实现；当前项目架构师继续旧线治理、对新实现独立审阅，不形成双重全项目 primary。现有工头及其 P0/#135/#64 活跃工作不被夺取；新实现使用独立分支、隔离工作树和 Draft PR。可连续推进已授权的设计、源码、合成验证；真实节点、Provider、生产权限、签名密钥、部署、merge、销毁与切换需独立现行授权。新的专项 scope 不得直接接管现役控制面。

## 1. 阅读优先级与当前性

| 优先级 | 入口 | 阅读目的 |
| --- | --- | --- |
| P0 | [ai-use L0](https://github.com/youling/ai-use/blob/main/AGENTS.md)、[BOOT](https://github.com/youling/ai-use/blob/main/10_BOOT/BOOTSTRAP_CHECK_PROTOCOL.md)、[ARCH-0](https://github.com/youling/ai-use/blob/main/docs/ARCHITECT_RECONNAISSANCE.md)、[Agent Interface](https://github.com/youling/ai-use/blob/main/docs/AGENT_INTERFACE.md)、[Recovery](https://github.com/youling/ai-use/blob/main/30_PROTOCOLS/RECOVERY_HANDOFF.md) | 先 live L0 再定向读取，按 Fresh Context 启动。参考快照 ai-use main 5a22a42913068bfdb1d1ceaaeb857c47595373bc / L0 3.1.0，不冻结治理。 |
| P0 | [#140 架构候选原文](https://github.com/youling/ghostfleet/blob/5a71e62b2be2bae8f8b32d5c499c1126cf944ed2/docs/research/VERSIONED_COMPOSABLE_FLEET_2026-11-26.md) | 本轮需求、版本、更新、信任与阶段方向。 |
| P0 | [#11 产品](https://github.com/youling/ghostfleet/issues/11)、[#3 架构](https://github.com/youling/ghostfleet/issues/3)、[#64 隔离](https://github.com/youling/ghostfleet/issues/64)、[#36 传输](https://github.com/youling/ghostfleet/issues/36) | 只先读 current top/latest ruling，历史段落不得自动成为现行要求。 |
| P1 | [main 完整代码](https://github.com/youling/ghostfleet/tree/d24138597fea41c74400f741ddd9634b40d8a7e8)、[#135 综合候选](https://github.com/youling/ghostfleet/tree/99d3d72655e405da60038c3514e50057c6f7c4e5)、[exact review](https://github.com/youling/ghostfleet/pull/135#issuecomment-7129365134) | 旧行为、失败和测试来源，不把候选当已接受。 |
| P1 | [企业 prior art](https://github.com/youling/ghostfleet/issues/11#issuecomment-7192430009)、[可选 K3s 接缝](https://github.com/youling/ghostfleet/issues/11#issuecomment-7192302399) | 已做广泛企业研究，按具体问题补查，不重做无界研究。 |
| P1 私有可读时 | [ai-hub #445](https://github.com/youling/ai-hub/pull/445)、[#446](https://github.com/youling/ai-hub/pull/446)、[领域会签](https://github.com/youling/ai-hub/pull/446#pullrequestreview-6074269489) | 非对称信任、独立控制者、统一交付、平台职责；均为候选而非现役权限。 |
| P2 | §2–6 原始索引 | 针对具体模块和反例读 exact source；摘要不替代原始证据。 |

2026-11-26 实际重新读取 GitHub 与现役目录的快照（新上下文须核对漂移）：

| 对象 | 固定提交/状态 | 证据边界 |
| --- | --- | --- |
| GhostFleet main | d24138597fea41c74400f741ddd9634b40d8a7e8 | 68 个 tracked blob，递归 tree 未截断；已进入主干，不等于全部已部署。 |
| #135 | 99d3d72655e405da60038c3514e50057c6f7c4e5 | 77 个 tracked blob、35 个变更文件；#128–139 已收敛，Draft/HOLD。 |
| #140 原始设计 | 5a71e62b2be2bae8f8b32d5c499c1126cf944ed2 | 本文件追加前 HEAD；非正式版本，不是运行实现。 |
| 私有 #445 / #446 | 6cbfbbcaf59916701d52453e346725e9473f3c53 / eaafc514bf2ff6210461ef539dfa0cd8c1da1a99 | Draft，跨仓方向收敛。 |
| 私有 #450 | fd70c639513b185987d573ebf9e51986b5afde87 | F1/F3 限定源码复核接受，发布仍 HOLD。 |
| 私有 #433 | 1dc105c18deebcda8cb41e2e0cd5d4aa8115b377 | Draft，动态 admission consumer，真实 producer/绑定未完成。 |

#135 exact CI [push](https://github.com/youling/ghostfleet/actions/runs/45370555548) 和 [PR](https://github.com/youling/ghostfleet/actions/runs/45370570560) 此前已读成功日志：Node 126、Python 29+25+11、POSIX 33、Workerd/DO 10 行为断言与 publication guard。不能外推为实机纳管。#450 本地测试系工头报告，私有 Hosted CI 未建立成功证据。现役 DCR 此次读回 5 个登记节点、3 个有普通 Job，单台下位机 P0 仍未获 Job；runtime/source/policy 不同且候选与实际发布线分叉。实际实例资料由私有 owner 持有，公开不得写地址、节点真实标识、账户、指纹或原始日志。

## 2. 源码地图：继承行为，不继承结构

以下路径来自完整 main/#135 tree。逐模块 KEEP / REUSE_ARTIFACT / ADAPT / REIMPLEMENT / RETIRE / UNKNOWN；重写可转换旧测试为行为测试，不要求保留旧测试框架。

| 模块 | 原始参考 | 应理解的行为 |
| --- | --- | --- |
| 产品及验收 | [PRODUCT](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/PRODUCT.md)、[ARCHITECTURE](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/ARCHITECTURE.md)、[DELIVERY](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/DELIVERY.md)、[ACCEPTANCE](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/ACCEPTANCE.md)、[MIGRATION](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/docs/MIGRATION.md) | 已有能力、迁移与未验收事项；当前 Human 方向优先。 |
| Panel/数据 | [ADR004](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/docs/adr/004-lightweight-enrollment-presence.md)、[presence.js](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/src/control-plane/presence.js)、[http.js](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/src/control-plane/http.js)、[tests](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/presence.test.mjs) | node_uid、同 UID 恢复、票据原子消费/重发/撤销、状态；持久数据是迁移输入。 |
| CF/认证 | [worker](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/src/adapters/cloudflare/worker.js)、[index](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/src/adapters/cloudflare/index.js)、[auth](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/src/adapters/cloudflare/auth.js)、[wrangler](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/wrangler.jsonc)、[Access tests](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/panel-access.test.mjs) | Panel/Node origin、issuer/audience、Operator/Read、same-origin、DO 数据；可重选框架，但不新增公开管理接口或绕过权限。 |
| 纳管 | [ADR007](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/adr/007-fully-managed-lower-node-enrollment.md)、[enroll-managed.py](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/scripts/enroll-managed.py)、[managed-bootstrap-host.py](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/scripts/managed-bootstrap-host.py)、[PRESENCE](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/PRESENCE.md)、[client tests](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/test_managed_enrollment.py)、[host tests](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/test_managed_bootstrap_host.py) | 可信客户端、域名+短码、同 UID claim、固定摘要、一次受权 root ceremony；当前仅 Host/reporter 等阶段，不冒称私有完整纳管。 |
| Reporter | [heartbeat.py](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/scripts/heartbeat.py)、[tests](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/test_heartbeat.py)、[live-presence](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/live-presence.py) | heartbeat/v1 严格 4KiB，oneshot/timer、DynamicUser/LoadCredential、system/user manager 区别、install manifest/repair/remove；仅补原生观测真实缺口。 |
| SSH/TS/CF | [REMOTE_ACCESS](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/REMOTE_ACCESS.md)、[SSH example](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/config/ssh/ghostfleet.conf.example)、[sshd](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/config/sshd/00-ghostfleet-admin.conf.example)、[verify](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/scripts/verify-sshd-admin.sh)、[TS](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/config/tailscale/README.md)、[CF](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/config/cloudflared/README.md) | 原生 SSH 账户、目标认证、LAN/TS/CF 可替代救援；最小充分组件。 |
| 观测/隔离 | [ADR006](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/docs/adr/006-node-connectivity-evidence.md)、[provider-shadow](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/src/control-plane/provider-shadow.js)、[endpoint-evidence](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/src/control-plane/endpoint-evidence.js)、[A09 migration](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/config/tailscale/A09_CONTROLLED_MIGRATION.md)、[shadow tests](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/test/provider-shadow.test.mjs) | 身份与 locator 解耦、证据来源/时间/冲突、观察不是授权；离线投影已实现，真实 shadow 和 A09 仍待验收。 |
| 发布/安装 | [ADR005](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/docs/adr/005-pinned-posix-join-bootstrap.md)、[join.sh](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/scripts/join.sh)、[build-presence](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/scripts/build-presence.mjs)、[build-managed](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/scripts/build-managed-host-bootstrap.mjs)、[check release](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/scripts/check-presence-release.mjs)、[build tests](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/build-presence.test.mjs) | 固定源码/字节/摘要，可信 HTTPS、覆盖与回退；现有版本/自动 pull 未完成。 |
| OMV/appliance | [phase0](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/scripts/omv8_phase0_readonly.py)、[tests](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/test/test_omv8_phase0.py) | 只读前检，不能因 Debian 同源就盲装、碰存储或替换共享运行时。 |
| UI | [console](https://github.com/youling/ghostfleet/tree/99d3d72655e405da60038c3514e50057c6f7c4e5/console)、[app](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/console/app.js)、[index](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/console/index.html)、[UI tests](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/test/panel-access-ui.test.mjs) | 统一入口，状态/首用/角色；新版需呈现安装、运行、期望、组件版本及更新证据。可重新设计 UI。 |
| 公开边界与 CI | [AGENTS](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/AGENTS.md)、[publication policy](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/publication-policy.json)、[guard](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/scripts/publication-guard.mjs)、[guard tests](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/test/publication-guard.test.mjs)、[CI](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/.github/workflows/ci.yml)、[LICENSE](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/LICENSE) | 公共只用合成材料，AGPL-3.0-only；上游许可/NOTICE、安全与依赖核验，CI 真执行。 |

## 3. 经验教训：以反例测试消除历史包袱

| 已知问题/历史教训 | 原始来源 | 下一代验收 |
| --- | --- | --- |
| 自建远控、强制逐命令审批已放弃 | [#63 SUPERSEDED](https://github.com/youling/ghostfleet/issues/63)、[#69 旧线清理](https://github.com/youling/ghostfleet/issues/69)、[ADR004](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/docs/adr/004-lightweight-enrollment-presence.md) | 不恢复公共 SSH server、命令队列、常驻执行 agent、强制 JIT/逐命令审批或独立命令账本；合法私有授权/现役消费者不能被误删。 |
| 角色、可达、本机 root 不证明实际控制身份；实际 allow-all | [#64 当前](https://github.com/youling/ghostfleet/issues/64#issuecomment-7127536913)、[A09 缺口](https://github.com/youling/ghostfleet/issues/64#issuecomment-7053383692)、[#139](https://github.com/youling/ghostfleet/pull/139) | 可信端 default-deny；独立 Controller principal/target scope；公网 root 失陷无法反向/横向管理、签发、改发布；真实可信侧拒绝证据，非本地自证。 |
| 可信客户端交付循环依赖；匿名配对共享容量耗尽 | [#135 review](https://github.com/youling/ghostfleet/pull/135#issuecomment-7129365134)、[repair](https://github.com/youling/ghostfleet/issues/11#issuecomment-7129418939) | 干净机可验证地获取可信 client/预置信任根；有限来源防滥用、合法并发、失效/重放/错误秘密拒绝；隔离合成负控。 |
| ONLINE ≠ SSH READY ≠ JOB ADMITTED；CF Edge healthy 不等于 origin 正常；user unit 被 system manager 漏看 | [ADR006](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/docs/adr/006-node-connectivity-evidence.md)、[PRESENCE](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/PRESENCE.md) | 观测来源/时效/范围/可信度，UNKNOWN/STALE/CONFLICT；断网、错身份、API 不可用、K8s 非成员、伪造自报；独立救援。 |
| repair 不能升级；重发票据可能让原上报中断 | [PRESENCE](https://github.com/youling/ghostfleet/blob/99d3d72655e405da60038c3514e50057c6f7c4e5/docs/PRESENCE.md)、[#140 原文](https://github.com/youling/ghostfleet/blob/5a71e62b2be2bae8f8b32d5c499c1126cf944ed2/docs/research/VERSIONED_COMPOSABLE_FLEET_2026-11-26.md) | 正常升级保留 node_uid、凭据/配置/原生连接，不重新纳管；相同摘要 no-op，故障恢复。 |
| dirty worktree 策略被标成已审 HEAD；缺失目标曾被硬编码 pin 合成 | [#450 初审](https://github.com/youling/ai-hub/pull/450#pullrequestreview-6045302155)、[返修复核](https://github.com/youling/ai-hub/pull/450#pullrequestreview-6074268851) | exact input/manifest digest、dirty valid input 不改变已审发布；缺失/撤销/错 UID/pin 不产生权限；不再逐节点修改源码。 |
| 现役 Worker 与候选发布线分叉，旧版本重部署可能覆盖实际功能 | [#450 复核](https://github.com/youling/ai-hub/pull/450#pullrequestreview-6074268851)、[私有发布接续](https://github.com/youling/ai-hub/issues/300#issuecomment-7141154855) | source/runtime/policy/target/consumer 各自读回、同制品晋升、兼容矩阵、独立回退；main 不等于 live。 |
| 宿主本地执行成功错标为真实 ChatGPT 已可用 | [#11 P0 裁决](https://github.com/youling/ghostfleet/issues/11#issuecomment-7141161009)、[私有工头终态](https://github.com/youling/ai-hub/issues/300#issuecomment-7192154340) | SOURCE / HOST / CONSUMER / PRODUCTION 证据分层；普通实际身份、工作目录、持久执行/结果/取消、撤销；不得用 root helper 本地拒绝替代外部隔离。 |
| 公开回执误带真实实例信息 | [#11 纠偏](https://github.com/youling/ghostfleet/issues/11#issuecomment-7141161009)、[publication guard](https://github.com/youling/ghostfleet/blob/d24138597fea41c74400f741ddd9634b40d8a7e8/scripts/publication-guard.mjs) | 合成数据与真实私有原件分开，扫描源码/日志/制品；禁止复制历史公开回执中的实际值。 |

额外必测：K8s Node Ready/标签不能授 Fleet 控制权，K8s Job 非 exactly-once；默认 Agent token 与 Server token 相同的风险、独立凭据/CA pin、可信侧撤销、已签发身份处置、WAN/Quorum 失败时原生 SSH 救援；GitHub Latest 可变、签名与 channel promotion 分离；过期/回放/错误签名/平台错配/掉电/半安装/并发/回退。#64 原隔离证据不得被合成测试冲掉，不设与无关操作绑定的全局门禁。

## 4. 私有消费与企业设施（有合法访问才读）

公共仓负责通用纳管、原生远控、薄适配和证据；私有 ai-hub/实例 owner 持实际准入、节点、Provider/cluster/SSH、Work authority、凭据、发布/撤销。没有合法访问时用合成消费者与 mock，标私有接口未实测，继续独立源码，不要求用户贴秘密。

- [ai-hub AGENTS](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/AGENTS.md)、[Fleet Architecture](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/docs/fleet/ARCHITECTURE.md)、[ADR-0035](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/docs/adr/ADR-0035-merge-fleet-into-ai-hub.md)、[ADR-0034](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/docs/adr/ADR-0034-secret-custody-plane.md)、[ADR-0036](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/docs/adr/ADR-0036-jg-production-containerd-and-host-authority.md)：边界和已有实例契约。
- [#300](https://github.com/youling/ai-hub/issues/300)、[#428](https://github.com/youling/ai-hub/pull/428)、[#430](https://github.com/youling/ai-hub/pull/430)、[#433](https://github.com/youling/ai-hub/pull/433)：private dynamic admission、受信 decision/target/policy、目录与派发共用准入检查；候选不等于部署。
- [ROOTLESS_JOBS_V1](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/contracts/ROOTLESS_JOBS_V1.md)、[CONTROL_JOBS_DEPLOYMENT](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/docs/CONTROL_JOBS_DEPLOYMENT.md)、[DCR runbook](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/docs/runbooks/FLEET_CONTROL_DCR.md)、[operations](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/fleet/20_control_plane/cloudflare/worker/src/operations.ts)、[runtimeTarget](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/fleet/20_control_plane/cloudflare/worker/src/runtimeTarget.ts)、[policy generator](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/tools/generate_control_policy.py)：原生普通用户 Job/结果/取消、身份与发布；固定源码为参考，实际 runtime 以 live 为准。
- [#445](https://github.com/youling/ai-hub/pull/445)、[#446](https://github.com/youling/ai-hub/pull/446)、[Execution Lifecycle](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/contracts/execution/EXECUTION_LIFECYCLE.md)、[Runner](https://github.com/youling/ai-hub/blob/ded0441a2d39bb9159807414d0ddb6dd6dc43ca4/contracts/execution/RUNNER.md)、[OCI contract](https://github.com/youling/ai-use/blob/main/capabilities/oci/CONTRACT.md)、[#337](https://github.com/youling/ai-hub/issues/337)、[#339](https://github.com/youling/ai-hub/issues/339)：Work ownership/generation/fencing/UNKNOWN、固定 OCI 制品、私有/离线分发、现役 rootless；生产密钥不烘焙；K3s/Flux/ARC 各按实际收益，不强制。
- [#300 当前发布复核](https://github.com/youling/ai-hub/pull/450#pullrequestreview-6074268851)：现役发布漂移，避免把新旧线合并当作线上切换授权。实机、域名/IP、指纹、账户、策略、密钥及原始日志仍留私有。原生产力下位机 P0 不等待新架构完成。

## 5. 上游资料库：按具体问题补查

已有 [企业先验研究](https://github.com/youling/ghostfleet/issues/11#issuecomment-7192430009)：Rancher/SUSE Edge、Azure Arc、EKS Hybrid Nodes、Talos/Omni、CAPI、Metal3、Ansible、KubeEdge、Flux、Tailscale WIF、存储和发布。新上下文可得出不同路线；按 exact version/commit/license/资源与信任假设比较，不按星数/文档宣传选型。

| 问题 | 官方/上游入口 |
| --- | --- |
| 原生装机、配置、升级 | [K3s config](https://docs.k3s.io/installation/configuration)、[k3s-ansible](https://github.com/k3s-io/k3s-ansible)、[Ansible](https://docs.ansible.com/projects/ansible/latest/user_guide/playbooks_intro.html)、[K3s upgrade controller](https://docs.k3s.io/upgrades/automated) |
| 身份桥/不可信隔离 | [TS grants](https://tailscale.com/docs/features/access-control/grants)、[TS K8s API proxy](https://tailscale.com/docs/kubernetes-operator/api-server-access)、[TS WIF](https://tailscale.com/docs/kubernetes-operator/manage-and-configure/workload-identity-federation)、[K3s token](https://docs.k3s.io/cli/token)、[K8s Node authorizer](https://kubernetes.io/docs/reference/access-authn-authz/node/)、[multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/) |
| 版本、签名、Pull | [SemVer](https://semver.org/)、[GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)、[apt-secure](https://manpages.debian.org/trixie/apt/apt-secure.8.en.html)、[TUF](https://theupdateframework.io/docs/security/)、[systemd timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) |
| 原生观测、WAN/资源/HA | [K8s Node Status](https://kubernetes.io/docs/reference/node/node-status/)、[CF observability](https://developers.cloudflare.com/tunnel/observability/)、[K3s requirements](https://docs.k3s.io/installation/requirements)、[multicloud](https://docs.k3s.io/networking/distributed-multicloud)、[HA etcd](https://docs.k3s.io/datastore/ha-embedded)、[advanced](https://docs.k3s.io/advanced) |
| OCI、CI、GitOps | [K3s registry](https://docs.k3s.io/installation/private-registry)、[airgap](https://docs.k3s.io/installation/airgap)、[Flux multi-tenancy](https://fluxcd.io/flux/installation/configuration/multitenancy/)、[K8s Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)、[ARC](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets)、[Scale Set Client](https://github.com/actions/scaleset) |

## 6. 新架构不变量与可挑战决策

必须保留/证明：稳定机器身份与失陷替换重新准入；网络/OS/计算/发布/Work 身份正交；低信任节点即使 root 失陷也不能反向横向管理、访问控制者/备份或成为发布者；可信端默认拒绝；独立控制者与原生救援；一资源一 authoritative writer；按真实授权纳管、可选 K3s（原生非 K8s 节点仍可完整管理）；原生健康证据优先且区分来源；产品、目标、安装、运行、策略、协议与组件版本分开；签名固定制品/渠道、自动 pull、失败保留可用版本、正常更新不重领 UID；可逆迁移、旧数据/协议/现役能力保留。不要重建重复监控/任务/权限引擎。

可挑战：语言、框架、模块/目录、状态模型、协议、存储与 Worker/DO 实现细节（改变必须有兼容迁移和回退，不默认建立第二个生产控制面）、APT/TUF 选择、是否保留 reporter、版本号与检查周期、是否采用 Ansible/Flux/ARC、UI、原生组件组合。不得以代码量或“引入更多成熟产品”替代总维护成本。不要在旧 #135 为适配新架构叠补丁。清理历史架构是源码选择，不是生产资源删除权限。

## 7. 重构里程碑：完整源码研发而非设计后停住

沿原 #11 专项 scope；与现役 P0/#135/#64 及既有 M0 研究相互独立。先核 current ownership、已存在 claim；新实现另起隔离 nextgen/* 分支，不并写 #135/#140。阶段产物写回原 Work 与独立 Draft PR、精确提交与 CURRENT 恢复指针；既定 scope 内连续推进，不等 Human 再说继续，不擅改跨域合同/生产。若真实外部授权或材料不足，只阻断受影响部分。

| 里程碑 | 任务 | 有界验收 |
| --- | --- | --- |
| R0 世界模型 | 核 live HEAD/owner；消费两份代码树、产品裁决、私有接缝、历史反例；旧能力/测试证据清单。 | exact source map + current/候选/历史分层，不重新泛读聊天；原行为覆盖矩阵。 |
| R1 全新架构 | 完成 ARCH-0，选最小原生组合、技术栈、信任/身份/版本/证据/发布和兼容模型；写清边界、旧→新行为映射、退役项、Mermaid/接口、替代方案与成本。 | 可审设计与具名 KEEP/REUSE/REIMPLEMENT/RETIRE；所有重大假设有原始依据或有界验证计划。必要冲突 Challenge，不添加每阶段机械审批。 |
| R2 最小新核心 | 独立新实现；身份、注册、撤销、同 UID 恢复、证据及版本投影、可信 profile/制品与原生控制；合成 Provider/私有消费者实现第一条纵向链。 | 从干净检出可构建、端到端合成成功/拒绝、旧 v1 兼容或可逆迁移；不带真实凭据/现役依赖。 |
| R3 信任与可信 Pull 更新 | 原生签名/发布渠道、周期检查、升级/版本观测/回退；不可信节点、独立身份/撤销、外部可信拒绝；合成 key。 | 真实区分 dirty/过期/回放/错签名/错平台/旧凭据；重复 no-op、失败/掉电恢复、节点不具发布权、同 UID 与原生链路保持；合成和隔离负控。 |
| R4 原生 TS/CF/SSH/K3s 与健康聚合 | discovery/adopt-existing/plan/approved apply/verify；原生安装与可选计算，真实身份/资源/健康对照；隔离 1 Server+1 Agent，1GiB/512MiB Agent，Server 2c/2GiB 起。 | 不入群仍可完整纳管；真实资源、错 pin、断网/Quorum、恢复/撤销、独立 SSH；若无实际实验资源授权，先完成源码/fixture，明确 NOT_RUN。 |
| R5 E2E 与迁移 | 可丢弃节点首纳→真实执行→更新→故障回退；旧 snapshot、身份、数据/协议、私有 consumer 兼容演练；低资源/常驻服务与维护成本对照。 | 有效能力覆盖、真实测试日志与 exact candidate、旧系统仍可用、可逆切换及具名退役模块；不在客户机器试验。 |
| R6 独立验收/发行准备 | Fresh independent verifier 不继承作者接受判断；复核固定源码、负控和适用实际运行；修复 findings，形成候选发行、分批迁移及回退计划。 | SOURCE/ISOLATED/CONSUMER/PRODUCTION 分离；未执行如实标记。原 owner 按具体授权再决定 merge/publish/实机 canary/stable 晋升/旧实现退役。 |

新上下文自行选择 DIRECT/DELEGATE；复杂实现按 ai-use Foreman 规则组织有界独立子线，同一写域不并写。每阶段写低频可恢复 checkpoint：exact HEAD、产物/证据来源、当前 scope、结果、剩余风险、下一步。R2/R3 可在明确接口后并行。不能把本轮源码重构授权解释为真实节点/密钥/ACL/Provider/生产发布授权；不得重复工头已经完成的旧线。原 #140 是 design input，不强行覆盖；在新 Draft 中引用本包并将真实设计差分写清。

## 8. 资料整理证据与限制

本包由当前架构师在对话经 GitHub connector 整理。已重新读取两份完整递归文件树（68/77 tracked blob），live PR/Issue、代表性代码/审查、现行规范和实际 DCR 目录；前期企业研究直接引用已落档原始指针。未全量逐文件语义审计、未独立复跑旧测试、未创建实验环境、未调用新模型对话。保留 R0 的独立核验职责。本包不是新 L0、不是稳定版声明，不启动生产。Human 手动选择高推理模型，按此唯一参考入口开工。
