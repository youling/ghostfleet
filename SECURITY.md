# Security reporting / 安全报告

## 中文

<!-- topic:report -->
### 报告渠道

当前是开发版本。不要在公开issue/PR或聊天中提供密码、token、privatekey、真实node/providerlocator、账户inventory或可重放授权。若仓库启用GitHubPrivateVulnerabilityReporting，请使用仓库Security界面的原生私有报告入口；本文件不声称该入口已配置或可用。

若没有私有报告入口，可先在公开issue提出无敏感数据的“需要私有安全报告渠道”请求。Maintainer确认受控渠道后再提交必要材料。不要虚构安全邮箱或将秘密发送到未验证地址。

<!-- topic:contents -->
### 最小必要信息

报告publicversion/commit、affectedmodule、预期边界、脱敏复现步骤、impact和已知effects；使用独立syntheticfixtures。保持真实原始证据在其owner受控存储，以opaque引用说明可供后续核验；不要把受保护ref默认公开。

若疑似实际秘密已暴露，先停止传播并通知credentialowner，由owner核对revoke/rotate与影响范围；TTL到期不等于撤销或清理已完成。不要blindretry有副作用操作来验证漏洞。

<!-- topic:model -->
### 安全模型与支持

详见 [安全模型](docs/SECURITY.md) 与 [公开边界](docs/PUBLICATION.md)。默认MCP只有inspection，operatorbearer控制lifecycle对象；productionRBAC/OAuth与deviceexecution接入必须另行review。没有正式release支持承诺；报告修复和披露时间按实际case协商。

真机单节点canary、syntheticCI或依赖audit不构成完整安全认证。secondindependenthardware/rebuild、threatmodel与credentialcustody/recovery仍属正式releasegate。

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
