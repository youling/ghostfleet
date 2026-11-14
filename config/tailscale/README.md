# Tailscale 路径 / Tailscale path

## 中文

复用官方 Tailscale 软件包及 `tailscaled.service`，按所有者既定身份完成设备加入。现有 tailnet 网络策略应允许指定管理端访问目标 TCP/22；具体来源/目的地和凭据归属在原实例内配置。

本方案只使用 Tailscale 网络层。目标必须保持 Tailscale SSH 关闭，让两路进入同一个原生 sshd，并使用同一节点的主机密钥和 OS 账户。更改真实设备前保留已有恢复入口；下面是获授权后的配置模板：

```sh
sudo tailscale set --ssh=false
tailscale status
```

[Tailscale SSH 官方文档](https://tailscale.com/docs/features/tailscale-ssh)说明，启用该功能会把 tailnet 的 22 端口交给 Tailscale 自己的 SSH server；它和普通 OpenSSH over Tailscale 的身份/撤销语义不同。

没有 TUN 的客户端可以研究用户态 tailscaled 与 `ProxyCommand tailscale nc %h %p` 的组合；需要可访问的本地 daemon socket、已授权身份和允许的网络出口。它继续由 OpenSSH验证 SSH 身份，不启用 Tailscale SSH。当前只是官方能力与源码支持的候选，不代表已在任何云沙箱部署。详见 [技术调研](../../docs/research/TRANSPORT_RECONNAISSANCE_2026-11-14.md)。

## English

Reuse the official package and upstream service. Enroll using the owner's selected identity and configure the existing network policy for the intended source, destination and TCP/22.

Keep Tailscale SSH disabled so both paths terminate at the same native sshd with the same machine host key and OS account. Preserve a recovery route before changing a live device. The commands above are an authorized-deployment template. Enabling Tailscale SSH instead intercepts tailnet port 22 with Tailscale's own server, as described in the official documentation.

For clients without TUN, userspace tailscaled with `ProxyCommand tailscale nc %h %p` is a documented/source-supported option. It requires daemon access, authorized tailnet identity and permitted network egress; OpenSSH still authenticates SSH. This has not been deployed or accepted in a cloud sandbox by this repository change. See the research report for evidence and limits.
