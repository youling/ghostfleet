# Publication boundary / 公开边界

## 中文

<!-- topic:snapshot -->
### 公开快照和数据

只导出经过审阅的通用源码、契约和测试，保留公开包及第三方许可，不迁入私有 Git 历史。公开来源说明只陈述通用来源和许可；精确私有源码与排除路径的审计由受保护责任方保管。真实节点、提供方、账户、端点、拓扑、秘密引用与值、原始回执、日志、截图和运行数据不得进入公开文件树、PR、CI 产物或发布包。

演示和测试须独立重建合成样本，使用文档保留 IP、示例域名和临时路径；不能修改真实 UID 后当作样本。已审阅的合成控制台图片绑定精确 SHA，新增或修改后须重新视觉审阅。

<!-- topic:guard -->
### 执行公开边界检查

```sh
npm run check:publication
npm run check:docs
```

公开边界检查列出已跟踪文件及未被忽略的新文件，拒绝路径越界、符号链接、私有产物路径、未知二进制或编码及超过扫描预算的内容。它检查有限的令牌、PEM、Authorization、引号内凭据和 JWT 形状，以及 IPv4/IPv6、提供方密钥、节点 UID、tailnet 定位信息、用户主目录路径、邮箱和默认 AI 提供方耦合。结果只含规则、路径与行号，不输出匹配值，敏感路径会被遮蔽。

这是有限模式检查，不是完整的数据泄漏防护（DLP）。它无法识别所有秘密前缀、JWT、跨行字面量或编码密钥；动态拼接、加密、复杂编码和真实别名需要单独受保护的私有值审计与审阅。源码检查通过不替代对打包产物、source map、日志、tar/zip 元数据、发布包和图片的审查。

<!-- topic:exceptions -->
### 误报和例外

`publication-policy.json` 中的样本例外绑定精确路径、规则、匹配值 SHA 或整行源码 SHA、无实际作用的理由及类型；真实秘密不能加入允许清单。检测器中的密钥格式标记、Windows 版本和广播拒绝常量可逐点评审，不能放行整个测试文件、目录、CGNAT 范围或令牌前缀。失效例外会使检查失败。

公开联系地址的例外只允许精确地址、路径和理由，不放行整个域名。二进制审阅绑定文件 SHA、用途和审阅记录。公开默认入口或软件包不得新增 OpenAI/ChatGPT 依赖；专有客户端兼容须采用独立可选适配器并精确审阅，不能依赖大范围路径豁免。

<!-- topic:review -->
### 发布检查与处置

提交前在干净公开检出目录运行完整测试、构建和边界检查。机器导出清单只能含公开路径、状态、导出和测试；文档链接及中英文主题结构通过后，还须独立审阅语义。发现可能的真实秘密时停止传播内容，仅报告遮蔽后的路径和规则；凭据责任方核对轮换与撤销，不得自行复制、重放或公开诊断值。

公开 CI 不含提供方、设备或私有仓库秘密，不使用自托管设备、部署命令或 pull_request_target。发布前审查许可与依赖；源码 PR、正式发布、生产部署和私有调用方切换分别验收。

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
