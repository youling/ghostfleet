# Linux Privileged Helper v0 / Linux 节点提权 Helper v0

## 中文

本包实现节点本地的 typed privileged execution boundary。它不提供 root shell、sudo 密码搬运、root SSH、credential export 或任意命令透传。

核心模型：

```text
ordinary Agent/runtime
  -> authenticated local IPC envelope
  -> injected lease verifier
  -> exact typed operation
  -> effect fence
  -> OS backend
  -> public-safe receipt
```

第一版只提供最小 typed operation contract：

- `service.status.read`
- `service.restart`
- `managed.file.materialize`

真实 OS backend、production lease verifier 和安装执行由 deployment/integration 层注入。本包只冻结 Helper enforcement boundary、安装/卸载计划和 fail-closed 行为。

IPC 参数在异步租约验证前深复制并冻结；验证与执行使用同一快照。仅接受有限 JSON 数据（最多 64 层、10,000 个值）；循环引用、访问器、非有限数字、稀疏数组及自定义对象在验证器/OS backend 前拒绝，不调用 getter/toJSON，不在拒绝回执中回显参数。此边界加固不实现 #63 的通用 Human-approved 管理员命令或维护会话；现有 typed v0 与生产安装范围保持原状。

普通 Agent principal 不得拥有 NOPASSWD sudo、root-equivalent Docker/socket/group 等旁路。完整 root-owned Helper compromise 属于 incident/trust-boundary failure，不伪称协议还能约束已获 root 的攻击者。

## English

This package implements a node-local typed privileged-execution boundary. It never exposes arbitrary shell, password transport, root SSH, credential export or raw command passthrough. An authenticated local IPC envelope is validated by an injected lease verifier, dispatched to an exact typed operation through an effect fence, and produces public-safe receipts. Real OS backends, production lease verification and installation execution are deployment concerns.

IPC parameters are deeply copied and frozen before asynchronous lease verification; verification and execution share that snapshot. Only bounded JSON data is accepted (up to depth 64 and 10,000 values). Cycles, accessors, non-finite numbers, sparse arrays and custom objects are rejected before the verifier/OS backend, without invoking getters/toJSON or echoing parameters in denial receipts. This hardening does not implement the general Human-approved administrator command/session required by #63; the typed v0 and production-installation boundaries remain in place.
