# Security reporting / 安全报告

## 中文

<!-- topic:report -->
### 报告渠道

当前是开发版本。不要在公开工单、PR 或聊天中提供密码、令牌、私钥、真实节点或提供方定位信息、账户清单，以及可重放的授权。若仓库启用了 GitHub 私有漏洞报告（Private Vulnerability Reporting），请使用仓库 Security 界面的原生私有报告入口；本文件不声称该入口已配置或可用。

若没有私有报告入口，可先在公开工单提出不含敏感数据的“需要私有安全报告渠道”请求。维护者确认受控渠道后再提交必要材料。不要虚构安全邮箱或将秘密发送到未经验证的地址。

<!-- topic:contents -->
### 最小必要信息

使用独立合成测试数据，报告公开版本或提交、受影响模块、预期边界、脱敏复现步骤、影响及已知副作用。真实原始证据保留在所有者控制的存储中，通过不透露内容的引用供后续获授权核验；受保护引用不默认公开。

若疑似实际秘密已暴露，先停止传播并通知凭据所有者，由所有者核对撤销、轮换及影响范围；TTL 到期不等于撤销或清理已完成。不要盲目重试有副作用的操作来验证漏洞。

<!-- topic:model -->
### 安全模型与支持

详见 [安全模型](docs/SECURITY.md) 与 [公开边界](docs/PUBLICATION.md)。默认 MCP 只提供检查工具，操作员 Bearer 令牌用于管理生命周期对象；生产 RBAC、OAuth 与设备执行接入必须另行审查。当前没有正式发布版的支持承诺，修复和披露时间按实际个案协商。

真机单节点验证、合成 CI 或依赖审计不构成完整安全认证。第二台独立硬件及重建验证、威胁模型审查、凭据托管与恢复仍是正式发布的验收条件。

## English

<!-- topic:report -->
### Reporting channel

This is a development version. Do not provide passwords, tokens, private keys, real node/provider locators, account inventories or replayable authorization in public issues/PRs or chat. If the repository enables GitHub Private Vulnerability Reporting, use its native private entry under Security; this document does not claim that the feature is configured or available.

If no private entry exists, open a public request for a private security-reporting channel without sensitive data. Submit necessary material only after maintainers confirm a controlled channel. Do not invent a security mailbox or send secrets to an unverified address.

<!-- topic:contents -->
### Minimum necessary information

Report the public version/commit, affected module, expected boundary, sanitized reproduction, impact and known effects using independent synthetic fixtures. Keep real raw evidence in owner-controlled storage and use an opaque pointer for later authorized verification; protected references are not automatically public.

For suspected secret exposure, stop propagation and notify the credential owner to assess revocation/rotation and impact. TTL expiry does not prove revocation or cleanup. Do not blindly replay effects to verify a vulnerability.

<!-- topic:model -->
### Security model and support

See the [security model](docs/SECURITY.md) and [publication boundary](docs/PUBLICATION.md). Default MCP exposes inspection only; operator bearer manages lifecycle objects. Production RBAC/OAuth and device execution integrations require separate review. There is no formal release support commitment; remediation/disclosure timing is agreed for each actual case.

A single-device canary, synthetic CI or dependency audit is not complete security certification. Independent second-device/rebuild evidence, threat-model review and credential custody/recovery remain formal release gates.
