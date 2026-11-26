# GhostFleet 下一代候选操作手册

适用对象是独立验证者、实例发布者和受授权操作员。首验平台为 Debian 13 amd64。源码包含 arm64 构建目标，arm64 运行尚未实测。

## 源码复跑

在一次性 Debian 13 环境检出 Draft 指定 SHA，安装 Node 22+、Python 3、Git、dpkg、APT、apt-utils 和 GnuPG。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node --test 'nextgen/test/*.test.mjs'
python3 -m unittest discover -s nextgen/test -p test_native.py
sudo python3 -m unittest discover -s nextgen/test -p test_update.py
sudo "$(command -v node)" nextgen/test/host-e2e.mjs
npm run check:publication
npx --no-install wrangler deploy --dry-run --config nextgen/wrangler.jsonc --outdir dist/nextgen
```

这些测试使用临时 SQLite DO、合成签名、文件源与临时主机状态。Workerd 用仓库锁定的 Wrangler 依赖，用 Linux 验证；Windows 原生 Workerd 对 DO 落盘的失败不影响 Linux 路径。原有功能套件仍由现有 CI 一同运行。[隔离实验](LAB.md) 给出真实 Debian VM、OpenSSH 与 K3s 复跑步骤。

### 测试证据

- Workerd 从旧版写入的同一 SQLite DO 文件启动新版，旧 UID / v1 token 保持有效。含双 origin、只读角色、Observer 角色、匿名配对取消、请求过大、并发与撤销负控。
- 主机/Workerd E2E 使用真实 APT 从合成签名渠道拉取，执行首纳、重复首纳、老节点沿用同一 UID/凭据、v1/v2 并存、版本投影、过期拒绝、已知好内容前滚和撤销。真实 OS 上做 systemd `DynamicUser`/LoadCredential 验证；过渡期中的已安装版本与旧进程运行版本可单独读回。
- 真正的 Debian VM 从空的候选状态开始，使用独立 loopback 测试通道，首纳→systemd 证据→普通 UID 1000 OpenSSH→同包 no-op→下一版→拒绝过期→前滚→撤销。记录的 UID/凭据文件哈希保持一致，SSH 在更新及撤销前后可用。隔离环境没有访问实际实例消费者或生产发布。

## 构建与可信安装

构建者从干净的精确 Git 提交执行。输出目录应在 checkout 之外或者使用被 Git 忽略的 `dist`。正式版版本号与渠道晋升由实例发布 owner 记录。

```sh
python3 nextgen/release.py build --version '0.3.0~rc1' --arch amd64 --output dist/candidate
```

输出为 reporter Debian 制品、引导 tar 和 stdout 的 source revision / platform / SHA-256 记录。构建制品以相同源码和打包工具可复现。可信交付渠道预置引导 tar 摘要和 APT 签名根。签名者获取已审制品摘要，显式指定渠道及其独立签名身份。可在 canary 验证后对同一包晋升 stable。

```sh
python3 nextgen/release.py sign-channel --package 'dist/candidate/ghostfleet-node_0.3.0~rc1_amd64.deb' \
  --expected-sha256 "$APPROVED_PACKAGE_SHA256" --channel canary --arch amd64 \
  --signing-home "$SIGNER_GPG_DIRECTORY" --fingerprint "$APPROVED_SIGNER_FINGERPRINT" \
  --output dist/approved-canary
