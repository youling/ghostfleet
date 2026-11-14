# Tailscale path

Install the official Tailscale Linux package and use the vendor `tailscaled.service`. Complete `sudo tailscale up` with the owner's browser identity.

Allow the authorized operator/device to reach the target on TCP/22 in the existing tailnet policy. This is network/session reachability, not a command allowlist.

GhostFleet's reference profile leaves Tailscale SSH disabled and uses ordinary OpenSSH over the Tailscale network:
```sh
sudo tailscale set --ssh=false
tailscale status
```

This makes both Cloudflare and Tailscale paths terminate at the same sshd, with the same OS user, SSH key and OS-native connection logs. Do not add a custom Tailscale agent or policy engine.
