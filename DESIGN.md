---
name: "GhostFleet Console"
description: "A compact bilingual administration interface for control-plane records."
colors:
  canvas: "#fff"
  surface: "#fff"
  sidebar: "#fafafa"
  muted-surface: "#f4f4f5"
  ink: "#18181b"
  muted: "#62626c"
  line: "#e4e4e7"
  input-line: "#8b8b96"
  primary: "#18181b"
  primary-ink: "#fff"
  focus: "#2563eb"
  green: "#166534"
  green-bg: "#f0fdf4"
  amber: "#854d0e"
  amber-bg: "#fffbeb"
  blue: "#1d4ed8"
  blue-bg: "#eff6ff"
  red: "#b91c1c"
  red-bg: "#fef2f2"
  dark-canvas: "#09090b"
  dark-surface: "#111114"
  dark-sidebar: "#101013"
  dark-muted-surface: "#202024"
  dark-ink: "#fafafa"
  dark-muted: "#a1a1aa"
  dark-line: "#2c2c32"
  dark-input-line: "#62626c"
  dark-primary: "#fafafa"
  dark-primary-ink: "#18181b"
  dark-focus: "#93c5fd"
  dark-green: "#86efac"
  dark-green-bg: "#123021"
  dark-amber: "#fcd34d"
  dark-amber-bg: "#38280d"
  dark-blue: "#93c5fd"
  dark-blue-bg: "#172642"
  dark-red: "#fca5a5"
  dark-red-bg: "#3a191e"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "25px"
    fontWeight: 650
    lineHeight: "1.35"
    letterSpacing: "-0.02em"
  headline-mobile:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "23px"
    fontWeight: 650
    lineHeight: "1.35"
    letterSpacing: "-0.02em"
  detail-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "1.4"
    letterSpacing: "normal"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "1.45"
    letterSpacing: "normal"
  subheading:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.55"
    letterSpacing: "normal"
  description:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.55"
    letterSpacing: "normal"
  control:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"San Francisco\", \"Segoe UI\", Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "13px"
    fontWeight: 550
    lineHeight: "1.25rem"
    letterSpacing: "normal"
  field:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"San Francisco\", \"Segoe UI\", Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "normal"
  table:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "1.55"
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "1.55"
    letterSpacing: "normal"
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans SC\", sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: "1.35"
    letterSpacing: "normal"
  payload:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "1.4285714286"
    letterSpacing: "normal"
rounded:
  square: "0"
  small: "4px"
  badge: "5px"
  navigation: "6px"
  control: "7px"
  dialog: "10px"
spacing:
  space-4: "4px"
  space-8: "8px"
  space-10: "10px"
  space-12: "12px"
  space-14: "14px"
  space-16: "16px"
  space-18: "18px"
  space-20: "20px"
  space-22: "22px"
  space-24: "24px"
  space-26: "26px"
  space-28: "28px"
  space-32: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0.5625rem 1rem"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0.5625rem 1rem"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "{colors.muted-surface}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.red}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0.5625rem 1rem"
    height: "40px"
  button-danger-hover:
    backgroundColor: "{colors.red-bg}"
    textColor: "{colors.red}"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0"
    height: "40px"
    width: "40px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
    height: "40px"
  navigation-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.navigation}"
    padding: "8px 10px"
    height: "42px"
  navigation-item-current:
    backgroundColor: "{colors.muted-surface}"
    textColor: "{colors.ink}"
  state-neutral:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    padding: "2px 7px"
  state-success:
    backgroundColor: "{colors.green-bg}"
    textColor: "{colors.green}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    padding: "2px 7px"
  state-warning:
    backgroundColor: "{colors.amber-bg}"
    textColor: "{colors.amber}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    padding: "2px 7px"
  state-info:
    backgroundColor: "{colors.blue-bg}"
    textColor: "{colors.blue}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    padding: "2px 7px"
  state-danger:
    backgroundColor: "{colors.red-bg}"
    textColor: "{colors.red}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    padding: "2px 7px"
  queue-card:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "17px"
  data-frame:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  view-tabs:
    backgroundColor: "{colors.muted-surface}"
    rounded: "{rounded.control}"
    padding: "4px"
  view-tab-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.small}"
    padding: "5px 12px"
    height: "34px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "0"
  detail-sheet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "0"
    width: "min(490px, 100%)"
    height: "100dvh"
---

# Design System: GhostFleet Console

## 中文

