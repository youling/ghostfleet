# GhostFleet — transport-only project rules

GhostFleet is a deliberately thin remote-access profile. Its job is to make an owner-authorized SSH session reach a managed machine reliably through Cloudflare Tunnel and/or Tailscale.

## Product boundary

1. **Transport only.** Use the maintained upstream daemons: `cloudflared`, `tailscaled`, OpenSSH and systemd.
2. **No custom command plane.** GhostFleet does not inspect, monitor, parse, filter, rewrite, approve, deny or record remote commands.
3. **No custom device agent.** No Node Agent, task queue, job lease, SQLite task store, command executor, privileged Helper, HumanGate or per-command JIT approval.
4. **Full administrator session after owner authorization.** The owner chooses the SSH identity and OS account. The reference profile uses root with public-key authentication. Once the SSH session is authenticated, OpenSSH executes the administrator's requested commands without GhostFleet policy interception.
5. **Session/network authentication remains.** Cloudflare Access and Tailscale identity/ACL may decide who can establish a connection to TCP/22. They do not impose command-level restrictions.
6. **OS-native lifecycle and logs.** systemd supervises upstream transport daemons; sshd, cloudflared, tailscaled and journald provide their native service/authentication logs. GhostFleet does not build a parallel monitoring or audit pipeline.
7. **Two independent paths.** Cloudflare and Tailscale are alternative routes to the same OpenSSH server. No custom failover daemon. The operator chooses `omv8-cf` or `omv8-ts`; a broken TCP session must reconnect over the other route.
8. **No secrets in Git.** Tunnel tokens, SSH private keys and Tailscale credentials stay in owner-controlled local credential storage. Commit only placeholders and public configuration examples.
9. **No production changes from this repository.** Config examples are not deployment authorization. Cloudflare DNS/Access, Tailscale policy, SSH/root and NAS changes require the owner's explicit target-specific authorization.
10. **No new runtime framework.** Prefer OpenSSH configuration and vendor systemd units over custom code. Add code only when an upstream tool cannot provide the transport behavior.

## Contribution rules

- Keep the default product surface to docs and small config examples.
- Validate SSH config syntax with the system OpenSSH client.
- Do not reintroduce command allowlists, remote execution APIs, monitoring agents, approval state machines or custom audit logs.
- Keep examples generic; never commit real hostnames, node IDs, tunnel tokens, auth keys, private keys or account details.
