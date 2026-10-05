# Publication boundary / 公开边界

## 中文

<!-- topic:snapshot -->
### 公开快照和数据

只导出经review的通用source/contracts/tests，保留publicpackage与thirdpartylicense，不搬privateGit历史。Publicprovenance只陈述通用来源/许可；exactprivatesource与excludedpath审计留在受保护owner。真实node/provider/account/endpoint/topology、secretrefs/values、rawreceipts/logs、screenshots和运行数据不得放publictree、PR、CIartifact或release。

演示/测试必须独立重建syntheticfixtures，使用文档保留IP、example域名和temporarypaths；不能从真实UID变形得到fixture。已审syntheticConsole图片按exactSHA绑定，新增/改变后重新视觉review。

<!-- topic:guard -->
### 执行 guard

```sh
npm run check:publication
npm run check:docs
```

publicationguard使用tracked与nonignored新文件清单，拒路径越界/symlink、私有artifact路径、未知binary/encoding或超预算。检查有限token/PEM/Authorization/quotedcredential/JWT形状、IPv4/IPv6、providerkey、NodeUID、tailnet、home路径、email及defaultAIprovider耦合。结果仅rule/path/line，不输出匹配值；sensitivepath被遮蔽。

这是有限模式guard，不是DLP：不是所有secretprefix/JWT/跨行literal/编码key都可识别，动态拼接、加密、复杂encoding与真实alias需要另一个受保护privatevalue审计与review。source通过不替代打包产物、sourcemap、logs、tar/zipmetadata、release与图片审查。

<!-- topic:exceptions -->
### 误报和例外

`publication-policy.json`的fixtureexception绑定exactpath、rule、matchedvalueSHA或整source-lineSHA、inert理由与类型；真实秘密不能allowlist。Detector中keyformatmarker和Windowsversion/broadcastrejection常量可单点评审，但不能把整个test文件、directory、CGNATrange或tokenprefix放行。失效exception会失败。

publiccontact例外只允许exactaddress+path+理由，不放行整个domain。binaryreview绑定文件SHA、purpose、review。Publicdefaultentry/package不能新增OpenAI/ChatGPT依赖；专有clientcompatibility需单独可选adapter和exactreview，不通过广泛路径exemption。

<!-- topic:review -->
### 发布检查与处置

提交前在cleanpubliccheckout执行完整tests/build/guards。检查机器exportmanifest只含publicpaths/status/exports/tests；documentlink与中英topic结构通过后再独立审语义。发现可能实际secret时停止传播该内容，只报告redactedpath/rule；由credentialowner核对rotation/revocation，不自行复制、replay或公开诊断值。

公开CI无provider/device或私仓secret，无selfhosted设备、部署或pull_request_target。发布前审license与依赖；sourcePR、正式release、productiondeployment与privatecutover分别验收。

## English

<!-- topic:snapshot -->
### Public snapshots and data

Export reviewed generic source/contracts/tests with public package and third-party licensing, never private Git history. Public provenance describes generic origin/licensing; exact private-source and exclusion audits stay with protected owners. Real node/provider/account/endpoint/topology, secret references/values, raw receipts/logs/screenshots and runtime state belong in neither the public tree nor PRs, CI artifacts or releases.

Rebuild demonstrations/tests as independent synthetic fixtures using documentation IPs, example domains and temporary paths; never derive a fixture by modifying a real UID. Reviewed synthetic Console images bind exact SHA and require fresh visual review after changes.

<!-- topic:guard -->
### Run the guard

```sh
npm run check:publication
npm run check:docs
```

The publication guard inventories tracked and nonignored new files. It rejects path escapes/symlinks, private artifact paths, unknown binary/encoding and scan-budget overruns. It checks bounded token/PEM/Authorization/quoted-credential/JWT shapes, IPv4/IPv6, provider keys, Node UIDs, tailnet locators, home paths, email and default AI-provider coupling. Results contain only rule/path/line, never matched values; sensitive paths are redacted.

This is a bounded pattern guard, not DLP. It does not recognize every secret prefix, JWT, multiline literal or encoded key. Dynamic construction, encryption, complex encodings and actual aliases require separate protected private-value audit and review. Passing source checks does not replace package/source-map/log/archive-metadata/release/image review.

<!-- topic:exceptions -->
### False positives and exceptions

Fixture exceptions in `publication-policy.json` bind exact path, rule, matched-value SHA or whole source-line SHA, inert reason and kind; real secrets cannot be allowlisted. Detector key-format markers and Windows version/broadcast-rejection constants may receive specific review, never a blanket exemption for a test file, directory, CGNAT range or token prefix. Stale exceptions fail.

Public contact exceptions bind exact address, path and reason, not an entire domain. Binary reviews bind file SHA, purpose and review. Default entry points/packages cannot acquire OpenAI/ChatGPT dependencies; proprietary client compatibility requires a separate optional adapter and exact review, not broad path exemptions.

<!-- topic:review -->
### Publication review and handling

Before submission, run full tests/builds/guards in a clean public checkout. Machine export manifests contain only public paths/status/exports/tests. After document links and bilingual topic structure pass, review semantic parity independently. If a real secret may be present, stop propagating that content and report redacted path/rule only; credential owners determine rotation/revocation. Do not copy, replay or publicly diagnose secret values.

Public CI has no provider/device/private-repository secrets, self-hosted hardware, deployment or pull_request_target. Review licenses and dependencies before publication. Source PR acceptance, formal release, production deployment and private cutover are separate decisions.