<!-- topic:design -->
### 视觉原则

**设计方向：专业管理后台。**

GhostFleet 沿用用户选择的专业后台惯例：安静的中性界面、紧凑导航、以数据阅读为先的排版和熟悉的控件。中文与英文采用相同的信息层次，记录、访问范围和下一项可用操作都应便于扫读。

Console 自有样式表在 Tabler 核心 CSS 之后加载，规定可复用的视觉规则。它将 Tabler 的页面背景、正文颜色与边框颜色映射到 Console 设计变量，同时保留库中的按钮及表单机制。浅色与深色主题维持相同层次；用户明确选择外观前，主题跟随系统偏好。GhostFleet 名称作为视觉标识。

主要特征是克制的语义色、紧凑的页面框架、可读的数据行和以边框为主的分隔。界面默认中文，提供英文切换，并按当前语言处理日期与排序。原生对话框、可见的键盘焦点及保留列表上下文都是基本要求。

### 色彩

浅色主题使用白色与锌灰色系，深色主题使用近黑锌灰色系，语义前景色与背景色保持可读。文件开头的配置保留 CSS 自定义属性名称；每个 `dark-` 变量都是对应变量的深色覆盖值，不是额外的强调色。

#### 操作与状态

- **中性操作色：** `primary` 与 `primary-ink` 分别用于填充操作按钮与反色文字，深色主题反转两者的明暗关系。
- **焦点蓝色：** `focus` 用于自有键盘轮廓与输入框焦点边框。
- **语义状态色：** `green`/`green-bg` 表示活跃、已接纳、已批准或通过；`amber`/`amber-bg` 表示等待、过期、不确定状态及合成证据；`blue`/`blue-bg` 表示准备与证据进展；`red`/`red-bg` 表示失败、拒绝和错误。这些是状态含义，不是独立品牌色。

#### 中性色与阅读层次

- **页面与表面：** `canvas` 用于页面，`surface` 用于输入框、对话框、中性标签和选中的页签；`sidebar` 用于导航区域；`muted-surface` 用于表头、选中的导航、悬停、加载占位和次要容器。
- **文字：** `ink` 用于主要文字，`muted` 用于次要说明、时间戳和未激活导航。
- **分隔：** `line` 是轻量分隔线，`input-line` 是更醒目的输入框边界及次要按钮悬停边框。

**状态色规则：** 绿色、琥珀色、蓝色与红色用于解释状态、证据、反馈或焦点。主要操作保持中性，每种状态色都配有可见文字。

### 字体与排版

**正文字体：** 使用 `typography.body` 中声明的 Apple、Segoe UI、Noto Sans SC 系统字体栈，不使用装饰性展示字体。

**控件字体：** 库按钮与输入框保留 Tabler 的系统无衬线字体栈，分别记录在 `typography.control` 与 `typography.field` 中。这是系统回退字体，不是额外加载的品牌字体。自定义原生控件继承自有正文字体。

**等宽字体：** 事件载荷保留 Tabler 的界面等宽字体栈。已声明的数字计数与日期使用等宽数字。

#### 排版层次

- **`headline` / `headline-mobile`：** 页面标题；小屏断点使用较小的标题规格，字号分别为 25px 与 23px。
- **`detail-title`：** 详情面板中的记录身份，字号为 20px。
- **`title` / `subheading`：** 章节标题及详情子标题。
- **`body` / `description`：** 正文及页面说明，字号分别为 14px 与 13px。辅助说明与帮助文案的最大宽度为 70ch，空状态文案为 60ch。
- **`control` / `field`：** 按钮文字与库输入框的值，字号均为 13px，控件文字比字段值略粗。
- **`table` / `label`：** 密集记录、反馈与次要元数据，字号分别为 12px 与 11px。状态标签使用可读文字。
- **`brand`：** 桌面与移动导航中的紧凑 GhostFleet 标识。
- **`payload`：** 小字号、可换行的预格式化事件数据，字号为 11px。

字重、行高和字间距的完整数值见文件开头的配置。**任务层次规则：** 使用紧凑的标题、正文、表格与标签规格组织操作信息；最大的规格只用于页面标题，不增加装饰性展示字体。

### 布局

桌面框架包含固定侧栏（236px）、折叠侧栏（68px）及最小高度为 64px 的吸顶工具栏。内容随侧栏偏移，主内容居中，最大宽度为 1580px，桌面内边距按上、右、下、左依次为 `32px 32px 20px 32px`。间距变量记录现有 CSS 中的重复值，不对已交付界面强加新的统一网格。

