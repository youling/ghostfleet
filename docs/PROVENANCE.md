# Provenance and licensing / 来源与许可

## 中文

<!-- topic:origin -->
### 通用来源与干净快照

GhostFleet 从设备纳管、类型化控制、收敛与恢复实践中抽取可复用机制，作为独立公开产品维护。公开快照不含真实实例配置、设备目录、端点、凭据、原始回执或私有历史。精确的私有来源、排除项及许可审计保存在所有者控制的记录中，不写入公开安装文档或机器导出清单。

公开命名空间与新目录布局独立于旧通信协议和存储 ABI。`fleet-*` 协议标记或已安装的辅助程序路径是兼容机制，不表示公开源码依赖某个私有部署。迁入源码需具备可重新分发的许可并由所有者审查，不能通过改文件名宣称新的作者身份或消除来源约束。

<!-- topic:license -->
### 许可与依赖

本仓采用 `AGPL-3.0-only`，包含完整 [LICENSE](../LICENSE)，各包保留许可文件。第三方依赖保留原许可，完整说明见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。Console 构建保留 Tabler CSS 的版权及许可和官方 MCP SDK 的许可；可选 SSH、结构校验与运行时依赖由包清单、锁文件和产物中的说明记录。

依赖审计未发现已知漏洞，不等于许可及供应链审查已完成；版本与测试结果绑定精确提交。发布源码、提供网络服务或分发二进制时，都需核对 AGPL 与第三方许可说明义务，不能删除许可头或发布未经审查的供应商打包内容。

<!-- topic:ui -->
### 公共 UI 参考

Console 使用 Tabler CSS 与原生 JavaScript；shadcn-admin 只作为布局和交互参考，没有复制其代码、素材或品牌。Impeccable 只用于开发审查，不是运行时依赖。可核对 [UI 复用](UI_REUSE.md)、[Console](CONSOLE.md)、[设计](../DESIGN.md) 与 [产品范围](../PRODUCT.md)。

七张 Console 图片来自隔离的合成预览，审查绑定公开策略中的精确 SHA。没有公开真实单节点验证截图；这些图片不能证明生产托管或设备在线。

<!-- topic:manifest -->
### 导出索引与验收

[机器导出清单](export-manifest.json)只列公开模块、入口、模式、组件、检查与剩余发布条件，不含私有哈希、来源路径、工单或凭据引用。它是可复核的产品索引，不是自行签署的硬件证明，也不授权删除旧代码。

公开源码已合并至默认分支 `main`，包仍是可选源码开发模块，尚未正式发布到 npm 或 PyPI。审查是否通过、CI 是否成功及是否可发布，均以具体公开提交的证据为准，不能由本文预先认证后续提交。源码开发、合成测试、受保护的单机验证与正式发布须明确区分；第二台独立硬件、生产 Pages、OAuth 及消费者切换的未完成验收须明确保留。

本控制面的 `ACTIVE` 状态及七类准入证据不证明独立消费者的目录、鉴权、配置、调用路由、权限或回滚已切换。完整端到端验收须复用现有身份，并确认每个实际消费者可发现、可使用该节点；不能通过另建注册流程或扩大权限补足目录缺口。

## English

<!-- topic:origin -->
### Generic origin and clean snapshot

GhostFleet extracts reusable mechanisms from device enrollment, typed control, convergence and recovery practice and maintains them as an independent public product. Public snapshots contain no real instance configuration, registries, endpoints, credentials, raw receipts or private history. Exact private donor/exclusion/licensing audits remain owner-controlled, not public installation documents or machine export manifests.

The public namespace/layout is distinct from legacy wire/storage ABI. A `fleet-*` protocol marker or installed helper path is compatibility mechanism, not a dependency on a particular private deployment. Imported source requires redistribution rights and owner review; renaming files does not create authorship or remove handling constraints.

<!-- topic:license -->
### Licensing and dependencies

This repository is AGPL-3.0-only with the full [LICENSE](../LICENSE); packages retain license files. Third-party dependencies keep their original licenses; see [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md). Console builds retain Tabler CSS copyright/licensing and the official MCP SDK license. Optional SSH/schema/runtime dependencies are declared by manifests/locks and artifact notices.

A dependency audit with no known vulnerability is not a completed license/supply-chain review. Versions and test results bind the exact head. Source, network-service and binary publication each need AGPL and third-party notice review; never remove license headers or ship unreviewed vendor bundles.

<!-- topic:ui -->
### Public UI references

The Console uses Tabler CSS and native JavaScript. shadcn-admin is a layout/interaction reference only; its code/assets/brand were not copied. Impeccable is a development-review tool, not a runtime dependency. See [UI reuse](UI_REUSE.md), [Console](CONSOLE.md), [DESIGN](../DESIGN.md) and [PRODUCT](../PRODUCT.md).

The seven Console images are isolated synthetic previews, reviewed against exact SHA in publication policy. No actual canary screenshot is published; preview images prove neither production hosting nor device connectivity.

<!-- topic:manifest -->
### Export index and acceptance

The [machine manifest](export-manifest.json) lists public modules/entry points/modes/components/checks and remaining release gates only, never private hashes, donor paths, issues or credential references. It is a reviewable product index, not self-signed hardware proof or authority to delete previous code.

Public source is merged into the default `main` branch. Packages remain optional source-development modules without formal npm or PyPI publication. Reviewed status, green CI and release readiness depend on evidence for the exact public head; this document cannot certify later commits in advance. Distinguish source development, synthetic tests, protected single-node validation and formal release. Preserve unfinished second-device, production Pages, OAuth and consumer-cutover acceptance.

This control plane's `ACTIVE` status and seven admission evidence types do not prove an independent consumer's catalog, authentication/configuration, call routes, authority or rollback has switched. End-to-end acceptance must reuse the existing identity and establish discoverability and usability in each actual consumer. Do not create a parallel enrollment flow or expand authority to fill a catalog gap.
