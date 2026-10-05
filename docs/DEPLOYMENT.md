# Reference deployment / 参考部署

## 中文

<!-- topic:architecture -->
### Worker/DO/Console 与 Pages

当前参考宿主是CloudflareWorker+SQLiteDurableObject+staticassets，`wrangler.jsonc`将Consolebuild放在`dist/console`。DO对象与迁移tag保存lifecycle/evidence；MCP与API共享snapshot。它是可运行reference，不代表已经有productionURL或Pages迁移完成。

若迁Console到Pages，Worker仍负责authenticatedAPI/MCP及durablestate。必须设计exactAPIbase/origin、no-store/authheaders、secret不进staticbundle、HTTPS与身份系统、安全review及rollback；不能仅上传HTML就称production迁移成功。Host成功也不安装device或授予执行权限。

<!-- topic:build -->
### 本地验证与 dry-run

```sh
npm ci
npm run test:all
npm run check:all
npm run build:console
npm run build:typed
npm run build:worker
npm run verify:cloud
```

build:worker仅Wranglerdry-run打包；localverify只用隔离workerd/DO和syntheticfixtures。不能把CLI可用、packagebuild、localrestart或staticpreview当生产验收。PublicCI不会deploy或需要provider/accountsecret。

<!-- topic:secrets -->
### 授权与配置

在已授权目标account以Cloudflareprovider-nativeflow配置scopedAPIcredential，不用globalAPIkey，不将accountID/secret提交publicconfig。部署operator必须核对实际Workers/DO/asset/migration权限。两个独立随机controlplanebearer用Wrangler交互secret输入：

```sh
npx --no-install wrangler secret put GHOSTFLEET_READ_TOKEN
npx --no-install wrangler secret put GHOSTFLEET_OPERATOR_TOKEN
npx --no-install wrangler deploy
```

这些是effectfulsteps，只有指定account、deploymentauthority与review已满足才执行；不是publicCI步骤。`.dev.vars`仅local，不自动成为productionsecrets。Token不放shellargv或staticassets，provider/devicecredentials另外custody。

<!-- topic:acceptance -->
### 线上验收和回滚

部署后验证HTTPShealth、未登录拒绝、readonlymutation拒绝、sameoriginConsole、officialgenericMCPinitialize/list/call、DOrestart sameidentity与当前head。Multiclient/RBAC/OAuth、receiptinjection/trustedwriter、custody/revoke与logsartifact审查单独列出，不凭bearerprototype宣称productionidentity完整。

记录当前Workerrevision、DOschema/migration和Consolebuild；回滚要确认statecompatible，先停止effectdispatch，再只读reconcile，保留原identity及路径。第二独立hardware/rebuild和privateconsumer切换仍需对应acceptance；Pages/上线不能替代devicecanary。

## English

<!-- topic:architecture -->
### Worker/DO/Console and Pages

The reference host is a Cloudflare Worker with a SQLite Durable Object and static assets; `wrangler.jsonc` serves the Console build from `dist/console`. Durable Object classes/migration tags persist lifecycle/evidence and MCP/API share a snapshot. This is a runnable reference, not evidence of a production URL or completed Pages migration.

If the Console moves to Pages, the Worker still owns authenticated API/MCP and durable state. Design exact API base/origins, no-store/auth headers, no secrets in static bundles, HTTPS/identity, security review and rollback. Uploading HTML alone does not complete production migration. A deployed host neither installs devices nor grants execution authority.

<!-- topic:build -->
### Local validation and dry-run

```sh
npm ci
npm run test:all
npm run check:all
npm run build:console
npm run build:typed
npm run build:worker
npm run verify:cloud
```

`build:worker` is Wrangler dry-run packaging only; local verification uses isolated workerd/DO and synthetic fixtures. CLI availability, package builds, local restarts and static previews are not production acceptance. Public CI neither deploys nor requires provider/account secrets.

<!-- topic:secrets -->
### Authority and configuration

Configure scoped API credentials in the authorized target account through Cloudflare-native flows, not a global API key, and never commit account IDs/secrets into public configuration. Deployment operators verify actual Workers/DO/asset/migration permissions. Configure two independent random control-plane bearers with interactive Wrangler secret input:

```sh
npx --no-install wrangler secret put GHOSTFLEET_READ_TOKEN
npx --no-install wrangler secret put GHOSTFLEET_OPERATOR_TOKEN
npx --no-install wrangler deploy
```

These effectful steps require a specified account, deployment authority and completed review; they are not public CI steps. `.dev.vars` is local-only and does not become production secrets automatically. Tokens never belong in shell arguments or static assets; provider/device credentials have separate custody.

<!-- topic:acceptance -->
### Online acceptance and rollback

After deployment, verify HTTPS health, unauthenticated rejection, read-only mutation rejection, same-origin Console, official generic MCP initialize/list/call, persistent identity across DO restart and the current head. List multi-client/RBAC/OAuth, receipt injection/trusted writers, custody/revocation and log/artifact review separately; a bearer prototype does not establish complete production identity.

Record Worker revision, DO schema/migration and Console build. Rollback requires compatible state: stop effect dispatch, reconcile read-only and preserve identity/access paths. Independent second-device/rebuild evidence and private consumer cutover still need their own acceptance; Pages/hosting cannot substitute for hardware canaries.