概览由弹性主列与 310px 的工作队列组成，列间距为 26px。设置页面把说明与表单并排，章节最大宽度为 960px，表单宽度为 490px，列间距为 48px。这些是现有组合方式，不是每页必须遵循的模板。

响应布局使用以下精确的最大宽度媒体查询：

| 断点（最大宽度） | 实际行为 |
| --- | --- |
| 1200px | 工作队列收窄至 270px，概览列间距降至 20px，命令搜索触发控件宽度降至 150px，主内容左右内边距降至 26px。 |
| 1000px | 概览改为单列，工作队列排在记录之前；面包屑中的工作区前缀隐藏。 |
| 900px | 固定侧栏隐藏，内容取消侧栏偏移；导航以宽度为 260px 的原生模态对话框打开。主内容内边距改为 `26px 22px 18px 22px`。 |
| 640px | 顶部工具栏高度改为 60px，面包屑隐藏，顶部搜索触发控件改为图标，页面标题与操作区上下排列。主内容内边距改为 `23px 16px 16px 16px`。表格搜索占满工具栏一行，分页与页脚换行，设置页上下排列，详情面板占满屏幕宽度。 |

表格只在自身容器内横向滚动，滚动区域具有说明标签且可通过键盘聚焦。小屏断点下，首列固定可见，宽度限制在 180–210px；记录名与标识符在表格中截断，在详情中换行。记录名与排序控件的最小触摸高度为 44px，排序控件最小宽度也为 44px。标准按钮最小高度从 40px 提升至 44px；小型分页与列选择控件保留已定义的移动端 40px 最小高度。

### 层次与深度

视觉深度主要来自边框、悬停明暗与模态背景遮罩。表格和队列卡片不加装饰性阴影。选中的分段页签使用小阴影（`0 1px 2px #0000000d`），浮动列选择菜单使用菜单阴影（`0 6px 18px #00000012`），原生对话框背景遮罩以 `rgb(0 0 0 / .35)` 调暗当前上下文。其余浏览器或 Tabler 默认值不作为新增的自有层次变量。

**边框优先规则：** 静止状态下的表格与队列容器使用细边框及明暗分隔。小阴影只标识选中页签或浮动列菜单。

### 形状

控件与数据容器使用共享控件圆角；导航、反馈与菜单使用导航圆角；状态标签与命令结果使用标签圆角；计数和选中页签使用小圆角。居中对话框使用对话框圆角，全高详情面板与移动导航使用方角。

配置中的圆角为 `square: 0`、`small: 4px`、`badge: 5px`、`navigation: 6px`、`control: 7px`、`dialog: 10px`。边框通常为 1px，语义状态标签使用透明边框替代中性边框。小加载条与键盘按键提示局部使用 3px 圆角，欢迎面板使用 8px；这些局部值不扩充可复用的圆角尺度。

### 组件

#### 按钮

紧凑操作按钮采用控件文字规格、共享控件圆角、8px 的图标与文字间距，以及库定义的内边距。主要操作使用中性填充与反色文字，自有悬停及按下效果为 `brightness(.86)`。次要操作使用表面填充与分隔边框，悬停时改为次要表面及输入框边框色。破坏性操作的描边使用红色，悬停时增加浅红背景。图标按钮宽度为 40px，不设水平内边距，使用次要图标色与透明边框，悬停时显示次要表面。

自有背景色过渡为 150ms、`ease`。自有禁用控件使用 `.45` 透明度和 `not-allowed` 光标；Tabler 还会禁止禁用按钮的指针事件。**实现例外：** Tabler 的禁用及 `focus-visible` 按钮规则仍使用库变体颜色，包括主要按钮的蓝色；按钮焦点轮廓也使用库焦点变量。这些继承颜色不是主要调色板变量，也不作为中性主题的标准状态。

#### 输入框

输入框使用表面背景、主文字颜色、较强的输入边框、共享控件圆角与字段内边距。占位文字使用次要颜色且保持完全不透明。焦点时边框与轮廓改为焦点色，轮廓宽度为 2px、偏移为 2px。禁用文本框使用次要表面与次要文字。Tabler 保留边框、轮廓与阴影的 150ms、`ease-in-out` 过渡；自有焦点样式移除字段阴影。错误作为与当前界面关联的可见反馈显示，不另造红色输入框变体。

