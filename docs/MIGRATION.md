# Product-scope migration

## From the former management plane to transport-only GhostFleet

The former GhostFleet tree contained a custom Console, control plane, Workers/DO, bootstrap system, Node Agent, SQLite task repository, privileged Helper and per-operation approval machinery. The owner has superseded that product direction.

The current product is deliberately limited to Cloudflare Tunnel, Tailscale, OpenSSH, systemd and OS-native logs. The removed implementation remains in Git history for provenance and rollback investigation. It is not part of the current product, must not be re-vendored or re-pinned, and its former M4/REQ-01 acceptance claims do not apply to this transport-only product.

No automatic migration or deployment is performed by this document. Existing live Cloudflare/Tailscale/SSH configuration must be inspected and explicitly authorized before changing it.
