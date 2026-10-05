# Privilege Policy Engine v0

## Status

Draft architecture contract. No production mutation authority.

## Purpose

The Policy Engine decides whether a PrivilegeRequest can be:

- automatically approved;
- approved by Human intent confirmation;
- rejected;
- escalated for additional review.

It evaluates requested capability, target, scope, risk and rollback availability.

## Decision model

```text
PrivilegeRequest
        |
        v
Policy Engine
        |
 +------+-------+--------+
 |      |       |        |
AUTO  HUMAN  REJECT  REVIEW
```

## Risk classes

### LOW

Examples:

- read node health;
- inspect service state;
- collect diagnostics.

Default:

```yaml
approval: policy
lease: short
```

### MEDIUM

Examples:

- restart a known service;
- attach an approved mount;
- refresh a non-secret runtime state.

Default:

```yaml
approval: human_or_policy
lease: bounded
```

### HIGH

Examples:

- install packages;
- create system services;
- modify firewall rules;
- change persistent runtime configuration.

Default:

```yaml
approval: human
lease: explicit_scope
rollback_required: true
```

### CRITICAL

Examples:

- credential rotation;
- identity changes;
- SSH authorization changes;
- secret materialization;
- security boundary changes.

Default:

```yaml
approval: human
second_confirmation: possible
rollback_required: mandatory
```

## Policy invariants

- The engine approves capabilities, never unrestricted shell access.
- A lease must contain exact operations and scope.
- Unknown operations fail closed.
- Missing rollback plan increases risk classification.
- Agent intent explanation is mandatory for Human approval.
- Approval does not transfer custody of secrets.
- Expired leases cannot be reused.

## Future UI contract

Human should see:

- target node;
- requested intent;
- operations;
- scope;
- duration;
- rollback plan;
- expected impact.

Human should not need to understand sudo, SSH keys or shell commands.

## Implementation order

1. static policy evaluator;
2. lease validation;
3. approval payload;
4. audit ledger;
5. first ThinkPad consumer.
