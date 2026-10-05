# Privilege Helper IPC v0 Contract

## Status

Draft architecture contract. No production mutation authority.

## Purpose

Privilege Broker does not grant Agent a root shell. The node-side helper is the only component allowed to cross the OS privilege boundary.

```
Agent Runtime
    |
    | local authenticated IPC
    v
Privilege Helper
    |
    v
OS privileged API
```

## Request model

The helper receives a typed operation, never an arbitrary shell command.

```yaml
request_id: unique
lease_id: approved privilege lease
operation: typed.operation.name
target_resource: exact resource
parameters: validated operation parameters
nonce: unique execution nonce
```

## Helper validation

Before execution the helper MUST verify:

- lease exists;
- lease is unexpired;
- operation is included in allowed_operations;
- target resource matches scope;
- parameters pass operation schema;
- replay nonce has not been consumed.

Failure produces a rejection receipt. No partial execution.

## Forbidden interface

The v0 helper MUST NOT expose:

- arbitrary shell execution;
- unrestricted sudo;
- root SSH access;
- credential export;
- file browser over privileged paths.

## Receipt

Every accepted or rejected request emits:

```yaml
receipt_id: unique
request_id: source request
lease_id: source lease
operation: typed operation
result: accepted|rejected|failed|success
changed_resources: []
rollback_reference: optional
```

## First consumer

ThinkPad private Fleet deployment is the first consumer candidate. It must consume this contract rather than creating a node-specific privileged path.
