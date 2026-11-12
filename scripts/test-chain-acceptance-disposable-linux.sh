#!/usr/bin/env bash
# Chained acceptance on a disposable GitHub-hosted Ubuntu VM.
#
# One root ceremony, joined end to end:
#   real createTicketDelivery command text
#   -> real non-root Human (gf-review-human) with NOPASSWD sudo
#   -> real sudo -> real env -i -> the published BOOTSTRAP_SH over TLS
#   -> real claim POST (short code verified by the real control-plane module)
#   -> real reviewed privileged-operations installer with real SHA-256 checks
#   -> real completion POST, whose response carries the one-time node credential
#   -> only then the deferred lane: pinned payload, managed user unit, Linger
#   -> second run of the same launcher is zero delta.
#
# A second, negative arm answers the same flow with a completion response that
# carries no node credential and proves the courier fails closed with
# CAPABILITY_NODE_CREDENTIAL_MISSING before installing the payload, the unit,
# Linger, the public projection or the agent configuration.
#
# The only stubbed step is the Tailscale provider join, which needs a real
# tailnet credential. Every host fact the courier checks is real: the
# provisioning below happens BEFORE the ceremony and never replaces a courier
# check with a recorded result. GitHub-hosted ephemeral VM ONLY: no Fleet/NAS,
# no production node, no credentials.
#
# The successful path prints an EVIDENCE block with the measured values behind
# every assertion, then the REAL / STUB / NOT_RUN report built from them.
set -Eeuo pipefail
IFS=$'\n\t'

if [[ "$(id -u)" -ne 0 || "${GITHUB_ACTIONS:-}" != true ||
      "${RUNNER_ENVIRONMENT:-}" != github-hosted ||
      "${GHOSTFLEET_DISPOSABLE_TEST_CONFIRMED:-}" != 1 ||
      -z "${GITHUB_WORKSPACE:-}" ]]; then
  echo "DENIED: disposable GitHub-hosted root runner required" >&2
  exit 3
fi
if [[ -d /etc/openmediavault || -e /etc/openmediavault/config.xml ]]; then
  echo "DENIED: an OpenMediaVault appliance must not be the disposable target" >&2
  exit 3
fi

workspace="$GITHUB_WORKSPACE"
human=gf-review-human
control_account=ghostfleet-managed
privileged_account=ghostfleet-ops
short_code=41832576
# The negative arm uses its own ticket on its own stub instance; the codes only
# have to be distinct because each stub verifies exactly one ticket.
negative_short_code=41832577
node_id="gf-chain-$(openssl rand -hex 4)"
installer_state=/etc/youling-fleet/privileged-operations/control.json
capability_state=/var/lib/fleet/capability-state.json
unit_name=ghostfleet-managed.service

work="$(mktemp -d)"
run_dir=/run/gf-chain
server_pid=
negative_server_pid=
install -d -m 0700 -o root -g root "$work"
install -d -m 0755 -o root -g root "$run_dir" "$run_dir/poison"

section() { printf '\n=== %s ===\n' "$*"; }
fail_check() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
record_ok() { printf 'OK   %s\n' "$*"; }
evidence() { printf 'EVIDENCE %s\n' "$*"; }
assert_eq() {
  if [[ "$2" = "$3" ]]; then record_ok "$1 = $3"; else fail_check "$1: expected [$2], got [$3]"; fi
}
assert_contains() {
  [[ -r "$3" ]] || fail_check "$1: evidence file $3 is missing"
  if grep -Fq -- "$2" "$3"; then record_ok "$1: found [$2] in $3"; else fail_check "$1: [$2] not found in $3"; fi
}
assert_absent() {
  [[ -r "$3" ]] || fail_check "$1: evidence file $3 is missing"
  if grep -Fq -- "$2" "$3"; then fail_check "$1: [$2] unexpectedly present in $3"; fi
  record_ok "$1: [$2] absent from $3"
}
json_value() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)
PY
}

# The launcher's private /run workspace is removed by its own cleanup; clear any
# leftover from a failed attempt so each capture sees only this run's download.
clear_launcher_workspace() { rm -rf /run/ghostfleet-enroll.* 2>/dev/null || true; }

# Capture the exact bytes the launcher's own curl wrote. The file appears while
# curl streams it; wait for a stable size, copy, and verify the copy is complete.
capture_courier_download() {
  local tag="$1" deadline=$((SECONDS + 90)) directory candidate size previous=0 target
  target="$work/downloaded-bootstrap-$tag.sh"
  while (( SECONDS < deadline )); do
    candidate=
    for directory in /run/ghostfleet-enroll.*; do
      [[ -d "$directory" && -s "$directory/bootstrap.sh" ]] || continue
      candidate="$directory/bootstrap.sh"
      break
    done
    if [[ -n "$candidate" ]]; then
      size="$(stat -c %s "$candidate" 2>/dev/null || printf '0')"
      if [[ "$size" -gt 0 && "$size" = "$previous" ]]; then
        if cp -- "$candidate" "$target" 2>/dev/null &&
           [[ "$(stat -c %s "$target" 2>/dev/null || printf '0')" = "$size" ]]; then
          return 0
        fi
      fi
      previous="$size"
    fi
    sleep 0.1
  done
  return 1
}

# Capture the live process tree of the elevation: the sudo process (its environ
# is the caller's poisoned environment) and its child, the root /bin/sh started
# by env -i (its environ is the post-env -i environment, its argv carries the
# Human identity handed over as $1).
capture_elevation() {
  local tag="$1" deadline=$((SECONDS + 30)) candidate other pid child
  while (( SECONDS < deadline )); do
    for candidate in /proc/[0-9]*; do
      pid="${candidate##*/}"
      [[ -r "$candidate/comm" ]] || continue
      [[ "$(cat "$candidate/comm" 2>/dev/null)" = sudo ]] || continue
      grep -qa -- 'ghostfleet-enroll' "$candidate/cmdline" 2>/dev/null || continue
      child=
      for other in /proc/[0-9]*; do
        [[ "$(awk '/^PPid:/{print $2}' "$other/status" 2>/dev/null)" = "$pid" ]] || continue
        child="${other##*/}"
        break
      done
      [[ -n "$child" ]] || continue
      # Skip the momentary /usr/bin/env process: only the /bin/sh it execs has
      # the post-env -i environment we want to record.
      [[ "$(cat "/proc/$child/comm" 2>/dev/null)" = sh ]] || continue
      tr '\0' '\n' <"$candidate/environ" 2>/dev/null >"$work/caller-environ-$tag.txt" || true
      tr '\0' '\n' <"/proc/$child/environ" 2>/dev/null >"$work/elevated-environ-$tag.txt" || true
      tr '\0' '\n' <"/proc/$child/cmdline" 2>/dev/null >"$work/elevated-argv-$tag.txt" || true
      cat "$candidate/comm" >"$work/elevated-parent-$tag.txt" 2>/dev/null || true
      readlink -f "$candidate/exe" >"$work/elevated-parent-exe-$tag.txt" 2>/dev/null || true
      return 0
    done
    sleep 0.1
  done
  return 1
}

cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "${negative_server_pid:-}" ]]; then
    kill "$negative_server_pid" 2>/dev/null || true
    wait "$negative_server_pid" 2>/dev/null || true
  fi
  if [[ "$status" -ne 0 ]]; then
    printf '\nCHAIN FAILED (status %s); keeping the evidence below\n' "$status" >&2
    for file in "$work/server.log" "$work/negative/server.log" "$work/negative/run.log" "$work/run-1.log" "$work/run-2.log"; do
      [[ -r "$file" ]] || continue
      printf -- '--- %s (tail) ---\n' "$file" >&2
      tail -n 120 "$file" >&2 || true
    done
  fi
  if [[ "${GHOSTFLEET_CHAIN_KEEP_WORK:-0}" = 1 ]]; then
    printf 'kept: %s\n' "$work" >&2
  else
    rm -rf "$work"
  fi
  exit "$status"
}
trap cleanup EXIT

section "setup: disposable host provisioning (never substitutes for a courier check)"
for tool in node openssl curl sha256sum su sudo script ssh-keygen visudo useradd loginctl getent install dpkg-query python3 readlink; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 3; }
done
# Real host identity evidence for the courier's phase 0.
if ! compgen -G "/etc/ssh/ssh_host_*_key.pub" >/dev/null; then ssh-keygen -A; fi
# A real non-root Human with a real NOPASSWD sudo grant.
if ! id "$human" >/dev/null 2>&1; then useradd -m -s /bin/bash "$human"; fi
human_uid="$(id -u "$human")"
[[ "$human_uid" -ne 0 && "$human_uid" -ge 1000 ]] || { echo "the Human account is not ordinary" >&2; exit 3; }
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$human" >/etc/sudoers.d/90-gf-chain-human
chmod 0440 /etc/sudoers.d/90-gf-chain-human
visudo -cf /etc/sudoers.d/90-gf-chain-human >/dev/null
# Disposable-VM hygiene: a reused worker may still carry Linger for the accounts
# this job is about to claim from an earlier run. A fresh runner has none; removing
# it here keeps the negative arm's "the courier did not enable Linger" assertion
# about this run's courier instead of a stale marker.
rm -f "/var/lib/systemd/linger/$control_account" "/var/lib/systemd/linger/$privileged_account"
# The same reuse can leave a half-removed account behind: an earlier job deleted
# only part of the identity (or userdel -r skipped the account because a process
# still ran) while the home directory it owns was already removed. This job then
# starts from an account row the reviewed installer will never recreate, and the
# negative arm would fail for a host-hygiene reason instead of the missing
# credential. Remove both managed identities completely before either arm runs.
for stale_account in "$control_account" "$privileged_account"; do
  pkill -9 -u "$stale_account" >/dev/null 2>&1 || true
  userdel -f -r "$stale_account" >/dev/null 2>&1 || true
  rm -rf "/home/$stale_account" "/var/lib/$stale_account"
  if id "$stale_account" >/dev/null 2>&1; then
    echo "cannot clear the stale $stale_account identity on this disposable host" >&2
    exit 3
  fi
done
# The real Tailscale package, from its official origin, so the courier's own
# apt/systemctl lane finds a compliant, real system state.
if ! dpkg-query -W -f='${Status}' tailscale 2>/dev/null | grep -qx 'install ok installed'; then
  . /etc/os-release
  codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  curl -fsSL "https://pkgs.tailscale.com/stable/$ID/$codename.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/$ID/$codename.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tailscale
fi
# The provider join is the one stubbed step. The courier must observe a FRESH
# host before its package lane, so the CLI is absent and no daemon state
# survives here; the shim appears only when the courier itself starts
# tailscaled, and it reports the identity the local control-plane stub issued.
# The stub is re-installed for every arm because each arm pins a different
# node id, and a stale identity would be refused as a foreign host.
install_tailscale_stub() {
  local stub_node_id="$1"
  systemctl stop tailscaled 2>/dev/null || true
  rm -f /var/lib/tailscale/tailscaled.state /usr/sbin/tailscale
  if [[ -e /usr/bin/tailscale && ! -e /usr/bin/tailscale.real ]]; then mv -f /usr/bin/tailscale /usr/bin/tailscale.real; fi
  install -d -m 0755 /usr/local/lib/gf-chain
  cat >/usr/local/lib/gf-chain/tailscale-stub <<STUB
#!/bin/sh
# Disposable acceptance stub: the Tailscale provider join is the only stubbed
# step of this chain (it needs a real tailnet credential). It reports the
# identity the local control-plane stub already issued for this run, so the
# courier's join block is skipped and the capability lane runs.
NODE_ID='$stub_node_id'
case "\${1:-}" in
  status)
    printf '{"BackendState":"Running","Self":{"HostName":"%s","DNSName":"%s.gf-chain.invalid.","OS":"linux"},"Version":"1.104.6-stub"}\n' "\$NODE_ID" "\$NODE_ID"
    ;;
  up)
    printf '%s\n' 'gf-chain: the provider join is stubbed on this disposable VM; the courier must skip it' >&2
    exit 1
    ;;
  *)
    printf '%s\n' "gf-chain: unsupported tailscale invocation: \$*" >&2
    exit 1
    ;;
esac
STUB
  chmod 0755 /usr/local/lib/gf-chain/tailscale-stub
  install -d -m 0755 /etc/systemd/system/tailscaled.service.d
  cat >/etc/systemd/system/tailscaled.service.d/50-gf-chain-shim.conf <<'CONF'
