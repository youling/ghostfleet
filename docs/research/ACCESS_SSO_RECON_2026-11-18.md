# Cloudflare Access 单点登录增量研究（设计输入）

状态：**SOURCE_INSPECTED / DOCUMENTED_CAPABILITY；设计候选，未实现、未部署、未做生产验证。**

研究日期：2026-11-18（Asia/Shanghai）。源码基线：`ce645aacde8caa72b866bb127a05c746323f8d1f`。

本篇是[纳管体验与原生运维增量研究](ONBOARDING_RECONNAISSANCE_2026-11-18.md)的身份与会话分报告；范围为当前源码与 Cloudflare 官方能力的对照。`SOURCE_INSPECTED` 只表示已读精确版本源码；`DOCUMENTED_CAPABILITY` 只表示一手文档定义了能力。方案尚未实现，现场验收均未执行；没有访问真实节点、账户控制台、凭据或生产 origin。

## 一、可改变方案的结论

**支持消除浏览器第二次粘贴 Operator Token。推荐把 Access 验证与现有 Operator/Read 权限映射放在 Worker 后端，页面刷新后自动调用同源 `/v0/access` 恢复界面。** 浏览器不需要读取、持久化或向下游转发原始 Access JWT，也不需要新的登录服务器、会话数据库或 OAuth issuer。这是基于现有代码与官方能力的设计推论，尚非当前产品功能。

“前端读取 Cloudflare 注入的 `Cf-Access-Jwt-Assertion` 请求头”这一实现提案需要修正：该请求头由 Access 发往 Worker/源站，前端脚本不能从页面导航获得这个源站请求头。Worker 应验证它，仅把已授权角色和必要页面信息返回前端。官方当前推荐验证该头，而非假设 Cookie 一定传到源站。[S1]

当前官方能力与本仓的适配有一处关键差异：**Workers 已有原生 `ctx.access`，但官方明确 Static Assets 内部路由器不把它传给用户 Worker。** GhostFleet 的 `wrangler.jsonc` 正在使用 `assets` 和 `run_worker_first: true`，因此不能凭原生 API 已发布就认定此仓可直接使用；官方没有说明 `run_worker_first` 消除此限制。保持现有资源部署形态时，手动验证 Access 请求头是更明确的候选；不为使用 `ctx.access` 立即拆 Worker 或迁移静态资源。[S2]、[L5]

## 二、当前源码对照

基线：`ce645aacde8caa72b866bb127a05c746323f8d1f`，不是生产部署断言。

| 文件 | 已读实际行为 | SSO 候选需要改变的最小位置 |
| --- | --- | --- |
| [auth.js][L1] | 只识别 `Authorization: Bearer` 的 Operator/Read 两种应用 Token；未验证 Access JWT | 添加后端 Access 身份适配；保留现有两种应用角色和非浏览器兼容入口 |
| [http.js][L2] | `/v0/*` 先鉴权；POST 的 `Origin` 只在存在时检查；严格 JSON/4 KiB；`/v0/access` 返回角色与安装材料 | 认证结果应携带认证方法；Cookie/Access 浏览器写操作必须有可信同源证明；不要把缺失 Origin 的旧机器调用规则直接沿用给 Cookie 登录 |
| [worker.js][L3] | 两个精确 origin；管理路由只在 panel origin，claim/heartbeat 只在 node origin；Worker 与 DO 重复边界校验；不信任客户端角色头 | SSO 仅进入 panel 管理路径；DO 继续验证原始受信证据，不接受客户端 `X-Role: operator` 一类声明 |
| [console/app.js][L4] | Token 仅页面内存；刷新丢失；请求已使用 `credentials: same-origin`、`redirect: error`；pagehide 清理；启动先探测 Token 模式 | 页面加载无显式 Bearer 时探测 Access 会话，恢复角色与节点表；过期请求显示重新登录入口；不落 localStorage |
| [wrangler.jsonc][L5] | Static Assets、`run_worker_first: true`，`workers_dev=false`、`preview_urls=false`，一个 DO | 当前不以 `ctx.access` 为可用假设；保留精确双 origin 与同一 DO 身份 |

`auth.js` 原来的纯 Bearer 路径没有浏览器自动附带应用 Token 的语义。改为 Access Cookie 后，CSRF 条件发生实际变化；补同源约束属于该变更的必要行为验收，不是另加审批系统。[S7]

## 三、建议的有界设计

### 1. 后端验证，再映射已有两种角色

实例配置固定 `issuer`、应用 `audience` 和受信 JWKS 地址，不从未经验证的 token `iss`/`jku` 指定任意取钥 URL。采用标准 JWT 验证库；官方 Worker 示例用 `jose` 的 `createRemoteJWKSet` 与 `jwtVerify`，核对 issuer/audience。还应明确允许算法、应用 Token 类型、有效期、未来生效时间与大小边界。新依赖只在实施 PR 里选择精确版本并验证 Worker/DO 构建；本报告不增加依赖。[S1]

