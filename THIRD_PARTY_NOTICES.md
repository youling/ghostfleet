# Third-Party Notices

## Tabler

- Project: Tabler
- Upstream: `https://github.com/tabler/tabler`
- Package used by V0: `@tabler/core@1.6.1`
- License: MIT
- Used files: compiled core CSS only. Native HTML/JavaScript implements current Console interactions; unused Tabler JavaScript and optional plugins are not bundled.
- Copyright: 2018-2026 The Tabler Authors; 2018-2026 codecalm.net Paweł Kuna (as preserved in package artifact headers).
- Full MIT text: `Tabler-LICENSE.txt`, retrieved from upstream master at `f7c848a9382d1f806d569d3866c0e02b8709c340`, the source linked in the package's license header. The npm package omits a standalone LICENSE and no `v1.6.1` Git tag was available during review; this notice does not claim a source/artifact version match.
- The Console build copies this notice into `dist/console/third-party/THIRD_PARTY_NOTICES.md`; the project release process must preserve applicable upstream license notices.

GhostFleet V0 intentionally excludes optional `dist/libs` vendor plugins.

## Model Context Protocol SDK

- Package: `@modelcontextprotocol/sdk@1.32.0`
- Upstream: `https://github.com/modelcontextprotocol/typescript-sdk`
- Copyright: 2024 Anthropic, PBC.
- License: MIT; the Console build preserves the package's full license in `third-party/MCP-SDK-LICENSE.txt`.
- The Worker uses the official server and Web Standards Streamable HTTP transport. The smoke verifier uses the official client.
