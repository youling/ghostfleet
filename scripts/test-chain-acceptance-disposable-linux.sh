#!/usr/bin/env bash
# Chained acceptance on a disposable GitHub-hosted Ubuntu VM.
#
# One root ceremony, joined end to end:
#   real createTicketDelivery command text
#   -> real non-root Human (gf-review-human) with NOPASSWD sudo
#   -> real sudo -> real env -i -> the published BOOTSTRAP_SH over TLS
#   -> real claim POST (short code verified by the real control-plane module)
#   -> real reviewed privileged-operations installer with real SHA-256 checks
#   -> user unit + Linger owned by the template's control account
#   -> second run of the same launcher is zero delta.
#
# The only stubbed step is the Tailscale provider join, which needs a real
# tailnet credential. Every host fact the courier checks is real: the
# provisioning below happens BEFORE the ceremony and never replaces a courier
# check with a recorded result. GitHub-hosted ephemeral VM ONLY: no Fleet/NAS,
# no production node, no credentials.
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
control_account=ghostfleet-ops
short_code=41832576
node_id="gf-chain-$(openssl rand -hex 4)"
installer_state=/etc/youling-fleet/privileged-operations/control.json
capability_state=/var/lib/fleet/capability-state.json

work="$(mktemp -d)"
run_dir=/run/gf-chain
server_pid=
install -d -m 0700 -o root -g root "$work"
install -d -m 0755 -o root -g root "$run_dir" "$run_dir/poison"

section() { printf '\n=== %s ===\n' "$*"; }
fail_check() { printf 'CHAIN ASSERTION FAILED: %s\n' "$*" >&2; exit 1; }
assert_eq() { [[ "$2" = "$3" ]] || fail_check "$1: expected [$2], got [$3]"; }
assert_contains() { grep -Fq -- "$2" "$3" || fail_check "$1: [$2] not found in $3"; }
assert_absent() { ! grep -Fq -- "$2" "$3" || fail_check "$1: [$2] unexpectedly present in $3"; }
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

cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "$status" -ne 0 ]]; then
    printf '\nCHAIN FAILED (status %s); keeping the evidence below\n' "$status" >&2
    for file in "$work/server.log" "$work/run-1.log" "$work/run-2.log"; do
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
for tool in node openssl curl sha256sum su sudo script ssh-keygen visudo useradd loginctl getent install dpkg-query python3; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 3; }
done
# Real host identity evidence for the courier's phase 0.
if ! compgen -G "/etc/ssh/ssh_host_*_key.pub" >/dev/null; then ssh-keygen -A; fi
# A real non-root Human with a real NOPASSWD sudo grant.
if ! id "$human" >/dev/null 2>&1; then useradd -m -s /bin/bash "$human"; fi
[[ "$(id -u "$human")" -ne 0 && "$(id -u "$human")" -ge 1000 ]] || { echo "the Human account is not ordinary" >&2; exit 3; }
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$human" >/etc/sudoers.d/90-gf-chain-human
chmod 0440 /etc/sudoers.d/90-gf-chain-human
visudo -cf /etc/sudoers.d/90-gf-chain-human >/dev/null
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
# tailscaled, and it reports the pre-arranged identity so the join is skipped.
systemctl stop tailscaled 2>/dev/null || true
rm -f /var/lib/tailscale/tailscaled.state
if [[ -e /usr/bin/tailscale ]]; then mv -f /usr/bin/tailscale /usr/bin/tailscale.real; fi
rm -f /usr/sbin/tailscale
install -d -m 0755 /usr/local/lib/gf-chain
cat >/usr/local/lib/gf-chain/tailscale-stub <<STUB
#!/bin/sh
# Disposable acceptance stub: the Tailscale provider join is the only stubbed
# step of this chain (it needs a real tailnet credential). It reports the
# identity the local control-plane stub already issued for this run, so the
# courier's join block is skipped and the capability lane runs.
NODE_ID='$node_id'
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

section "setup: local control-plane stub (server side only)"
ssh-keygen -q -t ed25519 -N '' -C 'synthetic-chained-acceptance' -f "$work/privileged-ops"
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
url="$ORIGIN/v1/enrollment-tickets/$TICKET_ID"
printf '%s\n%s\n' "$url" "$short_code" >"$work/in-1"
printf '%s\n' "$url" >"$work/in-2"
[[ "$(sha256sum "$work/published-bootstrap.sh" | cut -d ' ' -f1)" = "$BOOTSTRAP_SHA256" ]] ||
  { echo "the served courier is not the published BOOTSTRAP_SH" >&2; exit 1; }
