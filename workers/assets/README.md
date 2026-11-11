# ghostfleet-assets (public immutable material origin)

**中文**

这是 GhostFleet 的**公开只读材料源**，只提供按摘要寻址的不可变字节：`GET /sha256/<64 hex>`。
它没有 Access 登录、没有上传、没有目录列表、没有重定向，也不返回任何动态内容。
内容寻址不等于加密：这里的一切都是公开的，因此构建脚本 `scripts/build-assets.mjs` 会在发布前拒绝私钥、Token、`.env`、私有域名/节点名等形态的材料。

部署约束（配置层已写死）：`workers_dev: false`、`preview_urls: false`。唯一公开地址是部署方自己的 zone（`routes`/custom domain 由私有部署注入，本仓不写死域名）。

发布前：

```sh
node scripts/build-assets.mjs --inventory <inventory.json> --out dist/assets
```

产物是 `dist/assets/sha256/<digest>` 文件树加 `manifest.json`（`ghostfleet-assets-manifest/v1`）。manifest 只供部署盘点，不对外提供（Worker 对非 `/sha256/<digest>` 一律 404）。

## 配置面契约（私有部署只需写这些）

| 名称 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `ASSETS` | static-assets binding | **是** | 指向 `scripts/build-assets.mjs` 产出的 `dist/assets` 目录；只含 `sha256/<digest>` 与 `manifest.json` |
| `routes` / custom domain | 部署方注入 | 是（生产） | 唯一公开地址；本仓不写死域名 |

- **路由前缀**：仅 `GET/HEAD /sha256/<64 小写 hex>`；`workers_dev: false`、`preview_urls: false` 已写死。
- **不提供**：目录列表、上传、重定向、动态内容；`manifest.json` **不对外**。
- **响应契约**：200 带 `cache-control: public, max-age=31536000, immutable`、`ETag: "<64hex>"`（与路径摘要同值）、稳定 `application/octet-stream`、`nosniff` 与沙箱 CSP；带匹配的 `If-None-Match`（含 `W/` 与 `*`）返回 **304 无 body** 并保留 `ETag`/`cache-control`；非内容地址 404（即使带了 validator 也不伪造 304）；非 GET/HEAD 405（`allow: GET, HEAD`）；binding 缺失 503。
- **限流**：不需要。对象不可变且可被 CDN 全量缓存；如部署方另加滥用限流，它只能是辅助且 fail-open，绝不能成为访问/授权判定。
- **vendor 规则**：`src/index.js` 与本仓逐字节一致；私有仓只允许 `wrangler` 覆盖（routes/bindings），不得改代码。

## English

This is GhostFleet's **public read-only material origin**. It serves exactly one
route: `GET /sha256/<64 hex>`, the immutable bytes reviewed for that digest. No
Access login, no upload, no listing, no redirect, no dynamic content.

Content addressing is not encryption: every byte here is public, so
`scripts/build-assets.mjs` refuses to publish private keys, tokens, `.env`
material or private host/node names.

Deployment constraints are in the config: `workers_dev: false` and
`preview_urls: false`. The only public address is the deployment's own zone; the
route/custom domain is injected by the private deployment and never hardcoded
here.

**Configuration contract (all a deployment provides):** the required `ASSETS`
static-assets binding points at the `dist/assets` tree built by
`scripts/build-assets.mjs`, and the deployment injects the route/custom domain.
The only route is `GET/HEAD /sha256/<64 lowercase hex>`; there is no listing,
upload, redirect or dynamic content, and `manifest.json` is never served.
Responses are 200 with immutable caching, `ETag: "<64hex>"` equal to the path
digest, a stable `application/octet-stream`, `nosniff` and a sandbox CSP. A
matching `If-None-Match` (including `W/` forms and `*`) returns a bodiless **304**
with `ETag` and `cache-control` preserved; a missing address is 404 even when a
validator is presented, so a 304 can never confirm a phantom object; non-GET/HEAD
methods are 405 with `allow: GET, HEAD`; an unwired binding is 503. No rate limiter is required
(immutable objects cache at the CDN); any deployment-added abuse limiter must be
advisory and fail-open, never an access or authorization decision. `src/index.js`
is vendored byte for byte; a private repo may only overlay `wrangler`
configuration.

```sh
node scripts/build-assets.mjs --inventory <inventory.json> --out dist/assets
```

The output is a `dist/assets/sha256/<digest>` tree plus `manifest.json`
(`ghostfleet-assets-manifest/v1`). The manifest is deployment inventory only and
is never served: every other path 404s.
