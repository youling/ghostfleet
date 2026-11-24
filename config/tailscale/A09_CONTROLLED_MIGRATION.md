# A09 Tailnet 单向管理：生产切换执行卡

> **SOURCE/REVIEW ONLY · NOT A LIVE TAILNET POLICY · NO PERMISSION TO APPLY.** 此卡为 GhostFleet 可复用的治理/验收流程，不包含真实 Tailnet IP、用户名、Token、SSH key、控制面写权限或现役 Policy 原文。节点实例与认证证据由 Fleet 实例 owner 私有保存。实际生产仍按 [REMOTE_ACCESS §5.1](../../docs/REMOTE_ACCESS.md) 的角色和 [ACCEPTANCE](../../docs/ACCEPTANCE.md) 的 A09 验收口径执行。

## 1. 定义问题，而不是误把“网络通”当“授权”

- 依据 [REMOTE_ACCESS §5.1](../../docs/REMOTE_ACCESS.md) 与 [ACCEPTANCE §7](../../docs/ACCEPTANCE.md)，允许一个或多个独立授权的 Controller principal 到明确目标实际 SSH listener；`MANAGED_ONLY` 不得反向或横向发起管理。Controller 所在主机也可被其他明确授权的 Controller 管理。旧 TP-only 是历史实例 scope；多 Controller 目标不扩大现役权限。
- 历史 A09 最后可核验结果为 FAIL_ALLOW_ALL（[#64](https://github.com/youling/ghostfleet/issues/64)）。不能把 sshd 公钥拒绝当网络层拒绝，也不能通过添加窄 grant 覆盖已有 broad allow。
- 单向管理不等于禁止正常业务、节点自身上报或已经获准连接的返回流量。必要通信按真实协议、目标和端口独立允许。
- 受保护的 Human/Operator 救援身份和各 Controller principal 必须独立验证。不能依赖某一 Controller 或 Tailnet 自身恢复来解除故障，也不能用共享私钥制造冗余。

## 2. 一次性只读取证包（不修改现网）

由有权限的 Tailnet Owner **私有**归档原始 `policy.hujson`，仅向公共工单展示脱敏摘要；同时固定内容 SHA256、读取时间、审查主体及版本标识。如果已有合法的只读 Tailscale API 凭据，可直接使用官方 `GET /api/v2/tailnet/-/acl` 取得 Policy 和 ETag（`-` 表示该凭据的默认 Tailnet），无需由 Human 手工复制文本。**仅限读取权限**：Tailscale scoped trust credential 的 `policy_file:read`，按官方要求附属的设备读取权限，不取得 `policy_file` 写权限。不可为了这次只读审计创建宽权限管理员 Token；没有合法读取权限就标 `READBACK_UNAVAILABLE` 并停在只读阶段。不得在 URL、命令行参数、GitHub 评论或普通日志中输出凭据。私有原件应按受信任 Host 存储规则保存；若未来实施写入，必须用获准写主体对照 ETag/原始摘要，防止覆盖他人并发修改。参考官方 [Policy File API](https://tailscale.com/api) 与 [Trust Credentials](https://tailscale.com/docs/reference/trust-credentials)。

同时记录：

| 对象 | 必须读回 |
|---|---|
| Tailnet Policy | 完整 `hosts/tagOwners/groups/grants/acls/ssh/tests/sshTests` 与其他有关段；所有宽泛 allow |
| 设备与源主体 | 当前实例已获准 Controller、候选 Controller、MANAGED_ONLY、Operator/救援的真实身份及映射；用户/tag、有效地址、key expiry 与当前授权范围，原件私有 |
| 服务消费 | 实际管理 listener（不能固定为 22），业务、Reporter、Runner、数据与其他必要流量 |
| Controller executor | 各实际出站执行主体的 OS 身份、运行位置、受保护凭据/agent、known_hosts 与目标 scope；入站公钥/Tunnel/Reporter 不等于出站凭据 |
| 救援与控制恢复 | 不依赖待变更路径的实际新建认证会话；控制状态/凭据恢复方案与共享电源、网络、Provider、存储故障域 |
| 当前生效策略 | 受影响设备正规接口的有效过滤规则；仅 Policy 文件文本不能证明下发 |

读不全按实际缺项保留 FAIL/INVENTORY_INCOMPLETE/NOT_PROVEN，不从在线状态猜测可投产策略。

## 3. 分阶段收敛，绝不提前换 tag 或密钥

**Phase 0：冻结原件，补真实矩阵。** 按实例 Owner 当前批准的控制主体、目标与 scope 生成明确允许/拒绝，保留 Human/Operator 独立救援及合法业务。候选 Controller 不自动列入允许集合，普通 Runner 不因位于核心主机而成为控制主体。

**Phase 1：精确身份与完整 Policy 差异。** 优先沿用已有经核验的 user/tag/host selector，不为统一形式先改设备身份或 key。先移除与目标隔离冲突的全网放行，再保留受审的准确 source/destination/port。完整 Policy tests 是正负回归断言，不是运行时 deny 规则；语法通过不等于所有业务已覆盖。按原 Owner 授权和 ETag/版本核对实施。

**Phase 2：真实 A09 验证。** 从每个本次已获准 Controller 实际执行身份建立新会话，验证 host-key pin 与允许动作；从 MANAGED_ONLY 测试所有相关反向、横向管理 listener 的新建 TCP 拒绝；核对救援和业务正例、实际有效过滤规则及独立目标证据。不得用旧 ControlMaster、未知 SSH key 拒绝或其他控制端登录冒充成功。

**Phase 3：独立接替和回归（在实际授权范围内）。** 多 Controller 分别验证其独立凭据、目标范围与恢复；独立任务可并行；同一有副作用的独占资源按既有 ownership/generation/fencing/UNKNOWN 对账，确认旧主恢复不能以陈旧 generation 写入（适用时）。原生 SSH 没有天然 fencing，不能证明安全接替则只阻断该资源。不得把身份变更、全局选主或新 daemon 作为 A09 通用前置。

## 4. Policy tests：实例 owner 按原件补入，禁止直接套用示例

以下为故意不完整的合成断言形状，不是可部署 Policy；必须替换为已审的实例 selectors 与真实 listener，保留其他合法 tests。控制主体间许可只针对明确 scope，不意味着所有候选 Controller 相互全通。

```hujson
// SYNTHETIC SHAPE ONLY — NOT A VALID DEPLOYABLE POLICY
"tests": [
  {
    "src": "REPLACE_AUTHORIZED_CONTROLLER_A",
    "proto": "tcp",
    "accept": ["REPLACE_ALLOWED_TARGET:22"],
    "deny": ["REPLACE_UNGRANTED_TARGET:8280"]
  },
  {
    "src": "REPLACE_AUTHORIZED_CONTROLLER_B",
    "proto": "tcp",
    "accept": ["REPLACE_SEPARATELY_ALLOWED_TARGET:8280"]
  },
  {
    "src": "REPLACE_MANAGED_ONLY_A",
    "proto": "tcp",
    "deny": [
      "REPLACE_CONTROLLER_A:22",
      "REPLACE_CONTROLLER_B:22",
      "REPLACE_MANAGED_ONLY_B:8280"
    ]
  }
  // ADD: all remaining real positive/negative cases, actual listener ports,
  // independently authorized recovery and legitimate business paths.
]
```

示意包含非标准端口，仅说明测试维度；真实矩阵必须覆盖所有实际相关管理端口、主体与准入范围。

## 5. Controller 原生 SSH 控制凭据：按实际执行身份接入

- Controller 是已授权的控制能力，不要求常驻 SSH daemon。明确每个实际出站执行 principal，核对来源/目标、受保护凭据与现有 authorized_keys。只确认入站 Tunnel/Reporter、HOME 无私钥或其他 Operator 登录不足以证明该执行身份出站可用。
- 各 Controller 使用独立、可撤销、受保护的身份和最小目标 scope；只在获准目标增量安装相应公钥，按实际任务区分 root 管理、普通账号、受限 helper、PTY/SFTP。不能复制 Human/其他节点的私钥，不向下位机/普通 CI 交付广域管理凭据或 agent 转发能力。
- 从对应实际 principal 发起新 SSH 连接，使用 `BatchMode=yes`、`IdentitiesOnly=yes`、`StrictHostKeyChecking=yes`，禁用连接复用与非必要转发。记录实际认证身份、主机指纹、目标端口、命令/传输结果和撤销边界。替代来源的成功仅证明替代来源；多 Controller 必须分别实测。

## 6. 切换与恢复边界

- **需单独 Human 批准**：生产 Policy 写入（含完整原→新 diff、Operator 救援正例、tag/hosts 范围、预期影响、负责写主体、检查窗口）；节点 tag/密钥变更和故障注入均各自独立审批。
- **不能依赖仍为 allow-all 的旧 Policy 作为“安全回滚”**。如果切换导致拒绝合法业务，优先通过不依赖故障 Tailnet 的已验证救援入口修补**仍保持最小授权**的 Policy；若 Owner 明确批准恢复旧的 allow-all，必须记录这是一种为了恢复可用性而重新接受横向暴露的紧急例外，状态退回 `A09=FAIL`。
- Tailnet ACL/grants 不限制普通 LAN 直连、非 Tailscale 的 Cloudflare 公网管理入口或其他网络路径。**A09=PASS 只能表示所验 Tailnet 新建连接策略达标**；不能推断整台机器对所有接口都不存在横向 SSH。
- 不改变现有 Cloudflare A03/A08、Runner 上线、A10/A11 故障注入的独立授权与验收结论。失陷半径（应用 API、凭据、其他路径、制品发布、备份删除）需从独立可信边界取证；A09 不替代该验收。

## 7. 判定

A09 PASS 必须有本次完整 Policy/readback、受影响设备生效过滤规则、完整 scoped tests、每个已获准并纳入本次矩阵的实际 Controller SSH 正例、MANAGED_ONLY 新建反向/横向网络拒绝及救援/业务正例。缺项按具体事实报告；不把未获准候选 Controller 作为现役 A09 的新通用门禁。多主体接替、旧写入拒绝、独立救援和跨路径失陷隔离分别按既有验收 Work 记录，不能由 A09 PASS 推导。历史 FAIL 不因文档改动改变。

官方文档：[Policy file syntax](https://tailscale.com/docs/reference/syntax/policy-file) · [Grants / cumulative allow](https://tailscale.com/docs/features/access-control/grants/grants-explained) · [ACL default allow-all](https://tailscale.com/docs/features/access-control/acls) · [Tags](https://tailscale.com/docs/features/tags)。
