# UI Reuse Decision

status: `V0_SELECTED`
selected_at: `2026-10-04`

## 中文版

<!-- topic:reference -->



### 选择

GhostFleet V0 官方 Console 保留 **Tabler** core CSS 作为组件基础，GhostFleet 自己实现模块壳、表格和详情交互。用户选择 [shadcn-admin](https://github.com/satnaing/shadcn-admin) 的专业后台风格；具体参考版本与边界见 [Console](CONSOLE.md)。

- upstream: `https://github.com/tabler/tabler`
- package: `@tabler/core@1.6.1`
- license: `MIT`
- V0 使用范围：core CSS + 原项目 LICENSE。当前交互使用原生 HTML 与 JavaScript，不打包未使用的 Tabler JavaScript。

### 明确排除

V0 不复制或打包 `dist/libs` 中的可选第三方插件，也不加载 vendor stylesheet。尤其不因为 Dashboard 需求默认引入图表库。

理由：GhostFleet 当前页面主要是生命周期、列表、状态、HumanGate 和事件，不需要图表依赖；减少许可证面和供应链面也符合 V0 最小化原则。

### 复用边界

Tabler 提供组件样式基础：

- cards / tables / forms / badges；
- light/dark capable design foundation。

GhostFleet 自己负责：

- 固定/折叠侧栏、手机导航、主题 tokens、搜索、表格筛选/分页和详情弹窗；
- Enrollment / Node / Capability / Event 领域模型；
- HumanGate UX；
- API/view model；
- 授权 boundary。

绝不复用第三方后台自己的 凭据、身份、ACL 或 生命周期 语义覆盖 GhostFleet contract。

---


## English Version

<!-- topic:reference -->



### Selection

The official GhostFleet V0 Console keeps **Tabler** core CSS as its component foundation. GhostFleet implements the module shell, tables and detail interactions. The user selected shadcn-admin conventions; the exact reference and reuse boundaries are recorded in [Console](CONSOLE.md).

- upstream: `https://github.com/tabler/tabler`
- package: `@tabler/core@1.6.1`
- license: `MIT`
- V0 scope: core CSS + upstream LICENSE. Current interactions use native HTML and JavaScript; unused Tabler JavaScript is not bundled.

### Explicit exclusions

V0 does not copy or bundle optional third-party plugins under `dist/libs`, and it does not load vendor stylesheets by default. Charts are not a baseline dependency.

The current GhostFleet UI is primarily lifecycle, lists, state, Human Gates and events; avoiding optional vendor packages reduces both license and supply-chain surface.

### Reuse boundary

Tabler provides the base component styles. GhostFleet owns its navigation, responsive composition, theme tokens, filtering/paging, command search and detail dialogs.

GhostFleet owns Enrollment/Node/Capability/Event domain semantics, HumanGate UX, API/view models and authority boundaries.

Third-party credential, identity, ACL or lifecycle semantics must never replace the GhostFleet contract.
