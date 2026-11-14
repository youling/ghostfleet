# GhostFleet — transport-only project rules

GhostFleet provides stable, owner-authorized network paths to a machine's native OpenSSH service. It is not a device-management agent or command policy engine.

## Product boundary
1. Use maintained upstream components: cloudflared, tailscaled, OpenSSH and systemd.
2. GhostFleet must not monitor host state or commands, inspect/filter/rewrite/block commands, approve operations, execute commands through a custom agent, or maintain a parallel command-audit service.
3. No custom Node Agent, task queue, job/lease engine, SQLite task store, command executor, privileged Helper, HumanGate or per-command JIT.
4. After the owner authorizes the device and the operator authenticates the session, the selected OS account has its normal full authority. The reference profile uses root with SSH public-key authentication.
5. Keep the boundaries distinct: network reachability is not SSH authentication; SSH authentication selects the OS account; the OS account determines authority. Capability/reachability is not authority.
6. Cloudflare Access and Tailscale policy decide who can establish a connection. They must not impose command-level filtering or approval.
7. Cloudflare and Tailscale are alternative paths to the same sshd. No custom failover daemon. An established TCP session cannot migrate; reconnect through the other path.
8. Use OS-native systemd, sshd, cloudflared, tailscaled and journald logs. Do not add a parallel monitor or command-audit pipeline.
9. Never commit real hostnames, IPs, endpoint URLs, tailnet locators, node IDs, tunnel tokens, Tailscale auth keys, SSH private keys or account identifiers. Use reserved .invalid placeholders.
10. Never write directly to main. Use a branch and PR; bind security/semantic review and CI evidence to the exact HEAD.
11. Public docs are bilingual where they describe owner-facing installation or operational procedures. Keep deterministic tests and publication-boundary checks in CI.
12. Human/owner decisions govern production topology, Cloudflare/Tailscale policy and target-specific SSH/root deployment. A config example is not deployment authorization.

## Contribution rules
- Keep the product surface to documentation, generic config examples and small validators.
- Validate shipped SSH config with OpenSSH; validate sshd effective settings, not only file syntax.
- Validate shipped systemd units with systemd-analyze.
- Run node scripts/publication-guard.mjs and node --test test/publication-guard.test.mjs.
- Do not reintroduce command allowlists, remote execution APIs, monitoring agents, approval state machines or custom audit logs.
- Preserve historical source in Git; explain product-scope migrations in docs/MIGRATION.md.