[Service]
ExecStartPost=/usr/bin/install -m 0755 /usr/local/lib/gf-chain/tailscale-stub /usr/sbin/tailscale
CONF
  systemctl daemon-reload
}
install_tailscale_stub "$node_id"
# A local TLS identity for the control-plane stub, trusted by the real curl the
# courier runs (the published courier only accepts an exact HTTPS ticket URL).
openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -keyout "$work/ca.key" -out "$work/ca.crt" \
  -subj "/CN=GhostFleet disposable chained acceptance CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$work/server.key" -out "$work/server.csr" \
  -subj "/CN=gf-chain-local" >/dev/null 2>&1
cat >"$work/server.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:localhost
EXT
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" \
  -CAcreateserial -days 2 -sha256 -extfile "$work/server.ext" -out "$work/server.crt" >/dev/null 2>&1
install -m 0644 "$work/ca.crt" /usr/local/share/ca-certificates/gf-chain-acceptance.crt
if ! update-ca-certificates >"$work/ca-update.log" 2>&1; then
  cat "$work/ca-update.log" >&2
  echo "the local control-plane CA could not be trusted" >&2
  exit 1
fi
# The Human's environment is poisoned before elevation: nothing a caller puts
# on PATH or in TMPDIR may run as root, and the caller's name may not decide
# which Human the installer records.
printf '#!/bin/sh\ntouch %s\nexit 0\n' "$work/poison-sh-ran" >"$run_dir/poison/sh"
printf '#!/bin/sh\ntouch %s\nexit 0\n' "$work/poison-curl-ran" >"$run_dir/poison/curl"
chmod 0755 "$run_dir/poison/sh" "$run_dir/poison/curl"
poison_tmp="$work/poison-tmp"
install -d -m 0700 -o root -g root "$poison_tmp"

section "setup: synthetic privileged operations key"
ssh-keygen -q -t ed25519 -N '' -C 'synthetic-chained-acceptance' -f "$work/privileged-ops"

run_launcher_with() {
  local launcher_path="$1" log="$2" input="$3" rc=0
  set +e
  su -s /bin/sh "$human" -c "export PATH='$run_dir/poison':\$PATH; export GHOSTFLEET_POISON=caller-poison; export GHOSTFLEET_OPERATING_USER=root; export TMPDIR='$poison_tmp'; script -qec '$launcher_path' /dev/null" <"$input" >"$log" 2>&1
  rc=$?
  set -e
  return "$rc"
}
run_launcher() { run_launcher_with "$launcher" "$1" "$2"; }

# Everything the failing negative ceremony created is removed before the positive
# ceremony. This is disposable-VM test hygiene, not a product rollback: the courier
# is expected to leave a prepared helper lane when the control plane cannot deliver
# a credential, and the next authorized Console command has to start from a host
# that never held a managed lane.
reset_negative_lane() {
  systemctl stop tailscaled 2>/dev/null || true
  rm -f /var/lib/tailscale/tailscaled.state /usr/sbin/tailscale
  rm -rf /var/lib/tailscale /var/lib/fleet /run/fleet
  rm -rf /etc/youling-fleet /usr/local/libexec/youling-fleet
  rm -f /etc/sudoers.d/90-youling-fleet-privileged-operations
  userdel -r ghostfleet-managed >/dev/null 2>&1 || true
  userdel -r ghostfleet-ops >/dev/null 2>&1 || true
  # The reviewed installer keeps the privileged account's key under
  # /var/lib/<account>, not under /home; userdel -r alone leaves that key behind,
  # and a stale authorized_keys is exactly the drift a REPAIR run must reconcile.
  # Removing it here keeps the positive ceremony starting from a host that never
  # held a lane, so its first run is a real NEW run.
  for account in "$control_account" "$privileged_account"; do
    account_home=$(getent passwd "$account" | cut -d: -f6)
    [ -n "$account_home" ] && rm -rf "$account_home"
    rm -rf "/var/lib/$account"
    rm -f "/var/lib/systemd/linger/$account"
  done
  systemctl daemon-reload 2>/dev/null || true
}

section "negative arm: a completion response without a node credential fails closed"
negative_node_id="gf-chain-negative-$(openssl rand -hex 3)"
negative_work="$work/negative"
install -d -m 0700 -o root -g root "$negative_work"
node "$workspace/scripts/chain-acceptance-control-plane.mjs" \
  --work "$negative_work" \
  --cert "$work/server.crt" \
  --key "$work/server.key" \
  --privileged-key "$work/privileged-ops.pub" \
  --node-id "$negative_node_id" \
  --short-code "$negative_short_code" \
  --omit-node-credential 1 >"$negative_work/server.log" 2>&1 &
negative_server_pid=$!
for _ in $(seq 1 240); do
  [[ -f "$negative_work/ready" ]] && break
  sleep 0.5
done
[[ -f "$negative_work/ready" ]] || { echo "the negative control-plane stub did not become ready" >&2; cat "$negative_work/server.log" >&2; exit 1; }
# shellcheck disable=SC1091
. "$negative_work/facts.sh"
install -m 0755 "$negative_work/launcher.sh" "$run_dir/launcher-negative.sh"
negative_launcher="$run_dir/launcher-negative.sh"
negative_url="$ORIGIN/v1/enrollment-tickets/$TICKET_ID"
printf '%s\n%s\n' "$negative_url" "$negative_short_code" >"$negative_work/in"
# This arm pins its own node id, so the provider stub has to report that id.
install_tailscale_stub "$negative_node_id"
clear_launcher_workspace
if run_launcher_with "$negative_launcher" "$negative_work/run.log" "$negative_work/in"; then
  fail_check "the credential-less completion arm succeeded although no node credential was delivered"
fi
record_ok "the credential-less completion failed the ceremony"
assert_contains "the failure names the missing credential" 'CAPABILITY_NODE_CREDENTIAL_MISSING' "$negative_work/run.log"
assert_contains "the failure names the deferred artifacts" 'the agent payload and the user unit were not installed, nothing was enabled and Linger was not enabled' "$negative_work/run.log"
negative_control_home="$(getent passwd "$control_account" | cut -d: -f6)"
[[ -n "$negative_control_home" ]] || fail_check "the negative arm never created the control account"
if [[ -e /usr/local/libexec/ghostfleet/node-agent.pyz ]]; then fail_check "the negative arm installed the agent payload"; fi
if [[ -e "$negative_control_home/.config/systemd/user/$unit_name" ]]; then fail_check "the negative arm installed the user unit"; fi
if [[ -L "$negative_control_home/.config/systemd/user/default.target.wants/$unit_name" ]]; then fail_check "the negative arm enabled the user unit"; fi
negative_linger="$(loginctl show-user "$control_account" -p Linger 2>/dev/null || true)"
[[ "$negative_linger" != "Linger=yes" ]] || fail_check "the negative arm enabled Linger"
if [[ -e /etc/ghostfleet/capability-status.json ]]; then fail_check "the negative arm wrote the public capability projection"; fi
if [[ -e /etc/ghostfleet/node-agent.json ]]; then fail_check "the negative arm wrote the agent configuration"; fi
if [[ -e "$negative_control_home/.config/ghostfleet/node-token" ]]; then fail_check "the negative arm installed a node token"; fi
record_ok "negative: no payload, no unit, no enablement link, no Linger, no projection, no token"
kill "$negative_server_pid" 2>/dev/null || true
wait "$negative_server_pid" 2>/dev/null || true
negative_server_pid=
reset_negative_lane
record_ok "the negative lane was removed; the positive ceremony starts from a clean host"
# The positive ceremony pins the positive node id again.
install_tailscale_stub "$node_id"