角色来源由实例 owner 配置，首版适合少量精确 subject 或受验证邮箱映射到既有 `operator`/`read_only`。不因为通过 Access 就给所有人 Operator，也不需要通用 RBAC 数据库。`sub` 在用户删除重建后可能变化；若使用组，不能假设组自动进入 JWT，更不能把缺组当允许：官方说明 custom claims 可能因 Cookie 大小而被裁剪，需要完整组时才取受信的 identity endpoint。[S3]

JWKS 解析器应复用有界缓存、取钥超时和缺失 `kid` 冷却，避免每次请求重新取钥；缓存不延长 JWT 到期时间。`jose` 的远程 JWKS 已有这些机制，无需自建新凭据库或自写密码学。具体包版本与参数在实现时固定。[S8]

### 2. 浏览器通过既有 Access Cookie 自动恢复

前端保持同源 `fetch('/v0/access', { credentials: 'same-origin' })`，没有显式应用 Token 时不发送空 `Authorization: Bearer `。后端只回角色、认证方式等必要信息，不回原始 JWT、Cookie、服务凭据或完整身份属性。Access Cookie 可配置 HttpOnly；采用服务器验证后无需为了前端读取而关闭它。SameSite 选择应与真实登录跳转一起验证，而非假设所有部署都是默认保护值。[S4]

过期 AJAX 请求可按官方指引带 `X-Requested-With: XMLHttpRequest` 获取 401；UI 明确引导整页重新认证，别把所有非 JSON/302 统称“后端坏了”，也不要在写操作失联后自动重放。将“断开面板”与“退出 Access”区分：Access logout 目前会撤销跨应用会话，不能把它静默绑定成只退出本面板。[S5]

浏览器管理 API 保持与页面同源。node origin 继续服务加入、心跳与固定哈希安装器，无需浏览器跨域 CORS 或 Access 登录。跨源预检本身不能携带 Cookie，官方对此有明确限制；当前双 origin 分工无需引入这类摩擦。[S6]

### 3. 保留自动化和节点凭据各自的权限

现有 Operator/Read Bearer 可作为明确的机器兼容路径；它与浏览器 Access 身份同时出现时必须有确定规则。例如：显式 Bearer 存在就按该路径验证，失败即失败，不自动回退至 Cookie 身份掩盖错误。也可采用实例显式模式开关；具体兼容取舍需要实施合同固定，当前没有强行选择。

Cloudflare Service Token 是外层机器身份，不是 GhostFleet Operator Token，更不是节点 reporting token。官方 service-token JWT 可以没有人类 `sub`；不能落到“已认证用户默认 Operator”。若机器将来走 Access Service Auth，应沿既有应用角色映射单独确定，不把凭据发给浏览器或 reporter。[S3]、[S9]

2026 年新增的 Worker/account 级 Access 能自动覆盖 Worker 的多个域名，但 GhostFleet 一个 Worker 同时服务人类 panel 和机器 node origin。直接套全 Worker 人类登录策略可能把 claim/heartbeat 也挡住。采用当前精确 panel-hostname 策略更贴合现有形态；node 端保持其已有票据/节点鉴权，不为 SSO 改成新 Worker/新 DO。[S2]、[S10]

### 4. 不信任客户端角色转发

当前 Worker 与 DO 都执行 `prepare()`。设计应保留这一边界：要么 DO 对保留的 Access assertion 独立验证并映射角色；要么实施一个可证明只来自授权内部调用的上下文接口。第一条更贴近当前代码。不能新增一个任意 HTTP 请求可伪造的角色头，再以“Worker 已验过”作为 DO 信任依据。官方 `ctx.access` 也不传播到 Service Binding/RPC；它不是跨组件免验通行证。[L2]、[L3]、[S2]

## 四、最小验收矩阵（提案；均未运行）

| 范围 | 正向 | 反例/失败行为 |
| --- | --- | --- |
| JWT 验证 | 固定 issuer/aud 的有效身份可读；精确 Operator 可签票 | 缺失/伪造/过期/尚未生效/错误 issuer/aud/算法/未知 key 拒绝，写状态不变 |
| 角色 | Read 只读；Operator 使用既有管理行为 | 未映射身份、被裁剪/缺失的角色属性、服务身份不能升格；伪造角色头不起作用 |
| 浏览器恢复 | 有效 Access 会话刷新页面后恢复，不二次粘贴 Token | 会话过期走可理解的重新登录；无原始 JWT/长期 Token 落入 localStorage、DOM 回显或应用日志 |
| 同源写入 | 真实 panel-origin JSON POST 正常 | cross-origin、`Origin: null`、缺可信源证明的 Cookie 写请求拒绝；旧机器 Bearer 行为按明确兼容合同验证 |
| 双 origin | panel API 正常；node claim/heartbeat 不需人类登录 | node origin 上管理路径仍 404；不能凭 reporting token、Access Cookie 或伪造头得到管理权限 |
| Worker/DO | 两层对同一受信证据得出一致角色 | 直达 DO 的伪造角色/无效 assertion 无写效应；Access 外层已放行不等于内部角色允许 |
| JWKS/故障 | 缓存有效钥可验证；轮换后按限定策略更新 | 取钥失败、未知 `kid`、坏 JWKS 不绕过验证；新代码不得无限重试或输出 JWT |
| 兼容/回退 | 旧合法 Bearer 仍工作；配置关闭 SSO 可恢复旧界面 | 身份冲突有确定规则；SSO 故障不触碰节点 Token/SSH；无自动部署或凭据复制 |

