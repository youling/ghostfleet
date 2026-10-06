# Tailscale Transport Adapter v0 / Tailscale 传输适配器 v0

## 中文

这是可选 transport adapter，不是 GhostFleet core dependency，也不授予 root/PrivilegeLease/Break-glass authority。

它只定义：

- Control Panel / Enrollment Template 可见的 option manifest；
- desired/current diff planner；
- authority requirement metadata；
- sanitized receipt；
- UNKNOWN / partial outcome 的 reconcile 语义。

本目录不调用真实 Tailscale API、不保存 auth key/token、不修改真实 ACL 或节点。

```text
TAILSCALE_ENABLED != TAILSCALE_SSH_ENABLED
TAILSCALE_SSH_ENABLED != ROOT_AUTHORITY
UI_SELECTION != PROVIDER_AUTHORITY
```

## English

This optional transport adapter exposes a provider-option manifest, deterministic desired/current planning, authority requirement metadata, sanitized receipts and reconcile semantics. It is not a GhostFleet core dependency and does not grant root, PrivilegeLease or break-glass authority. No real Tailscale API, auth key, ACL or node mutation is performed here.
