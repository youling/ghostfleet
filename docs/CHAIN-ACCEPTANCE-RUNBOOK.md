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
   bound to the ticket's `template_digest`; the selection carries content
   addresses (`name|sha256|mode`), not inline bytes.
4. The bootstrap and every artifact come from a real content-addressed HTTP
   origin (`/sha256/<digest>`), and the launcher refuses to execute anything
   whose bytes do not match the pinned digest.
5. The reviewed installer runs with real artifacts and real SHA-256 checks and
   installs the user unit plus Linger. The unit itself is a synthetic one-shot
   canary pinned by the test selection; what is real is the installation path,
   its ownership, its bytes matching the pinned artifact and its enablement.
6. `FLEET_CONTROL_ORDINARY_USER` equals the Human; the unit and Linger belong to
   the template's `control_account`; neither is root; a second run is zero delta.
6. The run account is created by the courier inside the same ceremony and is
   least privilege: `sudo -l -U <control_account>` reports no grant, its groups
   contain no root-equivalent group, and `su -s /bin/sh <control_account> -c
   'sudo -n /usr/local/libexec/youling-fleet/fleet-privctl'` fails, while the
   same command run as the privileged `ghostfleet-ops` account reaches the
   helper. `control_account` and `privileged_account` are never equal.

The only allowed stub is the **Tailscale provider join** (a real tailnet auth key
is an external credential). Everything else must be real.

## v1 selections are not migrated

A v1 selection (`ghostfleet-selected-capability/v1`) put the managed unit and Linger
inside the privileged operations account. The courier refuses such a selection, and
it refuses to install the v2 lane beside the residue:

```sh
getent passwd ghostfleet-ops | cut -d: -f6          # the privileged home
ls -l  "<privileged home>/.config/systemd/user/ghostfleet-managed.service"
ls -l  "<privileged home>/.config/systemd/user/default.target.wants/ghostfleet-managed.service"
loginctl show-user ghostfleet-ops -p Linger          # expect Linger=no on a v1-free node
```

Decommission the old lane before rendering a v2 selection:

```sh
sudo -iu ghostfleet-ops systemctl --user disable --now ghostfleet-managed.service
sudo -iu ghostfleet-ops systemctl --user is-active ghostfleet-managed.service   # expect inactive or failed
pgrep -u ghostfleet-ops -f '<ExecStart binary>'                                  # expect no output
rm -f "<privileged home>/.config/systemd/user/default.target.wants/ghostfleet-managed.service"
rm -f "<privileged home>/.config/systemd/user/ghostfleet-managed.service"
loginctl disable-linger ghostfleet-ops
# the v1 record would otherwise block the next claim at the schema gate
rm -f /var/lib/fleet/capability-selection.txt
```

The courier removes a stale v1 record by itself when the lane it describes is
already gone, but the manual path must do the same or the next claim is refused
with `[CAPABILITY_SCHEMA_V1_UNPROVEN]`.

The courier deletes that lane itself only in one narrow case: this run restored
its selection **from this node's own record** (`/var/lib/fleet/capability-selection.txt`,
no rendered payload was delivered) and the record names the privileged account as
the unit owner. Even then it verifies the bytes first — the unit must hash to the
pinned artifact digest and the enablement link must point at that unit — and it
removes the record in the same step so the next authorized claim can deliver the
v2 selection. A delivered payload that merely finds the file never authorises a
delete: the residue is reported and left in place. A *running* instance is not
stopped by the courier; stop it in that account's session
(`sudo -iu <account> systemctl --user disable --now <unit>`) before removing the
files by hand.

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

Serve `/root/gf/courier.sh` at `/sha256/<digest>` (the digest you just recorded)
and every pinned artifact at its own `/sha256/<artifact digest>`. Answer
`<one-time URL>/claim` with a JSON body whose `capability_selection` is the
base64 selection reviewed for the ticket (see `packages/bootstrap/test/fixtures/`
for the shape); the selection carries `name|sha256|mode` rows only. Expected: the
courier fetches the exact bytes whose SHA-256 the claim pinned and installs
nothing whose digest differs.

