# GhostFleet Console

## 中文

Console 默认中文，可以切换为英文；仅语言偏好保存在浏览器本地。访问令牌仅保留在页面内存中，连接后清空输入框，断开、重新加载或关闭页面即清除。

### 使用

运行方式见 [Cloud development](CLOUD_DEVELOPMENT.md)。打开当前控制平面的 Console：

1. 输入该实例的 `GHOSTFLEET_READ_TOKEN` 或 `GHOSTFLEET_OPERATOR_TOKEN`，点击「连接」。这不是 Cloudflare API Token。
2. 只读访问可查看状态；操作员可填写设备名称、创建纳管记录，再按每条记录的「下一步」操作。
3. 人工确认会显示对应的设备、请求和有效期。核对后批准或拒绝；已处理、已结束或已过期的记录折叠到历史区。
4. 不明确的变更结果会暂时禁用变更按钮。先「刷新状态」核对服务端记录，界面不会自动重试变更。

V0 只跟踪控制平面生命周期。输入「ThinkPad」创建记录不会在设备上安装 agent，也不会生成真实验收证据。验收证据来自适配器；标注为「模拟验收」的节点只用于本地流程验证。

### 界面与技能来源

保留 [Tabler](UI_REUSE.md) 组件与表单基础，使用 [Impeccable](https://github.com/pbakaus/impeccable) 的 Operate、onboard、polish 指导完善现有 Console。技能来源固定为 `6e802bd0ed99f53180e2359fddab6da8d97970d9`，Apache-2.0；它是开发工具，没有复制进项目，也不是运行时依赖。

界面采用克制的蓝色操作强调、可读的系统字体、明确的文字状态和原生交互。桌面并列显示记录与人工确认；手机优先显示人工确认；设备表格在自己的区域内横向滚动，活动列表可滚动。验收类型直接复用 `src/core/model.js`，不另立协议事实源。UI 的禁用状态和进度只帮助操作，服务端仍负责认证、授权、TTL、状态迁移和验收。

### 预览

下面是本地合成数据截图，未连接真实 ThinkPad，也不是线上部署结果。

![中文桌面 Console，合成设备与人工确认](images/console-desktop.png)

[手机截图](images/console-mobile.png) · [英文截图](images/console-english.png)

### 验证记录

2026-10-04，在本地 Chromium 与实际 workerd/SQLite Durable Object 上验证：

- 中英文切换、320/390/640/760/1024/1440px 布局、连接错误与令牌清除；
- 服务端返回的操作员/只读权限、断开期间迟到的读取结果；
- 创建记录、准备、请求人工确认、批准、进入证据验收；
- 不明确的变更结果禁止重复提交、刷新恢复、过期控制、长名称与 HTML 注入文本；
- core/HTTP/MCP/权限回归，以及 Worker 打包和重启持久化验证。

Impeccable 手动 detector 执行一次。字体提示通过使用系统字体解决；`details` 顶部内距提示经渲染确认由其 `summary` 的内距满足。源目录不含构建生成的 Tabler 样式路径，因此 detector 的第三方样式解析不完整；实际布局以浏览器验证为准。没有将 detector 的结果当成完整视觉或无障碍认证。

## English

The Console defaults to Chinese and offers an English switch. Only the language preference is stored locally. The bearer token stays in page memory and is cleared on disconnect, reload or close. Use this instance’s read-only/operator control-plane token, not a Cloudflare API token.

Operators can create enrollment records, follow their next steps and resolve matching human approvals. Read-only users can inspect state. Unconfirmed mutation outcomes block further changes until the user refreshes and checks the records. The server remains authoritative.

V0 tracks control-plane records; creating a ThinkPad record does not install a device agent or fabricate acceptance evidence. Screenshots above contain synthetic local fixtures only.

The existing Tabler foundation was refined using Impeccable’s Operate/onboard/polish guidance at the revision above (Apache-2.0). Impeccable is a development tool, not a vendored or runtime dependency. Acceptance type metadata comes from the canonical core model. Browser checks cover localization, responsive layout, scopes, enrollment actions, ambiguous outcomes, expired requests, hostile labels and stale responses after disconnect.
