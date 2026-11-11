# Chained acceptance runbook: Console launcher → published bootstrap → installer

Status: **EXECUTED** by the `chain-acceptance-disposable` job in
`.github/workflows/ci.yml` on a disposable GitHub-hosted Ubuntu VM. That job
runs the chain below in one root ceremony and prints its REAL / STUB / NOT_RUN
report at the end of the job log. This document stays the executable
specification for repeating the same chain by hand; the failure criteria are the
same either way.

Why it needs a disposable VM at all: the chain needs a real non-root Human
account that can elevate with `sudo`, the published courier must run its package
steps, and `loginctl`/user-systemd behaviour must be real. The two halves are now
joined in one run instead of being reported separately. Only the Tailscale
provider join is stubbed, because a tailnet auth key is an external credential;
every other step, including every check the courier makes, runs against the real
machine.

## What the chain must prove

1. The command text comes from the real `createTicketDelivery(...)`, not a
   hand-written command.
2. A real non-root Human runs it, elevates with real `sudo` (NOPASSWD), crosses
   `env -i` and reaches the published `BOOTSTRAP_SH` (not a recorder).
3. The claim is real: a local control-plane stub returns a `capability_selection`
   bound to the ticket's `template_digest`.
4. The reviewed installer runs with real artifacts and real SHA-256 checks and
   installs the user unit plus Linger. The unit itself is a synthetic one-shot
   canary pinned by the test selection; what is real is the installation path,
   its ownership, its bytes matching the pinned artifact and its enablement.
5. `FLEET_CONTROL_ORDINARY_USER` equals the Human; the unit and Linger belong to
   the template's `control_account`; neither is root; a second run is zero delta.
6. The run account is created by the courier inside the same ceremony and is
   least privilege: `sudo -l -U <control_account>` reports no grant, its groups
   contain no root-equivalent group, and `su -s /bin/sh <control_account> -c
   'sudo -n /usr/local/libexec/youling-fleet/fleet-privctl'` fails, while the
   same command run as the privileged `ghostfleet-ops` account reaches the
   helper. `control_account` and `privileged_account` are never equal.

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

The published courier only accepts an exact `https://` ticket URL, so the origin
must be TLS even on loopback. The CI job mints a throwaway CA, installs it into
the system trust store and serves the stub with a certificate for `127.0.0.1`;
a plain `http://127.0.0.1:<port>` origin is rejected by the courier before any
effect.

Failure criterion: the served bytes differ from `courier.sh`, or the courier
stops with `invalid one-time enrollment URL` (the origin is not trusted TLS).

## Step 3 — the real launcher text

```sh
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { createTicketDelivery } from "./src/control-plane/tickets.js";
const d = createTicketDelivery({
  record: { ticket_id: "ticket-<id>" },
  short_code: "12345678",
  public_origin: "https://127.0.0.1:<port>",
});
if (d.command.includes("ticket-<id>")) throw new Error("ticket leaked into argv");
writeFileSync("/run/gf-chain/launcher.sh", "#!/bin/sh\n" + d.command + "\n", { mode: 0o755 });
'
# The Human executes this file, so it lives in a root-owned, world-readable
# directory: the Human cannot read anything under /root.
install -d -m 0755 /run/gf-chain
grep -q 'TRUSTED_ID=/usr/bin/id' /run/gf-chain/launcher.sh   # expect: match
```

Failure criterion: the ticket id appears in the command text.

## Step 4 — run it as the Human, through real sudo

```sh
printf '%s\n%s\n' 'https://127.0.0.1:<port>/v1/enrollment-tickets/ticket-<id>' '12345678' \
  | su -s /bin/sh gfhuman -c "script -qec /run/gf-chain/launcher.sh /dev/null"
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

## The CI job that runs this chain

`chain-acceptance-disposable` in `.github/workflows/ci.yml` runs
`scripts/test-chain-acceptance-disposable-linux.sh` as root on a one-use
GitHub-hosted Ubuntu VM, with the same fork protection as the other privileged
jobs. It prepares real host state before the ceremony, then runs the chain
twice (first run installs, second run must be zero delta). The preparation is
never a substitute for a courier check:

- the official Tailscale package from its own APT source, so the courier's
  package lane finds a compliant real system; the CLI is then hidden and the
  daemon stopped, so the courier still sees a fresh host, and the shim appears
  only when the courier itself starts `tailscaled`;
- a non-root `gf-review-human` account with a NOPASSWD sudo grant;
- a throwaway TLS CA and a server certificate for `127.0.0.1`, trusted by the
  system store the courier's `curl` uses;
- a local control-plane stub (`scripts/chain-acceptance-control-plane.mjs`)
  that serves the published courier bytes, verifies the short code with
  `src/control-plane/tickets.js`, and answers the claim with the reviewed
  selection bound to the ticket's `template_digest` (the digest is a synthetic
  test value: no reviewed enrollment template carries it).

The courier still probes the account, the packages, the daemon, the artifacts
and their digests, the unit and Linger itself, and the installer still runs its
own `--check`/`--apply` with real SHA-256 verification. Before the first real
claim the job also submits one wrong eight-digit short code and requires HTTP
403 with no claim consumed, so both sides of `verifyTicketClaim` are exercised.

The successful job does not just print the report: it first prints one
`EVIDENCE` line per measured fact (launcher SHA-256 and its `env -i` line, the
live `sudo` parent and the post-`env -i` environment of its child, the claim
verdict and both digests, the installer/unit/helper SHA-256s, `stat` and
`loginctl` output, the claim/apply counters and the before/after SHA-256s of the
four durable files), and the `REAL` line is assembled from those values. The
courier bytes are checked three ways: what the launcher's own `curl` wrote, what
the stub sent, and a fresh module import in a new process.

```
REAL: <each step that really ran>
STUB: tailscale-join
NOT_RUN: <each step that did not run, with the reason>
```

## Recording the result

Quote the job's own three lines in the PR. The `NOT_RUN` section of the current
job lists the real Tailscale provider join and tailnet reachability (no tailnet
credential), a hosted GhostFleet control plane (the claim server is local), and
OMV8 appliance SSH admission/OMV Linger (not an OMV appliance).

For a manual run, the equivalent record is:

```
CHAIN_REAL: launcher text, sudo elevation, env -i, published courier, claim, installer, unit, Linger, zero delta
CHAIN_STUB: Tailscale provider join (no tailnet credential available)
CHAIN_NOT_RUN: <step>, because <reason>
```

Do not replace a failing step with a stub and call it PASS.