The stub needs two distinguishable origins. The CI job mints a throwaway CA,
installs it into the system trust store and serves one HTTPS listener with a
certificate for both `127.0.0.1` and `localhost`: the asset origin is
`https://127.0.0.1:<port>` and the enrollment origin is
`https://localhost:<port>`. The published courier only accepts an exact
`https://` ticket URL, and `createTicketDelivery` refuses to collapse both
surfaces onto one origin.

Failure criterion: the served bytes differ from `courier.sh`, or the courier
stops with `invalid one-time enrollment URL` (the origin is not trusted TLS).

## Step 3 — the real launcher text

```sh
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { createTicketDelivery } from "./src/control-plane/tickets.js";
const d = createTicketDelivery({
  ticket_id: "ticket-<id>",
  short_code: "12345678",
  assets_origin: "https://127.0.0.1:<port>",
  enroll_origin: "https://localhost:<port>",
  bootstrap_sha256: "<sha256sum of courier.sh>",
});
if (d.command.includes("ticket-<id>")) throw new Error("ticket leaked into argv");
writeFileSync("/run/gf-chain/launcher.sh", "#!/bin/sh\n" + d.command + "\n", { mode: 0o755 });
'
# The Human executes this file, so it lives in a root-owned, world-readable
# directory: the Human cannot read anything under /root.
install -d -m 0755 /run/gf-chain
grep -q 'TRUSTED_ID=/usr/bin/id' /run/gf-chain/launcher.sh   # expect: match
grep -q -- '--max-redirs 0' /run/gf-chain/launcher.sh       # expect: match
grep -q 'sha256sum "$BOOTSTRAP"' /run/gf-chain/launcher.sh  # expect: match
grep -q '<assets origin>/sha256/<digest>' /run/gf-chain/launcher.sh  # expect: match
```

Failure criterion: the ticket id appears in the command text.

## Step 4 — run it as the Human, through real sudo

