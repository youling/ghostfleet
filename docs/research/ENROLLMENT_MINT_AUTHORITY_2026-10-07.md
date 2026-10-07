# Enrollment Mint Authority — 去除 GitHub Actions 依赖的单控制节点纳管调研

- Issue: https://github.com/youling/ghostfleet/issues/35
- 日期：2026-10-07
- 状态：Research 阶段交付，不冻结名词/枚举/方案，不写生产代码。候选不等于决策，需 Architect review。

## 0. 当前事实（从代码核实）

| 事实 | 证据 |
| --- | --- |
| 节点侧 enrollment 的 WIF mint 路径仍消费 OIDC token（当前来自 GitHub Actions WIF），再经 auth_keys-only 交换 mint one-off auth_key | `packages/runtime-python/src/ghostfleet_runtime/control/enrollment_attempt.py::run_attempt_wif_mint`（L261）、`enrollment_v2_minter.py::exchange_oidc_for_access_token`（L420） |
| WIF 配置 fail-closed，缺 `TAILSCALE_WIF_CLIENT_ID/AUDIENCE` 即拒 mint | `validate_wif_config`（L112） |
| secretref provider 仍列 `github` | `enrollment_console.py` L32 `PROVIDERS = ("github", "tailscale", "cloudflare")`、L42 `REF_RE` |
| 未进入 main 的 `leet/enroll-broker` 是 Cloudflare Worker + DO + `TS_OAUTH_CLIENT_ID/SECRET` 的控制平面自持雏形（本地未找到该分支，只能引用 issue 描述） | issue #35 描述 |
| 现有 courier / attempt 协议（`fleet-enrollment-attempt/v1`）已经把 claim_code、manifest_digest、mint-ack/deposit/状态机这套 fence 化诚信机制做完，mint authority 可整体替换而不动协议 | `enrollment_attempt.py` L24-315 |

问题本质：GitHub Actions 曾是 OIDC issuer，上次纳管卡在 Action 上。需要把 mint authority 收拢到单一纳管控制节点，消除 CI 运行时依赖。

## 1. 业界一键纳管 Tailscale 节点的实现

| 项目 | 一键纳管形态 | mint authority 位置 |
| --- | --- | --- |
| Tailscale 官方 | `tailscale up --auth-key=…` / OAuth client secret 作为 `--auth-key` / WIF `client-id + audience` 注入；平台支持时 `tailscale up` 自动发现 OIDC token（AWS/GCP/GitHub Actions/K8s SA token） | Tailscale 控制面 mint；客户端持一次性凭证。OIDC 自动发现仍依赖云平台 issuer |
| Tailscale 官方 | `auth_keys`（一次性/可复用/临时节点），API Keys 上限 90 天，`tskey-auth-*` | 控制面 |
| Headscale（自建协调面） | 管理员 `headscale preauthkeys create --user/--tags`；客户端 `tailscale up --login-server … --authkey …`；key 默认一次性、1 小时 | 自建 Headscale 服务端 |
| Netmaker | `netclient join -t <registration_token>`，enrollment key 绑定网卡/网络/使用次数/有效期/tags | 自建 Netmaker 服务端（enrollment key） |
| 设备授权现状 | Tailscale 交互式入网走浏览器 SSO；自动化场景 Tailscale 不提供 OAuth device-code 流做无人值守入网，自动化必须落到 auth key / OAuth client / WIF 三种 credential 之一 | 见 §3 |

结论事实：所有一键纳管实现的共同结构是**控制节点下发一次性/短时 enrollment credential，客户端凭此 join**。差异只在 credential 的 mint authority 持有者与轮换方式。

## 2. 业界一键纳管 Cloudflare

| 场景 | 形态 | credential |
| --- | --- | --- |
| cloudflared 接入 | `sudo cloudflared service install <TUNNEL_TOKEN>`；token 由 dashboard/`POST /accounts/:id/cfd_tunnel` 生成 | per-tunnel token，明文进 systemd unit |
| Zero Trust WARP 客户端 | enrollment rules（device posture / group）+ gateway policy | 客户端 OIDC/SCIM 注册到 Zero Trust org |
| Tunnel token 分发 | API token（`Cloudflare Tunnel Write` scope）→ 创建 tunnel → 领 token → 注入节点 | 分发走 out-of-band 注入（cloud-init / 配置管理） |

结论事实：Cloudflare 侧的一键纳管与 Tailscale 同构——控制面 mint per-tunnel token，`cloudflared service install` 相当于 `tailscale up --auth-key=…`。GhostFleet 侧的 CF-Drop 投递与此模式一致，两条链可以共用同一 mint-node 抽象。

## 3. Tailscale OAuth client vs API key vs WIF 对比

| 维度 | API key (`tskey-api-`) | OAuth client (`tskey-client-`) | WIF / federated identity |
| --- | --- | --- | --- |
| 密钥材料 | 长久 API token，≤90 天 | client_id + client_secret，长期有效直至撤销 | 无长久 secret；依赖 OIDC issuer（GitHub Actions / AWS / GCP / K8s） |
| 权限粒度 | 全量或无（不支持 scope） | scope 清单（如仅 `auth_keys` + 指定 tags） | 同 OAuth client，scope 在 Tailscale 侧配置 |
| 轮换 | 到期手工换 | 吊销重发 secret | issuer 侧换 trust config，无 secret 可轮换 |
| 审计归因 | 绑定单个用户/tailnet，粒度粗 | 绑定 tailnet + client identity | 绑定 issuer + subject claim（repo/SA/role），归因最细 |
| 外部依赖 | 无 | 无 | 依赖第三方 OIDC issuer 可用性——当前卡点即在此（GitHub Actions） |
| token 有效期 | 最长 90 天 | access token 1 小时 | access token 短时（同 WIF 交换） |
| 适用 | 仅 break-glass / 小部署 | 自持控制节点的生产默认 | 云平台原生 workload 身份已就绪的场景 |

