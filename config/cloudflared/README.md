# Cloudflare Tunnel route

Use the upstream cloudflared daemon; GhostFleet does not implement a tunnel protocol or Worker proxy.

Recommended route:
- Published hostname: `ssh.example.com`
- Origin service: `ssh://127.0.0.1:22`
- Access application: self-hosted application for that hostname
- Access policy: allow the owner's identity

The SSH client uses `cloudflared access ssh --hostname %h` as its OpenSSH ProxyCommand. Install cloudflared on both the target (tunnel connector) and the client.

For a remotely-managed tunnel, the tunnel token is a credential: do not commit it. The example systemd service reads it from `/etc/cloudflared/ssh-tunnel.token` using `--token-file` (supported by cloudflared 2025.4.0 and later). Keep the file owner-controlled and readable only by the cloudflared service account.

Cloudflare Access authenticates the connection. This reference intentionally does not use Access for Infrastructure command-level policies or command recording.