#### 导航

导航行静止时使用次要文字色，悬停时使用主文字色与次要表面；当前页面保留这些颜色并使用 600 字重。当前路由标记为 `aria-current="page"`。行最小高度为 42px，图标与文字间距为 10px，并附紧凑计数标签。桌面折叠后保留 SVG 图标和可访问标题；移动导航使用带可见关闭控件的原生对话框。

#### 状态标签与进度

状态标签采用紧凑、轻圆角、单行文字及配对的语义颜色。中性状态使用表面背景与分隔边框。状态映射遵循记录本身：已接纳、活跃和已批准使用绿色；等待、对账和过期使用琥珀色；失败与拒绝使用红色；准备、已领取和实体化中使用蓝色。能力风险标签保持中性，合成证据另带琥珀色文字标签。五步进度条使用分隔色顶边，已完成步骤使用绿色，当前步骤使用蓝色并标记 `aria-current="step"`。

#### 容器与表格

数据框与队列容器使用共享控件圆角和轻量分隔边框。数据框限制内部滚动区域的溢出；队列内边距为 17px，小屏为 15px。表格使用次要表头、轻量行分隔与次要表面悬停色。表头内边距为 `11px 14px`，单元格为 14px，小屏为 12px。记录名控件打开详情，排序按钮通过对应列头表达 `aria-sort`，列选择使用原生 `details` 与复选框。分页支持每页 10、25 或 50 行，不可用的上一页及下一页控件禁用。

#### 分段页签

次要表面轨道内放置紧凑页签，选中页签使用表面填充、主文字色与选中页签阴影。页签建立 `tablist`、`tab`、`tabpanel` 关系，键盘顺序中只保留一个选中页签，支持左、右、Home、End 导航。检查记录时保留筛选、排序、列选择与分页上下文；界面显示模型不代表服务端授权。

#### 对话框、详情面板与键盘

居中的创建及搜索对话框使用对话框圆角，宽度分别为 480px 与 560px，均不超过视口宽度减去 32px。详情面板贴靠右侧，最大宽度为 490px，高度为 `100dvh`，小屏时占满宽度。详情标题区吸顶，字段标签列为 115px，值占其余宽度；长标识符与载荷在详情中换行。

原生模态对话框将焦点限制在内部，支持 Escape、关闭控件及点击外部背景遮罩来关闭。Ctrl/Cmd K 打开命令搜索并聚焦查询框，上下箭头与 Enter 用于选择和打开结果；创建、详情或移动导航对话框打开时，该快捷键不再叠加搜索框。详情支持关联记录的回退导航，关闭时恢复原触发控件或页面标题的焦点。Escape 也可关闭列选择菜单并将焦点返回其摘要控件。可见的跳转链接帮助键盘用户进入主内容。

#### 反馈、权限、空状态与加载

反馈使用安静的中性容器，成功为绿色、错误为红色，权限与不确定状态提示为琥珀色。页面及创建、详情对话框中的状态消息使用礼貌且原子更新的实时区域（`aria-live="polite"`、`aria-atomic="true"`），让反馈在当前模态界面中保持可见。对话框内错误提供读取状态以恢复的操作；不可用的写入保持禁用，并以文字解释权限原因。结果为 `UNKNOWN` 时保持变更禁用，不自动重试。空状态与断连状态给出简短说明及实际可执行的下一步。

加载使用五行紧凑骨架占位及 `aria-busy`，占位脉冲持续 1.2s，使用 `ease-in-out` 并无限循环，中点透明度为 `.45`。全局自有键盘焦点使用 2px 焦点色轮廓，偏移为 3px；库按钮焦点遵循前述例外。`prefers-reduced-motion: reduce` 下移除所有动画与过渡。

图标使用自有内联 SVG，坐标网格为 24px，描边宽度为 1.7，端点与连接均为圆角，颜色跟随当前文字色。普通图标显示为 18px，表格排序图标为 14px，品牌与空状态图标为 28px。装饰性 SVG 对辅助技术隐藏，只含图标的按钮具有本地化可访问名称。

### 应做与禁止

应使用当前主题的语义变量表达表面、文字、边框、焦点与状态；保留可见状态词、合成证据标签、权限说明和对话框内恢复反馈。溢出应限制在带说明且可聚焦的表格区域，小屏保留首列。使用自有 SVG 图标并提供可访问文字或名称。检查记录时保留键盘焦点和列表上下文，核对两种语言与主题，并遵循减少动态效果的偏好。

