# M3 现场验证增量 / Field Validation Delta — 2026-11-17

```yaml
artifact_type: ARCHITECT_FIELD_VALIDATION_DELTA
status: ARCHITECT_RECONCILED_OWNER_REPORTED_EVIDENCE
as_of: 2026-11-17 Asia/Shanghai
baseline_research: REUSE_RECONNAISSANCE_2026-11-12
source_main_at_field_rollout: 810494aae8de1785b9dd0727ee8ba1cabb0b371f
production_worker_version: 0473a4fd-02b5-4791-b748-656b578f4820
previous_worker_version: f4f65150-34ba-446a-9663-651a21d242d4
installer_sha256: 5d67d35efae5d7a621a7261a346e899dad7efb397882e6b76a76d5b40b8b107c
installer_bytes: 15257
scope: THINKPAD_FIRST_NODE_SYSTEMD_HAPPY_PATH
not_claimed: INTERRUPTED_INSTALL_RECOVERY, REPORTER_REVOCATION, NETWORK_OUTAGE_RECOVERY, SECOND_NODE, CLOUDFLARE_SSH_PATH
new_dependencies: NONE
```

## 中文

### 1. 目的与证据边界

本记录不是重新罗列产品，而是把 M3 首节点真实部署中暴露的差异，与既有外部机制侦察对照，提炼可复用的工程纪律。

既有 [外部机制复用侦察（2026-11-12）](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md) 覆盖 14 个管理/身份/执行项目、27 个传输/分发仓库，合计 42 个主要上游仓库（不是 42 个独立项目）。本记录只做现场证据增量，不把旧报告的候选测试改写为 PASS，也不新增依赖准入。

