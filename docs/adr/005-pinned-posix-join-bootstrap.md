# ADR 005 — 固定摘要的 POSIX 首次引导

- 日期：2026-11-18。
- 范围：[#108](https://github.com/youling/ghostfleet/issues/108)；以[有界修复裁决](https://github.com/youling/ghostfleet/issues/108#issuecomment-6980574716)为准。
- 状态：源码决定；合并、实例发布与现场验收分别留证。

## 问题与决定

最小 Linux 系统可能没有 `/usr/bin/python3`，旧的 Python 一行命令会在下载安装器之前失败。为一次性加入增加小型 POSIX shell 引导，复用现有 node origin、稳定节点身份、短码和 Python 安装器；不改变 reporter、SSH 或提供商协议。

面板先用 HTTPS 下载 shell 文件至私有临时目录，核对构建固定的 SHA-256 后执行。shell 再核对 Python 安装器的固定 SHA-256 与字节数，最后交给原安装/领取流程。两次下载都拒绝重定向：curl 显式要求 HTTP 200；GNU wget 使用 `--max-redirect=0`。下载工具不读取用户配置文件，避免配置把重定向或不验证 TLS 带回流程。

## 前置与唯一新增系统效果

可信 CA bundle、curl 或 GNU wget、sha256sum、交互终端和受支持 Linux 是初始前置。缺 CA 时不能先可信地下载引导脚本，因此不承诺 CA 自动补齐，更不允许跳过 TLS 验证。

仅当 `/usr/bin/python3` 不存在时补装 `python3` 及其包管理器必需依赖：Debian/Ubuntu 使用 APT，Fedora/RHEL 系优先 DNF、无 DNF 时使用 YUM。APT 只更新索引并 `install --no-install-recommends --no-upgrade python3`；DNF/YUM 只安装固定 python3 包。已有 Python 必须为 3.10+；版本过低、不可执行或安装后仍不满足条件时失败，不自动替换。

不升级系统、不改变软件源、不删除包，不安装 CA 或下载工具，也不修改 SSH、公钥、提供商、账户、sudoers、防火墙、DNS、OMV、存储或业务服务。一次性依赖补齐结束后不留下常驻命令进程。

## 失败、迁移与验收

依赖、TLS、重定向、大小或摘要失败都在 ticket claim 前终止。短码继续由 Python getpass 隐藏输入，不放进 argv、URL 或环境。系统 Python 安装成功但后续加入失败时保留该共享运行时，不为回滚卸载它。领取结果未知时继续使用原同节点 Reissue/replace；已保存有效配置后的本地修复仍使用 repair，不能拿 repair 当版本升级。

现有节点不会因源码合并而改变。发布时保留构建派生的两个摘要；回退 Worker 发布物可恢复先前加入入口，已安装节点保持原有身份和凭据。系统包安装、真实纳管及 NAS Phase 0 仍由实例 owner 按既有范围执行。

回归使用真正的 POSIX shell、Panel 生成命令、curl/wget 和本地 TLS，包管理器与 OS 路径替换为隔离合成对象。覆盖快路径零包调用、APT/DNF/YUM 固定安装、正常/错误 UUID4、版本与前置失败、两个下载阶段的重定向/摘要拒绝、TTY 与 User-Agent。该证据不替代真实发行版软件源与生产安装验收。

## English summary

Add only a one-time, SHA-256-pinned POSIX bootstrap for systems missing Python. Trusted CA certificates, curl or GNU wget, sha256sum and an interactive terminal are prerequisites; never disable TLS verification to bootstrap trust. Both downloads refuse redirects and verify their pinned artifacts. Only missing system python3 and its required package dependencies may be installed through APT/DNF/YUM. An existing Python below 3.10 fails without replacement. No system upgrade, repository change, package removal, SSH/provider/account or storage effect is introduced. Failures before installer handoff preserve the ticket; a successfully installed shared runtime is retained after later enrollment failure. Existing identity, hidden short code and reissue/repair semantics remain unchanged.
