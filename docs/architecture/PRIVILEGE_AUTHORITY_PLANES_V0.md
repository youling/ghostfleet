# 权限与凭据平面 v0 / Authority and Credential Planes v0

status: Proposed  
owner: youling/ghostfleet  
source: #9 / ADR 003

## 中文

<!-- topic:planes -->
### 三个 authority 平面

GhostFleet 把“能连接”“能识别”“能提权/恢复”拆开，禁止再用一把长期 controller/root key 同时承担所有职责：

```text
Transport / Control Plane
  -> stable reachability + authenticated ordinary identity
  -> DOES NOT imply root/system privilege

Privilege Plane
  -> PrivilegeRequest -> Policy/Human -> PrivilegeLease
  -> node-local Privileged Helper
  -> bounded root/system operation

Break-glass / Recovery Plane
  -> exceptional Human-gated recovery only
  -> separate custody / separate authority / durable receipt
  -> never an ordinary Agent workflow
```

核心不变量：

> stable connectivity != stable elevation

长期连接可以存在；**Agent 的日常 root/system execution privilege 不以长期 ambient authority 存在。** Broker signer、节点 Helper 的本地 system authority、独立 break-glass custody 可以长期存在，但它们都必须留在各自 enforcement/custody boundary 内，不能转成 Agent 常驻 root。

<!-- topic:classes -->
### 六类 identity / credential

公共 contract 至少区分：

```text
TRANSPORT_IDENTITY
NODE_IDENTITY
LEASE_SIGNING_AUTHORITY
NODE_HELPER_TRUST_ROOT
SECRET_REFERENCE
BREAK_GLASS_RECOVERY_AUTHORITY
```

#### TRANSPORT_IDENTITY

证明“谁在建立/使用 transport channel”，例如某类 SSH/RPC/mTLS/tailnet identity。它只授予 transport/session 层允许的普通权限，不自动成为 PrivilegeLease authority，也不等价 root。

#### NODE_IDENTITY

表示被管理节点的稳定 GhostFleet identity。它用于 target binding 与 lifecycle，不是登录凭据，也不自动授予 transport 或 privilege。

#### LEASE_SIGNING_AUTHORITY

Broker/issuer 用于产生可验证 PrivilegeLease 的 signing/issuing authority。它不能被当作 remote root login credential；Agent 不获得可导出的 signer private authority。

#### NODE_HELPER_TRUST_ROOT

节点本地 Privileged Helper 用于判断哪些 issuer/lease authenticity 可接受的 trust anchor/reference。它属于节点 enforcement boundary，普通 Agent 不得修改/替换它。若实现使用 public key/certificate 作为 verification anchor，该 public verification material 可以按 deployment policy 可见；任何 helper-side private authority 仍不得导出。

#### SECRET_REFERENCE

对 deployment-owned secret/custody 的 opaque reference。它可以被 request/lease/adapter 引用，但 reference 本身不是 secret，也不授予 authority。

#### BREAK_GLASS_RECOVERY_AUTHORITY

只服务异常恢复/重新 enrollment/console/provider rescue 等极端路径。它与日常 transport identity、lease signing authority 分离，并始终要求 Human explicit gate。

<!-- topic:separation -->
### 不允许 silent class collapse

同一 credential/secret/material 不得静默同时满足多个 class。

特别禁止：

```text
TRANSPORT_IDENTITY == root-equivalent authority
TRANSPORT_IDENTITY == LEASE_SIGNING_AUTHORITY
NODE_IDENTITY == login credential
LEASE_SIGNING_AUTHORITY == remote root login key
NODE_HELPER_TRUST_ROOT == exportable Agent credential
BREAK_GLASS_RECOVERY_AUTHORITY == normal Agent authority
```

如果某 deployment 使用共同硬件 root/HSM/CA 作为更高层 trust source，必须给不同 class 派生独立 key/reference/usage constraints，并分别审计；不能因为“同一个 HSM/CA”就把 class 合并成一个可复用 credential。

<!-- topic:transport -->
### Transport / Control Channel