printf 'control-plane origin: %s\n' "$ORIGIN"
printf 'ticket: %s\ntemplate digest: %s\nmodule selection digest: %s\nnode: %s\n' "$TICKET_ID" "$TEMPLATE_DIGEST" "$SELECTION_DIGEST" "$NODE_ID"

# The launcher text is the Console output; it must not carry the ticket handle
# or the short code (both are typed into the protected root terminal instead).
assert_contains "launcher identity capture" 'TRUSTED_ID=/usr/bin/id' "$run_dir/launcher.sh"
assert_absent "launcher ticket leak" "$TICKET_ID" "$run_dir/launcher.sh"
assert_absent "launcher short-code leak" "$short_code" "$run_dir/launcher.sh"

run_launcher() {
  local log="$1" input="$2" rc=0
  set +e
  su -s /bin/sh "$human" -c "export PATH='$run_dir/poison':\$PATH; export GHOSTFLEET_OPERATING_USER=root; export TMPDIR='$poison_tmp'; script -qec '$run_dir/launcher.sh' /dev/null" <"$input" >"$log" 2>&1
  rc=$?
  set -e
  return "$rc"
}

section "run 1: the real Console launcher, the real Human, real sudo, real env -i"
if ! run_launcher "$work/run-1.log" "$work/in-1"; then
  echo "the first chained run failed" >&2
  tail -n 80 "$work/run-1.log" >&2
  exit 1
fi
[[ -e "$work/poison-sh-ran" || -e "$work/poison-curl-ran" ]] && fail_check "a caller-controlled binary executed during elevation"
[[ -z "$(ls -A "$poison_tmp")" ]] || fail_check "the caller TMPDIR was used by the elevated script"

