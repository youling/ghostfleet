# Enrollment Mint Authority —— Contract 候选（待 Architect review）

- Issue: https://github.com/youling/ghostfleet/issues/35
- 日期：2026-10-07
- 状态：候选，不冻结；不改生产链路。

## 1. 目标

把"谁 mint enrollment credential、credential 长什么样、节点以什么身份入网"从 CI 实现细节提升为一等契约，同时移除对 GitHub Actions 的运行时依赖。

## 2. 角色

| 角色 | 职责 |
| --- | --- |
| MintAuthority | 控制节点；唯一允许签发 enrollment credential 的实体 |
| EnrollmentBroker | （可选）接收 enrollment request、调用 MintAuthority、投递 credential 与回执 |
| Node | 目标设备；消费一次性 credential 入网 |
| Registry | 记录 node_uid ↔ provider_ref 绑定与 lifecycle |

## 3. Mint authority 形态（二选一，按部署语境）

| 形态 | 适用 | secret custody |
| --- | --- | --- |
| WIF（GitHub/GitLab/Azure/GCP OIDC） | 控制面跑在 CI 内 | 无长期 secret，审计关联 CI run |
| OAuth client（`auth_keys` scope + tag 限定） | 常驻控制节点 | secret 驻留控制节点，须加密存储、90 天轮换、按 tag 最小权限 |

两者都输出同一产物：`EnrollmentCredential`。

## 4. EnrollmentCredential（候选 schema）

```
credential_id: uuid
node_uid: node-<uuidv4>            # 与 registry 绑定
provider: tailscale|cloudflare
expires_at: RFC3339                # 一次性，≤ 1h
usage: one_shot                    # 单次 tailscale up / cloudflared install
tags: ["tag:fleet-ssh-target"]     # 必须精确等于受管 tag 集合
preauthorized: true                # Tailscale 侧跳过人工审批
ephemeral: false                   # 受管节点默认非 ephemeral，容器类除外
mint:
  authority: wif|oauth-client      # 形态
  minted_at: RFC3339
  actor_ref: sha256(authKind:userId)
  policy_revision: string          # 签发时的 tailnet policy 版本
purpose: managed-node-enrollment   # 禁止复用为其它用途
```

## 5. 不变量（候选冻结项）

1. MintAuthority 是唯一签发点；节点不得自持签发能力。
2. credential 一次性、短 TTL、`tags` 集合不可被调用方改写。
3. credential 一旦被节点成功消费，receipt 必须回写 `node_uid`、`minted_at`、`policy_revision`、`actor_ref`；禁止回写 secret 本体。
4. 启用 WIF 时无需长期 secret；启用 OAuth client 时该 secret 不出控制节点，日志/错误消息不得泄露。
5. 任何降级（复用 credential、放宽 tag 校验、延长 TTL）都 fail closed。

## 6. 与 #33 Transport 模型的组合

- 节点入网后的 `node_uid ↔ provider_ref + tag` 绑定是 Transport 解析的 authority；EnrollmentCredential 只负责把节点写进 registry，不参与后续 transport selection。
- 若入网后节点丢 tag（被改 tag 或 re-auth），Transport 侧 fail closed，MintAuthority 侧应产生 drift 告警。

## 7. 迁移路径（候选）

1. 保持现有 WIF 路径可用（Fleet/CI 内 mint）。
2. 新增 OAuth client mint 路径（常驻控制节点），broker 抽象为 MintAuthority adapter。
3. enrollment console 的 `github` secretref provider 降级为可选；新的 mint authority 通过 `authority:` 字段自述。
4. 完成真机 canary 后，才允许默认切到 OAuth-client 路径。

## 8. Open questions（等 Architect 拍板）

- OAuth client secret 的 custody 由 Fleet 控制节点自建 vault 还是接 KMS？
- WIF 与 OAuth-client 是否允许并存（多 mint authority 时的 registry 冲突裁决）？
- `policy_revision` 的来源（Tailscale 无直接 API，是否用 policy file hash 自报）？
