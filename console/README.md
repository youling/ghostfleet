# GhostFleet 控制面板 / Control Panel

## 中文

`console/` 是 GhostFleet 面向 Human 的 canonical Control Panel 产品目录。

```text
console/
  index.html              # 页面入口
  app.js                  # 当前装配/编排入口
  shared/                 # 复用展示基础
  enrollment/             # 纳管 UX 与管理模板
  nodes/                  # 节点列表与详情
  capabilities/           # 能力目录
  privilege/              # JIT 提权审批与租约
  recovery/               # 恢复与 break-glass
  settings/               # 控制面板设置
```

这些产品域目录先冻结 ownership 与未来落点，不代表对应功能已经实现。它们不得建立第二套 lifecycle、authority、secret vault 或 backend。服务端事实仍由 `src/core`、`src/control-plane`、adapters 与 integrations 持有。

后续 Control Panel 功能应进入最窄的 owning domain，避免继续把所有逻辑堆进 `app.js`。

## English

`console/` is the canonical Human-facing GhostFleet Control Panel product surface. The domain directories reserve ownership and future placement only; they do not create a second lifecycle, authority store, secret vault, or backend. Server-side truth remains under `src/core`, `src/control-plane`, adapters and integrations.

New Control Panel features should land in the narrowest owning domain rather than growing `app.js` indefinitely.
