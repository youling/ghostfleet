# GhostFleet product scope / 产品范围

## 中文

<!-- topic:purpose -->
### 用户与核心价值

GhostFleet 是面向人工操作员、AI 智能体与插件开发者的设备舰队控制平面。它通过稳定身份、生命周期、能力、授权、人工审批（`HumanGate`）和证据管理设备；HTTP、MCP 和 Console 展示同一组对象。远程 Shell 只是设备管理的一种能力。

通用机制在本仓维护，实例所有者保留账户、节点与提供方的实际信息、配置、凭据和原始运行证据。主流程与 AI 客户端无关，不需要 ChatGPT 或 OpenAI；专有客户端适配器仅为可选项。

<!-- topic:implemented -->
### 当前可实现的体验

默认 Console 管理生命周期及 `HumanGate` 对象并检查证据；默认 MCP 提供四个只读检查工具。核心实体化流程产生稳定的 `PROVISIONAL` UID，完整证据通过后将同一 UID 提升为 `ACTIVE`，保留原有身份和 Assets 归属。界面明确展示结构化标签、合成数据来源和只读权限范围。

可选的 `typed-control`、`bootstrap` 和 Python 运行时提供平台机制与后端接入接口，但不自动开放设备执行入口。公开源码已合并至默认分支 `main`，可构建、测试并在无设备环境中预览；这些包仍处于可选源码开发阶段，尚未正式发布到 npm 或 PyPI。生产适配器与凭据托管、上线 OAuth 或 Pages，以及各平台真机验收均需另行完成。

核心的 `ACTIVE` 状态及七类准入证据只证明本控制面的身份准入，不证明独立消费者的目录注册、认证配置、调用路由、权限或回滚已切换。每个消费者必须复用现有身份，分别验证目录可发现性、认证与配置、实际调用路由、正向与越权拒绝、身份回读及回滚；完整端到端验收以该消费者实际可发现、可使用为准。

<!-- topic:limits -->
### 范围、限制与品牌

产品采用专业、中性的双语管理界面，状态说明不夸大能力。Console 已实现导航、表格、详情、搜索、主题和语言切换；合成截图只展示界面。默认能力目录不提供设备执行按钮。公开介绍与文档不承诺已支持所有平台、生产 SLA、无限免费 Actions 或完整发布的插件。

源码开发、受保护的单节点验证、第二台独立硬件验证、安全审查、生产部署和正式发布分别验收。未来插件以本仓维护的公开包为准；删除原有私有通用代码须先完成消费者兼容性与回滚验收。

## English

<!-- topic:purpose -->
### Users and purpose

A device fleet control plane for human operators, AI agents and plugin builders. Stable identity, lifecycle, capability, authority, HumanGate and evidence govern devices. HTTP/MCP and Console expose the same objects; a remote shell is not complete device management.

This repository maintains generic mechanisms; instance owners retain accounts, node/provider facts, configuration, credentials and raw runtime evidence. The main flow is AI-client-neutral and requires no ChatGPT/OpenAI; proprietary client adapters are optional.

<!-- topic:implemented -->
### Current implemented experience

The default Console manages lifecycle/HumanGate objects and inspects evidence; default MCP exposes four inspection tools. Core materialization creates a stable PROVISIONAL UID and promotes the same UID to ACTIVE after complete proof, preserving prior identity and Assets ownership. Structured labels, synthetic provenance and read-only scope are visible.

Optional typed-control/bootstrap/Python runtimes provide platform mechanisms/backend seams without automatic device-execution ingress. Public source is merged into the default `main` branch and builds/tests/previews without hardware. The packages remain optional source-development modules, without formal npm or PyPI publication. Production adapters/credential custody, online OAuth/Pages and platform hardware acceptance require separate completion.

Core `ACTIVE` status and the seven admission evidence types prove identity admission in this control plane only. They do not prove an independent consumer's catalog registration, authentication/configuration, call routes, authority or rollback has switched. Each consumer must reuse the existing identity and separately verify discoverability, authentication/configuration, actual call routes, positive and negative authority, identity readback and rollback. Complete end-to-end acceptance requires the node to be discoverable and usable in that actual consumer.

<!-- topic:limits -->
### Scope, limits and presentation

The brand is a professional neutral bilingual administration interface whose status language does not overstate capability. The Console implements navigation/tables/details/search/themes/languages; synthetic screenshots demonstrate UI only. The capability catalog is not an execution button. Public landing/docs claim neither every platform, production SLA, unlimited free Actions nor a fully released plugin.

Accept source development, protected single-node validation, independent second-device evidence, security review, production deployment and formal release separately. Future plugins use public canonical packages; prior-source removal requires consumer/rollback acceptance.