section "setup: local control-plane stub (server side only)"
node "$workspace/scripts/chain-acceptance-control-plane.mjs" \
  --work "$work" \
  --cert "$work/server.crt" \
  --key "$work/server.key" \
  --privileged-key "$work/privileged-ops.pub" \
  --node-id "$node_id" \
  --short-code "$short_code" >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 240); do
  [[ -f "$work/ready" ]] && break
  sleep 0.5
done
[[ -f "$work/ready" ]] || { echo "the control-plane stub did not become ready" >&2; cat "$work/server.log" >&2; exit 1; }
# shellcheck disable=SC1091
. "$work/facts.sh"
install -m 0755 "$work/launcher.sh" "$run_dir/launcher.sh"
launcher="$run_dir/launcher.sh"
url="$ORIGIN/v1/enrollment-tickets/$TICKET_ID"
printf '%s\n%s\n' "$url" "$short_code" >"$work/in-1"
printf '%s\n' "$url" >"$work/in-2"

# The published bytes, hashed by a NEW node process (not the stub's memory).
published_sha="$(cd "$workspace" && node --input-type=module -e '
import { createHash } from "node:crypto";
import { BOOTSTRAP_SH } from "./packages/bootstrap/src/index.js";
process.stdout.write(createHash("sha256").update(BOOTSTRAP_SH).digest("hex"));
')"
launcher_sha="$(sha256sum "$launcher" | cut -d ' ' -f1)"
env_i_line="$(grep -o -m1 '/usr/bin/env -i PATH=[^ ]* HOME=/root /bin/sh -c' "$launcher" || true)"
printf 'control-plane origin: %s\n' "$ORIGIN"
printf 'ticket: %s\nsynthetic test template digest: %s\nnode: %s\n' "$TICKET_ID" "$TEMPLATE_DIGEST" "$NODE_ID"

# The launcher text is the Console output; it must not carry the ticket handle
# or the short code, and it must keep the sudo branch and the env -i boundary.
assert_contains "launcher identity capture" 'TRUSTED_ID=/usr/bin/id' "$launcher"
assert_contains "launcher caller uid capture" 'if [ "$CALLER_UID" -eq 0 ]; then' "$launcher"
assert_contains "launcher sudo branch" 'elif command -v sudo >/dev/null 2>&1; then' "$launcher"
assert_contains "launcher sudo invocation" 'sudo /usr/bin/env -i PATH=' "$launcher"
assert_contains "launcher env -i boundary" '/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/sh -c' "$launcher"
assert_absent "launcher ticket leak" "$TICKET_ID" "$launcher"
assert_absent "launcher short-code leak" "$short_code" "$launcher"
# The launcher carries exactly three public coordinates: the immutable asset
# origin, the pinned bootstrap digest, and the enrollment origin of the ticket.
assert_contains "launcher pinned asset origin" "$ASSETS_ORIGIN/sha256/" "$launcher"
assert_contains "launcher pinned bootstrap digest" "$BOOTSTRAP_SHA256" "$launcher"
assert_contains "launcher pinned enrollment origin" "$ORIGIN/v1/enrollment-tickets/" "$launcher"
assert_contains "launcher disables redirects" '--max-redirs 0' "$launcher"
assert_contains "launcher verifies before execution" 'sha256sum "$BOOTSTRAP"' "$launcher"
[[ -n "$env_i_line" ]] || fail_check "the env -i invocation line could not be read from the launcher"
evidence "launcher_sha256=$launcher_sha"
evidence "launcher_env_i=$env_i_line"
evidence "launcher_sudo=$(grep -o -m1 'sudo /usr/bin/env -i PATH=[^ ]*' "$launcher")"
evidence "human=$human human_uid=$human_uid"

# The negative half of the claim protocol: the same ticket module must refuse a
# wrong short code, and the refusal must not consume the one claim.
section "negative: a wrong short code must be refused before the real claim"
negative_digest="sha256:$(printf '%064d' 0)"
negative_status="$(curl -sS -o "$work/negative-claim.json" -w '%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H 'content-type: text/plain' \
  -H 'x-fleet-os-family: debian-family' \
  -H 'x-fleet-os-id: ubuntu' \
  -H "x-ghostfleet-preflight-digest: $negative_digest" \
  --data-binary '00000000' "$url/claim")"
assert_eq "a wrong short code is refused with 403" 403 "$negative_status"
assert_contains "the refusal comes from the ticket module" 'TICKET_SHORT_CODE_INVALID' "$work/negative-claim.json"
negative_claims="$(cat "$work/claim-count")"
assert_eq "a refused claim does not consume the claim" 0 "$negative_claims"
evidence "negative_claim=http_$negative_status code=$(json_value "$work/negative-claim.json" code) claims_after=$negative_claims"

# run_launcher is defined above, next to the negative arm that also uses it.
section "run 1: the real Console launcher, the real Human, real sudo, real env -i"
clear_launcher_workspace
capture_courier_download 1 &
download_watch=$!
capture_elevation 1 &
elevation_watch=$!
if ! run_launcher "$work/run-1.log" "$work/in-1"; then
  echo "the first chained run failed" >&2
  tail -n 80 "$work/run-1.log" >&2
  exit 1
fi
wait "$download_watch" || fail_check "the courier bytes the launcher downloaded were not captured"
wait "$elevation_watch" || fail_check "the elevated sudo/env -i process was not observed"
if [[ -e "$work/poison-sh-ran" || -e "$work/poison-curl-ran" ]]; then
  fail_check "a caller-controlled binary executed during elevation"