最小现场验证由现役工头执行：读取真实 Access application/AUD、匹配 policy 与两个 origin 的覆盖，观察浏览器刷新/过期、Operator/Read 正负测试，以及 node endpoint 仍正常。只读配置和合成源码测试不能替代该部署验收。

## 五、复用决策与剩余未知

| 候选 | 建议 | 理由 |
| --- | --- | --- |
| Access 现有浏览器会话 | REUSE | 直接消除第二次粘贴，保持现有身份提供商 |
| 后端 JWT 验证标准库 | ADAPT_BEHIND_EXISTING_AUTH | 已有官方范式；不重写密码学；仅在实施时引入受验证的精确版本 |
| `ctx.access` | DEFER_FOR_CURRENT_ASSETS_SHAPE | 最新官方能力值得跟踪，当前 Static Assets 限制明确；不为它拆现有架构 |
| 固定身份→Operator/Read | REUSE_KNOWLEDGE_NATIVE_IMPLEMENT | 两个现有角色足够；配置由实例 owner 保存 |
| localStorage 保存 Operator Token | 不作为首选修复 | 会延续第二凭据体系；现有 Access 会话已经能解决刷新体验 |
| 自建登录服务/会话库/通用权限引擎 | DEFER | 当前问题没有提出这些需求 |
| Managed OAuth / Linked App Token | 保留后续线索 | 可服务交互 CLI/跨应用调用，但本次浏览器刷新问题不需要扩到这些接口 [S11] |

关键未知：真实实例 Access 应用及 policy 覆盖、要映射的身份集合、真实 Cookie 配置、未来实现采用哪个固定 JWT 库版本、Worker/DO JWT 缓存与故障行为、Static Assets 限制是否已在具体部署消除。以上只影响 SSO 的实施/现场验证，不阻塞当前仓库文档治理，也不要求重新安装已纳管节点。

## 来源登记

外部均为官方/上游一手材料；其“文档已定义”不证明当前实例具备能力。日期为页面明示更新时间或发布日期；未标则保留读取日期，不猜发布版本。

| 编号 | 来源与定位 | 日期 / 证据 |
| --- | --- | --- |
| S1 | [Cloudflare Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)；`Cloudflare Workers example` | 2026-11-02；DOCUMENTED |
| S2 | [Workers Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)；`Read authenticated user identity with ctx.access`、`ctx.access limitations`、`Understand Access hierarchy` | 2026-11-02；DOCUMENTED |
| S3 | [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)；custom claims、user identity、service-token payload | 2026-11-17；DOCUMENTED |
| S4 | [Authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)；Cookie settings | 2026-11-17（以正文更新时间为准，搜索摘要日期较旧）；DOCUMENTED |
| S5 | [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)；AJAX、Log out as a user | 2026-11-10；DOCUMENTED |
| S6 | [CORS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/) | 2026-11-02；DOCUMENTED |
| S7 | [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)；source/target origin、Fetch Metadata | 读取 2026-11-18；DOCUMENTED |
| S8 | [jose createRemoteJWKSet](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)、[options](https://github.com/panva/jose/blob/main/docs/jwks/remote/interfaces/RemoteJWKSetOptions.md) | 读取 2026-11-18；上游文档，尚未固定实施版本 |
| S9 | [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)；Strict service token authentication | 2026-11-17（以正文更新时间为准）；DOCUMENTED |
| S10 | [Worker/account Access 发布](https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/) | 发布 2026-08-14；DOCUMENTED |
| S11 | [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)、[Linked App Token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/linked-app-token/) | 读取 2026-11-18；后续候选，未用于本设计 |

[L1]: https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/src/adapters/cloudflare/auth.js
[L2]: https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/src/control-plane/http.js
[L3]: https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/src/adapters/cloudflare/worker.js
[L4]: https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/console/app.js
[L5]: https://github.com/youling/ghostfleet/blob/ce645aacde8caa72b866bb127a05c746323f8d1f/wrangler.jsonc

[S1]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
[S2]: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
[S3]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
[S4]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
[S5]: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
[S6]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/
[S7]: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
[S8]: https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md
[S9]: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
[S10]: https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/
[S11]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
