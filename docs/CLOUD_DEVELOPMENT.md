# Local and cloud development / 本地与云端开发

## 中文

<!-- topic:setup -->
### 无私有依赖的工作区

当前实现位于reviewedsource-previewbranch，main若仍为architectureseed则不可直接按main宣称冷启动实现可用；在candidate阶段：

```sh
git clone --branch feat/v0-control-plane https://github.com/youling/ghostfleet.git
cd ghostfleet
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
```

若reviewer给exactpubliccommit，再checkout该commit验证；合并后的release/ref与README保持一致。Publicclone不需要私仓、privateissue、真实node/provider、OpenAI配置或旧内部治理。

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

fakebackendexample只syntheticconnect/execute，不开network/SSH或subprocess。Pythonartifact在仓外cleanvenv证明资源可用而不碰device。`dev:init`排他创建ignored秘密文件，已存在则保留、不打印values；`dev`仅loopback，浏览器连接用实例自己的read/operatorcredential。

并行验证可运行 `npm run verify:cloud` 与Workerdry-run；输出只保留sanitizedsummary。真实node或provider访问不属于public开发test要求。

<!-- topic:boundaries -->
### 云端执行与结果边界

云端workspace可完成source/build/synthetic/localworkerd验证；networkpolicy、依赖下载和toolversion是环境能力，不创建productionauthority。PublicActions使用hostedrunner与no secrets，受平台quota/并发/time限制；不用私设备给forkPR“加速”。

localpreview、编译、synthetic tests、真实单机canary、formalrelease与Pagesproduction各自标记。环境中断后从currentpublichead与protectedlocalstate恢复，不重发未知effects。详见 [测试](TESTING.md)、[部署](DEPLOYMENT.md)、[恢复](RECOVERY.md)。

## English

<!-- topic:setup -->
### Workspace without private dependencies

Implementation is on the reviewed source-preview branch. If main still contains the architecture seed, do not claim that main cold-starts the implementation. During candidate review:

```sh
git clone --branch feat/v0-control-plane https://github.com/youling/ghostfleet.git
cd ghostfleet
npm ci
python -m pip install -e "packages/runtime-python[test]"
npm run test:all
npm run check:all
```

If reviewers specify an exact public commit, check out and validate that commit. Keep README aligned with the post-merge release/ref. The public clone needs no private repository/issue, real node/provider, OpenAI configuration or prior internal governance.

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

Run `npm run verify:cloud` and Worker dry-run separately, retaining sanitized summaries only. Real node/provider access is not a public development-test prerequisite.

<!-- topic:boundaries -->
### Cloud execution and evidence boundaries

Cloud workspaces can perform source/build/synthetic/local-workerd validation. Network policy, dependency downloads and tool versions are environment capabilities, not production authority. Public Actions uses hosted runners without secrets and remains subject to platform quotas/concurrency/time limits; private devices must not accelerate fork PRs.

Label local previews, compilation, synthetic tests, actual single-node canaries, formal release and production Pages separately. Recover interrupted environments from the current public head and protected local state, without replaying unknown effects. See [Testing](TESTING.md), [Deployment](DEPLOYMENT.md) and [Recovery](RECOVERY.md).
