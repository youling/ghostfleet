# Provenance and licensing / 来源与许可

## 中文

<!-- topic:origin -->
### 通用来源与 clean snapshot

GhostFleet从设备纳管、typedcontrol、convergence与recovery实践中抽取可复用机制，并作为独立publicproduct维护。公开snapshot不含真实instance配置、registry、endpoint、credentials、rawreceipts或privatehistory。精确private donor/exclusion/license审计保存在受控owner，而非公开安装文档或machineexportmanifest。

publicnamespace新布局与legacywire/storageABI分开。`fleet-*`protocolmark或installedhelperpath本身是兼容机制，不证明public源码依赖某个私有部署。迁入source需可重分发许可与ownerreview；不能通过改文件名宣称创造或消除来源约束。

<!-- topic:license -->
### 许可与依赖

本仓为AGPL-3.0-only，包含完整 [LICENSE](../LICENSE)，各package保留许可文件。第三方依赖保留其原许可，完整说明见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。Consolebuild保存TablerCSS版权/许可与officialMCP SDKlicense；optionalSSH/schema/runtime依赖由packagemanifests/lock和artifactnotices体现。

依赖audit没有发现已知vulnerability不等于license/supplychain完成审查；当前版本与test结果绑定exacthead。发布源码、networkservice和二进制时都需核对AGPL及thirdpartynotice义务，不能删licenseheader或发布未审vendorbundles。

<!-- topic:ui -->
### 公共 UI 参考

Console使用TablerCSS和nativeJavaScript；shadcn-admin只作为布局/交互参考，没有复制其code/assets/brand。Impeccable只用于developmentreview，不是runtime依赖。可核对 [UI reuse](UI_REUSE.md)、[Console](CONSOLE.md)、[DESIGN](../DESIGN.md) 与 [PRODUCT](../PRODUCT.md)。

七张Console图片是isolatedsyntheticpreview，review按publicationpolicyexactSHA绑定。没有公开真实canary截图；图片不能用来证明productionhosting或deviceonline。

<!-- topic:manifest -->
### 导出索引与验收

[机器manifest](export-manifest.json)只列publicmodules/entrypoints/mode/components/checks与remainingreleasegates；不含privatehash、donorpath、issue或credentialref。它是可复核产品索引，不是自行签署的hardwareproof或删除旧code授权。

当前是否reviewed、CIgreen或release-ready以具体publichead证据为准。source-preview、合成tests、私有单机canary与正式release必须明确区分；未完成secondhardware/productionPages/OAuthconsumer切换不得隐藏。

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

Reviewed status, green CI and release readiness depend on evidence for the exact public head. Distinguish source preview, synthetic tests, protected single-node canary and formal release. Do not hide unfinished second-device/production Pages/OAuth consumer cutover work.
