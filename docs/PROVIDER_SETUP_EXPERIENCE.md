# Provider Setup Experience v0

## Goal

GhostFleet must be usable by a first-time operator who does not understand OAuth, tags, authorities, or secret custody.

The Console should guide the user instead of requiring deployment documentation.

## User flow

```text
Open Console
  -> Setup status
  -> Missing provider capability detected
  -> Explain why capability is needed
  -> Open provider creation guide
  -> User creates provider credential
  -> User pastes credential metadata/material into secure setup flow
  -> Server validates
  -> Ready
```

## Tailscale Enrollment Authority v0

Required:

- OAuth scope: `auth_keys`
- Tag: `tag:fleet-ssh-target`

Not required:

- devices
- DNS
- ACL administration
- tailnet administration

## Security boundary

Console:

- explains state;
- collects user intent;
- never displays stored secret values;
- never decides authority.

Private authority service:

- stores provider credential;
- validates provider capability;
- mints short-lived enrollment material.

## Readiness model

User view:

```text
Tailscale
Connected
```

Operator view:

```text
provider: tailscale
authority_generation: ghostfleet-tailscale-auth-v1
scope: auth_keys
tag: tag:fleet-ssh-target
secret_state: PRESENT
```

Raw secret values are never returned.

## Acceptance

A first user should be able to:

1. Open GhostFleet Console.
2. Understand missing setup.
3. Follow provider setup guidance.
4. Complete validation.
5. Reach Ready state.
6. Continue to first device enrollment.
