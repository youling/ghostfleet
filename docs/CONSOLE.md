# GhostFleet Console

## 中文

Console 默认中文，可切换英文；支持浅色、深色和跟随系统。语言、主题和侧栏折叠偏好保存在本浏览器。访问令牌仅在页面内存中保留，连接后清空输入框，断开、重新加载或关闭页面即清除。

### 使用

运行方式见 [Cloud development](CLOUD_DEVELOPMENT.md)。打开此实例的 Console：

1. 在「设置 → 连接控制平面」输入该实例的 `GHOSTFLEET_READ_TOKEN` 或 `GHOSTFLEET_OPERATOR_TOKEN`，点击「连接」。这是控制面令牌，不是 Cloudflare API Token。
2. 首页优先显示最近纳管设备、进行中记录、待确认数量和待办事项。侧栏分别进入设备、纳管记录、人工确认、能力目录、活动记录和设置。
3. 列表支持名称/ID 搜索、状态筛选、排序、分页与可选列。纳管记录按进行中/全部/已结束切换，人工确认按待处理/全部/已处理切换。点击名称或「查看详情」打开侧栏，关闭后保留列表条件。
4. 操作员点击「创建纳管记录」，填写设备名称，然后在详情里按下一步操作。人工确认详情显示准确的对象 ID、设备、请求和有效期；核对后批准或拒绝。只读令牌可查看记录，无法提交这些变更。
5. 操作错误在当前弹窗内显示，可直接「读取服务端状态」。结果不明确时变更按钮暂时禁用，界面不会自动重试；创建记录的异常恢复会回到列表，供你先核对结果。

`Ctrl/Cmd K` 打开页面与记录搜索，方向键选择，Enter 打开，Esc 关闭。桌面侧栏可折叠，手机使用导航抽屉；宽表格仅在自己的区域横向滚动。

V0 跟踪控制平面生命周期。填写「ThinkPad」不会在设备上安装 agent，也不会生成验收证据；证据来自适配器。「活跃」表示记录的生命周期，不代表设备在线或心跳正常。能力目录仅展示定义和风险等级，不执行命令。节点、纳管列表和证据详情均根据证据来源标注模拟验收。

### 界面与来源

界面参考 [shadcn-admin](https://github.com/satnaing/shadcn-admin) 的紧凑侧栏、模块页面、数据表与详情操作，采用中性的浅色/深色底色、系统字体和明确的语义状态。保留 [Tabler](UI_REUSE.md) CSS 与原生 JavaScript；没有增加 React 或图表依赖，也没有复制参考仓库的代码、图片或品牌资产。

- shadcn-admin 参考版本：`e16c87f213a5ba5e45964e9b67c792105ec74d26`，MIT；只用作布局和交互参考。
- [Impeccable](https://github.com/pbakaus/impeccable) 技能版本：`6e802bd0ed99f53180e2359fddab6da8d97970d9`，Apache-2.0；用于开发和独立界面审查，没有复制进项目或成为运行时依赖。
- [DESIGN.md](../DESIGN.md) 和 `.impeccable/design.json` 记录实际界面 tokens；产品范围见 [PRODUCT.md](../PRODUCT.md)。

验收类型直接来自 `src/core/model.js`。表格模型只处理展示、搜索和分页；服务端仍负责认证、授权、TTL、状态迁移和验收。

### 预览

以下是隔离本地实例的合成数据截图，未连接真实 ThinkPad，也不是线上部署结果。

![中文桌面：设备状态与待办事项](images/console-desktop.png)

[设备列表](images/console-devices.png) · [纳管详情与模拟验收证据](images/console-detail.png) · [手机首页](images/console-mobile.png) · [手机列表](images/console-mobile-devices.png) · [英文](images/console-english.png) · [深色主题](images/console-dark.png)

### 验证记录

2026-10-04，在 Chromium 和本地 workerd/SQLite Durable Object 上验证：

- 中英文、浅深色、320/390/640/760/900/1024/1440px 布局、手机原生导航与详情弹窗；
- 搜索、组合筛选、空结果、自然排序、分页、列显示、快捷搜索与键盘操作；
- 创建 → 准备 → 请求人工确认 → 批准 → 进入验收；缺失证据保持 0/7，最新失败证据覆盖旧的通过结果；
- 服务端只读权限、输入清除、断开期间迟到的读取、令牌不落本地存储；
- 弹窗内异常提示与状态读取、不自动重试变更、过期请求、长名称与 HTML 注入文本；
- 21 个 core/HTTP/MCP/权限与列表模型用例、Worker dry-run 打包及重启持久化验证。

Impeccable 手动 detector 执行一次；小字号已修正，设置区域的内距提示经代码和渲染确认由 26px/22px 的块内距满足，重复渐变提示不来自项目自写样式。独立审查针对列出的修复进行最终复核。此记录不替代完整无障碍认证或真实设备验收。

## English

The Console defaults to Chinese and offers an English switch, light/dark/system themes and collapsible navigation. Only presentation preferences persist locally. The bearer token stays in page memory and is cleared on disconnect, reload or close. Connect under Settings with this instance’s control-plane token.

The homepage prioritizes device records and actionable work. Separate module tables offer search, state filters, sorting, paging and optional columns. Detail sheets preserve list context. Ctrl/Cmd K searches pages and actual records. Operators can create records and resolve exact matching human approvals; read-only users can inspect them. Dialogs show localized errors and allow a read-only state refresh. Unconfirmed outcomes block mutations without automatic retry.

V0 records control-plane lifecycle; it does not install a ThinkPad agent, detect online status or execute capability definitions. Synthetic evidence is source-labeled in node and enrollment views. All screenshots use isolated local synthetic fixtures.

The user-selected shadcn-admin reference informed layout and interaction conventions at the revision above. The existing Tabler CSS/native JavaScript stack remains; no upstream reference code or assets were copied. Impeccable is a development tool, not a runtime dependency. Shared acceptance metadata comes from the canonical core model; authentication, authorization and admission remain server-authoritative.
