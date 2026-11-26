# 隔离实验与证据等级

R4 使用本地 QEMU 10.0.13/KVM、Debian 13 genericcloud amd64 镜像的独立 qcow2 overlay，外网受限。合成 Controller 密钥与每台 VM 独立主机密钥预置。宿主机本地转发只监听 loopback，另一个独立虚拟网络连接 K3s 双机。两条链路不依赖现役服务。下列结果只适用于此实验。

| 检查 | 观察 |
| --- | --- |
| Server 2 vCPU/2 GiB，Agent 1 vCPU/1 GiB | K3s `v1.35.10+k3s1`，两节点 Ready。启动窗口 systemd cgroup MemoryPeak 分别约 991 MiB、648 MiB，包含可回收缓存。Agent 总可用内存可见 991164 KiB，采样 MemAvailable 635796 KiB，Swap 0。 |
| Agent 1 vCPU/512 MiB 重启 | 同节点恢复 Active，Server 读回 Ready 和新 Lease。采样 MemoryPeak 约 300 MiB，MemAvailable 252472 KiB，Swap 0，本次启动无 OOM 记录。仅空载，不据此批准生产资源配置。 |
| 已审 apply 与重复运行 | 源码按精确计划、二进制哈希、Agent token CA pin 准备。首次写入，重复得到 ALREADY_PREPARED。原生服务经独立启动。 |
| CA 与凭据边界 | 源码 CA 预检拒绝错误 pin，原生 K3s 连接同一端点时也拒绝。Agent/Server token 独立，实际 kubelet 身份被 API 拒绝删除系统 Secret。 |
| SSH 与故障 | 固定 host key 的正常用户 UID 1000 成功，错 host key 拒绝。可信侧断开实验集群链路，计算证据变为 UNAVAILABLE，恢复后回到 READY。单 Server API 暂停返回 UNKNOWN，独立 SSH 持续成功。 |
| TS、CF | API 配置与标识绑定走合成响应测试，真实 Tailnet、Tunnel、Access、A09 由实例 owner 验证。 |
| etcd 多节点 quorum、证书主动撤销 | NOT_RUN。单 Server 暂停只验证 API 丢失；集群侧真实证书撤销及信任域策略保持待验收。 |

## 复跑步骤

1. 从 Debian 官方 Cloud Images 获取 Debian 13 `genericcloud-amd64.qcow2`，按对应 SHA512SUMS 校验。实验镜像 SHA-512 为 `76488ba3bea2349cc595fedad7748b8ba98d6b36da398eaf2bbbae3db896ba1017d4ff41cd277926784cef2c1c11145a0d600f9b4afde9b8f174d698db0cda03`。创建设备独立磁盘和合成 SSH 凭据。仅允许实验管理端访问两台 VM 的 SSH。
2. 获取 K3s 官方 `v1.35.10+k3s1` 二进制与 amd64 airgap images；与官方 release SHA-256 对表。二进制为 `5cd49f0faca5b2ea4355d4761e7b1445b8aa05cd50e612fd9c370551db49e5e2`，images 为 `c10a9f07c357cfc41488f29c15872621ac8664c9864b3d1148a10155c9a1c2ff`。Server 使用独立 Agent token，启用单 Server embedded etcd，关闭 Traefik、ServiceLB、metrics-server、local-storage、CoreDNS，固定实验集群网卡。不在 Agent 上交付 Server token 或管理员 kubeconfig。
3. 在 Agent 使用 `native.py plan-agent` 与 `apply-agent`，对照工作手册配置字段，再单独安装并启动 `ghostfleet-nextgen-k3s-agent.service`。airgap images 置于 `/var/lib/ghostfleet-nextgen-k3s/agent/images/`。检查相同计划再执行为 no-op，错 CA 被拒绝。以独立 SSH 读取运行状态。
4. 在 Server 取 `kube-system` Namespace UID、Agent Node UID，按 read-only 配置运行 `native.py observe`，验证 Lease 和 Ready。用 Agent 的 kubelet 客户端执行 `kubectl auth can-i delete secrets -n kube-system` 并检查拒绝。保持管理网卡连通，从 Server 暂时关闭实验集群网卡及暂停 K3s API，然后恢复，分别观测连接、计算、救援。
5. 在关闭 Agent 后将 VM 内存改为 512 MiB，重新启动原磁盘。核对 Lease 时间晚于当前 boot，通过 `systemctl show` 读 MemoryCurrent/MemoryPeak/NRestarts，用 `/proc/meminfo` 与内核 OOM 日志交叉核对；按支持的实际负载重新测量。

Run the lab in disposable Debian machines with fixture credentials. Keep the management and cluster networks distinct. Capture node readiness, the bound lease and the native recovery result at each transition. These measurements cover an idle single-server cluster.