fi
record_ok "no caller-controlled binary ran during elevation"
if [[ -n "$(ls -A "$poison_tmp")" ]]; then fail_check "the caller TMPDIR was used by the elevated script"; fi
record_ok "the caller TMPDIR stayed empty"

section "assertions: the first run really installed the selected capability"
[[ -r "$capability_state" ]] || fail_check "no capability state was written"
record_ok "capability state file exists: $capability_state"
assert_contains "capability mode" '"mode":"NEW"' "$capability_state"
assert_contains "capability template binding" "\"template_digest\":\"$TEMPLATE_DIGEST\"" "$capability_state"
recorded_selection_digest="$(json_value "$capability_state" selection_digest)"
[[ "$recorded_selection_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail_check "the recorded selection digest is malformed"
record_ok "recorded selection digest is a sha256: $recorded_selection_digest"
assert_contains "preflight ran" 'fleet-enroll: preflight PASS' "$work/run-1.log"
assert_contains "completion ran" "fleet-enroll: bootstrap complete for $NODE_ID" "$work/run-1.log"
assert_contains "apply ran" "fleet-enroll: selected capability mode=NEW" "$work/run-1.log"
assert_contains "installer apply" 'DEDICATED_PRIVILEGED_OPS_LANE_READY' "$work/run-1.log"
applies_1="$(grep -c 'DEDICATED_PRIVILEGED_OPS_LANE_READY' "$work/run-1.log" || true)"
assert_eq "installer apply count in run 1" 1 "$applies_1"

claim_receipt="$work/claim-request.json"
[[ -r "$claim_receipt" ]] || fail_check "the courier never claimed"
record_ok "claim request recorded: $claim_receipt"
assert_eq "claim os family" debian-family "$(json_value "$claim_receipt" os_family)"
# The claim must report the real host OS id, not a constant: derive it from this
# host so the assertion holds on the Ubuntu runner and on a Debian dev VM alike.
claim_expected_os_id="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')"
[[ -n "$claim_expected_os_id" ]] || fail_check "cannot read the host OS id for the claim assertion"
assert_eq "claim os id" "$claim_expected_os_id" "$(json_value "$claim_receipt" os_id)"
ticket_verification="$(json_value "$claim_receipt" ticket_verification)"
assert_eq "claim verified by the ticket module" PASSED_BY_TICKETS_MODULE "$ticket_verification"
preflight_digest="$(json_value "$claim_receipt" preflight_digest)"
[[ "$preflight_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail_check "the claim carried no real preflight digest"
record_ok "claim carried the real phase-0 digest: $preflight_digest"
claims_1="$(cat "$work/claim-count")"
assert_eq "claim count after the first run" 1 "$claims_1"
selection_artifact_rows="$(grep -c '^artifact=' "$work/claim-selection.txt")"
assert_eq "pinned artifact rows in the delivered selection" 7 "$selection_artifact_rows"
assert_eq "delivered artifact rows match the normalized selection" "$ARTIFACT_COUNT" "$selection_artifact_rows"
# A1: the claim is a content address, never the bytes. name|sha256|mode is the
# whole row, so a fourth field (the old inline payload) must never appear.
inline_rows="$(grep -c '^artifact=[^|]*|[0-9a-f]*|[0-7]*|' "$work/claim-selection.txt" || true)"
assert_eq "claim rows carry no inline artifact bytes" 0 "$inline_rows"
asset_fetches="$(cat "$work/artifact-count")"
[[ "$asset_fetches" -ge "$ARTIFACT_COUNT" ]] || fail_check "the courier did not fetch the pinned artifacts from the asset origin (fetches=$asset_fetches)"
record_ok "pinned artifacts fetched from the asset origin: fetches=$asset_fetches"

completion="$work/completion-receipt.json"
[[ -r "$completion" ]] || fail_check "the courier never reported completion"
record_ok "completion receipt recorded: $completion"
assert_eq "completion node" "$NODE_ID" "$(json_value "$completion" report.node_id)"
assert_eq "completion capability mode" NEW "$(json_value "$completion" report.capability_mode)"
assert_eq "completion selection digest" "$recorded_selection_digest" "$(json_value "$completion" report.capability_selection_digest)"
ssh_host_sha="$(json_value "$completion" report.ssh_host_key_sha256)"
[[ -n "$ssh_host_sha" ]] || fail_check "completion carried no host identity evidence"
record_ok "completion carried the real host key fingerprint: $ssh_host_sha"

control_home="$(getent passwd "$control_account" | cut -d: -f6)"
unit="$control_home/.config/systemd/user/$unit_name"
want="$control_home/.config/systemd/user/default.target.wants/$unit_name"
[[ -f "$unit" && -L "$want" ]] || fail_check "the selected user unit was not installed and enabled"
record_ok "user unit installed and enabled: $unit -> $want"
unit_stat="$(stat -c '%U:%G:%a' "$unit")"
assert_eq "unit owner:group:mode" "$control_account:$control_account:644" "$unit_stat"
unit_owner="$(stat -c '%U' "$unit")"
if [[ "$unit_owner" = "$human" || "$unit_owner" = root ]]; then fail_check "the Human or root owns the managed unit"; fi
record_ok "the unit owner is neither the Human nor root: $unit_owner"
unit_sha="$(sha256sum "$unit" | cut -d ' ' -f1)"
assert_eq "unit bytes match the pinned artifact" "$UNIT_SHA256" "$unit_sha"
linger_out="$(loginctl show-user "$control_account" -p Linger)"
assert_eq "Linger" "Linger=yes" "$linger_out"
control_uid="$(id -u "$control_account")"
[[ "$control_uid" -ne 0 ]] || fail_check "the control account is root"
record_ok "control account uid is not root: $control_account uid=$control_uid"
# The deferred lane: the completion response delivered the one-time node
# credential, and only then did the payload, the unit and Linger appear. The
# public projection and the root-owned agent configuration record the same
# reviewed digests.
payload_path=/usr/local/libexec/ghostfleet/node-agent.pyz
[[ -f "$payload_path" ]] || fail_check "the deferred lane never installed the agent payload"
assert_eq "payload owner:group:mode" "root:root:755" "$(stat -c '%U:%G:%a' "$payload_path")"
assert_eq "payload bytes match the pinned artifact" "$PAYLOAD_SHA256" "$(sha256sum "$payload_path" | cut -d ' ' -f1)"
run_uid="$(id -u "$control_account")"
if ! su -s /bin/sh "$control_account" -c "XDG_RUNTIME_DIR=/run/user/$run_uid systemd-analyze --user verify '$unit'" >"$work/unit-verify.log" 2>&1; then
  cat "$work/unit-verify.log" >&2
  fail_check "the installed user unit does not pass systemd-analyze --user verify"
fi
record_ok "the installed unit passes systemd-analyze --user verify"
token_dir="$control_home/.config/ghostfleet"
assert_eq "credential directory owner:group:mode" "$control_account:$control_account:700" "$(stat -c '%U:%G:%a' "$token_dir")"
token_file="$token_dir/node-token"
[[ -f "$token_file" && ! -L "$token_file" ]] || fail_check "the node token is not a regular file"
assert_eq "node token owner:group:mode" "$control_account:$control_account:600" "$(stat -c '%U:%G:%a' "$token_file")"
assert_eq "node token length" 43 "$(wc -c <"$token_file")"
grep -Eqx '[A-Za-z0-9_-]{43}' "$token_file" || fail_check "the node token is not a base64url token"
node_json="$token_dir/node.json"
assert_eq "node descriptor owner:group:mode" "$control_account:$control_account:600" "$(stat -c '%U:%G:%a' "$node_json")"
assert_eq "node descriptor uid" "$NODE_UID" "$(json_value "$node_json" node_uid)"
if grep -Fq -- "$(cat "$token_file")" "$work/run-1.log"; then
  fail_check "the node token reached the run log"
fi
record_ok "the node token never reached the run log"
projection=/etc/ghostfleet/capability-status.json
[[ -f "$projection" ]] || fail_check "the public capability projection was not written"
assert_eq "projection owner:group:mode" "root:root:644" "$(stat -c '%U:%G:%a' "$projection")"
assert_eq "projection schema" ghostfleet-capability-status/v1 "$(json_value "$projection" schema)"
assert_eq "projection selection schema" ghostfleet-selected-capability/v2 "$(json_value "$projection" selection_schema)"
projection_pin="$(printf '%s' "$TEMPLATE_DIGEST" | sed 's/^sha256://' | cut -c 1-40)"
assert_eq "projection release pin" "$projection_pin" "$(json_value "$projection" release_pin)"
assert_eq "projection payload digest" "$PAYLOAD_SHA256" "$(json_value "$projection" user_unit.payload_sha256)"
assert_eq "projection payload path" "$payload_path" "$(json_value "$projection" user_unit.payload_path)"
assert_eq "projection unit digest" "$unit_sha" "$(json_value "$projection" user_unit.sha256)"
assert_absent "projection token leak" "$(cat "$token_file")" "$projection"
agent_config=/etc/ghostfleet/node-agent.json
[[ -f "$agent_config" ]] || fail_check "the root-owned agent configuration was not written"
assert_eq "agent configuration owner:group:mode" "root:root:644" "$(stat -c '%U:%G:%a' "$agent_config")"
# The agent parser in packages/node-agent rejects unknown top level keys and
# non numeric intervals, so the courier must write exactly this shape. The
# origin is the node-plane bridge the delivery exported, never the
# Access-protected enrollment origin the launcher used.
python3 - "$agent_config" "$NODE_PLANE_ORIGIN" "$unit_name" <<'PY' || fail_check "the agent configuration is not the exact shape the pinned agent accepts"
import json
import sys
config = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {
    "control_plane_origin": sys.argv[2],
    "heartbeat_interval_s": 30,
    "heartbeat_interval_min_s": 30,
    "heartbeat_interval_max_s": 300,
    "allowed_units": [sys.argv[3]],
}
assert config == expected, config
print("agent configuration keys: " + ",".join(sorted(config)))
PY
record_ok "agent configuration is exactly the node-plane origin plus numeric heartbeat contract (origin=$NODE_PLANE_ORIGIN)"
assert_eq "capability helper component" COMPLIANT "$(json_value "$capability_state" components.privileged_helper)"
assert_eq "capability user service component" COMPLIANT "$(json_value "$capability_state" components.user_service)"
assert_eq "capability linger component" COMPLIANT "$(json_value "$capability_state" components.linger)"
assert_contains "payload evidence" 'capability_agent_payload_state=INSTALLED' "$work/run-1.log"
assert_contains "unit evidence" 'capability_user_unit_state=INSTALLED' "$work/run-1.log"
assert_contains "service evidence" 'capability_service_state=INSTALLED' "$work/run-1.log"
assert_contains "credential evidence" 'capability_node_credential_received=yes' "$work/run-1.log"
assert_contains "token type evidence" 'capability_node_token_type=regular' "$work/run-1.log"
record_ok "the deferred lane finished only after the credential arrived: payload, unit, Linger, projection"
# The identity that owns the unit and Linger is neither the Human, root, nor the
# privileged operations account, and it carries no sudo lane of its own.
if [[ "$control_account" = "$privileged_account" || "$control_account" = "$human" ]]; then
  fail_check "the run account collides with the Human or the privileged account"
fi
record_ok "run account and privileged account are distinct: $control_account / $privileged_account"
control_groups="$(id -nG "$control_account")"
for group in sudo wheel admin docker lxd disk shadow; do
  if printf '%s\n' "$control_groups" | tr ' ' '\n' | grep -qx "$group"; then
    fail_check "the run account is in the root-equivalent group $group"
  fi
done
record_ok "run account groups: $control_groups"
control_sudo="$(sudo -l -U "$control_account" 2>&1 || true)"
case "$control_sudo" in
  *"is not allowed to run sudo"*) record_ok "run account has no sudo grant: $control_account" ;;
  *) fail_check "the run account has a sudo grant: $control_sudo" ;;
esac
ops_sudo="$(sudo -l -U "$privileged_account" 2>/dev/null || true)"
case "$ops_sudo" in
  */usr/local/libexec/youling-fleet/fleet-privctl*) record_ok "the ops lane still names the pinned helper: $privileged_account" ;;
  *) fail_check "the ops sudoers rule does not name the pinned helper: $ops_sudo" ;;
