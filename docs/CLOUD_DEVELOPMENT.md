# Cloud development and validation

## 中文

GhostFleet V0 可以在 Linux 云开发环境中实施：Node.js 22+、npm 和工作区写权限即可运行 core、Console 与 Cloudflare Worker/Durable Object 本地参考部署；无需 sudo、Docker、真实设备或云账号凭据。

```sh
npm ci
npm test
npm run check
npm run build:console
npm run dev:init
WRANGLER_SEND_METRICS=false npm run build:worker
npm run verify:cloud
```

`build:worker` 仅 dry-run 打包，不部署；`verify:cloud` 使用 Linux 子进程组，在 loopback 18791 启动真实 workerd/SQLite Durable Object，验证 Console 静态资源、认证、只读权限、HumanGate、证据入列、重复入列拒绝，再停止并重启验证持久化恢复。该脚本自动回收它创建的进程。全部设备证据是 **synthetic**，不能据此宣称真实节点已经完成纳管、零差异收敛或重启恢复。

持续开发时运行 `npm run dev`。本地端口为 8791；修改 Console 后重跑 `build:console`。`dev:init` 在 ignored `.dev.vars` 中生成独立本地随机凭据，并保留已有文件。不要提交该文件、`.wrangler` 状态或日志。安装依赖和保存文件不代表后台进程会跨环境快照存活，需要重新启动。

### 部署认证边界

- `GHOSTFLEET_READ_TOKEN`：允许 GET 观察；任何 mutation 返回 403。
- `GHOSTFLEET_OPERATOR_TOKEN`：允许此单租户参考控制面的对象操作和 gate resolution。
- 每个配置值至少 32 字符，应使用独立随机凭据；这些不是 provider/device 的 root credential。
- 未配置凭据的 `/v0/*` 返回 503；无效或缺失 bearer 返回 401；`/healthz` 和公开静态 Console 不返回实例记录。
- Console 的 Connect 输入只在页面内存中保留 bearer；Disconnect 清除页面状态；不使用 URL、localStorage 或 sessionStorage。
- Core HTTP handler 是 embedding seam。其他宿主必须提供自己的认证和授权边界；不要裸暴露它。

线上 Cloudflare 部署需要另外配置账户权限、秘密绑定和 HTTPS。多用户 RBAC、逐 actor 审计、限流及真实设备适配器安全审查仍属于生产验收；本参考 bearer 边界不是完整的生产身份系统。公共 AGPL 发布时，应向网络用户提供对应源码。V0 MCP 目前是只读 dispatcher integration surface，不是可直接连接的远程 MCP transport。

### 验证记录与公开边界

当前改动在 PR #1 的基线 `164c9e84edeccd8c3373176d5f69ec89bd7f89c7` 上完成。设计参考 donor 读取固定在 Fleet `7c9f22f7fc30b4c75f56b8e4f28ccdb86b479d0a`，只查阅通用收敛机制；本改动没有复制 donor 源码、私有 inventory、账户信息、网络坐标或凭据。AGPL 正文来自 SPDX license-list-data `31ba1a50e5397e00a304dbadc76531740e89ee48`。

发布前必须检查 diff 和完整公共 tree。凭据扫描的 fixture 和 runtime variable assignment 需要逐项判定；不能把零扫描结果当作完整 DLP 证明。运行时 `.dev.vars` 和测试 receipt 始终排除在提交之外。

### 当前验证证据（2026-10-04，Asia/Shanghai）

| 检查 | 结果 |
| --- | --- |
| 现有锁文件重新安装 `npm ci` | PASS |
| Node 回归套件 | 14 tests PASS，0 failed/skipped |
| `npm run check` | PASS |
| Console + Worker dry-run build | PASS |
| `npm run verify:cloud` | PASS：真实 workerd/SQLite DO，合成完整流程和重启恢复 |
| 公开 tree 检查 | 41 files；未检出测试的私有实例模式；唯一 credential-pattern 提示为 Console runtime input assignment，经检查无源码凭据 |
| 真实设备 / 线上部署 / 远程 MCP transport | 未执行，不以本地合成验证替代 |

测试 artifact/状态保存在 ignored `.wrangler` 中。CI 已加入相同安装、测试、构建和重启验证命令；此表不宣称远端 CI 已执行。

## English

The V0 core, Console and local Cloudflare reference adapter run in a Linux cloud workspace without sudo, Docker, device access or production credentials. Use the commands above. `build:worker` only packages; it does not deploy. `verify:cloud` starts the actual local workerd/SQLite Durable Object, checks authority and synthetic admission, then restarts it to verify durable recovery. It stops its own processes.

The API requires independent read-only/operator bearer credentials; absent configuration fails closed. The Console holds its token in page memory only. This reference single-tenant boundary does not implement production multi-user RBAC or prove live device admission. Other hosts embedding the core HTTP handler must enforce their own authority boundary. The MCP integration is currently a read-only dispatcher, not a remote MCP transport.

Production rollout and device canaries remain separate gates. Keep credentials, runtime snapshots and private instance metadata outside public source. Preserve AGPL and third-party notices, and provide corresponding source to network users of an AGPL deployment.
