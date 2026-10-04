# Provenance and Extraction Notes

status: `V0`

## Public Console references / 公共界面参考

The professional admin Console follows the user's shadcn-admin layout/interaction reference at `e16c87f213a5ba5e45964e9b67c792105ec74d26` (MIT). No upstream code, screenshot or brand asset is copied into this repository. The Tabler component CSS remains the runtime foundation. Impeccable `6e802bd0ed99f53180e2359fddab6da8d97970d9` (Apache-2.0) is a development/review skill only; its code is not vendored. Exact use and synthetic preview evidence are recorded in [Console](CONSOLE.md).

## 中文版

GhostFleet 源自 `youling/fleet` 的真实实践，但公共仓库不是私仓 visibility flip，也不是整个目录复制。

V0 设计提取参考的私仓 donor 包括：

- `fleet/20_control_plane/control-panel/README.md` — reusable Console/domain boundary；
- `fleet/20_control_plane/control-panel/THIRD_PARTY_REUSE.md` — 第三方 UI provenance/license gate；
- `fleet/20_control_plane/enrollment/cloudflare_broker/README.md` — provider-independent courier / one-time enrollment lessons；
- `fleet/20_control_plane/enrollment/cloudflare_broker/src/convergence.js` — convergence/evidence lessons；
- `docs/runbooks/MANAGED_LINUX_CHATGPT_CONTROL.md` — typed-first capability、zero-delta、reconcile lessons；
- `youling/fleet#289` — GhostFleet 架构 SSOT 来源。

当前公共 V0 主要是**按公共契约重写**，而不是把私仓实现逐文件复制出来。

禁止迁移：

- live account ID / provider coordinates；
- private node inventory / topology；
- token / key / secret plaintext；
- user-specific policy；
- recovery coordinates；
- private multi-agent governance。

未来若直接复制/派生私仓或第三方代码，PR 必须记录 exact source revision、license、files 和 modification。

---

## English Version

GhostFleet comes from real `youling/fleet` production experiments, but the public repository is neither a visibility flip nor a wholesale directory copy.

V0 design extraction is informed by these private donor surfaces:

- `fleet/20_control_plane/control-panel/README.md` — reusable Console/domain boundaries;
- `fleet/20_control_plane/control-panel/THIRD_PARTY_REUSE.md` — third-party UI provenance/license gate;
- `fleet/20_control_plane/enrollment/cloudflare_broker/README.md` — provider-independent courier and one-time enrollment lessons;
- `fleet/20_control_plane/enrollment/cloudflare_broker/src/convergence.js` — convergence/evidence lessons;
- `docs/runbooks/MANAGED_LINUX_CHATGPT_CONTROL.md` — typed-first capability, zero-delta and reconcile lessons;
- `youling/fleet#289` — architecture SSOT source.

The current public V0 is primarily a clean reimplementation of public contracts rather than a file-by-file copy of private implementation.

Never migrate live account IDs/provider coordinates, private node inventory/topology, token/key/secret plaintext, user-specific policy, recovery coordinates or private multi-agent governance.

Any future direct copy/derivation from private or third-party code must record exact source revision, license, copied files and modifications in the PR.
