# Enrollment Mint Authority 与现有实现差距分析（2026-10-07）

- Issue: https://github.com/youling/ghostfleet/issues/35
- 对照基线：`enrollment-attempt.schema.json`（fleet-enrollment-attempt/v1）、`packages/runtime-python/.../control/enrollment_attempt.py`、`enrollment_v2_minter.py`、`enrollment_console.py`、`linux/enroll_cli.py`、`windows/windows_enrollment.py`、`packages/bootstrap`。

## 已对齐

| 契约候选项 | 现状 |
| --- | --- |
| 一次性 ticket + claim + resume/retire | `enroll_cli.py` 已实现 one-time ticket、HttpClaimClient、RootEnrollmentState、resume/retire |
| attempt 状态机 | `enrollment-attempt.schema.json` 有 PREPARED→MINTING→MINT_UNKNOWN→MINTED→CREDENTIAL_READY→RELEASED→JOIN_VERIFIED→COMPLETE 全链路 + CAS revision |
| credential 不落盘、仅 secret-slot 引用 | `credential_ref: "secret-slot:..."` 已存在 |
| provider key id 可追溯 | `provider_key_id`、`mint_request_digest`、`join_evidence_ref`、`terminal_evidence_ref`、`completion_digest` 已在 schema |
| WIF mint 路径 | `enrollment_attempt.py` / `enrollment_v2_minter.py` 已可用（OIDC→WIF→one-off auth key） |

## 差距

| # | 差距 | 现状位置 | 建议收敛方式（不冻结） |
| --- | --- | --- | --- |
| 1 | mint authority 只有 WIF 一种；OAuth-client 分支不存在 | `enrollment_v2_minter.py` 仅 `V2_WIF_CLIENT_ID` 路径 | 抽出 `MintAuthorityAdapter` 协议，WIF 与 OAuth-client 各一个实现，产物统一为 `EnrollmentCredential` |
| 2 | credential 本身没有一等 schema | attempt schema 只有 `credential_ref` 指针 | 增加 `EnrollmentCredential` 对象（node_uid/provider/tags/preauthorized/expires_at/purpose），作为 attempt 的子对象 |
| 3 | 缺 `purpose` 约束 | schema 无 purpose 字段 | 增加 `purpose = managed-node-enrollment` 白名单 |
| 4 | 缺 `policy_revision` / `actor_ref` 的 attempt 级绑定 | mint receipt 里有 `wif_client_id`、部分 actor 信息 | 在 attempt metadata 增加 `actor_ref`、`policy_revision`（或 policy file hash） |
| 5 | enrollment console 把 `github` 列为一等 secretref provider | `enrollment_console.py:32` PROVIDERS 含 `github` | 降级为 optional，新 mint authority 以 `authority:` 字段自述 |
| 6 | 跨平台不一致 | Linux 走 enroll_cli+CF-Drop；Windows 走 managed-windows-enroll.ps1 + windows_enrollment.py；bootstrap 走 claim/repair | MintAuthority 作为跨平台单点；各平台 adapter 只消费 `EnrollmentCredential` |
| 7 | 未记录"节点入网后丢 tag 的 drift"处理 | 无 | Transport 侧 fail closed（已存在）+ MintAuthority 侧产生 drift 事件的闭环待设计 |
| 8 | receipt 不回写"签发策略 revision" | deposit receipt 只管 courier 语义 | `cf-drop-deposit/v1` receipt 增加 `policy_revision` 字段或在 attempt completion_digest 里吸收 |

## 结论

现有实现已经具备"一次性 ticket + attempt 状态机 + WIF mint + 安全 claim"的骨架，gap 集中在：**mint authority 不可插拔**、**credential 非一等对象**、**缺 purpose/policy_revision 绑定**、**github 仍是一等 provider**、**跨平台 adapter 未收敛**。这些都与 #35 contract 候选的五条不变量一致，可作为下一轮冻结前的 checklist 交 Architect review。
