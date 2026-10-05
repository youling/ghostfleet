# Optional authorization mechanisms / 可选授权机制

## 中文

<!-- topic:entry -->
### 显式可选的授权模块

`@ghostfleet/typed-control/authorization` 导出通用授权基础模块。导入它不会创建 HTTP 入口、OAuth 签发方、客户端注册或设备执行能力。默认 MCP 仍使用独立只读访问令牌，并且只开放四个观察工具。生产 OAuth 客户端的登录、配置、账户、回调和秘密存储由部署集成者配置并另行验收。

```sh
npm ci
npm run check:typed
npm run test:typed
npm run build:typed
```

源码入口为 `packages/typed-control/src/authorization/index.ts`，构建后的入口为 `dist/authorization/index.js`。JWT 机制依赖 jose，不依赖 OpenAI SDK。

<!-- topic:profile -->
### 客户端配置、动态注册和 PKCE

| 接口 | 可信输入、结果与拒绝条件 |
| --- | --- |
| `validateClientProfile(profile)` | 部署方安装 `profile_id/client_id/client_name/redirect_uris/scopes`；重定向必须精确 HTTPS，拒绝通配符、用户信息、fragment 和重复项 |
| `validateRegistration(metadata,profile)` | 名称和重定向匹配固定配置，返回版本化 `RegisteredClientBinding`，保存客户端、配置、重定向、注册权限及 `profile_snapshot` |
| `revalidateRegisteredClient(stored,profile)` | 从可信存储取注册绑定，与当前配置重新核对；轮换/缺失/陈旧绑定拒绝 |
| `validateAuthorizationRequest(params,profile,stored)` | 必需第三参数为可信已存储绑定；参数唯一、精确客户端/重定向/PKCE，权限不超过注册上限 |
| `revalidateTokenScope(grant,stored,profile)` | 重新核对已认证令牌/refresh 授权与注册及当前配置；只读注册不能扩大为执行授权 |
| `verifyPkce(verifier,storedChallenge)` | verifier 为 43–128 字符，并核对已存储 S256 challenge；返回布尔值，不能用调用方自选 challenge 作为授权依据 |

请求不能创建或扩大部署配置。集成者持久化已核验绑定，授权码只能使用一次；交换令牌时核对 code、verifier、client、redirect、expiry 和重放状态。动态注册、授权码和令牌中的权限还要按已注册上限及当前客户端配置重新验证。公开辅助模块不自动构成完整签发方存储或上线 OAuth 服务。

<!-- topic:ingress -->
### 请求预算、所有者同意和令牌

`guardOAuthRequest` 在读取请求体前要求配置全局和来源限额。缺配置时拒绝为 503，限额拒绝时为 429；方法、请求体和期限限制以实际模块为准。`bearerTokenMatches/bearerAuthorized` 比较哈希，拒绝弱的预期令牌和空白，不回显凭据。

`ownerConsentForm(request,secret,clientName,owner,origin)` 的第五个参数是必需的可信 HTTPS origin，不能从请求推断。证明绑定 origin、所有者主体、客户端查询和期限，使用 `ghostfleet-consent-v2` 签名域。GET/POST 验证拒绝跨 origin、不同主体、过期、篡改及旧版无 origin 证明。共享签名秘密也不能让 origin A 的证明在 origin B 重放。集成者仍提供可信存储、一次性 nonce 消费和撤销。`access` 模块显式验证部署配置的 Cloudflare Access JWT：核对 issuer、audience、身份和权限，不能因为可解码就信任。

访问令牌、签名密钥、verifier、所有者身份和提供方凭据都留在受控托管。合成模块测试不证明账户登录、生产重定向或撤销已经完成。私有签发方还没有因为迁移源文件自动切换到新版证明。

<!-- topic:family -->
### 客户端、SDK 家族和兼容

两个不相关的合成客户端配置验证精确重定向、PKCE、注册和权限。实际标准 MCP SDK 客户端通过 `npm run verify:ai-client-neutral` 在无 OpenAI 配置的干净环境执行 initialize/list/call，并检查缺少凭据拒绝、只读 403，以及存储/设备没有增量。这不等于专有 OAuth 客户端已生产接入。

旧 Sites 交接在独立可选兼容模块中，只有显式选择配置时才使用；保留精确预期 URL、HTTPS、路径与认证，通用交接不推断客户端。工具授权元数据的兼容镜像源码不注册默认工具。SDK 差异需要 JSON/SSE、大小限制、额外参数、令牌边界测试及具体客户端试验；不能用重命名或通配符绕过重验。