现场证据来源为 Host Foreman 的 ThinkPad 部署/首用报告及架构师脱敏汇总：[生产发布与 Reissue 就绪 #6948400534](https://github.com/youling/ghostfleet/issues/11#issuecomment-6948400534)、[首节点现场回执指针 #6949253869](https://github.com/youling/ghostfleet/issues/11#issuecomment-6949253869)、[Architect reconciliation #6949587945](https://github.com/youling/ghostfleet/issues/11#issuecomment-6949587945)。架构师没有在本轮独立操作 ThinkPad 或 Cloudflare 生产账号；状态属于 owner-reported field evidence, 已按证据范围接受。

### 2. 真实现场验证出的四个差异

#### 2.1 systemd user manager 不等于 system manager

- Debian 13 / systemd 257.13 的真实 system service 使用 `DynamicUser=yes` 与 `LoadCredential=` 时，凭据文件权限为 `0440`。
- 旧校验 `mode & 0o077` 把 group-read 当成不安全，导致真实服务失败；先前 `systemd-run --user` 测试观察到 `0400`，因此没有覆盖生产 system manager 的凭据投递语义。
- 修复使用 `0o037`：允许 group-read，继续拒绝 group-write/group-execute 与所有 others 权限。ThinkPad 现场回执报告修复后不再出现 `CONFIG_PERMISSIONS_OR_SIZE`，systemd service exit 0。
- 经验：对 DynamicUser/LoadCredential、Polkit、sudo、socket activation 等依赖 PID 1 或系统身份的能力，必须在目标发行版、目标 systemd 版本、真实 system service 下做至少一次验收。user manager 测试只能作为补充。

#### 2.2 HTTP 客户端默认标识可能与边缘安全策略冲突

- Python `urllib` 默认 `Python-urllib/3.x` 在该 Cloudflare 生产域触发 Browser Integrity Check / Error 1010。
- Reporter POST 与安装器下载请求显式设置 `User-Agent: GhostFleet-Reporter/1` 后，现场回执报告请求 HTTP 200、安装成功、持续心跳。
- 经验：不要假定标准库默认请求头能通过真实 WAF/CDN；客户端应有稳定、诚实的产品标识，并在目标边缘策略下实测。
- 边界：User-Agent 不是认证凭据，也不是 WAF 绕过授权。Reporter 仍必须使用节点专属 bearer token；WAF 放行不能替代应用鉴权、Access 或 origin 分隔。

#### 2.3 repair、版本更新与凭据重发不是同一操作

- 当前 `repair()` 复用本地正在执行的脚本（`Path(__file__).read_bytes()`），重写本项目文件与 unit；它不下载新版本、不 claim 新票据、不轮换 reporting token。
- 因此，旧版本执行 `repair` 只会恢复旧版本。版本更新应先部署固定 SHA 的新 Worker/安装器，再对原 `node_uid` Reissue，执行 Panel 生成的 `--replace` 命令。
- 同节点 Reissue 会立即使旧 reporting digest/token 失效。目标可信终端必须先就绪，再点击 Reissue；不能把它当作无副作用的预备步骤。
- 经验：将操作模型拆成 `repair(local recovery)`、`reissue(credential rotation)`、`replace(version installation)`，分别定义前置条件、副作用和回执。不能把它们都包装成含糊的“重装”。

#### 2.4 本机服务状态、出站心跳与入站远控是不同事实

- 现场报告 `ghostfleet-heartbeat.timer` ACTIVE、service exit 0，journald 连续出现四次 `GF_HEARTBEAT_OK`，Cloudflare Tunnel 与 Tailscale 服务也保持 active，SSH 会话未中断。
- 这些证据足以接受本次 ThinkPad 的 systemd 自动上报与原生 SSH 连续性。
- 但 `cloudflared.service active` 只证明本机服务状态；心跳只证明节点成功向控制面上报。它们都不能单独证明 Cloudflare SSH 入口端到端可达，也不能证明第二节点或双路传输。

### 3. 与同类项目机制的映射

| 既有项目/机制 | 本次现场对应的教训 | GhostFleet 决定 |
|---|---|---|
| Cockpit / AWX / Salt：OS 身份与执行环境 | user-level 与 system-level 的实际权限/凭据投递不同；声明式 unit 测试不足以证明真实主机行为 | 保留目标系统级 systemd 验收；不引入新的 RMM/执行平台 |
| FleetDM / osquery：身份、观察与状态分层 | 心跳是观测，不是 lifecycle promotion；报告不应接管节点身份 | `node_uid` 保持稳定，reporting 作为旁接观测状态 |
| Teleport / step-ca：身份与凭据生命周期 | 重发会使旧凭据失效；凭据撤销与 SSH 访问不是同一个权限域 | reporting token 与 SSH 凭据分离，按同节点重新绑定 |
| Cloudflare Tunnel / Tailscale：控制、路径与服务状态分层 | tunnel service active 不等于路径端到端通过；WAF 与应用认证是不同层 | 保留原生传输，不把 heartbeat 当作 SSH 可达证明 |
| TUF / Uptane / Mender / RAUC：制品、安装与回退 | 固定摘要、安装、健康检查、commit/rollback 是不同证明 | 固定 LF 安装器 SHA；生产 Worker 保留前一版本；回退仍需独立验收 |
| rsync / OpenSSH：字节传输与可信发布 | 下载成功、哈希匹配、安装成功、运行成功是不同步骤 | 保留精确 SHA、安装回执、systemd/journal 与控制面心跳的分层证据 |

结论与既有侦察报告一致：复用成熟机制的知识，不再引入第二套身份、策略、任务队列、生命周期或数据库。M3 的真实环境缺陷通过窄修复解决，不构成引入完整 RMM/MDM 平台的理由。

### 4. 验收状态与未完成项

**已接受的 M3 核心切片**：生产 Worker 已部署 main `810494aa`；canonical LF installer 15,257 bytes / SHA-256 `5d67d35e…b107c`；原 ThinkPad 节点通过同节点 Reissue + `--replace` 热替换；systemd timer 自动触发，连续心跳成功；journal 无旧权限错误；Cloudflare BIC 请求 HTTP 200；原生 SSH 会话保持。

**仍为 NOT_RUN / 待现场补证**：

- M3：中断安装后的 `repair` 恢复（不能破坏已验收生产节点；优先使用隔离/canary 或受控故障注入）。
- M3：网络中断后的自动恢复；测试必须不影响原生 SSH 和 provider 服务。
- M2：Read token 写操作 403 且无状态变更；Reporter 撤销后旧 token 401；Operator 轮换前后正负验证；双 origin 同 Worker/DO 与回退引用回读。
- M4：第二节点独立纳管；Cloudflare SSH 路径端到端验收。Tunnel 服务 active 不得替代这项验收。

以上未完成项不推翻 M3 核心首节点可用结论，也不能被其 happy-path 结果覆盖。

### 5. 决策

- `KEEP`：当前 native SSH + thin panel + one-shot reporter 架构。
- `KEEP`：固定 SHA、稳定 `node_uid`、节点专属 reporting token、systemd timer/oneshot、journald。
- `ADAPT`：把目标 systemd 版本和系统服务真实运行纳入验证矩阵；把 repair/reissue/replace 的操作语义和副作用写入 runbook。
- `DEFER`：完整 RMM/MDM、常驻 Agent、命令 API、任务队列、第二状态数据库、自动传输路径评分。
- `NO_NEW_DEPENDENCY`：本次 field lessons 未产生新软件依赖。

## English summary

The 2026-11-12 reconnaissance already covered 42 major upstream repositories (14 management projects and 27 transport/distribution repositories; not 42 independent projects). This delta does not repeat the product inventory. It maps real M3 field evidence to those existing mechanisms.

Four lessons emerged: (1) a systemd user manager does not reproduce system-manager `DynamicUser`/`LoadCredential` behavior; the target Debian 13/systemd 257.13 service delivered mode `0440`, while the earlier user-manager test saw `0400`; (2) Python's default urllib User-Agent triggered the production Cloudflare Browser Integrity Check, while an explicit `GhostFleet-Reporter/1` identifier was accepted; (3) local `repair`, same-node ticket `reissue`, and version `replace` have different semantics and side effects; (4) local service state, successful outbound heartbeat, and inbound SSH reachability are separate claims.

The accepted M3 slice is the original ThinkPad node's same-node replacement with the canonical 15,257-byte LF installer, repeated timer-driven heartbeats, clean journald permission checks, HTTP 200 through the production edge, and preserved native SSH. This is owner-reported field evidence reconciled by the Architect, not an independent operation of the production host.

Interrupted-install recovery, network-outage recovery, M2 Read/revocation/Operator/origin checks, and M4 second-node/Cloudflare SSH acceptance remain NOT_RUN until separately evidenced. No new dependency or second identity/authority/state owner is admitted.

## 资料来源 / References

- [2026-11-12 external mechanism reconnaissance](https://github.com/youling/ghostfleet/blob/0cbb9c17bdd298634e4ccebf2c1a9c50d9f09fe1/docs/research/REUSE_RECONNAISSANCE_2026-11-12.md)
- [M3 field reconciliation #6949587945](https://github.com/youling/ghostfleet/issues/11#issuecomment-6949587945)
- [M3 staged acceptance and remaining gates #11](https://github.com/youling/ghostfleet/issues/11)
- [systemd execution/credentials documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [GhostFleet presence deployment runbook](../PRESENCE.md)
