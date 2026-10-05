# Migration and cutover / 迁移与切换

## 中文

<!-- topic:ownership -->
### 唯一规范实现与当前状态

本仓维护通用核心/API/MCP、插件契约、校验器和可选设备运行时。实例责任方保留提供方/节点事实、私有策略与投影、秘密托管、原始回执、现役调用方和生产操作。公开源码预览不等于生产发布；[导出清单](export-manifest.json) 记录模块、入口、测试和待审状态。

公开迁移不导入私有 Git 历史、实例清单或原始真机证明。旧通用实现删除必须等逐项调用方切换验收，不因公开代码能够构建而删除现役路径。

<!-- topic:matrix -->
### 机制覆盖和剩余工作

| 能力 | 公开候选位置与模式 | 切换/发布前需完成 |
| --- | --- | --- |
| 生命周期、证据、节点、Console | `src/core`、`src/control-plane`、`console` | 精确身份、源绑定、持久化和调用方行为一致性 |
| MCP | `src/integrations`，四个只读工具 | 实际标准客户端握手及权限/Origin 验证，不开放设备变更 |
| 类型化控制、策略、传输 | `packages/typed-control`，显式可选库 | 调用主体/身份/主机指纹/版本/截止时间负测、真实后端与托管 |
| 任务、交互会话、特权 | 类型化 RPC 与 Python 包内资源 | 安装程序及 SHA、普通/特权分离、句柄/代次/输入序号、未知结果恢复 |
| Bootstrap/Linux 收敛 | `packages/bootstrap` 与 Python Linux 模块 | 单次派发记录、精确主机/软件包、独立观察器、实际立即重复零差异 |
| Windows/Android | Python 平台模块与资源 | 平台依赖、授权、真实适配器、跨平台负测及各自真机试验 |
| Profile/校验器/投影 | Python 核心与包内资源 | 责任方/派生视图边界、源版本、秘密字段拒绝和安装产物资源 |
| OAuth/access | 可选 `./authorization` | 已实现精确配置、PKCE、注册/当前权限上限重验、v2 origin 同意证明；生产签发方存储和调用方另验 |
| 生产 Console/Pages/身份 | 参考 Worker/DO/assets | 生产托管、身份、安全及 Pages 切换，尚未完成 |
| 第二独立硬件/重建 | 不能靠复制源码完成 | 单节点证据不能替代，另做独立硬件/恢复验收 |

未覆盖 SDK 或平台家族要列具体依赖与下一检查。辅助模块编译不等于完整 OAuth 服务接入；生产 broker 未迁也不意味着所有 OAuth 机制只有文档。

<!-- topic:retained -->
### 保留或暂缓的技术原因

生产提供方 broker、凭据托管、实例 OAuth 与 Worker 主入口包含真实授权和配置，留在实例责任方。后续用公开模块和显式提供方适配器接线，核对 binding、scope、redirect 和撤销。工单派发、工作图和私有治理是部署协调，不迁为公开设备协议。

硬件专属散热/root/解锁/恢复、原始证明包、历史 registry 和当前投影包含非公开事实或特殊平台副作用，不直接复制。可复用部分另需通用契约、独立合成样本、平台负测与硬件验收。旧调用方保持可用直到替代通过；现有 Linux/Windows/Android 源码不自动支持 Apple 或未测 SDK 家族。

<!-- topic:checklist -->
### 切换检查清单

1. 冻结一项能力的公开包/版本、旧代码与配置版本、调用方清单和责任方，不扩大到其它平台/节点。
2. 在独立公开仓库克隆执行完整测试、构建、安装产物及公开/文档检查，明确实际执行和平台跳过项。
3. 私有调用方引用公开包，不复制源码。重建投影，核对精确节点/主体/权限/指纹/版本和协议、安装路径与存储兼容性。
4. 先在无副作用后端验行为一致性、权限负测、截止时间和恢复，再进行明确授权的受限真机试验；不能用新身份掩盖旧绑定问题。
5. 控制面/API/Console/MCP 回读同一身份。新 FAIL/UNKNOWN 覆盖旧 PASS，真实派发记录由责任方对账。
6. 完成调用方切换与回滚演练，留下已接受的持久记录。旧机制改为薄兼容引用后，另在私仓 PR 删除重复通用实现。
7. 保留实例配置、证据、凭据托管和恢复访问。删除旧源码不等于撤销设备或销毁数据。

<!-- topic:rollback -->
### 回滚和状态

回滚要求状态/schema 兼容、精确新旧包版本和已发生副作用的回执，不是简单 reset 分支。先停新派发，只读对账，核对待确认任务、会话、纳管或重启，再切回已验收的旧调用方。未知变更不重新提交，普通执行权限不包含特权。

新的所有者同意证明是 v2，拒绝旧无 origin 证明；注册、授权和 token/refresh 权限须按可信存储与当前客户端配置重验。私有签发方仍未自动切换，不能以迁移文件宣称兼容旧授权。

本次源码预览不执行私有代码删除、main 合并、生产部署或提供方变更。源码迁入、合成测试、单机试验与正式发布分别记录，避免把“代码已迁”说成“全部远控已上线”。

