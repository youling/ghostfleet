# Third-Party Notices / 第三方说明

## 中文

<!-- topic:notices -->
### Tabler

- `@tabler/core@1.6.1`，MIT；上游：`https://github.com/tabler/tabler`。
- 只打包编译后的核心 CSS，Console 交互使用原生 HTML 与 JavaScript；排除未使用的 Tabler JavaScript 与可选供应商插件，包括 `dist/libs` 下的插件。
- 保留包产物头部中的版权声明：2018–2026 The Tabler Authors；2018–2026 codecalm.net Paweł Kuna。
- 完整 MIT 文本见 `Tabler-LICENSE.txt`，取自上游 `master` 提交 `f7c848a9382d1f806d569d3866c0e02b8709c340`，该源码由包的许可头链接。npm 包缺少独立 `LICENSE`，且审阅时没有可用的 `v1.6.1` Git 标签；本说明不宣称源码版本与产物版本匹配。
- 构建将本说明放入 `dist/console/third-party/THIRD_PARTY_NOTICES.md`；项目发布过程须保留适用的上游许可说明。

### Model Context Protocol SDK

- `@modelcontextprotocol/sdk@1.32.0`，MIT；上游：`https://github.com/modelcontextprotocol/typescript-sdk`；版权：2024 Anthropic, PBC.
- Console 构建将完整许可保留至 `third-party/MCP-SDK-LICENSE.txt`；Worker 使用官方服务端与 Web Standards Streamable HTTP 传输，冒烟验证使用官方客户端。

### 可选包

`typed-control` 直接依赖 Microsoft 的 `dev-tunnels-ssh` 与 `dev-tunnels-ssh-keys`、buffer、Zod 和 jose。Python 运行时依赖 PyYAML，测试扩展依赖 pytest，可选 Android 扩展依赖 uiautomator2。精确版本与依赖许可以根锁文件及包元数据、Python `pyproject` 和产物中保留的许可为准。第三方代码不改用 AGPL 重新许可；发布前须核对全部传递依赖及随附供应商代码的说明。迁入通用代码的所有者许可与来源审计另行保留，无需公开私有实例信息。



### 当前直接依赖清单

Node 包版本与许可来自本提交的 package-lock 元数据；Python 三个固定版本的 MIT 许可已按各自 PyPI 主来源核对。第三方许可不由本项目改写。

| 依赖 | 固定版本 | 许可 |
| --- | --- | --- |
| `@tabler/core` | `1.6.1` | MIT |
| `@modelcontextprotocol/sdk` | `1.32.0` | MIT |
| `@microsoft/dev-tunnels-ssh` | `3.12.42` | MIT |
| `@microsoft/dev-tunnels-ssh-keys` | `3.12.42` | MIT |
| `buffer` | `6.0.3` | MIT |
| `zod` | `4.6.5` | MIT |
| `jose` | `6.2.12` | MIT |
| [PyYAML](https://pypi.org/project/PyYAML/6.0.3/) | `6.0.3` | MIT |
| [pytest](https://pypi.org/project/pytest/8.4.2/) | `8.4.2` | MIT |
| [uiautomator2](https://pypi.org/project/uiautomator2/3.7.0/) | `3.7.0` | MIT |

`typescript`、`vitest`、`@types/node`、`wrangler`、Python 构建工具及传递依赖仅按实际锁定构建图使用，发布对应产物时仍须保留其完整许可。迁移的通用源码沿用项目 AGPL-3.0-only；每个包包含对应源码、LICENSE 和本说明。安装依赖时从上游包取得完整第三方许可，不把只有版本表当作完整许可文本。

## English

<!-- topic:notices -->
### Tabler

- Project: Tabler
- Upstream: `https://github.com/tabler/tabler`
- Package used by V0: `@tabler/core@1.6.1`
- License: MIT
- Used files: compiled core CSS only. Native HTML/JavaScript implements current Console interactions; unused Tabler JavaScript and optional plugins are not bundled.
- Copyright: 2018-2026 The Tabler Authors; 2018-2026 codecalm.net Paweł Kuna (as preserved in package artifact headers).
- Full MIT text: `Tabler-LICENSE.txt`, retrieved from upstream master at `f7c848a9382d1f806d569d3866c0e02b8709c340`, the source linked in the package's license header. The npm package omits a standalone LICENSE and no `v1.6.1` Git tag was available during review; this notice does not claim a source/artifact version match.
- The Console build copies this notice into `dist/console/third-party/THIRD_PARTY_NOTICES.md`; the project release process must preserve applicable upstream license notices.

GhostFleet V0 intentionally excludes optional `dist/libs` vendor plugins.

### Model Context Protocol SDK

- Package: `@modelcontextprotocol/sdk@1.32.0`
- Upstream: `https://github.com/modelcontextprotocol/typescript-sdk`
- Copyright: 2024 Anthropic, PBC.
- License: MIT; the Console build preserves the package's full license in `third-party/MCP-SDK-LICENSE.txt`.
- The Worker uses the official server and Web Standards Streamable HTTP transport. The smoke verifier uses the official client.

### Optional packages

Typed control directly depends on Microsoft dev-tunnels-ssh/keys, buffer, Zod and jose. The Python runtime depends on PyYAML, with pytest for tests and uiautomator2 in the optional Android extra. Exact versions and dependency licenses are defined by root lock/package metadata, Python pyproject and licenses retained in artifacts. Third-party code is not relicensed as AGPL; verify all transitive/vendored notices before publication. Generic-owner licensing and source audit remain separately preserved without publishing private instance facts.


### Current direct dependency inventory

Node versions/licenses come from this commit's package-lock metadata. MIT licenses for the three pinned Python versions were checked against their linked primary PyPI sources. This project does not rewrite third-party licensing.

| Dependency | Pinned version | License |
| --- | --- | --- |
| `@tabler/core` | `1.6.1` | MIT |
| `@modelcontextprotocol/sdk` | `1.32.0` | MIT |
| `@microsoft/dev-tunnels-ssh` | `3.12.42` | MIT |
| `@microsoft/dev-tunnels-ssh-keys` | `3.12.42` | MIT |
| `buffer` | `6.0.3` | MIT |
| `zod` | `4.6.5` | MIT |
| `jose` | `6.2.12` | MIT |
| [PyYAML](https://pypi.org/project/PyYAML/6.0.3/) | `6.0.3` | MIT |
| [pytest](https://pypi.org/project/pytest/8.4.2/) | `8.4.2` | MIT |
| [uiautomator2](https://pypi.org/project/uiautomator2/3.7.0/) | `3.7.0` | MIT |

Build-only typescript, vitest, @types/node, wrangler, Python build tools and transitive dependencies follow the actual locked build graph; preserve their full licenses in applicable artifacts. Extracted generic source uses project AGPL-3.0-only; each package includes corresponding source, LICENSE and these notices. Dependency installations obtain full licenses from upstream packages; a version table is not a substitute for complete license text.
