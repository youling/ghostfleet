"""GhostFleet 节点侧常驻代理。

本包只实现 ADR docs/architecture/NODE_AGENT_V0.md 定义的只读、非特权、
拉模型常驻运行时：没有 sudo、没有 shell、没有特权执行通路，也不监听入站端口。
导入本包不会触碰网络、磁盘或子进程。
"""

__version__ = "0.1.0.dev0"

__all__ = ["__version__"]
