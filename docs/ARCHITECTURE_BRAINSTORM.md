# GhostFleet Architecture Brainstorm

Status: Draft for Astra review

## 1. Core Principle

GhostFleet should be designed around lifecycle and objects, not isolated tasks.

Avoid:

```
Create a new issue for every feature
```

Prefer:

```
Existing GhostFleet object
        |
        + capability added
        + lifecycle state changed
        + new domain introduced
```

## 2. High-level Architecture

```
                    Human
                      |
                      v
              GhostFleet Console
                      |
       +--------------+--------------+
       |              |              |
 Enrollment      Fleet Domain   Capability
  Domain                          Domain
       |              |              |
       +--------------+--------------+
                      |
              Control Plane
                      |
              Device Agents
```

## 3. Single Entry Point, Multiple Domains

Enrollment and daily management should not become separate products.

Preferred:

```
app.ghostfleet.dev

Fleet
 ├── Dashboard
 ├── Nodes
 ├── Enrollment
 ├── Capabilities
 ├── Events
 └── Settings
```

The separation is a security/service boundary, not a user experience boundary.

## 4. Node Lifecycle

```
UNKNOWN
   |
ENROLLMENT_PENDING
   |
PROVISIONAL
   |
ACTIVE
   |
SUSPENDED
   |
RETIRED
```

Enrollment is part of the node lifecycle.

## 5. Security Model

Important distinction:

Bootstrap identity != operational authority

A new device may receive enough authority to register itself, but should not automatically receive unrestricted execution capability.

Conceptually:

```
Enrollment Token
        |
        v
Node Identity
        |
        v
Capability Grants
        |
        v
Approved Operations
```

Human Gate is required for sensitive capability issuance.

## 6. Control Plane Components

Initial conceptual modules:

```
Control Plane
 |
 +-- Enrollment Service
 |
 +-- Fleet Service
 |
 +-- Capability Service
 |
 +-- Event Service
 |
 +-- API Layer
```

## 7. UI Strategy

Do not build a complete custom admin UI from zero.

Reuse mature open-source dashboard/admin ecosystems where practical.

GhostFleet differentiation is:

- protocol;
- agent runtime;
- lifecycle model;
- capability security;
- AI integration.

Potential UI model:

```
GhostFleet API
      |
      +-- Official Console
      +-- Community Plugins
      +-- External Dashboards
```

## 8. Initial Capability Targets

Supported platforms explored:

- Linux
- Windows
- Android
- macOS (future)

Initial capabilities:

- shell/command execution;
- file operations;
- system information;
- container operations;
- browser/device automation where supported.

## 9. Integration Direction

Primary AI integration should be capability-oriented:

```
AI Agent
   |
   +-- MCP
   +-- API
   +-- SDK
   |
GhostFleet
```

Avoid exposing raw remote shell as the primary abstraction.
