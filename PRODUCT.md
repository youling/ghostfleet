# GhostFleet

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The user manages personal devices, including a ThinkPad, and wants an open-source plugin and accompanying control panel. Humans inspect and approve requests; AI clients inspect the same authoritative control-plane state through typed MCP tools.

## Product Purpose

Provide a device control plane with enrollment attempts, human approvals, evidence, admitted nodes, capabilities and events. The public project is extracted from private Fleet practices without private inventory or credentials.

## Capabilities and Constraints

- Existing stack: native HTML/CSS/JavaScript, Tabler core CSS, provider-neutral Node core, and a Cloudflare Worker/SQLite Durable Object reference host.
- V0 supports durable lifecycle records and read-only MCP inspection. It does not install device agents or prove that a real ThinkPad is managed.
- The backend owns bearer authentication, read-only/operator authority, human approvals, expiration, transitions and evidence acceptance.
- The Console stores access tokens in page memory only. Non-secret appearance/language preferences may be stored locally.
- Synthetic examples and screenshots must be identified as synthetic.
- AGPL-3.0-only was explicitly selected by the user. Private Fleet source remains until the public replacement exceeds its capability.

## Brand Commitments

- Preserve the GhostFleet name.
- Default Chinese with an English switch, explicitly requested by the user.
- The user requests a professional administration interface inspired by satnaing/shadcn-admin, preserving its core interaction ideas without a pixel-for-pixel copy.

## Evidence on Hand

README.md, docs/API.md, docs/SECURITY.md and the core model define the current public contract. Browser previews in docs/images contain local synthetic records only. The panel redesign uses shadcn-admin as a public visual/interaction reference, not as proof of GhostFleet backend functionality.

## Landing Page

The user explicitly selected device state and actionable work as the landing-page priority. Present inventory and pending work before secondary metadata.