section "assertions: the first run really installed the selected capability"
[[ -r "$capability_state" ]] || fail_check "no capability state was written"
assert_contains "capability mode" '"mode":"NEW"' "$capability_state"
assert_contains "capability template binding" "\"template_digest\":\"$TEMPLATE_DIGEST\"" "$capability_state"
recorded_selection_digest="$(json_value "$capability_state" selection_digest)"
[[ "$recorded_selection_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail_check "the recorded selection digest is malformed"
assert_contains "preflight ran" 'fleet-enroll: preflight PASS' "$work/run-1.log"
assert_contains "completion ran" "fleet-enroll: bootstrap complete for $NODE_ID" "$work/run-1.log"
assert_contains "apply ran" "fleet-enroll: selected capability mode=NEW" "$work/run-1.log"
assert_contains "installer apply" 'DEDICATED_PRIVILEGED_OPS_LANE_READY' "$work/run-1.log"

claim_receipt="$work/claim-request.json"
[[ -r "$claim_receipt" ]] || fail_check "the courier never claimed"
assert_eq "claim os family" debian-family "$(json_value "$claim_receipt" os_family)"
assert_eq "claim os id" ubuntu "$(json_value "$claim_receipt" os_id)"
[[ "$(json_value "$claim_receipt" preflight_digest)" =~ ^sha256:[0-9a-f]{64}$ ]] || fail_check "the claim carried no real preflight digest"
assert_eq "claim count after the first run" 1 "$(cat "$work/claim-count")"

completion="$work/completion-receipt.json"
[[ -r "$completion" ]] || fail_check "the courier never reported completion"
assert_eq "completion node" "$NODE_ID" "$(json_value "$completion" report.node_id)"
assert_eq "completion capability mode" NEW "$(json_value "$completion" report.capability_mode)"
assert_eq "completion selection digest" "$recorded_selection_digest" "$(json_value "$completion" report.capability_selection_digest)"
[[ -n "$(json_value "$completion" report.ssh_host_key_sha256)" ]] || fail_check "completion carried no host identity evidence"

control_home="$(getent passwd "$control_account" | cut -d: -f6)"
unit="$control_home/.config/systemd/user/ghostfleet-managed.service"
want="$control_home/.config/systemd/user/default.target.wants/ghostfleet-managed.service"
[[ -f "$unit" && -L "$want" ]] || fail_check "the selected user unit was not installed and enabled"
assert_eq "unit owner" "$control_account:$control_account:644" "$(stat -c '%U:%G:%a' "$unit")"
owner="$(stat -c '%U' "$unit")"
[[ "$owner" != "$human" && "$owner" != root ]] || fail_check "the Human or root owns the managed unit"
assert_eq "unit bytes" "$UNIT_SHA256" "$(sha256sum "$unit" | cut -d ' ' -f1)"
assert_eq "Linger" "Linger=yes" "$(loginctl show-user "$control_account" -p Linger)"
[[ "$(id -u "$control_account")" -ne 0 ]] || fail_check "the control account is root"
[[ "$(id -u "$human")" -ne 0 ]] || fail_check "the Human is root"
[[ -r "$installer_state" ]] || fail_check "the installer did not record its state"
assert_eq "FLEET_CONTROL_ORDINARY_USER recorded" "$human" "$(json_value "$installer_state" ordinary_user)"
assert_eq "recorded ops user" "$control_account" "$(json_value "$installer_state" ops_user)"
assert_eq "helper bytes" "$HELPER_SHA256" "$(sha256sum /usr/local/libexec/youling-fleet/fleet-privctl | cut -d ' ' -f1)"
visudo -cf /etc/sudoers.d/90-youling-fleet-privileged-operations >/dev/null || fail_check "the managed sudoers file is invalid"

section "run 2: the same launcher again must be zero delta"
state_before="$(sha256sum "$capability_state" | cut -d ' ' -f1)"
unit_before="$(sha256sum "$unit" | cut -d ' ' -f1)"
control_before="$(sha256sum "$installer_state" | cut -d ' ' -f1)"
helper_before="$(sha256sum /usr/local/libexec/youling-fleet/fleet-privctl | cut -d ' ' -f1)"
helper_mtime_before="$(stat -c %Y /usr/local/libexec/youling-fleet/fleet-privctl)"
unit_mtime_before="$(stat -c %Y "$unit")"
control_mtime_before="$(stat -c %Y "$installer_state")"
if ! run_launcher "$work/run-2.log" "$work/in-2"; then
  echo "the second chained run failed" >&2
  tail -n 80 "$work/run-2.log" >&2
  exit 1
fi
assert_contains "converged path" 'fleet-enroll: already converged; no enrollment credentials requested' "$work/run-2.log"
assert_absent "second-run credential prompt" 'Enrollment code' "$work/run-2.log"
assert_absent "second-run installer apply" 'DEDICATED_PRIVILEGED_OPS_LANE_READY' "$work/run-2.log"
assert_eq "claim count after the second run" 1 "$(cat "$work/claim-count")"
assert_eq "courier downloads" 2 "$(cat "$work/bootstrap-count")"
assert_eq "capability state unchanged" "$state_before" "$(sha256sum "$capability_state" | cut -d ' ' -f1)"
assert_eq "unit bytes unchanged" "$unit_before" "$(sha256sum "$unit" | cut -d ' ' -f1)"
assert_eq "installer state unchanged" "$control_before" "$(sha256sum "$installer_state" | cut -d ' ' -f1)"
assert_eq "helper bytes unchanged" "$helper_before" "$(sha256sum /usr/local/libexec/youling-fleet/fleet-privctl | cut -d ' ' -f1)"
assert_eq "helper mtime unchanged" "$helper_mtime_before" "$(stat -c %Y /usr/local/libexec/youling-fleet/fleet-privctl)"
assert_eq "unit mtime unchanged" "$unit_mtime_before" "$(stat -c %Y "$unit")"
assert_eq "installer state mtime unchanged" "$control_mtime_before" "$(stat -c %Y "$installer_state")"

section "chained acceptance: PASS"
cat <<'REPORT'
REAL: Console launcher text from createTicketDelivery (no ticket handle or short code in argv); non-root Human gf-review-human answering on a real pty; real NOPASSWD sudo; real env -i root environment; published BOOTSTRAP_SH downloaded over TLS from the local control-plane origin; real claim POST verified against the ticket short code by src/control-plane/tickets.js and bound to the ticket template_digest; real reviewed privileged-operations installer --apply with real SHA-256 artifact verification; user unit owned by ghostfleet-ops with Linger=yes; FLEET_CONTROL_ORDINARY_USER=gf-review-human recorded by the installer; second run: zero delta (one claim, one installer apply, unchanged unit/helper/state)
STUB: tailscale-join
NOT_RUN: the real Tailscale provider join and tailnet reachability, because a tailnet auth key is an external credential this disposable VM does not have (the courier's join block is skipped by the shim reporting the pre-arranged identity); a hosted GhostFleet control plane, because this run answers the claim from the local control-plane stub (the courier's claim and completion clients are the published ones); OMV 8 appliance SSH admission and OMV Linger, because the disposable VM is not an OpenMediaVault appliance
REPORT
exit 0
