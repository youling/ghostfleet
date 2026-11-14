# Contributing

GhostFleet is intentionally transport-only.

Accepted changes:
- accurate Cloudflare Tunnel, Tailscale, OpenSSH and systemd configuration examples;
- documentation and compatibility fixes;
- small validation checks for shipped SSH/config examples.

Out of scope:
- device monitoring or inventory agents;
- remote command APIs or command allowlists;
- per-command approval/HumanGate/JIT;
- custom task queues, durable command ledgers or SQLite stores;
- custom privileged helpers or command audit pipelines;
- a custom SSH implementation or tunnel protocol.

Use upstream tools directly. Never commit tunnel tokens, auth keys, SSH private keys, real hostnames or device identifiers. Config changes are examples only; production changes require owner authorization.
