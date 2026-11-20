# A09 Tailnet 单向管理：生产切换执行卡

> **SOURCE/REVIEW ONLY · NOT A LIVE TAILNET POLICY · NO PERMISSION TO APPLY.** 此卡为 GhostFleet 可复用的治理/验收流程，不包含真实 Tailnet IP、用户名、Token、SSH key、控制面写权限或现役 Policy 原文。节点实例与认证证据由 Fleet 实例 owner 私有保存。实际生产仍按 [REMOTE_ACCESS §5.1](../../docs/REMOTE_ACCESS.md) 的角色和 [ACCEPTANCE](../../docs/ACCEPTANCE.md) 的 A09 验收口径执行。

## 1. 定义问题，而不是误把“网络通”当“授权”

- **TP 是唯一 Fleet Controller**；Managed Nodes 的典型新建管理连接只允许 `TP → Managed SSH listener`。Managed → TP、Managed → Managed 的**新建管理连接**必须被有效 Tailnet Policy 拒绝。原生 OpenSSH 继续负责 OS 用户认证，不改用 Tailscale SSH。
- A09 实测的当前有效 PacketFilterRules 为尾网 source pool → all destination/port。**这是网络层 FAIL**，不能靠 SSH `Permission denied (publickey)` 作为 ACL 拒绝证据。
- `grants`、`acls` 是**累加 Allow**，加窄规则并不能覆盖现有宽规则；省略 `acls` 时默认可能是 allow-all。迁移时必须读取**整份 Policy**并审查所有广泛 Allow，再受控地替换；只修改 GhostFleet 文档或机器 tag 无法修正 A09。
- **单向是管理权限边界，不是“Managed Node 不允许主动做任何事”**：节点对 Cloudflare/外部 GitHub/软件源的出站连接通常不经上述点对点 Tailnet ACL；但如果真实心跳、反向管理辅助、NAS/私有 Worker 或业务数据流使用了 Tailnet 内节点地址，必须按实际协议与端口列入最小必要例外并正测，不得一刀切导致失联。
- **已有的 Windows Operator / Boss 管理及带外救援**不是 TP 服务身份。必须逐项读回其当前 Tailscale identity 和所需端口；操作端的临时登录不授予 TP Controller 的长效执行凭据。不能先删掉操作端允许规则，再靠“TP 总会能连上”赌恢复。

## 2. 一次性只读取证包（不修改现网）

由有权限的 Tailnet Owner **私有**归档完整、脱敏展示的原始 `policy.hujson` + 内容 SHA256、读取时间及审查主体，并同时记录：

| 对象 | 必须读回 |
| --- | --- |
| Tailnet Policy | 原有 `hosts`、`tagOwners`、`groups`、`grants`、`acls`、`ssh`、`tests` 与其他既有段；所有 `*:* / *` 或宽泛 grant 来源 |
| 设备身份 | TP/Managed/Windows Operator/救援设备的当前 Tailscale IP、节点 key、user-vs-tag identity、现有 tag 与 key expiry |
| 服务消费 | 实际 SSH listener：不同节点可能是 22 或另一个端口；Fleet 心跳、反向调用、Runner/业务数据、NAS、SSH/SFTP 的真实通信方向及目的端口 |
| Control service | TP 现役控制服务的 **ExecStart/User/Group** 和受权的执行主体（不是简单读 /root/.ssh）；服务使用哪一种 SSH client identity、known_hosts 与凭据设施 |
| 救援通道 | Windows Operator 到 TP/至少一个 Managed 节点的独立**新建已认证** SSH/SFTP 会话；若依赖 LAN/Cloudflare，记录真实可用性、控制面回退权限、恢复操作者 |
| 当前有效策略 | TP/Managed 从 `tailscale debug netmap` 或等价正规接口读回本机生效过滤规则；仅 policy 文件文本不能证明设备已接收更新 |

以上内容如果读不到，保持 `A09=FAIL/INVENTORY_INCOMPLETE`，**不得猜测或从四节点在线状态生成可投产策略**。

## 3. 分阶段收敛，绝不提前换 tag 或密钥

**Phase 0：冻结原件，补全真实流量矩阵。** 审查 Windows Operator、云/本地业务和其他 Tailnet 设备实际需要的连接。Managed → TP 的非管理业务若确实存在，明确标成允许的 `src/dst/ip` 最小例外；否则默认拒绝。核对两台 Runner 只需要访问 GitHub 外网还是使用 Tailnet 内网服务，不要误把它们当成 TP 的 SSH 管理客户端。

**Phase 1：同设备身份迁移。** 暂不改变 TP 当前的 tag、JG 的 user-bound identity、或 WCX/SYJ 的 tagged identity。使用精确 `hosts` alias / Tailscale IP 来识别**当前四台设备**，避免误把目前也携带 managed-target tag 的 TP 纳入目标集合。审批的是**完整 Policy 差异**，不是“加三条 allow”。需要明确移除默认/旧的 `*:* / any-any`，同时保留已确认的 Windows Operator 救援、其他合法业务路径及既有其他设备策略。Tailscale 在保存时对**整份** Policy 做语法和 tests 校验；校验失败不部分应用，但校验通过也不证明漏列的运行流量不会被切断。

**Phase 2：实际 A09 证明。** 先用管理端与 TP 各自建立**新**会话正测，验证 TP 的真实服务主体到所有 Managed 端口、Windows Operator 所需连接，以及被允许的业务/心跳；再从三个 Managed 端测试新建到 TP 管理端口、Managed 间目标 SSH 端口的明确拒绝。双向记录发起身份、目标/端口、时刻、尾网有效过滤规则、客户端退出码与目标 sshd 记录。**反向 sshd 拒绝不等于网络拒绝**；TCP 在 sshd 握手前被有效 ACL 拦截才算 A09 负控。不要用旧 ControlMaster/已有会话冒充新建连接。

