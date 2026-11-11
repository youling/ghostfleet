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

```sh
node scripts/build-assets.mjs --inventory <inventory.json> --out dist/assets
```

The output is a `dist/assets/sha256/<digest>` tree plus `manifest.json`
(`ghostfleet-assets-manifest/v1`). The manifest is deployment inventory only and
is never served: every other path 404s.
