# AI-native Privilege Broker v0

## Status

Draft architecture direction. No production node mutation.

## Principle

After initial enrollment, Humans do not repeatedly enter elevation passwords. Agents request capabilities; Humans or policy approve intent; the system issues bounded privilege leases.

## Model

```
Agent
  |
  | privilege request
  v
Privilege Broker
  |
  +-- Policy Engine
  +-- Human Approval
  +-- Audit Ledger
  |
  v
Privilege Lease
  |
  v
Node Privileged Helper
  |
  v
OS privileged operation
```

## Rules

- Agent is not root.
- No permanent root SSH keys.
- Human approves intent, not shell commands.
- Privilege is scoped, time bounded, and auditable.
- Every privileged operation has receipt and rollback semantics.

## Schemas

### Privilege Request

```yaml
target: node-id
reason: install service
operations:
  - systemd.service.create
ttl: 15m
risk: high
```

### Privilege Lease

```yaml
lease_id: generated
request_id: generated
approved_by: human-or-policy
expires_at: timestamp
allowed_operations: []
```

## Node model

Preferred:

```
normal agent
    |
local IPC
    |
privileged helper
    |
OS capability
```

Forbidden:

```
agent == root
```

## ThinkPad migration

ThinkPad is the first private Fleet consumer. Existing static privileged-account proposals are replaced by this model.

The Fleet side owns deployment binding and evidence. GhostFleet owns generic protocol, lease, helper contract, and audit semantics.

## Initial milestones

1. Request schema.
2. Lease schema.
3. Helper contract.
4. Approval UX contract.
5. Receipt and rollback tests.
6. Negative authority tests.
