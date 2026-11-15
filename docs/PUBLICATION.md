# 公开边界检查 / Publication boundary

## 中文

CI 对当前提交的全部 Git tracked 文件运行 `scripts/publication-guard.mjs`。本仓只交付 UTF-8 文本：NUL、UTF-16、非法 UTF-8、符号链接、非普通文件和缺失的 tracked 文件均报错，不静默跳过。

文本规则识别常见私钥头（含 DSA/ENCRYPTED）、已知 token/credential 形状、单独 tailnet 域名及机器 MagicDNS 名、节点 UUID、用户专属 home 路径、私有仓链接、带用户信息的 URL 和未经审核的 URL。规则只识别已列出的形状，不承诺发现任意编码或所有供应商的秘密。Cloudflare `cfast_` 采用 [2026-11-11 官方表达式](https://developers.cloudflare.com/changelog/post/2026-11-11-leaked-service-token-recovery/)，不校验 checksum 或凭据是否有效。

示例用 `.invalid` 保留域名。`publication-policy.json` 分别列出已审核的公共文档主机和准确的公共 GitHub 仓库路径；允许本公开仓与 ai-use 的出处链接，不放行整个 GitHub。新增来源要核对上游身份和页面，再在同一 PR 更新规则。不要添加宽泛路径或内容豁免。

提交前将预期文件加入 Git 跟踪，然后运行：

```sh
node scripts/publication-guard.mjs
node --test test/publication-guard.test.mjs
```

合成测试在运行时拼接假凭据，不把完整样本提交到仓库。扫描诊断只输出文件、行号和规则，不打印匹配到的秘密。本检查只服务公开源码发布，不监控运行中的主机或命令。

## English

CI scans every Git-tracked file in the checked-out commit. This repository ships UTF-8 text only: NUL/UTF-16, invalid UTF-8, symlinks, non-regular files and missing tracked files fail instead of being silently skipped.

Text rules detect listed private-key/credential shapes, tailnet domains and machine locators, node UUIDs, personal home paths, private-repository links, URL user information and unreviewed URLs. This bounded guard does not detect every secret or encoding. The Cloudflare candidate-secret expression follows the official changelog linked above; it does not validate checksums or token activity.

Use reserved `.invalid` names. Public hosts and exact GitHub repository paths are reviewed separately in the policy. Public project provenance links are permitted without allowing all GitHub content. Review additional destinations in the same PR; do not introduce broad exemptions. Track intended files and run the two commands above. Tests construct synthetic credentials at runtime; diagnostics never print matched secret values. This is a source-publication check, not runtime command monitoring.
