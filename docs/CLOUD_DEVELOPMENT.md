# Local and cloud development / 本地与云端开发

## 中文

<!-- topic:setup -->
### 无私有依赖的工作区

源码预览已合并至公开 `main`，新工作区默认从该分支取得实现。使用 Node.js 22+ 和 Python 3.10+，并为下面的 Python 命令选择同一环境：

```sh
git clone https://github.com/youling/ghostfleet.git
cd ghostfleet
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
```

审阅者若指定精确公开提交，则检出并验证该提交；旧提交的审阅或 CI 成功不能自动证明新的提交通过。`main` 中的软件包仍是源码开发/预览状态，正式稳定发布须单独验收。公开克隆不需要私有仓库或议题、真实节点或提供方、OpenAI 配置或旧内部治理。

<!-- topic:runtime -->
### 运行和验证

```sh
npm run build:console
npm run build:typed
node examples/typed-control-synthetic.mjs
npm run verify:python-artifact
npm run dev:init
npm run dev
```

模拟后端示例只执行合成连接与操作，不建立网络或 SSH 连接，不启动子进程。Python 产物检查在仓库外的干净虚拟环境证明资源可用，不接触设备。`dev:init` 以排他方式创建被 Git 忽略的秘密文件；若文件已存在则保留，且不打印其值。`dev` 仅监听回环地址，浏览器使用该实例自己的只读或操作员凭据。

Worker dry-run 与本地验证只保留脱敏摘要。`npm run verify:cloud` 仅支持 Linux；Windows 可运行 `npm run verify:ai-client-neutral`，Linux 专用检查另看对应提交的 Linux CI。真实节点或提供方访问不属于公开开发测试的前提。

<!-- topic:boundaries -->
### 云端执行与结果边界

云端工作区可完成源码、构建、合成测试及本地 workerd 验证。网络策略、依赖下载和工具版本属于环境能力，不产生生产授权。公开 Actions 使用无秘密的托管运行器，受平台额度、并发和时间限制；不能用私有设备为 fork PR 加速。

本地预览、编译、合成测试、真实单机试验、正式发布与生产 Pages 分别记录状态。环境中断后，从当前公开提交和受保护本地状态恢复，不重新派发结果不确定的副作用操作。详见 [测试](TESTING.md)、[部署](DEPLOYMENT.md)、[恢复](RECOVERY.md)。

## English

<!-- topic:setup -->
### Workspace without private dependencies

The source preview has been merged into public `main`, the default implementation entry for a new workspace. Use Node.js 22+ and Python 3.10+, with the same selected environment for every Python command below:

```sh
git clone https://github.com/youling/ghostfleet.git
cd ghostfleet
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
```

If reviewers specify an exact public commit, check out and validate that commit. Review or CI success for an older commit does not automatically establish acceptance of a newer one. Packages on `main` remain source-development/preview artifacts; a stable release needs separate acceptance. The public clone needs no private repository/issue, real node/provider, OpenAI configuration or prior internal governance.

<!-- topic:runtime -->
### Run and validate

```sh
npm run build:console
npm run build:typed
node examples/typed-control-synthetic.mjs
npm run verify:python-artifact
npm run dev:init
npm run dev
```

The fake-backend example uses synthetic connect/execute and opens no network/SSH connection or subprocess. Python artifact verification proves installed resources in a clean external venv without touching hardware. `dev:init` exclusively creates an ignored secret file, preserves existing state and prints no values. `dev` listens on loopback and browser sessions use that instance's read/operator credentials.

Retain only sanitized summaries from Worker dry-run and local validation. `npm run verify:cloud` supports Linux only. Windows can run `npm run verify:ai-client-neutral`; check Linux-only results separately against Linux CI for the corresponding commit. Real node/provider access is not a public development-test prerequisite.

<!-- topic:boundaries -->
### Cloud execution and evidence boundaries

Cloud workspaces can perform source/build/synthetic/local-workerd validation. Network policy, dependency downloads and tool versions are environment capabilities, not production authority. Public Actions uses hosted runners without secrets and remains subject to platform quotas/concurrency/time limits; private devices must not accelerate fork PRs.

Label local previews, compilation, synthetic tests, actual single-node canaries, formal release and production Pages separately. Recover interrupted environments from the current public head and protected local state, without replaying unknown effects. See [Testing](TESTING.md), [Deployment](DEPLOYMENT.md) and [Recovery](RECOVERY.md).
