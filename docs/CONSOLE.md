# Console usage / 控制台使用

## 中文

<!-- topic:session -->
### 连接与凭据

按 [快速开始](GETTING_STARTED.md) 启动，打开同源Console。在Settings连接该controlplane的read/operatorbearer；它不是CloudflareAPI或device/providercredential。Token只保留页面内存，连接清空输入，disconnect/reload/close清除。语言/theme/sidebar偏好可存浏览器；不要把credential存localStorage、URL、clipboardlog或screenshots。

界面默认中文，支持English与light/dark/system。Readonlysession禁对象mutation；operator可管理lifecycle/HumanGate，但默认不执行设备能力。ACTIVE是admission状态，不代表online/heartbeat；填写device名称不会安装agent或生成真机proof。

<!-- topic:workflow -->
### 列表、详情和不确定状态

首页显示最近设备、进行中记录、待确认与活动；侧栏进入devices/enrollment/gates/capabilities/events/settings。列表支持name/IDsearch、statefilter、sort、pagination和optionalcolumns；点击record打开detaildrawer保留查询条件。Ctrl/CmdK搜page/record，方向键/Enter选择、Esc关闭；mobile使用导航drawer，宽表区域横向滚动。

operator创建attempt，准备、请求精确gate，核对对象/请求/expiry再批准或拒绝。最新evidence FAIL/UNKNOWN覆盖旧PASS。错误显示在当前dialog，可读取serverstate；未知mutation暂禁button且不自动retry。Structuredasset_hint不直接Objectcoercion，优先有效字符串或boundnode/stableattemptID。

Capability目录只展示definition/risk，不执行命令。source-labeledsyntheticevidence不能当实际deviceacceptance。

<!-- topic:preview -->
### 设计、合成图片与验证

界面使用TablerCSS/nativeJavaScript，公共布局参考而无额外React/图表依赖。设计token见 [DESIGN](../DESIGN.md)，产品边界见 [PRODUCT](../PRODUCT.md)，license见 [第三方说明](../THIRD_PARTY_NOTICES.md)。认证、scope、TTL、gate/state与admission由server决定，UIlabel不提供authority。

七图均是isolatedsyntheticpreview，不是productionPages或realcanary：

![中文桌面合成预览](images/console-desktop.png)

[devices](images/console-devices.png) · [detail](images/console-detail.png) · [mobile](images/console-mobile.png) · [mobile devices](images/console-mobile-devices.png) · [English](images/console-english.png) · [dark](images/console-dark.png)

已有布局/keyboard/filters/tokenmemory/readonly/persistence等验证，不替代完整accessibilitycertification或平台真机验收。每次图像变更需publicationpolicyexactSHA复审。

## English

<!-- topic:session -->
### Connection and credentials

Start with [Getting started](GETTING_STARTED.md) and open the same-origin Console. Under Settings, connect with this control plane's read/operator bearer, never a Cloudflare API or device/provider credential. Tokens stay in page memory, the input clears after connection, and disconnect/reload/close clears them. Language/theme/sidebar preferences may persist locally; credentials must not enter localStorage, URLs, clipboard logs or screenshots.

The Console defaults to Chinese with English and light/dark/system support. Read-only sessions cannot mutate objects. Operators manage lifecycle/HumanGate objects but do not execute hardware capabilities by default. ACTIVE is admission status, not connectivity/heartbeat; entering a device name installs no agent and creates no hardware proof.

<!-- topic:workflow -->
### Lists, details and uncertain outcomes

The homepage shows recent devices, active attempts, pending approvals and activity. Navigate to devices/enrollment/gates/capabilities/events/settings through the sidebar. Lists support name/ID search, state filters, sort, pagination and optional columns. Detail drawers preserve query context. Ctrl/Cmd K searches pages/records; arrows/Enter select and Esc closes. Mobile uses navigation drawers and wide tables scroll within their own region.

Operators create an attempt, prepare and request an exact gate, then verify object/request/expiry before approving or rejecting. Latest FAIL/UNKNOWN evidence supersedes old PASS. Dialogs show errors and permit a server-state read; uncertain mutations disable buttons without automatic retry. Structured asset_hint is not coerced into an object label; use a valid string or the bound node/stable attempt ID.

The capability directory displays definitions/risks without execution. Source-labeled synthetic evidence is not real device acceptance.

<!-- topic:preview -->
### Design, synthetic images and validation

The UI uses Tabler CSS/native JavaScript with public layout references and no additional React/chart dependency. See [DESIGN](../DESIGN.md) for tokens, [PRODUCT](../PRODUCT.md) for boundaries and [third-party notices](../THIRD_PARTY_NOTICES.md) for licensing. Server authority determines authentication, scope, TTL, gates/state and admission; UI labels grant no authority.

All seven images are isolated synthetic previews, not production Pages or a real canary:

![Synthetic Chinese desktop preview](images/console-desktop.png)

[Devices](images/console-devices.png) · [Detail](images/console-detail.png) · [Mobile](images/console-mobile.png) · [Mobile devices](images/console-mobile-devices.png) · [English](images/console-english.png) · [Dark](images/console-dark.png)

Existing layout/keyboard/filter/token-memory/read-only/persistence checks do not establish complete accessibility certification or platform hardware acceptance. Every changed image requires renewed exact-SHA publication-policy review.
