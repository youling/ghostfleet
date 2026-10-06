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

普通 Agent principal 不得拥有 NOPASSWD sudo、root-equivalent Docker/socket/group 等旁路。完整 root-owned Helper compromise 属于 incident/trust-boundary failure，不伪称协议还能约束已获 root 的攻击者。

## English

This package implements a node-local typed privileged-execution boundary. It never exposes arbitrary shell, password transport, root SSH, credential export or raw command passthrough. An authenticated local IPC envelope is validated by an injected lease verifier, dispatched to an exact typed operation through an effect fence, and produces public-safe receipts. Real OS backends, production lease verification and installation execution are deployment concerns.