不要把语义状态色用作装饰性品牌强调色，也不要把中性的主要操作改为蓝色品牌按钮。不要仅靠颜色说明状态、权限或操作结果，不要撑宽整个文档来容纳表格，也不要让详情中的长标识符强制保持单行。不可用操作不能画成可用，不确定反馈不能替换为乐观成功提示。避免装饰渐变、过大展示字体与硬边偏移阴影，不用字符图形或表情替代自有 SVG。


## English

<!-- topic:design -->
### Overview

**Creative North Star: "Professional administration"**

GhostFleet follows the professional administration conventions the user chose: quiet neutral surfaces, compact navigation, data-first typography, and familiar controls. Records, access scope, and the next available action should be easy to scan in Chinese and English.

The authored console stylesheet sets the reusable visual rules after Tabler core CSS. It maps Tabler body background, body color, and border color to the console tokens, while retaining library button and form mechanics. Light and dark themes keep the same hierarchy; the system preference is used until an explicit appearance preference is selected. The GhostFleet name remains the visual identifier.

**Key Characteristics:**

- Neutral light and dark surfaces with restrained semantic color.
- Compact shell, readable data rows, and border-led separation.
- Chinese by default, with an English switch and locale-aware dates and sorting.
- Native dialogs, visible keyboard focus, and preserved list context.

### Colors

The palette uses white and zinc in light mode, near-black zinc in dark mode, and readable semantic foreground/background pairs. The frontmatter retains the CSS custom-property names; every `dark-` token is the matching override, not an additional accent.

#### Primary

- **Neutral action:** `primary` and `primary-ink` provide the filled action and inverse label. Dark mode reverses their tonal relationship.
- **Focus blue:** `focus` supplies the authored keyboard outline and field focus border.
- **Status accents:** `green`/`green-bg` communicate active, accepted, approved, or passed states; `amber`/`amber-bg` communicate waiting, expired, uncertain, and synthetic evidence; `blue`/`blue-bg` communicate preparation and evidence progress; `red`/`red-bg` communicate failure, rejection, and errors. These are semantic accents, not separate brand identities.

#### Neutral

- **Canvas and surfaces:** `canvas` is the page; `surface` is the field, dialog, neutral chip, and selected tab; `sidebar` sets the navigation plane; `muted-surface` marks table headers, selected navigation, hover, skeletons, and secondary containment.
- **Reading hierarchy:** `ink` is primary text; `muted` is secondary text, timestamps, and inactive navigation.
- **Separation:** `line` is the quiet divider; `input-line` is the stronger field boundary and secondary-button hover border.

**The State Color Rule.** Use green, amber, blue, and red to explain status, evidence, feedback, or focus. Keep the primary action neutral and pair every status color with visible text.

### Typography

**Text font:** The authored Apple/Segoe UI/Noto Sans SC system stack in `typography.body`. There is no decorative display font.

**Control font:** Tabler’s system sans stack remains on library buttons and fields, as recorded in `typography.control` and `typography.field`. It is a system fallback stack, not a loaded brand font. Native custom controls inherit the authored body stack.

**Mono font:** Tabler’s UI monospace stack is retained for event payloads. Numeric counts and dates use tabular figures where authored.

#### Hierarchy

- **Headline / headline-mobile:** The page heading. The smaller role takes effect at the small-screen breakpoint.
- **Detail title:** The record identity inside the inspection sheet.
- **Title:** Section headings; **subheading** covers detail subsections.
- **Body / description:** Normal reading and page explanations. Supporting descriptions and help copy use a measured maximum of (70ch); empty-state copy uses (60ch).
- **Control / field:** Button labels and library field values. Control labels are slightly heavier than field values.
- **Table / label:** Dense records, feedback, and secondary metadata. Status labels remain readable words rather than icon-only signals.
- **Brand:** The compact GhostFleet wordmark in desktop and mobile navigation.
- **Payload:** Small, wrapping preformatted event data.

**The Task Scale Rule.** Use the compact headline, title, body, table, and label roles for operational hierarchy. Reserve the largest role for the page heading; do not introduce a decorative display face.

### Layout

The desktop shell has a fixed sidebar (236px), a compact sidebar state (68px), and a sticky topbar with a minimum height of (64px). Content follows the sidebar offset. Main content is centered within a maximum width of (1580px), with desktop padding of (32px 32px 20px). The spacing tokens record repeated values, rather than imposing a new uniform grid on the shipped CSS.

