# Security model

GhostFleet is a thin transport configuration project. It does not implement a command execution service, command monitor, command filter, approval engine or custom audit store.

## Authority model

1. The device owner authorizes the machine to be reachable through the chosen network path.
2. Cloudflare Access and/or Tailscale identity policy authenticate the remote session/network connection.
3. OpenSSH authenticates the OS account using an owner-managed SSH key.
4. Once the session is authenticated, the selected OS account has its normal operating-system authority. The reference profile uses root public-key authentication. GhostFleet does not intercept or approve individual commands.

This means an authorized administrator can perform any operation permitted to that OS account, including destructive disk/filesystem operations. The transport layer will not prevent them.

## Credentials

- Never commit tunnel tokens, Tailscale auth keys, SSH private keys or real endpoint identifiers.
- Keep the private SSH key on the operator/AI execution host in an owner-controlled credential store.
- Keep Cloudflare tunnel credentials in a root-controlled local file readable only by the cloudflared service account.
- Revoke access at the relevant session boundary: Cloudflare Access policy/tunnel, Tailscale tailnet policy/device, and OpenSSH `authorized_keys`.

## Logging

GhostFleet creates no parallel command log. OpenSSH records authentication/session events according to the OS configuration; systemd/journald and the cloudflared/tailscaled services expose their own service logs. **OpenSSH/journald do not necessarily record every shell command.** Do not claim command-level auditing unless the owner separately enables an OS-native audit/session-recording facility.

## Network exposure

- Do not publish an unauthenticated public root SSH listener.
- Do not open router port-forwarding for TCP/22.
- Use Cloudflare Access or Tailscale network identity to control who can establish a session.
- Keep SSH host-key verification enabled.
- A tunnel is transport, not OS authentication or privilege by itself.

Report security issues through the repository's configured GitHub private vulnerability reporting channel.
