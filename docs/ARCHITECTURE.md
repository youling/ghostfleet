# Architecture — transport only

## Product contract

GhostFleet's runtime responsibility is deliberately zero: no custom server, node agent, command executor, task queue, device monitor, policy engine, per-command approval or audit pipeline.

Use mature OS/network components:

- OpenSSH is the remote administration protocol and executes commands as the authenticated OS user.
- Cloudflare Tunnel is one outbound network path.
- Tailscale/WireGuard is a second, independent private network path.
- Cloudflare Access and Tailscale identity policy authenticate who may establish a session.
- systemd supervises the upstream daemons.
- journald and OS-native service logs remain the operational log source.

## Topology

```text
                 Cloudflare Access
Operator/AI  ----------------------------.
   |                                      |
   | ssh omv8-cf                          v
   +---- cloudflared client ---- Cloudflare edge
                                      |
                                      | outbound tunnel
                                      v
                               cloudflared on node
                                      |
                                      v
                                  sshd:22
                                      ^
                                      |
                               tailscaled/WireGuard
                                      ^
                                      |
   +---- OpenSSH client ---------------'
   |
   | ssh omv8-ts
   v
Operator/AI on authorized tailnet
```

Both paths terminate at the same OpenSSH daemon. The OS sees the same user, shell, filesystem and permissions regardless of which transport carried the session.

## Failure behavior

- cloudflared and tailscaled maintain their own network connections and reconnect behavior.
- systemd restarts a daemon if it exits unexpectedly.
- GhostFleet does not run health polling or a failover controller.
- The operator chooses the route for each new SSH connection. If one route is down, reconnect using the other alias.
- An established TCP/SSH session cannot be transparently moved between CF and TS; a reconnect is required.

## Authority

Network policy answers only: "may this authenticated operator establish a connection to TCP/22 on this device?" OpenSSH answers: "which OS account is this?" After login, GhostFleet does not inspect, constrain or approve commands.

The reference SSH config uses root with public-key authentication. A deployment may choose a different administrator account, but GhostFleet does not add a second privilege broker.
