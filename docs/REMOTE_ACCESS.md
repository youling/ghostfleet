# Remote access deployment

This guide is a template. It does not deploy anything and contains no real hostnames, keys, tokens or account identifiers. Apply it only after the device owner authorizes the exact target and Cloudflare/Tailscale policy changes.

## 1. Install the native services on the target

On Debian/OMV, install and enable:
- OpenSSH server (`openssh-server`, service normally `ssh.service`);
- Tailscale from its official Debian package instructions (`tailscaled.service`);
- cloudflared from Cloudflare's official package instructions.

Do not install a GhostFleet Node Agent. There is no custom GhostFleet daemon.

## 2. Configure OpenSSH for owner-authorized administrator access

The example in [90-ghostfleet-admin.conf.example](../config/sshd/90-ghostfleet-admin.conf.example) allows root public-key login and disables password/keyboard-interactive login. Copy it to `/etc/ssh/sshd_config.d/90-ghostfleet-admin.conf`, add the owner's **public** key to `/root/.ssh/authorized_keys`, then validate before reloading:

```sh
sudo sshd -t
sudo sshd -T | grep -E '^(permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication|authenticationmethods) '
sudo systemctl reload ssh
```

Confirm the effective values are `permitrootlogin prohibit-password`, `pubkeyauthentication yes`, `passwordauthentication no`, `kbdinteractiveauthentication no` and `authenticationmethods publickey`. Debian/OMV may have earlier drop-in files; the effective `sshd -T` output is authoritative. Keep host-key verification enabled on the client. Do not copy the private key to the server, repository or chat.

Once authenticated as root, the SSH session has root authority. GhostFleet does not add command restrictions or per-command approvals.

## 3. Cloudflare path

Use a remotely-managed Cloudflare Tunnel:
1. Create/select a tunnel in Cloudflare Zero Trust.
2. Add a published application route for a hostname such as `ssh.example.com` to `ssh://127.0.0.1:22`.
3. Create a Cloudflare Access self-hosted application for that hostname and allow the owner's identity.
4. Install cloudflared on the target and run it as a systemd service. The service example uses a token file (cloudflared 2025.4.0+):
   ```sh
   sudo groupadd --system cloudflared
   sudo useradd --system --gid cloudflared --home-dir /var/lib/cloudflared --create-home --shell /usr/sbin/nologin cloudflared
   sudo install -d -o root -g cloudflared -m 0750 /etc/cloudflared
   sudo install -o root -g cloudflared -m 0640 /dev/null /etc/cloudflared/ssh-tunnel.token
   sudoedit /etc/cloudflared/ssh-tunnel.token
   sudo chown root:cloudflared /etc/cloudflared/ssh-tunnel.token
   sudo chmod 0640 /etc/cloudflared/ssh-tunnel.token
   sudo install -D -m 0644 config/systemd/cloudflared-ssh.service.example /etc/systemd/system/cloudflared-ssh.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared-ssh.service
   ```
   Adjust the binary path in the unit if `command -v cloudflared` is not `/usr/bin/cloudflared`. Do not put the token in Git, shell history or an AI prompt.
5. Install cloudflared on the client and connect using the `omv8-cf` SSH alias. The client-side `cloudflared access ssh` flow prompts for Cloudflare Access login when needed.

Use a normal Access self-hosted application. Access authenticates the connection; it does not inspect or filter SSH commands. Do not use Access for Infrastructure if the deployment goal is a plain unrestricted SSH session without per-target command policy or command recording.

## 4. Tailscale path

1. Install Tailscale from its official Linux package instructions.
2. Run `sudo tailscale up` and complete the owner-controlled browser authentication.
3. Ensure the tailnet's existing policy permits the authorized administrator/device to reach this node on TCP/22.
4. Leave Tailscale SSH disabled (`tailscale set --ssh=false`) so the connection uses the same OpenSSH daemon as the Cloudflare path.
5. Connect using the `omv8-ts` alias and the same OpenSSH key.

Tailscale is the network path; OpenSSH remains the SSH server and OS login authority. No custom Tailscale controller or GhostFleet ACL engine is installed.

## 5. Client configuration

Copy [ghostfleet.conf.example](../config/ssh/ghostfleet.conf.example) into the operator's SSH config or include it from `~/.ssh/config`. Replace:
- `ssh.example.com` with the Cloudflare Access hostname;
- `omv8.tailnet-name.ts.net` with the target's Tailscale MagicDNS name;
- `~/.ssh/ghostfleet_admin` with the owner's local private-key path.

Connect:
```sh
ssh omv8-cf
ssh omv8-ts
```

The two aliases share one `HostKeyAlias`, so the same server host key is checked on either route.

## 6. Logs and recovery

Use the OS's native logs:
```sh
journalctl -u ssh --since today
journalctl -u cloudflared-ssh --since today
journalctl -u tailscaled --since today
systemctl status ssh cloudflared-ssh tailscaled
```

These logs show service and connection/authentication events. They do not necessarily record every shell command. GhostFleet does not add command logging or monitoring.

If Cloudflare is unavailable, create a new SSH session with `ssh omv8-ts`. If Tailscale is unavailable, use `ssh omv8-cf`. Existing TCP sessions require reconnecting; no custom session migration is promised.

## 7. Revocation

- Remove the operator from the Cloudflare Access allow policy or disable the tunnel route.
- Remove the operator/device from the Tailscale network policy or revoke the node.
- Remove the corresponding public key from `/root/.ssh/authorized_keys`.
- Disable the relevant service if the route itself must be taken offline.

Revocation at the network layer blocks new sessions. Removing the SSH key blocks OS authentication regardless of route.

## Boundaries

This is a remote-access transport profile, not a complete device-management agent. It does not monitor disks, RAID, processes or services; it does not filter commands; it does not ask for per-command approval; it does not promise command-level audit records. It also does not modify storage, RAID, shares, packages or application services automatically.

## Upstream references

- Cloudflare SSH/Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/
- Cloudflare client-side SSH: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/
- Cloudflare Tunnel token-file run parameter: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/
- Tailscale Linux install: https://tailscale.com/docs/install/linux
- Tailscale network access policy: https://tailscale.com/docs/features/access-control
