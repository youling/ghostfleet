# Chained acceptance runbook: Console launcher → published bootstrap → installer

Status: **NOT_RUN_HERE**. This runbook is executable; it has not been executed in
this workspace. Every command below is the exact command that produces the
evidence, with the expected output and the failure criterion next to it.

Why it is not run here: the chain needs a disposable root VM where a real
non-root Human account can elevate with `sudo`, the published courier can run
its package steps, and `loginctl`/user-systemd behaviour is real. The CI runner
gives us root and the reviewed installer (the `bootstrap-capability-disposable`
job), and the launcher suite gives us the elevation boundary, but the two were
never joined in one run. Faking that join with stubs would be reported as PASS
for something that never happened, so it is recorded as partial instead.

## What the chain must prove

1. The command text comes from the real `createTicketDelivery(...)`, not a
   hand-written command.
2. A real non-root Human runs it, elevates with real `sudo` (NOPASSWD), crosses
   `env -i` and reaches the published `BOOTSTRAP_SH` (not a recorder).
3. The claim is real: a local control-plane stub returns a `capability_selection`
   bound to the ticket's `template_digest`.
4. The reviewed installer runs with real artifacts and real SHA-256 checks and
   installs the real user unit plus Linger.
5. `FLEET_CONTROL_ORDINARY_USER` equals the Human; the unit and Linger belong to
   the template's `control_account`; neither is root; a second run is zero delta.

The only allowed stub is the **Tailscale provider join** (a real tailnet auth key
is an external credential). Everything else must be real.

## Step 1 — disposable VM and a Human account

```sh
# Debian/Ubuntu disposable VM, root shell.
useradd -m -s /bin/bash gfhuman
printf '%s ALL=(ALL) NOPASSWD:ALL\n' gfhuman > /etc/sudoers.d/90-gf-chain
chmod 0440 /etc/sudoers.d/90-gf-chain
visudo -cf /etc/sudoers.d/90-gf-chain          # expect: parsed OK
id -u gfhuman                                   # expect: >= 1000, not 0
```

Failure criterion: `visudo -cf` fails, or `id -u gfhuman` is 0.

## Step 2 — serve the published courier and the claim

```sh
git clone https://github.com/youling/ghostfleet.git /root/gf && cd /root/gf
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { BOOTSTRAP_SH } from "./packages/bootstrap/src/bootstrap.js";
writeFileSync("/root/gf/courier.sh", BOOTSTRAP_SH);
'
sha256sum /root/gf/courier.sh                    # record it: this is the byte identity
```

Serve `/root/gf/courier.sh` at `/v1/bootstrap.sh` and answer `<one-time URL>/claim`
with a JSON body whose `capability_selection` is the base64 selection reviewed
for the ticket (see `packages/bootstrap/test/fixtures/` for the shape). Expected:
the courier downloads the exact bytes whose SHA-256 you recorded.

Failure criterion: the served bytes differ from `courier.sh`.

## Step 3 — the real launcher text

```sh
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { createTicketDelivery } from "./src/control-plane/tickets.js";
const d = createTicketDelivery({
  record: { ticket_id: "ticket-<id>" },
  short_code: "12345678",
  public_origin: "http://127.0.0.1:<port>",
});
if (d.command.includes("ticket-<id>")) throw new Error("ticket leaked into argv");
writeFileSync("/root/gf/launcher.sh", "#!/bin/sh\n" + d.command + "\n");
'
grep -q 'TRUSTED_ID=/usr/bin/id' /root/gf/launcher.sh   # expect: match
```

Failure criterion: the ticket id appears in the command text.

## Step 4 — run it as the Human, through real sudo

```sh
printf '%s\n%s\n' 'http://127.0.0.1:<port>/v1/enrollment-tickets/ticket-<id>' '12345678' \
  | su -s /bin/sh gfhuman -c "script -qec /root/gf/launcher.sh /dev/null"
```

Expected: the courier prints `fleet-enroll: bootstrap complete for …`.

Failure criterion: any `fail closed` line, or the courier asking for credentials
after `already converged`.

## Step 5 — assertions

```sh
grep -q '"mode":"NEW"' /var/lib/fleet/capability-state.json      # expect: match
home="$(getent passwd <control_account> | cut -d: -f6)"
unit="$home/.config/systemd/user/ghostfleet-managed.service"
stat -c '%U' "$unit"          # expect: <control_account>, never the Human, never root
loginctl show-user <control_account> -p Linger   # expect: Linger=yes
grep -R 'FLEET_CONTROL_ORDINARY_USER' /var/lib/fleet  # expect: the Human name
```

Second run of the same launcher: expect
`fleet-enroll: already converged; no enrollment credentials requested`, an
unchanged unit SHA-256 and no installer `--apply` in the log.

Failure criterion: the unit belongs to the Human or root, Linger is off, the
second run re-installs anything, or the checker reports `mode=REPAIR`.

## Step 6 — provider join

The join is the one stubbed step. Two acceptable ways:

- (a) put a `tailscale` shim early in the root PATH that reports the preclaim
  state as an existing identity matching the checkpoint, so the join block is
  skipped and the capability lane runs; or
- (b) pre-seed the checkpoint and run the "already joined → converge" path.

Either way the run must print, and the PR description must repeat:
**provider join is stubbed; everything else in this chain is real.**

## Recording the result

Write to the PR:

```
CHAIN_REAL: launcher text, sudo elevation, env -i, published courier, claim, installer, unit, Linger, zero delta
CHAIN_STUB: Tailscale provider join (no tailnet credential available)
CHAIN_NOT_RUN: <step>, because <reason>
```

Do not replace a failing step with a stub and call it PASS.
