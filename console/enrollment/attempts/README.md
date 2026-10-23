# 纳管记录 / Enrollment Attempts

## 中文

创建、跟踪和对账纳管记录的人工界面；生命周期、授权、执行和验收事实仍归服务端。

`presentation.js` 只投影既有状态。步骤分别对应创建、准备、等待人工确认、已认领、验收中和已准入；未经过人工确认的路径不展示一个虚假的已批准步骤。失败、取消、到期、待对账或未知状态不显示向前成功进度。已准入记录不会仅因原票据有效期过去而被显示为过期。

证据明确区分 PASS、FAIL、UNKNOWN 和尚未提交。陌生或畸形状态不猜成通过或执行失败；最新 UNKNOWN 不能被旧 PASS 掩盖。验收中与待对账详情提供现有的只读“读取服务端状态”，只刷新事实，不签发票据、不重放安装、不生成 PASS，也不触发准入。

本界面修复不代表完整安装器或证据采集已接通。首轮 OMV8/Debian 实验须由已验收的同一发布版本从正常面板入口完成：选择模板与安装意图、生成一次性材料、一次首次管理员授权、本机只读预检、所选能力安装与恢复、可信证据和独立消费者调用。不得靠临时 SSH 补命令、手改 Registry/Policy/证据、复制其他设备的 PASS 来宣布完成。

“全新流程”不等于清空或重装 NAS。现有身份、数据与业务必须保留；发现旧纳管身份应由接管/修复路径处理，不自动删除。真实重启、停机或存储变更不由本次流程测试推定授权，未运行的恢复验证明确记录 NOT_RUN。源码、纯函数/渲染测试、真实浏览器、可丢弃系统、私有部署和真实 NAS 的结果分别记录。

## English

Human-facing views for creating, tracking and reconciling enrollment attempts. Lifecycle, authorization, execution and acceptance remain server-owned.

`presentation.js` projects existing facts only. It separates creation, preparation, Human Gate, claim, materialization/verification and acceptance. A route with no Human Gate does not show a fabricated completed approval. Failed, cancelled, expired, reconciliation-required or unknown states never imply forward success; an accepted record remains accepted after its original ticket TTL.

Evidence distinguishes PASS, FAIL, UNKNOWN and MISSING. Unknown/malformed status is neither success nor a proven failure, and an earlier PASS never hides a later UNKNOWN. The existing read-only server-state refresh is available during materialization and reconciliation. It does not mint tickets, retry effects, produce evidence or admit nodes.

This UI fix does not connect the full installer or observer pipeline. The OMV8/Debian first-use test must exercise one accepted release through the actual Console: template and intent selection, one-time delivery, one initial administrator ceremony, local read-only preflight, selected capability convergence/recovery, verified evidence and independent consumer calls. Ad hoc SSH repair commands, edited registry/policy/evidence and copied PASS records are not product acceptance.

A fresh workflow is not permission to reset the NAS. Preserve existing identity, data and workloads; detect earlier enrollment and use the appropriate adoption/repair path. Reboot, outage and storage effects retain separate authorization, and unexecuted recovery checks remain NOT_RUN. Report source, renderer, real browser, disposable OS, private deployment and real NAS evidence separately.