GhostFleet generic core 只要求：

- authenticated identity；
- least-privileged ordinary access；
- revocable/scoped channel policy；
- transport session 不带 ambient root/sudo；
- privileged operation 即使来自一个已认证 transport session，也必须另过 lease/helper gate。

因此：

```text
valid transport + no valid lease -> privileged operation DENIED
```

SSH、mTLS RPC、Tailscale SSH、WireGuard/tailnet、其它 transport 都只是 adapter/deployment 选择。**GhostFleet 不规定某个具体 transport 必须默认开启。**

是否在礼宏 Fleet 中默认开启 Tailscale SSH、哪些节点互通、ACL/SSH policy/port/ordinary user scope，属于 `youling/fleet` deployment policy，不属于本公共 contract。

<!-- topic:bootstrap -->
### Bootstrap / enrollment

首次 bootstrap 可以建立：

- NodeIdentity；
- ordinary transport identity/trust；
- Privileged Helper；
- Helper trust root；
- broker/issuer trust relation；
- recovery/break-glass reference。

Bootstrap 是显式、高权限 ceremony；完成后，routine Agent 工作不能继续依赖 bootstrap credential 或长期 root login authority。

<!-- topic:counterexamples -->
### 反例

| 场景 | 必须结果 |
| --- | --- |
| 普通 SSH/session 已认证，但无 lease | privileged op DENIED |
| transport credential 被窃取 | 最多获得该普通 transport policy 的能力；不得自动获得 helper/root |
| lease 签给其它 node/helper/audience | DENIED |
| transport session 仍在线，但 lease 已过期/revoked | DENIED |
| Agent 尝试修改 helper trust root 或导出 helper/lease signer private material | 无 generic mutation/export surface；DENY |
| Agent 尝试调用 break-glass 作为普通 operation | DENY / Human recovery gate only |
| 一个“fleet-controller-key”想同时做 transport + root + signer + recovery | 架构非法，必须拆分 |

## English

<!-- topic:planes -->
### Three authority planes

GhostFleet separates stable transport/control connectivity, JIT privilege authority, and break-glass recovery. Stable connectivity never implies ambient Agent elevation. Durable broker/helper/recovery authorities may exist only inside their own enforcement/custody boundaries and never become reusable Agent root authority.

<!-- topic:classes -->
### Credential classes

The generic contract distinguishes `TRANSPORT_IDENTITY`, `NODE_IDENTITY`, `LEASE_SIGNING_AUTHORITY`, `NODE_HELPER_TRUST_ROOT`, `SECRET_REFERENCE`, and `BREAK_GLASS_RECOVERY_AUTHORITY`.

Transport identity authenticates an ordinary channel; node identity names the managed node; signing authority issues leases; the helper trust root verifies allowed issuers and is not writable by ordinary Agents; secret references point to deployment-owned custody without carrying plaintext; break-glass authority is exceptional Human-gated recovery authority.

<!-- topic:separation -->
### No silent class collapse

No credential silently satisfies multiple classes. Shared higher-level hardware/CA trust may exist only with separate derived keys/references, usage constraints, and audit boundaries.

<!-- topic:transport -->
### Transport/control channel

A valid transport session without a valid lease cannot authorize a privileged operation. GhostFleet remains transport-neutral and does not require Tailscale SSH, SSH, or any other concrete transport to be enabled by default; those are deployment choices.

<!-- topic:bootstrap -->
### Bootstrap

Initial bootstrap may establish node identity, ordinary transport trust, the privileged helper, helper trust root, issuer relation, and break-glass reference. Routine Agent operation after bootstrap must not depend on reusable bootstrap/root credentials.

<!-- topic:counterexamples -->
### Counterexamples

A stolen ordinary transport identity remains ordinary; wrong-node/helper leases are denied; expired/revoked leases remain denied while transport stays connected; helper/signing private authority is not exportable and helper trust roots are not ordinary-Agent mutable; break-glass is not an ordinary Agent capability; a universal controller/root/signer/recovery key is invalid architecture.
