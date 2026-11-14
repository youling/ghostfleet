# Public publication boundary

Every tracked file is checked by `scripts/publication-guard.mjs` in CI. The guard is deliberately small and has no exceptions by default.

It rejects private-key/token/credential shapes, realistic Tailscale MagicDNS locators and node UUID identifiers, user-specific home-directory paths, links to private GhostFleet/Fleet/ai-hub repositories, and URLs whose host is not in `publication-policy.json`.

Use reserved `.invalid` hostnames in examples. Approved public documentation hosts are explicitly listed in the policy file. To add a new public endpoint, review the destination and update the policy in the same PR. Do not add broad path or content exceptions.

This is a publication boundary, not a runtime monitor or command filter.
