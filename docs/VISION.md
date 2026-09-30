# GhostFleet Vision

## Overview

GhostFleet is an open-source AI-native device fleet control plane.

The original motivation was enabling AI agents inside chat and agent environments to safely interact with real-world devices. Instead of treating machines as remote shells, GhostFleet models devices as managed nodes with explicit identities, capabilities, lifecycle states, and human-controlled permissions.

## Positioning

GhostFleet is not a traditional remote desktop or RMM replacement.

The core model is:

```
AI Agent
   |
   v
Capability Layer
   |
   v
GhostFleet Control Plane
   |
   v
Device Agents
```

The project focuses on the missing infrastructure layer between AI agents and physical computing environments.

## Brand Structure

Repository:

```
youling/ghostfleet
```

Brand:

```
GhostFleet
```

Components:

```
GhostFleet Control Plane
GhostFleet Agent
GhostFleet Console
GhostFleet Protocol
GhostFleet SDK
```

## Non-goals

GhostFleet is not intended to become:

- a generic remote desktop product;
- a closed enterprise MDM platform;
- a replacement for existing admin dashboards;
- a provider-specific cloud product.

The project should reuse mature UI/control-panel ecosystems where possible and focus engineering effort on lifecycle, protocol, security, and AI integration.
