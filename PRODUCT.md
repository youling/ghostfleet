# GhostFleet product scope / 产品范围

## 中文

<!-- topic:purpose -->
### 用户与核心价值

面向Humanoperator、AIagent与pluginbuilder的设备fleetcontrolplane。通过稳定identity、lifecycle、capability、authority、HumanGate和evidence管理设备；HTTP/MCP和Console提供同一对象，不把remote shell当完整设备管理。

通用机制在本仓维护，实例owner保留账户、node/provider事实、配置、credentials与rawruntimeevidence。主流程与AIclient无关，不需要ChatGPT/OpenAI；专有clientadapter仅可选。

<!-- topic:implemented -->
### 当前可实现的体验

DefaultConsole管理lifecycle/HumanGate并检查evidence；defaultMCP提供四inspectiontools。Corematerialization产生稳定PROVISIONALUID，fullproof后同UID升ACTIVE，不改旧identity/Assets主权。Structuredlabels、synthetic来源和readonlyscope可见。

Optionaltyped-control/bootstrap/Pythonruntime提供平台机制和backendseam，但没有自动deviceexecutioningress。Publicsource可build/test和device-freepreview；实际生产adapter/custody、上线OAuth/Pages与平台真机验收不是默认体验。

<!-- topic:limits -->
### 范围、限制与品牌

品牌是专业中性的bilingualadmininterface，语义状态不夸大能力。实际Console有navigation/tables/detail/search/theme/language；synthetic截图仅展示UI。Defaultcapabilitycatalog不是执行按钮。Publiclanding/docs不宣称已支持所有平台、生产SLA、无限freeActions或完整发布插件。

source-preview、单节点canary、独立secondhardware、securityreview、productiondeploy和正式release分别陈述。未来plugin以publiccanonicalpackage为准；oldprivate删除需consumer/rollback验收。

## English

<!-- topic:purpose -->
### Users and purpose

A device fleet control plane for human operators, AI agents and plugin builders. Stable identity, lifecycle, capability, authority, HumanGate and evidence govern devices. HTTP/MCP and Console expose the same objects; a remote shell is not complete device management.

This repository maintains generic mechanisms; instance owners retain accounts, node/provider facts, configuration, credentials and raw runtime evidence. The main flow is AI-client-neutral and requires no ChatGPT/OpenAI; proprietary client adapters are optional.

<!-- topic:implemented -->
### Current implemented experience

The default Console manages lifecycle/HumanGate objects and inspects evidence; default MCP exposes four inspection tools. Core materialization creates a stable PROVISIONAL UID and promotes the same UID after complete proof, preserving prior identity and Assets ownership. Structured labels, synthetic provenance and read-only scope are visible.

Optional typed-control/bootstrap/Python runtimes provide platform mechanisms/backend seams without automatic device-execution ingress. Public source builds/tests and previews without hardware; production adapters/custody, online OAuth/Pages and platform hardware acceptance are not the default experience.

<!-- topic:limits -->
### Scope, limits and presentation

The brand is a professional neutral bilingual administration interface whose status language does not overstate capability. The Console implements navigation/tables/details/search/themes/languages; synthetic screenshots demonstrate UI only. The capability catalog is not an execution button. Public landing/docs claim neither every platform, production SLA, unlimited free Actions nor a fully released plugin.

Describe source preview, single-node canary, independent second-device evidence, security review, production deployment and formal release separately. Future plugins use public canonical packages; prior-source removal requires consumer/rollback acceptance.
