# 纳管模板运行时 v0 / Enrollment Template Runtime v0

## 中文

本包定义 provider-neutral 的纳管模板、deployment overlay、用户可调整项和 EnrollmentAttempt 绑定语义。

核心约束：

- template identity/version/generation 是 immutable identity；
- deployment overlay 只能修改 posture，不能重写 template identity；
- overlay 与 base generation 必须一致；
- user override 只能修改 template 明确 allowlist 的路径；
- provider adapter/option 未登记时 fail closed；
- template / overlay 不保存 secret plaintext，只能保存 opaque reference；
- normalization 与 digest 确定性；
- EnrollmentAttempt 绑定 exact template generation + normalized digest；
- template 变化不能让旧 attempt/approval 静默继承。

本包不拥有 NodeIdentity、EnrollmentAttempt lifecycle、provider authority 或真实部署 secret。

## English

This package defines provider-neutral enrollment templates, deployment overlays, user-overridable settings and exact EnrollmentAttempt bindings. Template identity/version/generation are immutable; overlays only change posture and must match the base generation; user overrides are allowlisted; unknown provider options fail closed; plaintext secrets are rejected; normalization/digests are deterministic; attempts bind an exact generation and digest. The package does not own NodeIdentity, EnrollmentAttempt lifecycle, provider authority or deployment secrets.
