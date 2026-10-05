# Contributing / 参与贡献

## 中文

<!-- topic:scope -->
### 贡献边界

通用插件、core/API/MCP/Console、validators和可选runtime都在本仓维护。实例账号、registry、providerendpoint、key、credentialref、rawdeviceevidence与生产runbook不属于公开贡献。主流程保持AIclientneutral；可以增加显式可选clientadapter，但不能让ChatGPT/OpenAI成为必需依赖或放宽exactclientredirect/profile/scopes。

新的执行能力必须保留identity/authority/currentness、effectfence、timeout与UNKNOWNreconcile，不通过“方便AI”绕过policy。先读 [插件开发](docs/PLUGIN_DEVELOPMENT.md)、[安全](docs/SECURITY.md) 和 [公开边界](docs/PUBLICATION.md)。

<!-- topic:workflow -->
### 实现和 Pull Request

在featurebranch提交可审source/tests/documentation；不直接改protectedmain。PR描述具体problem、行为变化、risk与validation。更新每篇中英对应topic、publicexport/migrationmatrix与license。只提交reviewedsyntheticevidence；不要粘贴真实logs或全环境输出。

执行 `npm ci`、root与optionalpackage相关checks、publication/docs、Console/Workerdry-run及localverify。新模块不得依赖privateclone、真实device或默认OAuthclient。Reviewer绑定exacthead；scope/head改变需复核，不以旧CI或模型selfreport替代验收。

<!-- topic:license -->
### 许可、依赖与安全报告

项目为AGPL-3.0-only，保留LICENSE、copyright与thirdparty notices。迁入源码需核对来源许可及可重新分发权；不可仅改namespace就抹去来源。新的依赖需最小化、锁版本、审许可与公开audit；publicActions固定exactrevision，forkPR没有秘密。

安全问题遵循 [SECURITY.md](SECURITY.md)。公开issue只给脱敏影响/复现，不贴credential、真实locator或rawpayload。Merge不自动授权productiondeploy、release、旧code删除或设备操作。

## English

<!-- topic:scope -->
### Contribution scope

Generic plugins, core/API/MCP/Console, validators and optional runtimes are maintained here. Instance accounts, registries, provider endpoints, keys, credential references, raw device evidence and production runbooks are not public contributions. Keep the primary flow AI-client-neutral. Explicit optional client adapters are welcome; ChatGPT/OpenAI must not become mandatory or weaken exact client redirects/profiles/scopes.

New execution capabilities preserve identity/authority/currentness, effect fences, deadlines and UNKNOWN reconciliation. Convenience for AI cannot bypass policy. Read [Plugin development](docs/PLUGIN_DEVELOPMENT.md), [Security](docs/SECURITY.md) and [Publication](docs/PUBLICATION.md) first.

<!-- topic:workflow -->
### Implementation and pull requests

Submit reviewable source/tests/documentation on a feature branch, not directly to protected main. PR descriptions explain the concrete problem, behavioral change, risk and validation. Update equivalent Chinese/English topics, public export/migration matrices and licensing. Include reviewed synthetic evidence only; never paste live logs or full environment output.

Run `npm ci`, relevant root/optional package checks, publication/docs checks, Console/Worker dry-run and local verification. New modules cannot depend on a private clone, real device or default OAuth client. Review binds the exact head; scope/head changes require renewed review rather than old CI or model self-reports.

<!-- topic:license -->
### License, dependencies and security reporting

The project is AGPL-3.0-only; retain LICENSE, copyright and third-party notices. Verify source licensing and redistribution rights for imports; a namespace change must not erase origin. Minimize dependencies, lock versions, review licenses and public audits. Public actions pin exact revisions and fork PRs receive no secrets.

Follow [SECURITY.md](SECURITY.md) for security issues. Public issues contain only sanitized impact/reproduction, never credentials, real locators or raw payloads. Merge does not automatically authorize production deployment, release, prior-code deletion or device operations.
