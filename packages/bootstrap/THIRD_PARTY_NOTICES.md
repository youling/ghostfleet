# Third-Party Notices / 第三方说明

## 中文

<!-- topic:notices -->
### Tabler

- `@tabler/core@1.6.1`，MIT；upstream：https://github.com/tabler/tabler。
- 只 bundlecompiledcoreCSS，Console 交互用 nativeHTML/JavaScript；排除 unusedTablerJavaScript 与 optionalvendorplugins。
- 版权保留 2018–2026TheTablerAuthors 与 codecalm.netPawełKuna，如 packageartifactheader。
- 完整 MIT 文本见`Tabler-LICENSE.txt`；来源 upstreammasterrevision`f7c848a9382d1f806d569d3866c0e02b8709c340`，为 packageheader 链接的源代码。Npm 包缺独立 LICENSE 且审阅时没有 v1.6.1GitTag，不宣称源代码/artifactversionmatch。
- Build 将本 notice 放`dist/console/third-party/THIRD_PARTY_NOTICES.md`；发布保留适用 upstreamlicensenotices。

### Model Context Protocol SDK

- `@modelcontextprotocol/sdk@1.32.0`，MIT；upstream：https://github.com/modelcontextprotocol/typescript-sdk；copyright2024Anthropic,PBC。
- Consolebuild 保留完整 license 至`third-party/MCP-SDK-LICENSE.txt`；Worker 使用 officialserver/WebStandardsStreamableHTTPtransport，verifier 使用 officialclient。

### Optional packages

typed-control 直接依赖 Microsoftdev-tunnels-ssh/keys、buffer、Zod、jose；runtimePython 依赖 PyYAML，测试扩展依赖是 pytest，Android 扩展依赖是 uiautomator2。精确版本与依赖 license 以 rootlock/package 元数据、Pythonpyproject 和随产物保留的 license 为准。不是将 thirdpartycode 重新许可为 AGPL；所有 transitive/vendorednotice 发布前核对。代码迁入 genericowner 许可与 sourceaudit 另外保留；不需要公开私有实例事实。



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