The overview uses a flexible main column and a work queue (310px) separated by (26px). The settings layout pairs a description and form, with a maximum section width of (960px), a form width of (490px), and a column gap of (48px). These are existing composition patterns, not mandatory page templates.

Responsive behavior uses these exact maximum-width queries:

| Breakpoint | Observed behavior |
| --- | --- |
| 1200px | Queue narrows to (270px), overview gap to (20px), command trigger to (150px), and main horizontal padding to (26px). |
| 1000px | Overview becomes one column; work queue precedes records. The workspace breadcrumb prefix hides. |
| 900px | Fixed sidebar hides, content loses its offset, and navigation opens as a native modal (260px wide). Main padding becomes (26px 22px 18px). |
| 640px | Topbar becomes (60px) high, breadcrumb hides, search becomes an icon, and page heading/actions stack. Main padding becomes (23px 16px 16px). Search fills the toolbar row; pagination and footer wrap; settings stack; detail sheet uses the full width. |

Tables scroll horizontally inside their frame. The scroll region is labeled and keyboard focusable. At the small breakpoint, the first column stays sticky, with bounded widths (180–210px); record names and identifiers truncate in the table and wrap in details. Row-name and sort controls have a minimum touch height of (44px), and sort controls have a minimum width of (44px). Standard buttons rise from a minimum height of (40px) to (44px); small pagination and column controls retain their authored (40px) mobile minimum.

### Elevation & Depth

Depth comes mostly from borders, hover tones, and the modal backdrop. Tables and queue cards do not receive decorative shadows. The selected segmented tab has a small shadow (`0 1px 2px #0000000d`); the floating column picker has a menu shadow (`0 6px 18px #00000012`). Native dialog backdrops dim the current context (`rgb(0 0 0 / .35)`). Any remaining browser or Tabler defaults are not additional authored elevation tokens.

**The Border First Rule.** At-rest tables and queue containers use thin borders and tonal separation. Small shadows identify a selected tab or a floating column menu.

### Shapes

Controls and data containers use the shared control radius. Navigation, feedback, and menus use the navigation radius; status badges and command results use the badge radius; counts and selected tabs use the small radius. Centered dialogs use the dialog radius, while full-height side sheets and mobile navigation have square edges. Borders are ordinarily (1px); semantic status badges replace the neutral border with a transparent border. The small loading bar and keyboard-key hint use a local radius of (3px), and the welcome panel uses (8px); these local values do not extend the reusable radius scale.

### Components

#### Buttons

Compact actions combine the control type role, shared control radius, an icon/text gap of (8px), and library padding. Primary actions use neutral fill and inverse text. Their authored hover and active treatment uses `brightness(.86)`. Secondary actions use surface fill with a line border, changing to muted surface and input border on hover. Destructive outlines use red and gain the red tint on hover. Icon buttons are (40px) wide with no horizontal padding, muted icons, and a transparent border; hover reveals a muted surface.

The authored transition is background color (150ms, ease). Authored disabled controls use opacity (.45) and a not-allowed cursor. Tabler additionally suppresses pointer events on disabled buttons. **Implementation exception:** Tabler’s disabled and focus-visible button rules still resolve library variant colors, including blue on primary actions, and its button focus outline uses library focus variables. Those inherited colors are not primary-palette tokens and are not canonized as neutral-theme states.

#### Inputs / Fields

Fields use surface fill, ink text, the stronger input border, shared control radius, and field padding. Placeholders use muted text at full opacity. Focus changes the border and outline to the focus token, with an outline width of (2px) and offset of (2px). Disabled text fields use muted surface and text. Tabler retains a (150ms, ease-in-out) border, outline, and shadow transition; authored focus removes its field shadow. Errors appear as visible feedback associated with the active surface rather than an invented red-field variant.

#### Navigation

Navigation rows are muted at rest, gain ink and muted surface on hover, and retain those colors with weight (600) on the current page. The active route uses `aria-current="page"`. Rows have a minimum height of (42px), an icon/text gap of (10px), and compact count pills. Desktop collapse keeps the SVG symbols and accessible title; mobile navigation uses a native dialog with a visible close control.

#### Status Chips and Progress

