# Privilege Broker v0 Contracts

## Status

Draft architecture contract. No production mutation authority.

## Goal

After initial node enrollment, Human should not repeatedly enter elevation passwords. Agent requests intent-scoped privilege; policy and Human approval create a temporary capability lease.

## Objects

### PrivilegeRequest

```yaml
request_id: unique
node_id: target node
agent_id: requester
intent: human-readable goal
operations:
  - typed.operation.name
risk: low|medium|high
requested_ttl: duration
rollback_plan: reference
```

### PrivilegeLease

```yaml
lease_id: unique
request_id: source request
node_id: target node
allowed_operations:
  - typed.operation.name
scope:
  paths: []
  resources: []
expires_at: timestamp
approved_by:
  type: human|policy
```

### PrivilegeReceipt

Every privileged operation must emit:

```yaml
receipt_id: unique
lease_id: source lease
operation: typed operation
executor: helper identity
result: success|failure|rollback_required
before_state: reference
after_state: reference
```

## Node contract

Preferred node layout:

```
Agent Runtime
    |
    | local IPC
    v
Privilege Helper
    |
    v
OS privileged APIs
```

The Agent never receives a permanent root credential.

## Human Gate

Human approves intent:

- why elevation is needed;
- target node;
- operations;
- scope;
- duration;
- rollback behavior.

Human does not approve opaque shell access.

## Security invariants

- no recurring password entry after enrollment;
- no root SSH key distribution;
- no Builder/session/chat custody of privileged secrets;
- capability does not imply unrestricted authority;
- all privileged actions are auditable and reversible where possible.

## v0 implementation order

1. request schema
2. lease schema
3. helper IPC contract
4. approval surface
5. receipt ledger
6. negative authority tests
7. first consumer: ThinkPad private Fleet deployment