生产签发方存储/撤销、ChatGPT 等可选客户端适配器和 SDK 家族互操作逐项验收，不阻塞无需专有平台的标准 HTTP/MCP 路径。

## English

<!-- topic:entry -->
### Explicit package entry

`@ghostfleet/typed-control/authorization` exports generic authorization building blocks. Importing it creates no HTTP ingress, OAuth issuer, client registration or device execution. Root MCP still uses an independent read bearer and four inspection tools. Deployment integrators configure and separately validate production OAuth consumer login/profiles/accounts/callbacks/secret stores.

```sh
npm ci
npm run check:typed
npm run test:typed
npm run build:typed
```

The source entry is `packages/typed-control/src/authorization/index.ts`; the runtime build entry is `dist/authorization/index.js`. jose supports JWT mechanisms, not an OpenAI SDK.

<!-- topic:profile -->
### Client profiles, DCR and PKCE

| API | Trusted input and result/rejection |
| --- | --- |
| `validateClientProfile(profile)` | Trusted deployment profile_id/client_id/name/exact HTTPS redirects/scopes; rejects wildcard/userinfo/fragment/duplicates |
| `validateRegistration(metadata,profile)` | Exact name/redirects; returns versioned RegisteredClientBinding containing client/profile/redirects/registered scopes/profile_snapshot |
| `revalidateRegisteredClient(stored,profile)` | Rechecks trusted persisted registration against current profile; rejects rotation/missing/stale state |
| `validateAuthorizationRequest(params,profile,stored)` | Required third argument is trusted persisted registration; unique parameters, exact client/redirect/PKCE and registered scope ceiling |
| `revalidateTokenScope(grant,stored,profile)` | Rechecks authenticated token/refresh grants against registration/current profile; read-only registration cannot expand into execution authority |
| `verifyPkce(verifier,storedChallenge)` | 43–128-character verifier and stored S256 challenge; returns boolean, never treats caller-selected challenge as authority |

Requests cannot create or widen deployment profiles. Integrators persist validated bindings in one-use authorization-code/token state and verify code/verifier/client/redirect/expiry with replay protection at exchange. Call the public revalidation helpers against trusted registered scope ceilings and current profiles for authorization/token/refresh use. Helpers do not independently implement complete issuer storage, token authentication or production consumer cutover.

<!-- topic:ingress -->
### Ingress budgets, consent and tokens

`guardOAuthRequest` requires configured global/source limits before reading bodies and fails closed with 503 when unconfigured or 429 when denied; method/body/TTL requirements follow actual helper configuration. `bearerTokenMatches/bearerAuthorized` compare hashes, reject weak expected values/whitespace and never reflect credentials.

`ownerConsentForm(request,secret,clientName,owner,origin)` requires trusted canonical HTTPS origin as its fifth argument, never inferred from request data. Proofs bind origin, owner subject, client query and expiry using the `ghostfleet-consent-v2` signing domain. GET/POST verification rejects cross-origin, different-owner, expired, tampered and legacy origin-less proofs. Even shared signing secrets cannot replay origin A proofs at origin B. Integrators still provide trusted storage, one-use nonce consumption and revocation. The `access` module explicitly validates deployment-configured Cloudflare Access JWTs; verify issuer/audience/identity/scopes rather than trusting decoded claims.

Raw bearers, signing keys, code verifiers, owner identity and provider credentials stay in controlled custody. Generic helper tests do not establish account login, production OAuth redirects or provider revocation.

<!-- topic:family -->
### Clients, SDK families and compatibility

Two unrelated synthetic client profiles validate exact redirects/PKCE/DCR/scopes. Actual standard root MCP SDK clients use `npm run verify:ai-client-neutral` to cold-start without OpenAI configuration and exercise initialize/list/call, missing-credential rejection, read-only 403 and zero storage/device delta. They do not establish a proprietary OAuth client's production connection.

Legacy Sites lives in a separate optional compatibility module, preserving exact expected URL, HTTPS, path and authentication only when explicitly selected; generic handoff infers no client. Tool-auth metadata mirror compatibility source registers no default tools. SDK metadata/family differences need JSON/SSE/size/extra-argument/token-boundary tests and concrete client canaries before integration. Never widen redirects with wildcards or rename the same client profile to bypass revalidation.

Production OAuth issuer storage/revocation, ChatGPT or other client adapters and SDK-family interoperability require individual consumer acceptance without blocking the platform-neutral standard HTTP/MCP path.
