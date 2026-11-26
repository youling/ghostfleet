# GhostFleet 下一代 当前恢复入口

- 工作坐标 `youling/ghostfleet#11@clean-sheet-v0.3`。
- [启动回执](https://github.com/youling/ghostfleet/issues/11#issuecomment-7194173372)。
- 分支 `nextgen/clean-sheet-v0.3`，以 Draft PR 的实时 HEAD 为准。恢复时先与 #11 最近检查点核对。
- R0–R1 的输入、取舍和接口见 [架构记录](ARCHITECTURE.md)。
- R2 已接通隔离 Worker/DO 中的邀请、恢复、报告、撤销与 v1 兼容；测试从原存储启动新版验证现有 UID 和凭据。Python 主机客户端已加入，随 R3 可信制品验证。
- 下一步为 R3。实现固定源码构建、有界 APT 信任、更新/失败/回退和周期检查。
- 现役、#135 与 #64 由原 owner 管理。实际节点与密钥证据保留在实例侧。