```

发布 owner 先将固定 pool/Packages 字节发布到私有测试 origin，再切换签名 `InRelease`。保持上一个签名索引曾引用的包在客户端过渡窗口内可读。签名有效期 24 小时，客户端最多接受 48 小时新鲜度。需要持续服务的渠道应在到期前由受信发布端重新签署现行索引。签名身份轮换先用实例 owner 信任通道更新 keyring/fingerprint，再发布新签名。失陷时冻结推进并沿独立 SSH 救援更新信任。Node profile 的最低版本可抵御首次更新前的旧签名包。短有效期内、尚未见过的新版本仍受 APT 的时间模型限制。

受授权操作员验证引导 tar 的批准摘要后在私有目录解包。把 `update.py` 和 `report.py` 安装到 root-owned `/usr/local/lib/ghostfleet-nextgen/`。把 `ghostfleet-nextgen-report.*` 与 `ghostfleet-nextgen-update.*` 安装到系统 unit 目录。先以 0600 写入 root-owned `/etc/ghostfleet-nextgen/update.json`，下例 `fingerprint` 代表实际已审批的公开钥指纹。

```json
{
  "uri": "https://updates.example.invalid",
  "channel": "canary",
  "keyring": "/etc/ghostfleet-nextgen/release.gpg",
  "fingerprint": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "minimum_version": "0.3.0~rc1"
}
```

公钥 keyring 使用 root-owned 0644 文件，走独立信任通道。先手动运行 `sudo python3 -I /usr/local/lib/ghostfleet-nextgen/update.py` 得到 ACTIVATED，核对 `/var/lib/ghostfleet-nextgen/software/current/receipt.json`。主机更新器只读取审核渠道，只解包固定的自有 reporter 文件。源签名错误、包下载失败或未提交的激活中断，保留当前 release。需回退时，发布 owner 以更高版本号签署已知好内容并保留当前安全底线。

## 首次纳管、授权与可选计算

面板部署规划使用两个 origin，Panel 上游可放已批准的 Access 策略。应用内由实例配置独立 operator、read-only、observer 凭据。面板凭据只在页面内存；节点和 observer 从本地受限文件读取各自凭据。真实密钥不使用候选默认值。Worker 版本由 provider metadata 读回，部署时单独把 `NEXTGEN_SOURCE_REVISION` 绑定到实际构建提交。

公网领取使用 Cloudflare 的可信连接地址和 Worker Rate Limit binding，在调用 DO 前执行来源级限流。缺少来源或绑定时保守失败；超出预算返回 429。实际账户应为绑定分配独占 namespace，并在可信入口移除可伪造来源的非受信子请求。该限制按 Cloudflare 站点近似计数，领用授权和原子性仍由高熵邀请及 DO 决定。参见 [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

1. 在操作员面板选渠道、平台及审批 profile 摘要，签发一次性邀请。把邀请文件经受信通道以 0600 交给目标；只在节点侧读入。预置 root-owned `/etc/ghostfleet-nextgen/enrollment.json`，包含 `origin` 和 `config_revision`。配置摘要必须来自相同的已审批配置。
2. 用 `sudo python3 -I /var/lib/ghostfleet-nextgen/software/current/node.py enroll --invitation-file /path/to/invitation.json`。验证面板 UID 和注册状态。若网络结果不确定，重试同一邀请，客户端沿已有 pending 凭据继续。
3. 在已授权靶机 `sudo systemctl daemon-reload` 后，启用 `ghostfleet-nextgen-report.timer` 和 `ghostfleet-nextgen-update.timer`，先手动触发各自 oneshot 取证。实例另验普通用户的 pinned SSH 与独立救援。首次安装可跳过 K3s。
4. 实例 owner 管理 TS、CF、SSH、集群和私有 Work 物理准入。从可信端执行 `python3 nextgen/native.py observe /path/to/bindings.json`。配置键和取值见代码与 `test_native.py`。提交观察时增加 `--panel-origin`、`--credential-file`。Tailnet device ID、Tunnel ID、Cloudflare account、K8s cluster/Node UID、SSH host key 由实例确认，credential 采用只读范围。
5. 可选 Agent profile 为 `node_uid`、`server`、`ca_sha256`、`version`、`sha256`、`node_name`，多接口可加 `node_ip` 和 `flannel_iface`。运行 `plan-agent PROFILE` 读出 digest。原生服务存在时先做所有权和可信绑定核验。需要新 Agent 时，经具体批准执行 `sudo python3 native.py apply-agent PROFILE --approve-plan DIGEST --artifact FILE --token-file FILE`。这个步骤只完整准备自己的目录。集群 owner 另行安装/启动 `ghostfleet-nextgen-k3s-agent.service`，检查真实 Node UID、Lease 和独立救援，再授予私有 Work scope。

报告撤销立即阻断旧报告凭据。主机失陷处置由可信实例同时撤销网络/SSH/集群能力及已签发的权限，保留独立救援。面板 Ready、软件版本和 K3s Ready 均作为证据输入。

同 UID 轮换凭据时，保持相同审批配置下的独立观测，旧报告器版本留作历史线索。配置摘要变化会清除之前的独立观测；再绑定通过真实 Provider/SSH 探测完成。Observer 可按 `primary`/`secondary` 两个有界来源分别提交同一维度，保留两份同时有效的相反结论。

## 迁移、回退与发行次序

- **部署前**，原 owner 读回现役 Worker/DO class、binding、对象名、部署版本、策略版本与实际客户端。准备一致快照和旧版本可恢复工件，snapshots 包含持久身份材料并由实例保管。不同 Worker script/service namespace 对同名 DO 会产生不同对象，不可直接照搬隔离配置部署。
- **兼容控制面先行**。先冻结新邀请，保存同一写者的快照，在可丢弃副本复跑 legacy v1。正式配置切回同一持久 DO 后，核对旧 UID、老凭据、接收时间与独立 SSH。对每个 legacy 节点由 operator 调用 `POST /v2/nodes/{uid}/adopt` 提供已审 profile，再用 `node.py adopt --legacy-config … --expected-node-uid …` 保留旧 UID/凭据。保留旧配置、reporter 文件和 units。逐节点验证两种协议及预期版本。
- **可回退的首批**。单个有独立救援的 canary，通过 SSH、普通消费、更新故障、撤销与回退；再小批次晋升。切回旧 Worker 前暂停 v2 写入并留取最新快照，验证旧程序读得懂共同字段、前一 reporter 能恢复 v1。恢复快照只用于 owner 授权的必要数据恢复，须按最后写入时间对账，避免覆盖期间的节点变化。SSH/CF/TS/K3s 保持各 self-owner，分别回退对应组件。
- **候选退役范围**。新版邀请及签名引导覆盖后，逐步停止为新目标发行 v1 票据。旧 POSIX join、旧面板与 reporter 按 v1 客户端和原生健康覆盖分批停用。旧命令引擎继续沿原裁决。同资源完整切换前保留救援和快照，不从新版源码自动清理运行节点。
- **发行准备边界**。源码/合成和隔离主机可复跑后交原 owner 与独立验证者。生产发布、现场 A09/Access、TS/CF live、独立真实消费者、证书撤销/多 Server quorum、arm64 实机和 canary 晋升分别取证。

## English operations

Build the signed APT candidate from a clean commit and record the package and bootstrap digests. Install the verified bootstrap, provision the approved keyring and profile through the instance trust path, and use a separate short-lived enrollment invitation. Keep the present reporting files and UID when adopting an existing host. Use the native SSH and provider credentials owned by the instance. Keep the old control plane available throughout validation. A rollback must preserve current identities and restore a reviewed release or deployment under the instance's authority; an older signed client package is rejected by default.