esac
if su -s /bin/sh "$control_account" -c 'sudo -n /usr/local/libexec/youling-fleet/fleet-privctl </dev/null' >"$work/run-account-sudo.log" 2>&1; then
  fail_check "the run account reached the privileged helper through sudo"
fi
record_ok "negative: $control_account cannot invoke the helper through sudo"
if su -s /bin/sh "$privileged_account" -c 'sudo -n /usr/local/libexec/youling-fleet/fleet-privctl </dev/null' >"$work/ops-sudo.log" 2>&1; then
  fail_check "the privileged helper accepted an empty request"
fi
grep -q '"ok":false' "$work/ops-sudo.log" || fail_check "the ops lane did not execute the helper"
record_ok "positive: $privileged_account still reaches the helper through the mediated lane"
[[ "$human_uid" -ne 0 ]] || fail_check "the Human is root"
record_ok "Human uid is not root: $human uid=$human_uid"
[[ -r "$installer_state" ]] || fail_check "the installer did not record its state"
record_ok "installer state recorded: $installer_state"
ordinary_user="$(json_value "$installer_state" ordinary_user)"
assert_eq "FLEET_CONTROL_ORDINARY_USER recorded" "$human" "$ordinary_user"
assert_eq "recorded ops user" "$privileged_account" "$(json_value "$installer_state" ops_user)"
assert_eq "recorded run account" "$control_account" "$(json_value "$capability_state" control_account)"
assert_eq "recorded privileged account" "$privileged_account" "$(json_value "$capability_state" privileged_account)"
assert_eq "run account origin" CREATED "$(json_value "$capability_state" control_account_state)"
assert_eq "run account provenance" True "$(json_value "$capability_state" control_account_created_by_courier)"
helper_path=/usr/local/libexec/youling-fleet/fleet-privctl
assert_eq "helper bytes match the pinned artifact" "$HELPER_SHA256" "$(sha256sum "$helper_path" | cut -d ' ' -f1)"
visudo -cf /etc/sudoers.d/90-youling-fleet-privileged-operations >/dev/null || fail_check "the managed sudoers file is invalid"
record_ok "the managed sudoers file parses"
installer_sha="$(sha256sum "$workspace/packages/runtime-python/src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged/managed-linux-privileged-operations.sh" | cut -d ' ' -f1)"
assert_eq "installer bytes match the pinned artifact" "$INSTALLER_SHA256" "$installer_sha"

