# GhostFleet 下一代候选操作手册

适用对象是独立验证者、实例发布者和受授权操作员。首验平台为 Debian 13 amd64。源码包含 arm64 构建目标，arm64 运行尚未实测。

## 源码复跑

在一次性 Debian 13 环境检出 Draft 指定 SHA，安装 Node 22+、Python 3、Git、dpkg、APT、apt-utils 和 GnuPG。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node --test 'nextgen/test/*.test.mjs'
python3 -m unittest discover -s nextgen/test -p test_native.py
python3 -m unittest discover -s nextgen/test -p test_install.py
sudo python3 -m unittest discover -s nextgen/test -p test_update.py
sudo "$(command -v node)" nextgen/test/host-e2e.mjs
npm run check:publication
npx --no-install wrangler deploy --dry-run --config nextgen/wrangler.jsonc --outdir dist/nextgen
```

这些测试使用临时 SQLite DO、合成签名、文件源与临时主机状态。Workerd 用仓库锁定的 Wrangler 依赖，用 Linux 验证；Windows 原生 Workerd 对 DO 落盘的失败不影响 Linux 路径。原有功能套件仍由现有 CI 一同运行。[隔离实验](https://github.com/youling/ghostfleet/blob/main/docs/nextgen/LAB.md) 给出真实 Debian VM、OpenSSH 与 K3s 复跑步骤。

### 测试证据

- Workerd 从旧版写入的同一 SQLite DO 文件启动新版，旧 UID / v1 token 保持有效。含双 origin、只读角色、Observer 角色、匿名配对取消、请求过大、并发与撤销负控。
- 主机/Workerd E2E 使用真实 APT 从合成签名渠道拉取，执行首纳、重复首纳、老节点沿用同一 UID/凭据、v1/v2 并存、版本投影、过期拒绝、已知好内容前滚和撤销。真实 OS 上做 systemd `DynamicUser`/LoadCredential 验证；过渡期中的已安装版本与旧进程运行版本可单独读回。
- 真正的 Debian VM 从空的候选状态开始，使用独立 loopback 测试通道，首纳→systemd 证据→普通 UID 1000 OpenSSH→同包 no-op→下一版→拒绝过期→前滚→撤销。记录的 UID/凭据文件哈希保持一致，SSH 在更新及撤销前后可用。隔离环境没有访问实际实例消费者或生产发布。

## 构建与可信安装

构建者从干净的精确 Git 提交执行，并传入经批准的完整提交 SHA。输出目录应在 checkout 之外或者使用被 Git 忽略的 `dist`。实例发布 owner 记录版本和渠道晋升，已经发布的版本继续绑定原字节。

```sh
/usr/bin/python3 -I nextgen/release.py build --source-revision "$APPROVED_SOURCE_SHA" \
  --version '0.3.0~rc3' --arch amd64 --output dist/candidate
```

输出为 reporter Debian 制品、引导 tar 和构建回执。独立构建者以同一提交及打包工具比对制品摘要。可信交付渠道预置引导 tar 摘要和 APT 签名根。签名者在独立环境接收已审制品摘要，指定渠道和签名身份。可在 canary 验证及 owner 批准后对同一包晋升 stable。

```sh
/usr/bin/python3 -I nextgen/release.py sign-channel --package 'dist/candidate/ghostfleet-node_0.3.0~rc3_amd64.deb' \
  --expected-sha256 "$APPROVED_PACKAGE_SHA256" --channel canary --arch amd64 \
  --signing-home "$SIGNER_GPG_DIRECTORY" --fingerprint "$APPROVED_SIGNER_FINGERPRINT" \
  --output dist/approved-canary