Status chips are compact, softly rounded, single-line labels using paired semantic colors. Neutral status uses a surface fill and line border. Status mapping follows the record state: accepted/active/approved are green; waiting/reconciliation/expiry are amber; failed/rejected are red; preparing/claimed/materializing are blue. Capability risk labels remain neutral. Synthetic evidence carries a separate amber text label. The five-step progress strip uses line-colored top rules, green completed steps, and a blue current step with `aria-current="step"`.

#### Cards / Containers and Tables

Data frames and queue containers use the shared control radius and quiet line border. Frames clip their internal scroll region; queue padding is (17px), reduced to (15px) on small screens. Tables use muted headers, light row dividers, and a muted-surface hover. Header padding is (11px 14px); cell padding is (14px), reduced to (12px) on small screens. Record-name controls can open details, sort buttons expose `aria-sort` through their column header, and column selection uses native details/checkbox controls. Paging supports (10), (25), or (50) rows, with unavailable previous/next controls disabled.

#### Segmented Tabs

A muted-surface track contains compact tabs. The selected tab uses surface fill, ink text, and the selected-tab shadow. Tabs implement `tablist`, `tab`, and `tabpanel` relationships, one selected tab in the tab order, and left/right/Home/End navigation.

Record inspection preserves filter, sort, column and pagination context; the display model does not grant server authority.

#### Dialogs and Detail Sheets

Centered create and search dialogs use the dialog radius and a viewport-bounded width: creation (480px), search (560px), each capped at viewport width minus (32px). The detail sheet attaches to the right at up to (490px), fills (100dvh), and becomes full-width on small screens. Its header stays sticky; record fields use label/value columns (115px / remaining width). Detail content wraps long identifiers and payloads.

Native modal behavior contains focus and supports Escape. Close controls and outside-backdrop clicks dismiss dialogs. Command search opens with Ctrl/Cmd K, focuses its query, and uses up/down arrows and Enter to select/open results. The command shortcut does not open over creation, details, or mobile navigation. Detail navigation supports related-record backtracking and restores the originating control, or the page heading, when closed. Escape also closes the column picker and returns focus to its summary. A visible skip link moves keyboard users into main content.

#### Feedback, Permissions, Empty and Loading States

Feedback uses quiet neutral containment, green success, or red error. Permission and uncertain-state banners use amber. Status messages are polite, atomic live regions in the page and in create/detail dialogs, so feedback remains visible in the active modal. In-dialog errors expose a read-state recovery action; unavailable writes remain disabled with a textual permission explanation. Empty and disconnected states provide short guidance with real next actions. Loading uses five compact skeleton rows and `aria-busy`; the placeholder pulse lasts (1.2s, ease-in-out, infinite), reaching opacity (.45) at its midpoint.

An `UNKNOWN` outcome keeps mutation disabled and does not trigger automatic retry.

The authored global keyboard focus is a (2px) focus-colored outline with offset (3px); library button focus is the exception described above. All animations and transitions are removed under `prefers-reduced-motion: reduce`. Icons use authored inline SVGs on a (24px) coordinate grid, stroke width (1.7), rounded caps/joins, and current text color. Normal icons render at (18px), table sort icons at (14px), and brand/empty-state icons at (28px). Decorative SVGs are hidden from assistive technology; icon-only buttons receive a localized accessible name.

### Do's and Don'ts

#### Do:

- **Do** use the active theme’s semantic tokens for surfaces, text, borders, focus, and status.
- **Do** preserve visible status words, synthetic-evidence labels, permission explanations, and in-dialog recovery feedback.
- **Do** keep overflow inside a labeled, focusable table region and keep the first record column visible on small screens.
- **Do** use authored SVG symbols with accessible text or an accessible name on icon-only controls.
- **Do** preserve keyboard focus, filter state, sort state, column selection, and pagination when inspecting a record.
- **Do** check both languages and themes, and disable animation and transitions for reduced-motion preferences.

#### Don't:

- **Don’t** use semantic status colors as decorative brand accents or replace the neutral primary action with a blue brand color.
- **Don’t** rely on color alone to communicate state, permission, or an operation result.
- **Don’t** widen the document to fit a dense table or force long record identifiers onto an unbroken line in detail content.
- **Don’t** make an unavailable action look available or replace uncertain operation feedback with an optimistic success message.
- **Don’t** introduce decorative gradients, oversized display typography, or hard offset shadows into this established admin interface.
- **Don’t** use glyphs or emoji in place of the authored interface SVGs.