## English

<!-- topic:ownership -->
### Canonical owners and current status

This repository owns generic core/API/MCP, plugin contracts/validators and optional device runtimes. Instance owners retain provider/node facts, private policy/projection, secret custody, raw receipts, existing consumers and production operations. A public source-preview candidate is not a production release; the [export manifest](export-manifest.json) declares modules/exports/tests and pending review.

Publication imports no private Git history, inventory or actual device proof. Removing prior generic implementations is conditional on subsequent capability-specific cutover, not merely a successful public build.

<!-- topic:matrix -->
### Mechanism coverage and remaining work

| Capability | Public candidate location/mode | Cutover or release work |
| --- | --- | --- |
| Lifecycle/evidence/Node/Console | `src/core`, `src/control-plane`, `console`; default object surface | Exact identity, source binding, persistence and consumer parity |
| MCP | `src/integrations`; four read-only tools | Actual generic SDK handshakes and scope/origin checks; no device mutation |
| Typed control/policy/transport | `packages/typed-control`; explicit library/backend | Source/actor/identity/pin/deadline negative tests, deployment custody and real backend |
| Jobs/sessions/privileged | Typed RPC plus Python resources; optional | Helper installation/hash, normal versus root, handles/generations/input sequence, UNKNOWN recovery and consumer parity |
| Bootstrap/Linux convergence | `packages/bootstrap` plus Python Linux runtime; optional | One-dispatch fence, exact package/host, fresh observer and actual immediate zero-delta repeat |
| Windows/Android runtime | Python resources/platform modules; optional | Platform dependencies/authority, real adapters, cross-platform negatives and hardware canaries |
| Profiles/validators/projection | Python core and packaged resources | Owner/read-model boundaries, source revisions, forbidden inventory/secret fields and installed resources |
| OAuth/access mechanisms | Evaluate actual public optional helper exports only | Generic PKCE/redirect/DCR/consent/token-scope review; production ingress/consumer configuration remains separate |
| Production Console/Pages/identity | Reference Worker/DO/assets | Separate production hosting/identity/security and Pages cutover; not completed |
| Independent second-device/rebuild | Not a source copy | Single-node evidence cannot substitute; perform independent hardware/recovery acceptance |

For uncovered SDK/platform families, state concrete dependencies and the next test. Compiled optional helpers do not establish an integrated OAuth server; an unmigrated production broker does not make every OAuth mechanism documentation-only.

<!-- topic:retained -->
### Technical reasons for retained/deferred components

Real provider brokers, secret custody, instance OAuth and production Worker entry points include deployed authority/configuration and remain instance-owned. Next, integrate public generic helpers through explicit provider adapters and review concrete bindings/scopes/redirects/revocation. Issue dispatch, owner work graphs and private governance are deployment coordination, not public device protocols.

Hardware-specific thermal/root/unlock/recovery mechanisms, raw legacy proof bundles, historical registries and current projections contain nonpublic facts or special platform effects and are not copied directly. Reusable parts need a generic contract, synthetic fixtures, platform negative tests and hardware acceptance. Existing private consumers remain usable until replacement passes. Linux/Windows/Android source does not automatically support Apple or untested SDK families.

<!-- topic:checklist -->
### Cutover checklist

1. Freeze one capability's public package/revision, previous source/config revisions, consumer list and owner without expanding to other platforms/nodes.
2. Run full tests/build/artifact/publication/docs checks in a standalone public clone and distinguish executed from skipped platform tests.
3. Make private consumers reference public packages without copying source. Rebuild projections and check exact node/actor/scopes/pin/currentness and legacy wire/storage ABI.
4. Validate parity/negative/deadline/recovery with an inert adapter, then exercise all effects in an explicitly authorized bounded canary. Do not mint a new identity to hide old binding problems.
5. Confirm the same identity through control plane/API/Console/MCP. Fresh FAIL/UNKNOWN supersedes old PASS; owners reconcile real effect fences.
6. Complete consumer cutover and rollback rehearsal with a durable accepted decision. Convert prior mechanisms to thin compatibility pointers and remove duplicated generic implementations in a separate private PR.
7. Preserve instance configuration/evidence/credential custody and safe recovery access. Removing old source does not revoke devices or destroy data.

<!-- topic:rollback -->
### Rollback and state

Rollback requires compatible state/schema, exact public/prior package revisions and receipts for effects; resetting a branch alone is insufficient. Stop new dispatch, reconcile read-only, inspect pending jobs/sessions/enrollment/reboot, then restore the accepted prior consumer. Unknown mutations are never re-submitted; privileged authority is not inherited from ordinary exec.

This source preview performs no private-source deletion, main merge, production deployment or provider changes. Record formal release conditions, provenance audit and current review separately so “source migrated” cannot mean “all remote control is live”.


Public owner-consent proof v2 rejects legacy origin-less proofs. Registered-client, authorization and token/refresh scopes are revalidated against trusted stored ceilings and current profiles; private issuers have not automatically cut over.
