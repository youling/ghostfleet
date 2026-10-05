# Testing and evidence / 测试与证据

## 中文

<!-- topic:layers -->
### 分层证据

核心、HTTP、MCP 和控制台单元测试验证生命周期、权限和同一对象投影；Linux 回执适配器测试全部使用合成样本。可选类型化控制通过模拟连接与执行验证权限范围、源码、身份、期限和回执。Python 平台运行时使用模拟系统与临时状态，不连接真实机器。本地 workerd 验证 Durable Object 持久化及官方标准 MCP 客户端与 HTTP 的身份一致性。

受保护部署中的真实单节点试验曾完成类型化观察、初始纳管/收敛的立即重复执行、一次重启与恢复，以及同一核心 UID 的准入。这项脱敏状态不公开原始设备证据，不证明所有公开后端或第二独立设备已验收。正式发布仍需第二独立硬件/重建验证和安全复审。核心 `ACTIVE` 与七项证据仅证明本控制面准入；独立调用方仍须验收同一身份的目录发现、认证配置、调用路由、正负权限和回滚。

<!-- topic:commands -->
### 重复执行的检查

使用 Node.js 22+ 和 Python 3.10+，在本次选定的同一 Python 环境中安装测试扩展。以下检查无需真实设备或提供方凭据：

```sh
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
npm run verify:python-artifact
npm run build:console
npm run build:typed
npm run build:worker
npm run verify:ai-client-neutral
```

仅在 Linux 上另行运行 `npm run verify:cloud`；Windows 不运行该 Linux 专用检查。根目录 `test:all` 包含核心、类型化控制、初始纳管和 Python 测试，Python 实际入口为 `python -m pytest packages/runtime-python/tests`。可选包还有各自的 TypeScript 检查、构建与测试，具体以根脚本、各包清单和 [平台](PLATFORMS.md) 为准。未执行的检查不能计为通过。`build:worker` 是 dry-run，不创建线上 URL。

<!-- topic:ci -->
### CI 与资源

公开工作流仅响应 push、pull_request 和 workflow_dispatch，使用托管 Ubuntu 与 Windows 矩阵、只读仓库内容权限、完整 SHA 固定的 Actions、有限超时及同分支并发控制。`verify:cloud` 仅在 Linux 运行；Linux 专用原生测试在 Windows 明确跳过，跳过不证明对应实机能力。工作流不使用 pull_request_target、部署命令、提供方秘密或自托管设备；检出后不保留凭据。外部 fork PR 仅验证公开源码和合成样本。

GitHub Actions 的可用额度、并发与运行时间以当前平台和账户限制为准，不承诺免费无限执行。OpenCode 或其他自动审查仅使用已脱敏候选；模型自述不能替代精确提交上的测试、独立审阅或硬件证据。

<!-- topic:acceptance -->
### 失败处理与验收

收集同批完整失败结果后修复源码，冻结公开提交后再运行受影响检查。不能通过修改样本或扩大通配符来掩盖权限负向测试失败。公开边界检查只输出规则、路径和行号，不打印匹配的秘密值；文档检查只保证链接、结构与主题覆盖，中英文语义等价仍需审阅。

移交须记录精确提交、运行位置、执行命令、结果及未覆盖限制。未提交或未跟踪源码和旧 CI 成功不能证明当前提交通过验收。生产部署、正式发布、旧代码删除和源码 PR 分别验收。

## English

<!-- topic:layers -->
### Evidence layers

Core/HTTP/MCP/Console unit tests cover lifecycle, authority and the same object projection; Linux receipt tests are entirely synthetic. Optional typed control uses fake connect/execute for scope, source, identity, deadlines and receipts. Python platform runtimes use fake systems and temporary state, not real hardware. Local workerd verifies Durable Object persistence and identity agreement between the official standard MCP client and HTTP.

A protected single-node hardware canary exercised typed observation, immediate bootstrap/convergence repeat, one reboot/recovery and admission of the same core UID. This sanitized status publishes no raw device proof and establishes neither every public backend nor a second independent device. Formal release still requires independent second-device/rebuild evidence and security review. Core `ACTIVE` and seven evidence types establish admission in this control plane only. Independent consumers still need acceptance for same-identity catalog discovery, authentication/configuration, call routes, positive/negative permissions and rollback.

<!-- topic:commands -->
### Reproducible checks

Use Node.js 22+ and Python 3.10+, installing the test extra into the same selected Python environment. These checks need no real device or provider credentials:

```sh
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
npm run verify:python-artifact
npm run build:console
npm run build:typed
npm run build:worker
npm run verify:ai-client-neutral
```

Run `npm run verify:cloud` additionally on Linux only; Windows does not run this Linux-only check. Root `test:all` includes core, typed-control, bootstrap and Python tests. The actual Python entry is `python -m pytest packages/runtime-python/tests`. Optional packages also define individual TypeScript checks/builds/tests; consult root scripts, package manifests and [Platforms](PLATFORMS.md). Never count an unexecuted check as passing. `build:worker` is a dry-run and creates no online URL.

<!-- topic:ci -->
### CI and resources

The public workflow uses push/pull_request/workflow_dispatch, a hosted Ubuntu and Windows matrix, contents-read permission, full-SHA action pins, bounded timeouts and per-branch concurrency. `verify:cloud` runs on Linux only. Linux-native tests explicitly skip on Windows; a skip establishes no corresponding hardware capability. The workflow uses no pull_request_target, deployment command, provider secret or self-hosted device. Checkout does not retain credentials. Fork PRs validate public source and synthetic fixtures only.

GitHub Actions quotas, concurrency and runtime limits depend on current platform/account terms; free unlimited execution is not promised. OpenCode or other automated review consumes sanitized candidates only. Model self-reports do not replace exact-head tests, independent review or hardware evidence.

<!-- topic:acceptance -->
### Failures and acceptance

Collect the full failure batch and repair the source; freeze the public head before rerunning affected checks. Never hide negative-authority failures by weakening fixtures or widening wildcards. Publication output contains only rule/path/line, never matched secrets. The docs guard checks links, structure and topics; full bilingual semantic equivalence still requires review.

Handoffs record exact commit, execution environment, commands, results and coverage limits. Dirty/untracked source and old successful CI runs do not establish acceptance of the current head. Production deployment, formal release and prior-source deletion are separate from source PR acceptance.
