# GhostFleet 下一代 当前恢复入口

- 工作坐标 `youling/ghostfleet#11@clean-sheet-v0.3`。
- [启动回执](https://github.com/youling/ghostfleet/issues/11#issuecomment-7194173372)。
- 分支 `nextgen/clean-sheet-v0.3`，以 Draft PR 的实时 HEAD 为准。恢复时先与 #11 最近检查点核对。
- R0–R1 的输入、取舍和接口见 [架构记录](ARCHITECTURE.md)。
- R2 已接通隔离 Worker/DO 中的邀请、恢复、报告、撤销与 v1 兼容；测试从原存储启动新版验证现有 UID 和凭据。Python 主机客户端已加入，随 R3 可信制品验证。
- R3 已实现精确 Git 源码构建、签名 APT 渠道、原子激活和独立 systemd timer。真实 Debian APT 合成负控见 `nextgen/test/test_update.py`。
- R4 新增 TS/CF 只读观测、OpenSSH 固定主机密钥探测、K3s 发现/计划/受审准备及面板视图。Debian 双机验证说明见 [隔离实验](LAB.md)。
- R5 完成可丢弃 Debian VM 首纳、真实 systemd/UID 1000 SSH、更新/故障/前滚，旧 v1 身份续接由 Workerd 与主机 E2E 验证。见 [操作手册](OPERATIONS.md)。
- R6 候选增加领取入口的来源级限流，并修复独立审查发现的同 UID 观测连续性与冲突投影。精确源码复验、制品校验及剩余现场事项见本工单最新 R6 回执。
- 现役、#135 与 #64 由原 owner 管理。实际节点与密钥证据保留在实例侧。