## 4. 单控制节点自持 mint authority 的端到端候选

共同前提：复用现有 courier / attempt 协议（prepare → handoff → reserve → mint-ack → deposit），节点侧 OIDC 依赖移除后不再回传 GitHub 身份；`secretref://github/…` 可在迁移完成后退役。

### 候选 A：控制节点持 OAuth client（推荐路径候选，非决策）

- 控制节点 env 存 `TS_OAUTH_CLIENT_ID/SECRET`（scope = `auth_keys` + tag 绑定，如 `tag:fleet`），调 `POST /api/v2/tailnet/-/keys` mint one-off auth_key。
- 节点通过已有 `ENROLL_ATTEMPT_MINTER_TOKEN` + claim_code 向 courier 证明身份，courier 转发 mint 请求到控制节点 minter。
- 等价于 `leet/enroll-broker` 雏形的产品化路径。
- tradeoff：控制节点是 long-lived secret 的唯一持有点（可放 secret manager/HSM 降爆半径）；无第三方运行时依赖；轮换需吊销重发 secret；与 WIF 相比失去"无长久 secret"属性。

### 候选 B：控制节点自带 OIDC issuer + WIF

- 控制节点跑小型 IdP（Keycloak / smallstep / Vault OIDC），向 Tailscale 注册 federated identity（issuer=控制节点、audience=`api.tailscale.com/…`、sub 绑定 node_uid 或 attestation）。
- 节点 join 时用本机密钥向控制节点 IdP 换短时 JWT，再走现有 WIF exchange 路径——协议与 `enrollment_v2_minter.py` 的 mint 语义几乎不变。
- tradeoff：无第三方 issuer 依赖 + 无长久 secret；但控制节点多了一个关键服务（IdP），其自身身份（CA/私钥）需要保护，运维面更大；审计归因可做到 node_uid 级。

### 候选 C：控制节点持 Tailscale API key

- 最简单：控制节点调 API 直接 mint auth_key。
- tradeoff：无 scope 粒度，绑定用户/tailnet，吊销连坐面大；仅建议作为 break-glass，不建议作为生产默认。

### 候选 D：自建 Headscale 替换协调面

- mint authority 天然自持（headscale preauthkeys）。
- tradeoff：改变上游产品线（Tailscale → Headscale），节点生态/ACL/SSH 行为需重新验证；超出本 issue 的"去 GitHub Actions"范围，记录为长期选项。

### 候选 E：保留 GitHub Actions WIF，仅把 mint 调用挪到控制节点

- 只是把网络调用搬家，OIDC issuer 依赖不变，无法解决"纳管卡在 Action 上"的根因。排除。

## 5. 安全 tradeoff 矩阵（候选间）

| 维度 | A OAuth client | B 自建 IdP + WIF | C API key | D Headscale |
| --- | --- | --- | --- | --- |
| 长久 secret 持有点 | 控制节点 | 控制节点（IdP 私钥） | 控制节点 | Headscale 私钥 |
| 外部运行时依赖 | 无 | 无 | 无 | 无 |
| 权限粒度 | scope 最小化 ✓ | 最细 ✓ | 粗 ✗ | 中 |
| 轮换成本 | 中（重发 secret） | 高（轮换 CA/私钥） | 低 | 中 |
| 审计归因 | client identity | node_uid 级 ✓ | 用户级 ✗ | 中 |
| 协议改动 | 小（替换 exchange 为 client_credentials） | 极小（保留 WIF exchange） | 小 | 大 |
| 实现复杂度 | 低 | 高 | 低 | 极高 |

## 6. 结论与下一步（候选，非决策）

- 最短路径：候选 A（控制节点 OAuth client + `auth_keys` scope），可直接在 `enrollment_attempt.py::run_attempt_wif_mint` 处把 `exchange_oidc_for_access_token` 替换为 client_credentials 换 token，保留 courier fence 协议。
- 若要消灭长久 secret：候选 B，但需先跑通 IdP 的可用性与备份设计。
- 候选 C 仅 break-glass；D 长期评估；E 排除。
- 迁移完成后从 `enrollment_console.py` 的 `PROVIDERS`/`REF_RE` 移除 `github` 项。

## 7. 完成定义与下一步

- [x] 业界 Tailscale 一键纳管调研（官方/Headscale/Netmaker/device auth 现状）
- [x] 业界 Cloudflare 一键纳管调研（cloudflared service install / WARP enrollment / token 分发）
- [x] OAuth client vs API key vs WIF 权限/审计/轮换对比
- [x] 单控制节点自持 mint authority 端到端候选与安全 tradeoff
- [ ] Architect review：决定采用 A/B/C 或组合，冻结 minter authority 名词与凭证存放契约
- [ ] 决策落地后回写 issue #35 并制定 `secretref://github` 退役计划
