# A03 · Cloudflare Access SSH 加固、灰度与回滚合同

> **DESIGN_ONLY / NOT_DEPLOYED**。根据 [GhostFleet #11 架构裁决](https://github.com/youling/ghostfleet/issues/11#issuecomment-7022287529) 和 [工头 A03 设计回执](https://github.com/youling/ghostfleet/issues/11#issuecomment-7022736079) 整理。本文件不授权任何生产 API POST/PATCH/PUT/DELETE、Tunnel/DNS/SSH/Tailscale 修改或故障注入。实际实例状态以 #11、#64 和 ai-hub#215 最新回执为准。

## 1. 决策、已知事实和证据边界

**分支 A 已选定**：两个发布到公网的 SSH 主机名使用 Cloudflare Access 身份层，源站仍强制原生 OpenSSH 公钥认证，Host Key 须通过独立渠道固定。

| 主机名 | 已测路由 | 目前边缘准入 | 目标 |
| --- | --- | --- | --- |
| ssh-node-a.example.invalid | 示例 Tunnel A → ssh://localhost:22 | **NOT_RUN（示例）** | 第一个受控 Self-hosted Application 灰度 |
| ssh-node-b.example.invalid | 示例 Tunnel B → ssh://localhost:22 | **NOT_RUN（示例）** | A 验收后独立审批 |
| panel.example.invalid | 示例 Worker 控制面 | **NOT_RUN（示例）** | 不受本次灰度修改影响 |

**以上所有域名、Tunnel 名称和结果均为合成示例，不代表任何实际实例状态。** 实际 Cloudflare Access App/Policy 是否存在、路由是否公开、Edge 拒绝是否生效，只能在受权账户中读回并留在私有实例 owner。不能由没有观察到有效拒绝直接推断后台不存在 Access App。

~~~mermaid
flowchart LR
    Operator[Operator 人工客户端 / 被批准的 Agent] --> CF[Cloudflare Edge + Access]
    CF -->|授权后| Node A[Node A Tunnel → sshd / pubkey]
    CF -->|授权后| Node B[Node B Tunnel → sshd / pubkey]
    Operator -->|独立救援| LAN[LAN / Tailscale]
    LAN --> Node A
    LAN --> Node B
~~~

## 2. 变更前必须完成的只读清单

使用已有获准身份，**仅 GET/读取**云端配置，不创设或扩权 API Token，不输出 Token、Tunnel 凭据、DPAPI 明文或 Access Service Secret。

| 资源 | 必须取得的字段 | 当前判定 |
| --- | --- | --- |
| Cloudflare Account/Zone | Account ID、Zone ID、读取时刻、实际读方权限 | UNKNOWN |
| Published routes/DNS | exact hostname、DNS record ID、Tunnel UUID、ingress origin/service、源快照及其摘要 | 端到端 route 已测；对象 ID 尚未独立读回 |
| Access Application | App ID、type=self_hosted、exact domain/path、AUD、session TTL、MFA 与 IdP 列表 | UNKNOWN |
| Access Policies | Policy ID、action/precedence、include/exclude/require、绑定的 Service Token **ID**（非 Secret） | UNKNOWN |
| 审计日志 | Edge 的 allow/deny、目标 App ID/Policy ID、时间和最小必要 source metadata | UNKNOWN |
| 客户端 | Operator 的 cloudflared 真实路径/版本、人工/Agent 执行身份、已固定 host key、缓存隔离 | PARTIAL |

没有权限读回时填 UNKNOWN；不得以 HTTP 302/200、SSH 握手或本地 CLI help 冒充云端精确对象审计。

## 3. 两类认证必须分别成立

### 人工交互式登录

- **每个 exact hostname 独立 Self-hosted Access Application**；Allow include 仅指定的受信任用户/组。不得使用 Everyone、整个邮箱域名、所有 OTP 登录用户等泛匹配。
- 配置真实 IdP MFA 或 Cloudflare 独立 MFA；**邮件 One-Time PIN 不是天然的第二因素**。通过 API/UI 回读有效 MFA 配置和要求的身份提供商。
- Session TTL 需独立审批；**24 小时只是 Cloudflare 常见默认值，不代表本项目已批准**。优先评估 1–4 小时并说明操作成本、刷新行为。
- Operator 使用 cloudflared access ssh --hostname %h 发起新会话，完成身份挑战后仍进行 sshd 公钥验证及 StrictHostKeyChecking=yes；不能用旧 Access cookie、SSH 连接复用或已登录浏览器来替代新会话验收。

### 无人值守 Agent 的 Service Auth

- upstream cloudflared access tcp/ssh 确有 --service-token-id 和 --service-token-secret 选项，但**参数存在不代表认证链路成功**。上游曾有 cloudflare/cloudflared#1674 的 Service Token 回归报告，故必须对实际**当前版本 + Cloudflare 侧策略 + 干净客户端**执行正/负验证。
- 需要独立 Service Auth policy，指定最小范围的 token ID，不得采用永久 Bypass；匹配范围不得用 any-valid-service-token/Everyone 代替精确成员。Access policy 的 Include 是 OR，Require 是 AND，Service Auth/Bypass 优先于普通 Allow/Block 的 UI 顺序，须检查真实 precedence。
- Secret 不得直接出现在 ProxyCommand 文本、进程命令行、Git/GitHub 工单和日志。客户端支持 TUNNEL_SERVICE_TOKEN_ID 与 TUNNEL_SERVICE_TOKEN_SECRET 环境变量，但实际保管、注入、进程可见性、轮换及撤销需要单独审查，不能宣称环境变量本身绝对保密。
- Service Auth 解决的是身份认证，**不消除 cloudflared access ssh/tcp 的 WebSocket 传输**；长时 Agent 默认优先使用经过授权的 Tailscale/LAN，或单独研究 WARP-to-Tunnel 私网模型。
- 在真实 Edge Service Auth 正例与无 Token/无效 Token 负例均可复现前，Agent 入口维持 **AGENT_CF_AUTH=BLOCKED**。不得为保住无人值守而扩大人工登录策略。

官方参考：
[client-side SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)、
[Access policy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)、
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)、
[MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)、
[Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)、
[cloudflared #1674](https://github.com/cloudflare/cloudflared/issues/1674)。

## 4. Node A → Node B 逐节点灰度和 A08 独立验收

1. **变更冻结**：有权限的 Cloudflare 写主体实际读取 App/Policy/DNS/Tunnel 原配置并保存可复核快照、对象 ID 与 SHA。Operator 在当次环境下由 LAN 对 Node A、Node B **完成已认证的新 SSH 会话及无害命令**，不只检查 TCP/22 banner；确认另有 Tailscale 路径。LAN SSH 是 Cloudflare 失联时的独立连接，不是 sshd 本身损坏时的物理控制台。
2. **先对 Node A 的单一 hostname 写入**：Owner 批准具体 App/Policy、ID、用户/IdP、TTL、灰度窗口与回滚后，工头才可施行一次受控配置变更。不得同时操作 Node B 或 DNS/Tunnel UUID/systemd/SSH keys。
3. **人工允许正例**：全新 Access 登录和独立 SSH 会话完成 exec/PTTY；SFTP 小文件 upload → sha256 → download → sha256 → 清理，检查 Access allow Policy ID 与 sshd 用户认证，不能只看 SSH 成功。
4. **Edge 拒绝负例**：从不带 JWT/Service Token、浏览器凭据和缓存的隔离新客户端发起连接；**在源站 sshd 握手前被拒，不能读到 SSH Banner**。具体可见结果因协议/设置可能是 302、401、403 或 EOF，**不要求必须 403**。核对 Access decision/App ID/Policy ID 与同一窗口内无对应 sshd 新连接。Debian 可能用 journald，不能硬编码只有 /var/log/auth.log；缺失日志不是唯一证明。
5. **Agent 正负例**：使用现有获准服务凭据进行 headless auth 正例；无凭据、过期/错误凭据负例。记录实际版本、退出码、Access decision，不记录 credential 值。如果尚未授权 service token，填 BLOCKED，不能创建凭据冒充已完成。
6. **备用路径**：重新经 LAN/Tailscale 建立新 SSH/SFTP，确认其不因 Access 改动中断；旧会话不称为无损迁移。
7. **Node A 完整验收后再单独申请 Node B**。未在 Node A 完成全部实测之前，Node B 不得自动推广。

## 5. 安全回滚：不能自动删除 Access Application

**明确拒绝「DELETE Access App → 秒级、无损、安全回滚」的无条件承诺。** 删除 Access App 可能重新把 SSH 主机名暴露给全部公网，且 DNS/Edge 配置传播和缓存状态不保证瞬时一致。通过 LAN 登录 Node A 也**不等于**拥有 Cloudflare 账号控制权。

| 故障 | 默认安全终态 | 如需例外 |
| --- | --- | --- |
| Operator 的允许身份无法经 Edge 登录 | 保留边缘限制，改走已验证 LAN/Tailscale；在有权限的云端控制面定位 IdP/Policy 并恢复**同等安全**的已审快照 | 恢复无 Access 保护/删除 App 必须 Owner **另行接受公开 SSH 暴露风险** |
| Agent Service Auth 失败 | Agent 改走 LAN/Tailscale；不得放宽人工 Allow 或加 Bypass | 单独诊断 Token/版本兼容后重新验收 |
| Cloudflare API/后台不可达 | 停止云端写入；使用已验收救援入口 | 无独立云端写入权限时，禁止承诺“马上删 App 回滚” |
| 不预期的其他 App 受影响 | 停止 Node B 推广，按精确资源 ID 恢复经审核的策略快照 | 禁止全账号粗暴删除应用/Token |

记录写主体、实际快照 SHA、原/新配置 ID、操作时间、传播验收、Access 正负、SSH 新会话和剩余暴露风险；失败定性为 **ROLLBACK_UNCONFIRMED**，不能写“零停机”。

## 6. 其他验收边界

- A03_ROUTE=INSTANCE_READBACK_REQUIRED；A03_EDGE_ACCESS=NOT_RUN；A03_CONFIG_INVENTORY=UNKNOWN；A08=NOT_RUN，直到实际 Access 配置和边缘正负测试完成。
- A09=FAIL：当前 Tailscale 仍是 allow-all，违反 Node B Controller → Node A/WCX/SYJ Managed 的单向网络管理矩阵。Cloudflare Access 不解决 tailnet ACL，另案修正。
- A10/A11=NOT_AUTHORIZED：不得做 kill/restart/停 Tunnel/断网/生产故障注入。
- **文档合并不是线上 Access 变更授权，也不是任何实例已通过 A08 的证据。**

## English summary

Branch A secures two published SSH hostnames with Cloudflare Access plus native OpenSSH public-key authentication. This file is a design-only contract, not a live configuration or authorization to deploy. CLI support for service-token flags does not prove headless Service Auth works. Negative tests must demonstrate denial at the Edge before reaching SSH. Never automatically delete Access to “roll back”: doing so may re-expose SSH to the public Internet. Preserve independently verified LAN/Tailscale rescue, use staged Node A-first rollout, and record Cloudflare and sshd decisions separately.