```

发布 owner 先将固定 pool/Packages 字节发布到私有测试 origin，再切换签名 `InRelease`。保持上一个签名索引曾引用的包在客户端过渡窗口内可读。验证签名与摘要时同时核对 `Valid-Until` 恰好出现一次，距 `Date` 24 小时。客户端最多接受 48 小时新鲜度。需要持续服务的渠道应在到期前由受信发布端重新签署现行索引。签名身份轮换先用实例 owner 信任通道更新 keyring/fingerprint，再发布新签名。失陷时冻结推进并沿独立 SSH 救援更新信任。Node profile 的最低版本约束首装候选；短有效期内、尚未见过的新版本仍受 APT 的时间模型限制。

### 统一安装、接管、升级与修复

受授权操作员通过独立信任通道取得批准的 bootstrap SHA-256、公开签名 keyring 和实例资料。先验证 tar 摘要，再在 root 所有且普通用户不可写的目录解包。保留这一份批准的引导包，用其 `install.py` 处理首装、覆盖升级和修复。定时更新仍由签名 APT 更新器更新 reporter。

```json
{
  "schema": "ghostfleet-install/v1",
  "update": {
    "uri": "https://updates.example.invalid",
    "fallback_uri": "https://updates-backup.example.invalid",
    "channel": "canary",
    "keyring": "/etc/ghostfleet-nextgen/release.gpg",
    "fingerprint": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "minimum_version": "0.3.0~rc3"
  },
  "enrollment": {
    "mode": "enroll",
    "node_uid": "<APPROVED_NODE_UID>",
    "origin": "https://node.example.invalid",
    "config_revision": "1111111111111111111111111111111111111111111111111111111111111111",
    "invitation_file": "/root/trust/invitation.json"
  },
  "components": {"tailscale": "observe", "cloudflare": "none", "k3s": {"role": "none"}}
}
```

把 profile 和邀请或旧身份文件设为 root 所有、0600，并引用独立交付、周期更新服务可读的 keyring。例如把公钥文件放在 `/etc/ghostfleet-nextgen/release.gpg`。更新服务的 `ProtectHome` 与 `PrivateTmp` 会屏蔽 `/root`、用户家目录及临时目录，安装器会拒绝用这些位置作为周期更新的签名信任。已获准的 legacy 节点使用 `mode: adopt`，把 `invitation_file` 换成 `legacy_config`。确保面板已批准同 UID 接管，原 reporter 及其配置由原 owner 保留。已有手装的同名 GhostFleet 文件与引导包内容不同时，先由 owner 核准旧字节 SHA-256，再把固定文件名及对应摘要填入 `previous_files`。未知归属会报告冲突。

```sh
sudo /usr/bin/python3 -I /root/ghostfleet-bootstrap/install.py plan /root/ghostfleet-profile.json
sudo /usr/bin/python3 -I /root/ghostfleet-bootstrap/install.py apply /root/ghostfleet-profile.json
sudo /usr/bin/python3 -I /root/ghostfleet-bootstrap/install.py status /root/ghostfleet-profile.json
sudo /usr/bin/python3 -I /root/ghostfleet-bootstrap/install.py repair /root/ghostfleet-profile.json
```

首装或切换发布频道后，实触发一次 `sudo systemctl start ghostfleet-nextgen-update.service`，读回退出结果及 journal，确认周期服务使用相同信任根。

`plan` 与 `status` 读取本机文件、身份和 systemd 状态。`apply` 使用签名渠道激活 reporter，布置自有文件与定时器，首纳或保留既有身份。`repair` 通过相同版本和签名包恢复自有 reporter、引导文件和定时器。状态使用 JSON，包含实际安装版、变更项和诊断。当前 release 的签名索引不可用时保留原指针。前滚恢复由发布 owner 签署版本更高的已知好内容。`fallback_uri` 选用相同信任根和频道，只在可确认的获取故障时切换。若主源已经选定包，备用源必须给出同一版本、大小和摘要。

安装器首发支持 Debian 13 amd64 和原生 systemd。Debian 13 兼容设备只能在通过既有设备只读检查及 owner 授权后使用。arm64 reporter 可构建，统一安装器不在 arm64 执行。可选的 Tailscale 和 Cloudflare `observe` 只读取原生服务状态，既有自定义实例仍由 owner 管理。K3s `role: none` 为默认，`mode: external` 可观察外部 Server 或 Agent。对获准的专用 Agent，可配置 `mode: prepare` 或 `start`，以及受信的 `profile`、`artifact`、`token_file` 和 `approve_plan`；复用下面的批准计划与凭据校验。`start` 将启用对应专用单元。现有集群、第三方服务、防火墙、OMV 数据及 SSH 仍由各自 owner 管理。

## 首次纳管、授权与可选计算

面板部署使用两个 origin，Panel 上游可放已批准的 Access 策略。实例配置独立 operator、read-only 凭据。每个 observer 使用本地受限文件中的独立凭据，对应配置授权绑定节点 UID、观测范围和允许的证据流。面板凭据只在页面内存。Worker 版本由 provider metadata 读回，部署时单独把 `NEXTGEN_SOURCE_REVISION` 绑定到实际构建提交。

公网领取和上报在调用 DO 前分别使用 Cloudflare 的来源级配额。IPv6 按 `/64` 聚合，IPv4 映射地址与对应 IPv4 共用配额。Nextgen 使用 `NEXTGEN_CLAIM_LIMIT` 与 `GHOSTFLEET_REPORT_LIMIT`，单独部署 legacy 时为 `GHOSTFLEET_CLAIM_LIMIT` 与 `GHOSTFLEET_REPORT_LIMIT`。给每个绑定分配独占 namespace，并在可信入口保证连接地址的来源。缺少绑定或可信连接地址时相关入口返回 503，超出配额返回 429。Cloudflare 按站点近似计数，实例应实测预算和恢复窗口。 [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

部署前为 observer 换发受限凭据，Worker 中只配置 SHA-256 摘要和允许范围。`GHOSTFLEET_OBSERVER_GRANTS` 是 JSON 数组，每项含 `token_sha256`、`node_uid`、`scope` 和 `streams`。较大配置可用同格式的 `_01` 至 `_32` 分片。`streams` 每项由 `source/dimension` 表示，`scope` 取 `primary` 或 `secondary`。原有全局 observer 凭据应随切换撤回。

1. 在操作员面板选渠道、平台及审批 profile 摘要，签发一次性邀请。把邀请文件经受信通道以 0600 交给目标，只在节点侧读入。预置 root-owned 0600 `/etc/ghostfleet-nextgen/enrollment.json`，包含 `origin` 和 `config_revision`。配置摘要必须来自相同的已审批配置。
2. 在根级注册或换发前，核对独立引导入口来自批准的 bootstrap。执行 `sudo /usr/bin/python3 -I /usr/local/lib/ghostfleet-nextgen/enroll.py enroll --invitation-file /path/to/invitation.json`，验证面板 UID 和注册状态。若网络结果不确定，重试同一邀请，客户端沿已有 pending 凭据继续。
3. 在已授权靶机 `sudo systemctl daemon-reload` 后，启用 `ghostfleet-nextgen-report.timer` 和 `ghostfleet-nextgen-update.timer`，先手动触发各自 oneshot 取证。实例另验普通用户的 pinned SSH 与独立救援。首次安装可跳过 K3s。
4. 实例 owner 管理 TS、CF、SSH、集群和私有 Work 物理准入。从可信端执行 `python3 nextgen/native.py observe /path/to/bindings.json`。在配置顶层使用 `scope` 对应授权的观测范围，默认 `primary`。提交观察时增加 `--panel-origin`、`--credential-file`。Tailnet device ID、Tunnel ID、Cloudflare account、K8s cluster/Node UID、SSH host key 由实例确认，采集凭据采用只读范围。
5. 可选 Agent profile 为 `node_uid`、`server`、`ca_sha256`、`version`、`sha256`、`node_name`，多接口可加 `node_ip` 和 `flannel_iface`。运行 `plan-agent PROFILE` 读出 digest。发现已有安装时先用原生证据核验所有权和绑定。新 Agent 采用集群 owner 签发的固定 CA、有限 TTL 的原生 bootstrap 凭据，以集群侧签发记录核对有效期。静态共享凭据会被拒绝。经具体批准执行 `sudo python3 native.py apply-agent PROFILE --approve-plan DIGEST --artifact FILE --token-file FILE`，完成自己的目录准备。`ALREADY_PREPARED` 表示同一批准计划的本地准备结果一致。集群 owner 另行安装和启动 `ghostfleet-nextgen-k3s-agent.service`，检查真实 Node UID、Lease 和独立救援，再授予私有 Work scope。 可查阅 K3s CLI 的 Token 文档。

报告撤销立即阻断旧报告凭据。主机失陷处置由可信实例同时撤销网络/SSH/集群能力及已签发的权限，保留独立救援。面板 Ready、软件版本和 K3s Ready 均作为证据输入。

同 UID 轮换凭据时，保持相同审批配置下的独立观测，旧报告器版本留作历史线索。配置摘要变化会清除之前的独立观测；再绑定通过真实 Provider/SSH 探测完成。Observer 可按 `primary`/`secondary` 两个有界来源分别提交同一维度，保留两份同时有效的相反结论。

## 迁移、回退与发行次序

- **部署前**，原 owner 读回现役 Worker/DO class、binding、对象名、部署版本、策略版本与实际客户端。准备一致快照和旧版本可恢复工件，snapshots 包含持久身份材料并由实例保管。不同 Worker script/service namespace 对同名 DO 会产生不同对象，不可直接照搬隔离配置部署。
- **兼容控制面先行**。先冻结新邀请，保存同一写者的快照，在可丢弃副本复跑 legacy v1。正式配置切回同一持久 DO 后，核对旧 UID、老凭据、接收时间与独立 SSH。对每个 legacy 节点由 operator 调用 `POST /v2/nodes/{uid}/adopt` 提供已审 profile，再从固定的引导入口运行 `enroll.py adopt --legacy-config … --expected-node-uid …` 保留旧 UID 和凭据。逐节点保留并核对旧配置、reporter 和 units，验证两种协议及预期版本。
- **可回退的首批**。单个有独立救援的 canary，通过 SSH、普通消费、更新故障、撤销与回退；再小批次晋升。切回旧 Worker 前暂停 v2 写入并留取最新快照，验证旧程序读得懂共同字段、前一 reporter 能恢复 v1。恢复快照只用于 owner 授权的必要数据恢复，须按最后写入时间对账，避免覆盖期间的节点变化。SSH/CF/TS/K3s 保持各 self-owner，分别回退对应组件。
- **候选退役范围**。新版邀请及签名引导覆盖后，逐步停止为新目标发行 v1 票据。旧 POSIX join、旧面板与 reporter 按 v1 客户端和原生健康覆盖分批停用。旧命令引擎继续沿原裁决。同资源完整切换前保留救援和快照，不从新版源码自动清理运行节点。
- **发行准备边界**。源码/合成和隔离主机可复跑后交原 owner 与独立验证者。生产发布、现场 A09/Access、TS/CF live、独立真实消费者、证书撤销/多 Server quorum、arm64 实机和 canary 晋升分别取证。

## English operations

Build the APT candidate from an explicitly approved clean commit. Verify independent build digests and sign through the separate instance release environment. Verify the unique signed expiry before promotion. On Debian 13 amd64 with native systemd, verify the approved bootstrap digest before extraction, and provision the root-owned `0600` profile and approved keyring through the instance trust path. Use the same `install.py plan|apply|status|repair` entry point shown above. Set `enrollment.mode` to `adopt` and reference `legacy_config` to preserve an existing UID and reporting credential. Repeated apply preserves a healthy installation and refreshes only files it owns. The APT updater stays responsible for periodic reporter updates. Keep native SSH recovery and the previous control plane available throughout validation. Optional K3s uses approved Agent provisioning or observes an external server or agent. Tailscale, Cloudflare and external K3s stay under their current owners. The release owner can forward-roll to known-good content at a higher signed version.