**Phase 3：身份语义治理（可独立延期）。** 待 Phase 2 稳定后，另行审查是否把 TP 改为 `tag:fleet-controller`、Managed 改为 managed tag。Tag 会替换设备的 user identity，并可能改变 key expiry/授权语义；Owner 必须独立批准变更与撤销/恢复计划。**A09 可以先通过精确 host selector 实现，不必把 tag 迁移当成前置条件。**

## 4. Policy tests：实例 owner 按原件补入，禁止直接套用示例

下面是**故意不完整**的测试形状，所有 `REPLACE_...` 必须用真实私有 Policy 中的 `hosts` alias 或受审身份替代，保留现有其他 tests；不能单独覆盖生产 Policy。本项目使用原生 OpenSSH，`tests` 检查网络层，**不是** `sshTests`。

```hujson
// SYNTHETIC SHAPE ONLY — NOT A VALID DEPLOYABLE POLICY
"tests": [
  {
    "src": "REPLACE_TP_HOST_ALIAS",
    "proto": "tcp",
    "accept": [
      "REPLACE_JG_HOST_ALIAS:22",
      "REPLACE_WCX_HOST_ALIAS:22",
      "REPLACE_SYJ_HOST_ALIAS:8280"
    ]
  },
  {
    "src": "REPLACE_JG_HOST_ALIAS",
    "proto": "tcp",
    "deny": [
      "REPLACE_TP_HOST_ALIAS:22",
      "REPLACE_WCX_HOST_ALIAS:22",
      "REPLACE_SYJ_HOST_ALIAS:8280"
    ]
  },
  {
    "src": "REPLACE_WCX_HOST_ALIAS",
    "proto": "tcp",
    "deny": ["REPLACE_TP_HOST_ALIAS:22", "REPLACE_JG_HOST_ALIAS:22"]
  },
  {
    "src": "REPLACE_SYJ_HOST_ALIAS",
    "proto": "tcp",
    "deny": ["REPLACE_TP_HOST_ALIAS:22", "REPLACE_JG_HOST_ALIAS:22", "REPLACE_WCX_HOST_ALIAS:22"]
  }
  // ADD: Windows Operator positive tests, other actual legitimate Tailnet
  // traffic, and negative cases for ANY unintended managed management port.
]
```

**注意**：示意负控不等于完整的“禁止所有非管理方向”规则。对于 SYJ 的 `8280` 及任一节点将来新增的非标准 SSH 端口，需要随 listener 清单补测。最终测试覆盖范围由真实端口表决定，而不是按 22 猜。

## 5. TP 原生 SSH 控制凭据：按实际服务身份接入

- 首先读回 TP 现役 Controller unit 的 `User=`、`ExecStart=` 与实际执行 UID。**不要默认在 root HOME 创建私钥然后误以为服务就能使用**；也不要把 Windows 的管理私钥或任一 Managed Node 的私钥拷过去。
- 如果确需单独的 TP Controller Ed25519 key，其私钥应只给实际受信任控制服务主体使用；公钥仅加到受审 Managed SSH 入口，遵守原有 root/forced-command/privileged-helper 边界。能使用狭窄命令 helper 时，不因“方便”而一律给无限 root SSH。
- 从 TP **实际服务身份**发起全新 SSH，禁用连接复用，验证 host-key pin、root/限定命令 exec、PTY 与 SFTP；对三台目标分别做凭据正例、错误身份负例。A04/A05/A06 的 Windows Operator 历史回执不能顶替 TP Controller 出站验收。

## 6. 切换与恢复边界

- **需单独 Human 批准**：生产 Policy 写入（含完整原→新 diff、Operator 救援正例、tag/hosts 范围、预期影响、负责写主体、检查窗口）；节点 tag/密钥变更和故障注入均各自独立审批。
- **不能依赖仍为 allow-all 的旧 Policy 作为“安全回滚”**。如果切换导致拒绝合法业务，优先通过不依赖故障 Tailnet 的已验证救援入口修补**仍保持最小授权**的 Policy；若 Owner 明确批准恢复旧的 allow-all，必须记录这是一种为了恢复可用性而重新接受横向暴露的紧急例外，状态退回 `A09=FAIL`。
- Tailnet ACL/grants 不限制普通 LAN 直连（例如 10.0.0.x）、非 Tailscale 的 Cloudflare 公网管理入口或其他网络路径。**A09=PASS 只能表示所验 Tailnet 新建连接策略达标**；不能推断整台机器对所有接口都不存在横向 SSH。
- 不改变现有 Cloudflare A03/A08、Runner JG/TP 上线、A10/A11 故障注入的独立授权与验收结论。

## 7. 判定

`A09=PASS` 必须同时存在：**Tailnet 完整 Policy/readback**、完整允许/拒绝 `tests` 通过、四节点生效 netmap 更新、TP 服务身份原生 SSH 正例、Managed → TP/Managed 的**新建网络拒绝**以及 Operator/业务保活正例。缺任何一项分别标 `PARTIAL/NOT_ACCEPTED`，不能凭 tag 语义、netmap 允许列表、SSH 公钥拒绝或文档合并冒充通过。

官方文档：[Policy file syntax](https://tailscale.com/docs/reference/syntax/policy-file) · [Grants / cumulative allow](https://tailscale.com/docs/features/access-control/grants/grants-explained) · [ACL default allow-all](https://tailscale.com/docs/features/access-control/acls) · [Tags](https://tailscale.com/docs/features/tags)。
