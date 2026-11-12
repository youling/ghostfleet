# Scripts / 脚本

## Capability status projection / 能力状态投影

`/etc/ghostfleet/capability-status.json` has exactly one writer: the
`capability_status_projection` shell function in `packages/bootstrap/src/bootstrap.js`.
`scripts/emit-capability-status.mjs` renders that same function (its marked fragment)
into a disposable shell and runs it, so acceptance never re-implements the writer.

`/etc/ghostfleet/capability-status.json` 只有一个写入实现：`packages/bootstrap/src/bootstrap.js`
里的 `capability_status_projection`。`scripts/emit-capability-status.mjs` 直接渲染并执行同一段被标记的
函数，因此验收入口与 courier 共用此入口，不存在第二份实现。

Exact usage (root, on the node; every artifact is a measured `name=sha256:<64 hex>:<mode>` row):

```sh
node scripts/emit-capability-status.mjs \
  --template-digest sha256:<64 lowercase hex> \
  --artifact node-agent.pyz=sha256:<64 hex>:0755 \
  --artifact ghostfleet-managed.service=sha256:<64 hex>:0644 \
  --artifact fleet-privctl.py=sha256:<64 hex>:0755 \
  --artifact privileged-ops.pub=sha256:<64 hex>:0644 \
  --artifact managed-linux-privileged-operations.sh=sha256:<64 hex>:0750 \
  --installer managed-linux-privileged-operations.sh \
  --privileged-key privileged-ops.pub \
  --unit ghostfleet-managed.service \
  --unit-artifact ghostfleet-managed.service \
  --payload-artifact node-agent.pyz \
  --control-account ghostfleet-managed \
  --privileged-account ghostfleet-ops \
  --applied-at 2026-01-02T03:04:05Z
```

The default output directory is `/etc/ghostfleet` (root:root 0755, file root:root 0644,
written with tmp+fsync+rename). The command reads no stdin and has no `--dry-run` mode: it
either writes the projection or fails without touching the output path.

Inputs are argv flags only (every flag is required, values are never read from the
environment or file paths). On success it prints exactly one line to stdout:

```
capability-status: /etc/ghostfleet/capability-status.json release_pin=<40 hex> artifacts=<n> applied_at=<RFC3339 Z>
```

Stable exit codes (the first token of the stderr line is the code):

| exit | code | meaning |
| --- | --- | --- |
| 2 | `EMIT_CAPABILITY_STATUS_INPUT_INVALID` | missing/duplicate/malformed flag, bad digest or mode, duplicate artifact name, artifact not covered by a role, secret-shaped value, or control account == privileged account |
| 3 | `EMIT_CAPABILITY_STATUS_ENVIRONMENT` | the marked writer fragments are missing/duplicated in the courier source, or `/bin/sh` cannot be spawned |
| 4 | `EMIT_CAPABILITY_STATUS_WRITE_FAILED` / `EMIT_CAPABILITY_STATUS_OUTPUT_UNSAFE` | the writer could not replace the file atomically, or the result is not a root:root 0644 regular file |

The command is idempotent (byte-identical input rewrites the same body) and fails closed when
an input is missing, illegal or carries a secret.

用法：验收与 courier 共用此入口；只接受 argv 参数，不读 stdin，也没有 `--dry-run`；
成功时 stdout 恰好一行 `capability-status: <path> release_pin=<40 hex> artifacts=<n> applied_at=<RFC3339 Z>`；
缺参、非法摘要、含 token/secret/home 路径时 fail closed，退出码见上表
（2 = 输入非法，3 = 环境缺片段/无法 spawn /bin/sh，4 = 原子写失败或结果不是 root:root 0644 普通文件）。
