# ghostfleet-enroll (one-time enrollment bridge)

**中文**

这是**唯一**不需要 Access 登录的公开入口，只转两条 POST：

- `POST /v1/enrollment-tickets/{ticket-id}/claim`
- `POST /v1/enroll/complete`

其余路径/方法一律 404/405。桥本身不认证、不签发、不保存任何材料：票据的短码与 resume session 由私有控制面校验。控制面通过 Service Binding（`GHOSTFLEET_CONTROL_PLANE`）调用，**不对公网暴露**。桥还会剥离 `authorization`、`cookie` 等 Console 凭据，票据路径是唯一跨过边界的身份。

部署约束：`workers_dev: false`、`preview_urls: false`；唯一公开地址是部署方自己的 zone。**不要**给这个 host 加 Access 策略——未纳管的节点无法登录，加了就等于关闭纳管。

## English

This is the **only** public surface that requires no Access login, and it forwards
exactly two POST routes:

- `POST /v1/enrollment-tickets/{ticket-id}/claim`
- `POST /v1/enroll/complete`

Every other path or method is 404/405. The bridge does not authenticate, mint or
store material: the private control plane verifies the short code and resume
session. It reaches the control plane through the `GHOSTFLEET_CONTROL_PLANE`
service binding, so the control plane is never exposed to the public internet.
Console credentials (`authorization`, `cookie`) are stripped; the ticket path is
the only identity that crosses.

Deployment constraints: `workers_dev: false` and `preview_urls: false`; the only
public address is the deployment's own zone. Do **not** attach an Access policy
to this host: an unenrolled node cannot log in, so Access would disable enrollment.