```sh
printf '%s\n%s\n' 'https://localhost:<port>/v1/enrollment-tickets/ticket-<id>' '12345678' \
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

## The node agent lifecycle job

`node-agent-disposable` in `.github/workflows/ci.yml` runs
`scripts/test-node-agent-lifecycle-disposable-linux.sh` as root on a one-use
GitHub-hosted Ubuntu VM, with the same fork protection and
`RUNNER_ENVIRONMENT=github-hosted` gate as the other privileged jobs.

The script builds the artifacts the courier is supposed to install instead of
trusting a checked-in copy: it discovers the agent's build entry, builds the
zipapp twice and requires byte equality, then asserts the pinned systemd user
unit against `docs/architecture/NODE_AGENT_V0.md` section 8 (no shell, no
`curl`/`wget`, no `/bin/sh`, writes only under `%h`,
`ProtectHome=read-only` present and `read-write` absent, `ExecStart`
path character-equal to the install path, `StateDirectory` and
`ConfigurationDirectory` covering the two `ReadWritePaths`), and runs
`python3 -I <pyz> check-config` against both the missing-configuration and
the installed-configuration shapes.

The control plane it talks to is not a stub of the protocol: the script starts
`scripts/node-agent-acceptance-control-plane.mjs`, which imports
`src/control-plane/{http,store,controller,node-agent}.js` from the checkout
and serves the repository's own `createHttpHandler` over a loopback HTTPS
listener with a throwaway CA. Only the enrollment is synthetic: a node fixture
is minted through the real `createEnrollmentAttempt` / `prepareEnrollmentAttempt`
/ `claimEnrollmentAttempt` / `startMaterialization` sequence and gets a
credential from the real `mintNodeCredential`, so the three node routes run
their real verification order (body caps, content type, token digest in
constant time, lifecycle, clock window, nonce ring, rate limit). The harness
refuses to start when any of those modules or exports is missing, and the
script proves that refusal in a separate arm.

What the job proves, measured on the host rather than read off a config:

- the artifact is built deterministically and installed `root:root 0755` at
  the path `ExecStart` names;
- a real non-root control account with no login session runs the agent under
  `loginctl enable-linger`, with `ActiveState=active`,
  `SubState=running`, a live `MainPID` owned by that account, and new
  observations across more than two heartbeat intervals;
- the unit is not vacuous: a copy without `StateDirectory` and
  `ConfigurationDirectory` fails to start when the directories are missing
  (`status=226/NAMESPACE`), while the shipped unit self-heals by recreating
  them, so both arms are recorded;
- boot and session recovery: after `loginctl terminate-user` and a
  user-manager restart, with no session and no login, the service returns to
  `active`;
- failure recovery: `kill -9` increments `NRestarts` by exactly one and
  the agent returns active; `SIGTERM` exits `0` and does not restart
  across more than two `RestartSec` windows;
- continuous work: operator-created `node.observe` and
  `service.status.read` tasks complete through the real routes, and two
  `node.observe` results differ over time, so nothing is replaying a fixed
  payload;
- identity and authority: `sudo -n true` fails for the control account, it
  holds no privileged group, and a privileged helper probe rejects it with a
  dedicated-caller code while accepting root;
- task safety: nonce replay is `409 NODE_NONCE_REPLAY`, a duplicate result
  is idempotent, a conflicting result is `409 TASK_RESULT_CONFLICT`,
  `node.exec` and forbidden parameter keys are rejected, a wrongly shaped
  request is refused at submission rather than by the agent (a string `want`,
  a too-short nonce and an illegal task id are all 400 with a task-request
  code, and nothing is queued), and a task left at
  `MAY_HAVE_EXECUTED` by a crash is reported as `UNKNOWN` exactly once
  and never re-run;
- an independent read-only consumer, holding a token that is neither the
  operator's nor the node's, reads the node projection (agent health, version,
  last heartbeat) and the task timeline through the product routes, cannot
  create tasks, and receives no credential or token field.

What the job does not prove: a real tailnet and the operator hop over it (the
listener is loopback only), a real Cloudflare deployment of the bridge, real
OMV8 hardware with its disks and units, real PAM `su`/`sudo`
interaction (the control account has a `nologin` shell), a real machine
reboot, credential rotation, and multi-node lease races. Two seams are
acceptance-only: the operator/observer bearer split lives in the harness because
`src/control-plane/http.js` deliberately owns no transport auth, and the node
fixture is synthetic (it is admitted through the real controller calls but has
no enrollment ticket and no public bridge). The `ActiveState` the timeline
carries is the agent's own `service.status.read` observation, not a
control-plane measurement.

Two install-line facts this job refuses to fake. First, the capability
projection at `/etc/ghostfleet/capability-status.json` must be produced by
calling the product entrypoint `scripts/emit-capability-status.mjs`; if that
entrypoint is missing the job stops with
`INSTALL_LINE_MISSING_CAPABILITY_STATUS_ENTRYPOINT` instead of writing the JSON
itself, because a hand-written projection only proves the script can write JSON.
The emitter takes paired arguments (`--artifact name=sha256:<64 hex>:<octal
mode>` per pinned row, `--template-digest`, `--installer`, `--privileged-key`,
`--unit`, `--unit-artifact`, `--payload-artifact`, `--control-account`,
`--privileged-account`, `--output`, `--payload-path`), and a legitimate
projection pins rows this lifecycle job does not install (the privileged helper
`fleet_privctl.py`, the release `privileged-ops.pub` key and the reviewed
installer script) plus a real template digest. So the job calls the real CLI
with only the two rows it owns (the unit and the payload) and requires exit
`2` with `EMIT_CAPABILITY_STATUS_INPUT_INVALID`, which proves the product
writer refuses a partial projection; the positive projection is printed as
`NOT_RUN` with that reason rather than faked. Second, the unit asset must carry
`ConfigurationDirectoryMode=0700` and `StateDirectoryMode=0700`; the job fails
closed when either line is absent, since the systemd defaults (`0755`) leave the
agent configuration and state directories readable beyond the control account.

The job also records the mount-hardening facts a naive agent gets wrong: the
unit runs in an implicit `PrivateUsers` namespace (`/proc/<pid>/uid_map` is the
single self-mapping of the control account), the host configuration appears
inside that namespace as the overflow uid at mode `0644`, `/` is mounted
read-only, and the unit still reaches `READY` under `Type=notify` with a first
heartbeat. The namespace values are measured from inside it with
`nsenter -t <MainPID> -U -m --preserve-credentials`, not by statting
`/proc/<pid>/root`: a host-side `stat` reports the uid the reader resolves, and
`nsenter` without `--preserve-credentials` fails with `setgid failed: Invalid
argument`. A negative arm then makes the configuration unreadable for the
control account and requires the agent to exit `3` with a configuration code
instead of running degraded, and restoring the mode must return the unit to
`active`. The same namespace has no mapping for host root, so the per-account
files cannot be read with `--preserve-credentials`; the job measures them as the
service uid instead (`nsenter -t <MainPID> -U -m --setuid <uid> --setgid <gid> --
stat`) and requires the token at `0600` and the state directory at `0700`, both
owned by the service uid, and requires the `--preserve-credentials` read of the
account home to be refused. Arms that only ran against a fixture payload (any
build entry other than `packages/node-agent/tools/build_pyz.py`) are printed as
`STUB` and are never counted as product evidence.

One arm exists because the protocol once got it wrong: a node whose capability
projection has not been materialized yet legitimately reports
`capability_digest: null`, so with no `capability-status.json` in place the
heartbeat must still be accepted. The job asserts the unit journal contains no
`NODE_REQUEST_INVALID` and that the control plane projects
`capability_digest` as `null`; when the plane refused the explicit null every
heartbeat was rejected and no later arm was measurable.

Two more arms cover the ways a systemd agent fails without ever reporting it.
The offline arm points `control_plane_origin` at an unreachable origin,
restarts the unit, samples `ActiveState` every ten seconds for four minutes and
requires every sample to be `active`, `NRestarts` unchanged,
`ActiveEnterTimestamp` unchanged, `WatchdogTimestamp` advancing, and no
`Watchdog timeout`, `watchdog` result or `SIGABRT` in the journal; a broken
agent under `WatchdogSec=60` is killed and restarted in a loop there, which is
why the arm measures restarts instead of trusting the unit text. It then
restores the configuration and requires a fresh heartbeat, so a passing offline
arm cannot be a dead agent. The notification arm counts
`reception only permitted for main PID` in the unit journal and requires zero:
`NOTIFY_SOCKET` must be cleared for child processes, because libsystemd tools
such as `systemctl` and `systemd-analyze` send `EXIT_STATUS=0` at exit and would
otherwise masquerade as the agent. The helpers that talk to the user manager run
with `env -u DBUS_SESSION_BUS_ADDRESS -u DBUS_SYSTEM_BUS_ADDRESS`, since a
superuser environment leaks a root session bus path and makes `systemctl --user`
fail with `Failed to connect to bus: Permission denied`.
The job needs an exclusive machine. It creates and deletes
`ghostfleet-managed`/`ghostfleet-ops`, `/etc/ghostfleet`,
`/usr/local/libexec/ghostfleet`, a trusted CA and a lingering user manager, so
a second acceptance run on the same box will collide with it on every one of
those paths: shared hosts and shared WSL distros produce false red (measured:
another disposable run deleting `/usr/local/libexec/ghostfleet` mid-flight
turned a healthy agent into a restart loop; the script watches `ActiveState` while it
waits for a heartbeat and fails with `ENVIRONMENT_INTERFERENCE` naming the stopped unit
instead of timing out). Use a one-use VM or a dedicated
distro. It also needs node 19 or newer (the control-plane modules use the global
Web Crypto object; CI pins node 22) and refuses to start otherwise instead of
failing later with a module error.

The job prints `OK <n>: <fact>` for every assertion and
`EVIDENCE <key>=<value>` for every measured value, then a
`REAL`/`STUB`/`NOT_RUN` block assembled from those measured values.
Quote that block in the PR.