# The elevation boundary, measured on the live process tree.
elevated_parent="$(cat "$work/elevated-parent-1.txt" 2>/dev/null || true)"
assert_eq "measured parent comm of the elevated shell" sudo "$elevated_parent"
elevated_parent_exe="$(cat "$work/elevated-parent-exe-1.txt" 2>/dev/null || true)"
case "$elevated_parent_exe" in
  */sudo) record_ok "measured parent executable of the elevated shell: $elevated_parent_exe" ;;
  *) fail_check "the elevated shell's parent is not sudo: $elevated_parent_exe" ;;
esac
handed_over="$(tail -n 1 "$work/elevated-argv-1.txt" 2>/dev/null || true)"
assert_eq "root script received the Human as \$1" "$human" "$handed_over"
elevated_env="$(grep -v '^$' "$work/elevated-environ-1.txt" | paste -sd ';' -)"
elevated_env_count="$(grep -c '' "$work/elevated-environ-1.txt")"
assert_eq "the post-env -i environment has exactly two variables" 2 "$elevated_env_count"
assert_contains "elevated environment PATH" 'PATH=/usr/sbin:/usr/bin:/sbin:/bin' "$work/elevated-environ-1.txt"
assert_contains "elevated environment HOME" 'HOME=/root' "$work/elevated-environ-1.txt"
caller_env_poison="$(sed -n 's/^GHOSTFLEET_POISON=//p' "$work/caller-environ-1.txt" | head -n1)"
caller_env_tmpdir="$(sed -n 's/^TMPDIR=//p' "$work/caller-environ-1.txt" | head -n1)"
caller_env_path="$(sed -n 's/^PATH=//p' "$work/caller-environ-1.txt" | head -n1)"
assert_eq "the caller really exported the poison variable" caller-poison "$caller_env_poison"
assert_eq "the caller really exported TMPDIR" "$poison_tmp" "$caller_env_tmpdir"
case "$caller_env_path" in
  "$run_dir/poison":*) record_ok "the caller PATH really starts with the poison directory: $caller_env_path" ;;
  *) fail_check "the caller PATH does not start with the poison directory: $caller_env_path" ;;
esac
assert_absent "caller poison variable crossed env -i" 'GHOSTFLEET_POISON' "$work/elevated-environ-1.txt"
assert_absent "caller TMPDIR crossed env -i" 'TMPDIR=' "$work/elevated-environ-1.txt"
assert_absent "caller SUDO_USER crossed env -i" 'SUDO_USER=' "$work/elevated-environ-1.txt"
assert_absent "caller GHOSTFLEET_OPERATING_USER crossed env -i" 'GHOSTFLEET_OPERATING_USER' "$work/elevated-environ-1.txt"

# The courier bytes: what curl wrote, what the server sent, what the module has.
downloaded_sha_1="$(sha256sum "$work/downloaded-bootstrap-1.sh" | cut -d ' ' -f1)"
served_sha="$(cat "$work/served-bootstrap.sha256")"
assert_eq "downloaded courier == pinned bootstrap digest" "$BOOTSTRAP_SHA256" "$downloaded_sha_1"
assert_eq "downloaded courier == fresh module import" "$published_sha" "$downloaded_sha_1"
assert_eq "served courier == fresh module import" "$published_sha" "$served_sha"
assert_eq "downloaded courier == served courier" "$served_sha" "$downloaded_sha_1"

evidence "launcher_sha256=$launcher_sha"
evidence "elevated_parent_comm=$elevated_parent elevated_parent_exe=$elevated_parent_exe handed_over_argv1=$handed_over human_uid=$human_uid"
evidence "elevated_env=$elevated_env elevated_env_vars=$elevated_env_count"
evidence "caller_environ_measured=GHOSTFLEET_POISON=$caller_env_poison TMPDIR=$caller_env_tmpdir PATH=$caller_env_path"
evidence "claim_ticket=$TICKET_ID ticket_verification=$ticket_verification preflight_digest=$preflight_digest"
evidence "selection_digests recorded_by_courier=$recorded_selection_digest module_canonicalization=$SELECTION_DIGEST note=two_derivations_expected_different"
evidence "installer_sha256=$installer_sha pinned_artifacts=$ARTIFACT_COUNT delivered_artifact_rows=$selection_artifact_rows"
evidence "unit=$unit unit_stat=$unit_stat unit_sha256=$unit_sha"
evidence "linger=$linger_out installer_ordinary_user=$ordinary_user"
evidence "run_account=$control_account uid=$control_uid groups=$control_groups privileged_account=$privileged_account"
evidence "negative=run_account cannot sudo the helper; positive=ops lane executed the helper: $(cat "$work/ops-sudo.log")"
evidence "courier_downloaded_sha256=$downloaded_sha_1 courier_served_sha256=$served_sha courier_published_sha256=$published_sha"

