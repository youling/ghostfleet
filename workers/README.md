# workers/ — canonical public-edge implementations

**中文**

本目录是 GhostFleet 公开边缘面的**唯一代码来源**：

- [`assets/`](assets/README.md)：不可变材料源（内容寻址只读）。
- [`enroll/`](enroll/README.md)：一次性纳管入口（无需 Access 的窄桥）。
- [`node/`](node/README.md)：节点 Agent 入口（节点凭据而非 operator bearer 的三条窄路由）。

私有部署仓**不得**再维护第二份实现。它只保留部署配置（`wrangler` 覆盖：`routes`/custom domain、binding 名称与参数、可选限流 namespace、Access 计划），并像其它 vendored 闭包一样**逐字节 vendor** 本目录下的 `src/index.js`。任何安全边界变更先改这里，再用同一提交 vendor 过去；这样不会出现两份实现悄悄分叉。

配置面契约写在各自的 README 里：binding 名称、必填/可选、路由前缀、body 上限常量与错误码清单。

## English

This directory is the **single source of truth** for GhostFleet's public edge:

- [`assets/`](assets/README.md): the immutable content-addressed material origin.
- [`enroll/`](enroll/README.md): the narrow one-time enrollment bridge (no Access login).
- [`node/`](node/README.md): the node agent ingress (three narrow routes carrying a node credential, not the operator bearer).

A private deployment repository must **not** keep a second implementation. It
keeps deployment configuration only (`wrangler` overlays: `routes`/custom domain,
binding names and parameters, optional rate-limit namespaces, Access plan) and
**vendors** each `src/index.js` byte for byte, like any other vendored closure.
Change a security boundary here first, then vendor it in the same commit, so two
implementations cannot drift apart.

The configuration contract lives in each worker's README: binding names,
required/optional, route prefixes, body-limit constants and the error-code list.
