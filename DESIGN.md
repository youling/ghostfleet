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

沿用专业后台惯例：中性浅色/深色 surface、紧凑 navigation、数据优先 typography 与熟悉 controls。中文/English 同一层次，状态、accessscope 与下一 action 清晰可扫。TablerCSS 之后的自写 stylesheet 映射 body/background/border tokens，不复制外部参考 code；Theme 采用 system 直到用户明确选择。

### 色彩与字体

Frontmatter 是 machine-readableCSS 对应 tokens，dark-*是同一 token 的覆盖而非额外品牌色。Light 使用 white/zinc，dark 使用近黑 zinc；primary/primary-ink 反转中性色，focus 使用可辨蓝色。Green=active/accepted/approved，amber=waiting/对账/expiry，red=failed/rejected，blue=preparing/claimed/materializing。Synthetic 另用 amber 文字，不以颜色代替状态。

系统字体与 NotoSansSC fallback 避免 runtimefont 依赖，payload 使用 monospace。Headline25px/mobile23px，detailtitle20px，body14px，description/control/field13px，table12px，label/payload11px；权重/行高/spacing 完整数值在 frontmatter。LongID 在 tabletruncate、detailswrap，不让页面横向溢出。

### 布局、深度与形状

Desktop 侧栏可 collapse，mobile 使用 native navigation dialog。宽 table 只在带 label/focus 的 frame 内滚动；small 首列 sticky180–210px。Record/sort 触摸目标 44px，standardbutton40px/mobile44px，smallpaging/columns 按 40pxminimum。层次主要靠 1pxborder/hovertone，queue/table 无装饰 shadow；selectedtab 与 floatingcolumnmenu 用轻 shadow，nativebackdrop 暗化当前 context。

Radius 遵循 frontmatter：square0、small4px、badge5px、navigation6px、control7px、dialog10px。Sidebar/detail sheet 方角，少量 local3px/8px 值不扩全局 scale。Spacing 只用声明的 4–32px 层次，不把 semanticcolor 当 brand 装饰。

### Buttons、fields、navigation

Primary 中性填充，hover/activebrightness(.86)，secondarysurface+border/hovermuted，dangeroutline/redtint，iconbutton40px/currentColor。Transition150ms，disabledopacity.45 及 notallowed；Tabler 继承的 disabled/focusprimaryblue 是库 exception，不 canonize 为中性 theme。

Fieldsurface/ink 与较强 inputborder，placeholdermuted，focus2pxoutline+2pxoffset，无额外 shadow；error 在当前 modal 可见 feedback。Navigationrestmuted、hover/currentink+mutedsurface、currentweight600，aria-current=page；rows42px、icons/accessiblelabels 保留，desktopcollapse 保留 title，mobile 可明确关闭。

### Chips、tables、tabs

Statechip 使用 semanticforeground/background 与文字，riskchip 中性。五步 progress 使用 completedgreen/currentblue 和 aria-current=步骤。Queuepadding17px/mobile15px，tableheaders11px14px/cells14px/mobile12px、mutedhover、aria-sort、nativecolumncheckbox；pagination10/25/50rows，边界 disabled。

Segmentedtabs 实现 tablist/tab/tabpanel、single selectedtab 及 left/right/Home/End 键盘导航。Selectedsurfacefill+轻 shadow。查看 detail 时保留 filter/sort/column/page，不把 displaymodel 当 serverauthority。

### Dialog、detail 与 keyboard

Create480px/search560px 受 viewportminus32px 限制；detail 右侧 max490px/100dvh，smallfullwidth，stickyheader，label/value115px/rest。Longidentifiers/payloadwrap。Nativemodalcontainfocus/Escape/backdropdismiss；Ctrl/CmdK 搜 record，up/down/Enter 选，creation/detail/mobilemodal 中不开第二 search。

关闭恢复原 control 或 pageheading，relatedrecord 可 backtrack；Esc 关闭 columnmenu 后返 focus，skiplink 进入 main。Dialog 里 error/读取-状态恢复可见，UNKNOWNmutationdisable/不自动重试。

### Feedback、权限与 accessibility

Neutral/successgreen/errorredfeedback，权限/uncertainbanneramber。Politeatomicliveregion 在 page 与 dialog 中；只读/unavailableactions 提供文字原因，empty/disconnected 给实际 nextstep。Loading 五 skeletonrows 与 aria-busy，pulse1.2s/opacity.45；prefers-reduced-motion 关闭所有 animations/transitions。

全局 focus2pxoutline/3pxoffset，库 buttonfocus 保留已说明 exception。InlineSVG24grid/stroke1.7/roundcap/currentColor，normal18px/sort14px/brand28px；decorative 隐藏辅助技术，icon-only 有 localizedname。不能用 emoji/glyph 替代 SVG。

### 应做与禁止

使用 active-theme 语义 tokens、状态文字、合成 labels 与权限说明；保留 visiblefocus、listcontext、two-language/theme 与 reducedmotionchecks。避免装饰 gradient、oversizeddisplaytype、offsethardshadow；不以颜色独传状态，不把 unavailable/unknown 画成 available/success，不为表格撑宽 document。实际 tokens 与 implementationexceptions 以 frontmatter、CSS 和下方 English 详细 reference 共同核对。


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

#### Dialogs and Detail Sheets

Centered create and search dialogs use the dialog radius and a viewport-bounded width: creation (480px), search (560px), each capped at viewport width minus (32px). The detail sheet attaches to the right at up to (490px), fills (100dvh), and becomes full-width on small screens. Its header stays sticky; record fields use label/value columns (115px / remaining width). Detail content wraps long identifiers and payloads.

Native modal behavior contains focus and supports Escape. Close controls and outside-backdrop clicks dismiss dialogs. Command search opens with Ctrl/Cmd K, focuses its query, and uses up/down arrows and Enter to select/open results. The command shortcut does not open over creation, details, or mobile navigation. Detail navigation supports related-record backtracking and restores the originating control, or the page heading, when closed. Escape also closes the column picker and returns focus to its summary. A visible skip link moves keyboard users into main content.

#### Feedback, Permissions, Empty and Loading States

Feedback uses quiet neutral containment, green success, or red error. Permission and uncertain-state banners use amber. Status messages are polite, atomic live regions in the page and in create/detail dialogs, so feedback remains visible in the active modal. In-dialog errors expose a read-state recovery action; unavailable writes remain disabled with a textual permission explanation. Empty and disconnected states provide short guidance with real next actions. Loading uses five compact skeleton rows and `aria-busy`; the placeholder pulse lasts (1.2s, ease-in-out, infinite), reaching opacity (.45) at its midpoint.

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