section "run 2: the same launcher again must be zero delta"
state_before="$(sha256sum "$capability_state" | cut -d ' ' -f1)"
unit_before="$(sha256sum "$unit" | cut -d ' ' -f1)"
control_before="$(sha256sum "$installer_state" | cut -d ' ' -f1)"
helper_before="$(sha256sum "$helper_path" | cut -d ' ' -f1)"
helper_mtime_before="$(stat -c %Y "$helper_path")"
unit_mtime_before="$(stat -c %Y "$unit")"
control_mtime_before="$(stat -c %Y "$installer_state")"
clear_launcher_workspace
capture_courier_download 2 &
download_watch_2=$!
if ! run_launcher "$work/run-2.log" "$work/in-2"; then
  echo "the second chained run failed" >&2
  tail -n 80 "$work/run-2.log" >&2
  exit 1
fi
wait "$download_watch_2" || fail_check "the second run's courier bytes were not captured"
assert_contains "converged path" 'fleet-enroll: already converged; no enrollment credentials requested' "$work/run-2.log"
assert_absent "second-run credential prompt" 'Enrollment code' "$work/run-2.log"
assert_absent "second-run installer apply" 'DEDICATED_PRIVILEGED_OPS_LANE_READY' "$work/run-2.log"
applies_2="$(grep -c 'DEDICATED_PRIVILEGED_OPS_LANE_READY' "$work/run-2.log" || true)"
assert_eq "installer apply count in run 2" 0 "$applies_2"
claims_2="$(cat "$work/claim-count")"
assert_eq "claim count after the second run" 1 "$claims_2"
assert_eq "courier downloads" 2 "$(cat "$work/bootstrap-count")"
downloaded_sha_2="$(sha256sum "$work/downloaded-bootstrap-2.sh" | cut -d ' ' -f1)"
assert_eq "second-run downloaded courier == fresh module import" "$published_sha" "$downloaded_sha_2"
state_after="$(sha256sum "$capability_state" | cut -d ' ' -f1)"
unit_after="$(sha256sum "$unit" | cut -d ' ' -f1)"
control_after="$(sha256sum "$installer_state" | cut -d ' ' -f1)"
helper_after="$(sha256sum "$helper_path" | cut -d ' ' -f1)"
assert_eq "capability state unchanged" "$state_before" "$state_after"
assert_eq "unit bytes unchanged" "$unit_before" "$unit_after"
assert_eq "installer state unchanged" "$control_before" "$control_after"
assert_eq "helper bytes unchanged" "$helper_before" "$helper_after"
assert_eq "helper mtime unchanged" "$helper_mtime_before" "$(stat -c %Y "$helper_path")"
assert_eq "unit mtime unchanged" "$unit_mtime_before" "$(stat -c %Y "$unit")"
assert_eq "installer state mtime unchanged" "$control_mtime_before" "$(stat -c %Y "$installer_state")"

evidence "run1_claims=$claims_1 run1_applies=$applies_1"
evidence "run2_claims=$claims_2 run2_applies=$applies_2"
evidence "zero_delta state=$state_before->$state_after unit=$unit_before->$unit_after helper=$helper_before->$helper_after control=$control_before->$control_after"
evidence "run2_courier_downloaded_sha256=$downloaded_sha_2 == published $published_sha"

section "chained acceptance: PASS"
REAL_TEXT="Console launcher text from createTicketDelivery (sha256=$launcher_sha, no ticket handle or short code in argv) run by the non-root Human $human (uid $human_uid) through the sudo branch (measured parent $elevated_parent at $elevated_parent_exe, \$1=$handed_over) and the real env -i boundary (elevated environ {$elevated_env} = $elevated_env_count variables; caller-measured GHOSTFLEET_POISON/TMPDIR/SUDO_USER absent); published BOOTSTRAP_SH over TLS (downloaded sha256=$downloaded_sha_1 == served $served_sha == fresh-import $published_sha); a wrong short code was refused with HTTP $negative_status and consumed no claim, then the real claim was verified by src/control-plane/tickets.js against the ticket short code ($ticket_verification) for synthetic test template_digest=$TEMPLATE_DIGEST with recorded selection_digest=$recorded_selection_digest; real reviewed installer --apply (sha256=$installer_sha, $selection_artifact_rows pinned artifacts) and the completion response delivered a synthetic one-time node credential (43-character base64url) after which only the deferred lane installed the payload $payload_path (root:root 755 sha256=$PAYLOAD_SHA256), the managed launcher unit $unit_name (owned $unit_stat sha256=$unit_sha) and $linger_out, with root-owned /etc/ghostfleet/capability-status.json and node-agent.json recording the same digests; FLEET_CONTROL_ORDINARY_USER=$ordinary_user recorded by the installer; a negative arm whose completion response carried no node credential failed closed with CAPABILITY_NODE_CREDENTIAL_MISSING and left no payload, no unit, no enablement link, no Linger, no projection and no agent configuration; run 1 claims=$claims_1 applies=$applies_1; run 2 claims=$claims_2 applies=$applies_2 with unchanged state/unit/helper/control.json sha256"
NOT_RUN_TEXT="the real Tailscale provider join and tailnet reachability, because a tailnet auth key is an external credential this disposable VM does not have (the courier's join block is skipped by the shim reporting the pre-arranged identity); a hosted GhostFleet control plane, because this run answers the claim from the local control-plane stub (the courier's claim and completion clients are the published ones); the release unit asset and the product payload bytes, because the managed launcher unit and the payload installed here are synthetic canaries pinned by the test selection; a hosted control-plane credential handoff, because the completion response is synthesized by the local control-plane stub (the courier's credential parser/writer and the deferred payload, unit and Linger lane are the published ones); OMV 8 appliance SSH admission and OMV Linger, because the disposable VM is not an OpenMediaVault appliance"
printf 'REAL: %s\n' "$REAL_TEXT"
printf 'STUB: tailscale-join\n'
printf 'NOT_RUN: %s\n' "$NOT_RUN_TEXT"
exit 0
