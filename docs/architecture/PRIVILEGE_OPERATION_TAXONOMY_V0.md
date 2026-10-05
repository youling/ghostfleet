# Privilege Operation Taxonomy v0

## Purpose

Define the first classification layer between Agent intent and privileged execution.

The system does not grant root. It grants typed operations through a bounded privilege lease.

## Operation classes

### LOW — observation only

Examples:

- node.inspect
- system.info.read
- service.status.read
- storage.status.read
- network.status.read

Default:
- automatic policy approval allowed
- no privilege lease required where local agent permissions already cover the action

### MEDIUM — reversible state change

Examples:

- service.restart
- cache.cleanup
- mount.attach
- config.reload

Requirements:

- exact target
- before/after state receipt
- rollback reference

### HIGH — privileged infrastructure change

Examples:

- package.install
- systemd.unit.create
- systemd.unit.enable
- firewall.rule.modify
- filesystem.mount.configure
- kernel module load

Requirements:

- explicit PrivilegeRequest
- Human or approved policy authorization
- bounded lease
- rollback plan

### CRITICAL — identity/security boundary

Examples:

- credential.rotate
- identity.authorize
- SSH authorization change
- secret materialization
- trust root change

Requirements:

- explicit Human approval
- independent review
- no automatic approval
- enhanced receipt

## Forbidden generic operations

The helper MUST reject:

- arbitrary shell execution
- unrestricted sudo
- credential export
- reading unrelated private data
- disabling security controls
- modifying identity without typed contract

## Decision rule

Agent asks:

"What typed capability do I need to complete the intent?"

It does not ask:

"How do I obtain root?"

## First consumer

ThinkPad private Fleet deployment.
