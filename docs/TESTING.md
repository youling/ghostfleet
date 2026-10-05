# Testing and evidence / 测试与证据

## 中文

<!-- topic:layers -->
### 分层证据

Core/HTTP/MCP/Console单测验证生命周期、权限与同一对象投影；Linux receipt adapter测试全synthetic。optionaltyped-control使用fakeconnect/execute验证scope、source、identity、deadline、receipt。Python平台runtime使用fake系统/temporarystate，不接真实机器。workerd local验证DO persistence、标准officialMCPclient与HTTPidentity一致。

真机单节点canary曾在受保护部署完成typedobservation、bootstrap/convergence immediate repeat、一次reboot/recovery与同一coreUID admission；这项脱敏状态不发布rawdeviceproof、不证明所有公开backend或第二独立设备。正式release仍需第二独立硬件/重建验证及安全复审。

<!-- topic:commands -->
### 重复执行的检查

```sh
npm ci
npm test
npm run check
npm run check:publication
npm run check:docs
npm run build:console
npm run build:worker
npm run verify:cloud
```

可选package另有TypeScriptcheck/build/tests与Python unittest命令，以各package manifest和 [平台](PLATFORMS.md) 为准。Rootchecks/glue是否包含可选包以rootpackage为准；不得因为某个包没有执行就计为通过。`build:worker`是dry-run，不创建线上URL。

<!-- topic:ci -->
### CI 与资源

公开workflow仅push/pull_request/workflow_dispatch，hostedUbuntu、contentsread、完整SHA固定Actions、有限timeout与同branchconcurrency；没有pull_request_target、部署命令、providersecret或self-hosteddevice。checkout不保留凭据。外部forkPR只验证公开source与syntheticfixtures。

GitHubActions可用额度、并发和runtime限制以当前平台与账户为准，不能承诺免费无限执行。OpenCode或其它自动审查只消费已脱敏candidate；模型selfreport不代替exacthead tests、independentreview或hardwareevidence。

<!-- topic:acceptance -->
### 失败处理与验收

收集完整同一batch失败，再按source修复；freezepublichead后再复测有影响检查。权限负向测试失败不得通过改fixture/放宽wildcard消除。publication输出只给rule/path/line，不打印匹配秘密；docsguard只保证链接/结构/topic覆盖，完整中英语义仍需review。

移交记录exactcommit、运行位置、执行命令、结果与未覆盖限制。dirty/untracked源码与旧CI成功不是currenthead的验收。生产部署/正式发布/旧代码删除与sourcePR验收分别判断。

## English

<!-- topic:layers -->
### Evidence layers

Core/HTTP/MCP/Console unit tests cover lifecycle, authority and the same object projection; Linux receipt tests are entirely synthetic. Optional typed control uses fake connect/execute for scope, source, identity, deadlines and receipts. Python platform runtimes use fake systems and temporary state, not real hardware. Local workerd verifies Durable Object persistence and identity agreement between the official standard MCP client and HTTP.

A protected single-node hardware canary exercised typed observation, immediate bootstrap/convergence repeat, one reboot/recovery and admission of the same core UID. This sanitized status publishes no raw device proof and establishes neither every public backend nor a second independent device. Formal release still requires independent second-device/rebuild evidence and security review.

<!-- topic:commands -->
### Reproducible checks

```sh
npm ci
npm test
npm run check
npm run check:publication
npm run check:docs
npm run build:console
npm run build:worker
npm run verify:cloud
```

Optional packages have TypeScript check/build/tests and Python unittest commands, defined by their manifests and [Platforms](PLATFORMS.md). Root integration is determined by the root package; never count an unexecuted package as passing. `build:worker` is a dry-run and creates no online URL.

<!-- topic:ci -->
### CI and resources

The public workflow uses push/pull_request/workflow_dispatch, hosted Ubuntu, contents-read permission, full-SHA action pins, bounded timeouts and per-branch concurrency. It uses no pull_request_target, deployment command, provider secret or self-hosted device. Checkout does not retain credentials. Fork PRs validate public source and synthetic fixtures only.

GitHub Actions quotas, concurrency and runtime limits depend on current platform/account terms; free unlimited execution is not promised. OpenCode or other automated review consumes sanitized candidates only. Model self-reports do not replace exact-head tests, independent review or hardware evidence.

<!-- topic:acceptance -->
### Failures and acceptance

Collect the full failure batch and repair the source; freeze the public head before rerunning affected checks. Never hide negative-authority failures by weakening fixtures or widening wildcards. Publication output contains only rule/path/line, never matched secrets. The docs guard checks links, structure and topics; full bilingual semantic equivalence still requires review.

Handoffs record exact commit, execution environment, commands, results and coverage limits. Dirty/untracked source and old successful CI runs do not establish acceptance of the current head. Production deployment, formal release and prior-source deletion are separate from source PR acceptance.
