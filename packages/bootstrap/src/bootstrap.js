export const BOOTSTRAP_SH = `#!/bin/sh
set -eu

BROKER_ORIGIN="\${GHOSTFLEET_BROKER_ORIGIN:-}"
ENROLLMENT_URL="\${GHOSTFLEET_ENROLLMENT_URL:-}"
if [ -n "$ENROLLMENT_URL" ]; then
  case "$ENROLLMENT_URL" in
    https://*/v1/enrollment-tickets/*) ;;
    *) printf '%s\\n' 'fleet-enroll: invalid one-time enrollment URL' >&2; exit 1 ;;
  esac
  [ -n "$BROKER_ORIGIN" ] || BROKER_ORIGIN="\${ENROLLMENT_URL%%/v1/enrollment-tickets/*}"
fi
CHECKPOINT_DIR="\${GHOSTFLEET_CHECKPOINT_DIR:-/var/lib/fleet}"
CHECKPOINT_FILE="$CHECKPOINT_DIR/enrollment-checkpoint.json"

# V2 R1 Courier is a convergence engine. Checkpoint data is a resume hint only: every
# component used by the zero-delta path is re-proved from the live machine.
# This whole section is mutation-free and runs before /dev/tty, broker claim,
# or any credential request.
json_file_value() {
  JSON_FILE_QUOTED="$(grep -Eo '"'$2'"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -n1 || true)"
  if [ -n "$JSON_FILE_QUOTED" ]; then
    printf '%s' "$JSON_FILE_QUOTED" | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"[[:space:]]*$//'
  else
    grep -Eo '"'$2'"[[:space:]]*:[[:space:]]*[a-z]+' "$1" 2>/dev/null | head -n1 | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*//'
  fi
}

package_installed() {
  dpkg-query -W -f='\${Status}' "$1" 2>/dev/null | grep -qx 'install ok installed'
}

tailscale_self_state() {
  command -v tailscale >/dev/null 2>&1 || { printf '%s' ABSENT; return 0; }
  # Ask Tailscale for the local machine only.  This removes Peer[] from the
  # observation boundary, so a peer hostname can never satisfy self identity.
  TS_STATUS="$(tailscale status --self --peers=false --json 2>/dev/null)" || { printf '%s' UNKNOWN; return 0; }
  if printf '%s' "$TS_STATUS" | grep -Eq '"Self"[[:space:]]*:[[:space:]]*null'; then
    printf '%s' NOT_LOGGED_IN
    return 0
  fi
  SELF_HOST="$(printf '%s' "$TS_STATUS" | grep -Eo '"HostName"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\\1/')"
  BACKEND_STATE="$(printf '%s' "$TS_STATUS" | grep -Eo '"BackendState"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\\1/')"
  [ -n "$BACKEND_STATE" ] || { printf '%s' UNKNOWN; return 0; }
  case "$BACKEND_STATE" in
    NeedsLogin|NoState) printf '%s' NOT_LOGGED_IN; return 0 ;;
  esac
  [ -n "$SELF_HOST" ] || { printf '%s' UNKNOWN; return 0; }
  [ "$SELF_HOST" = "$1" ] || { printf '%s' IDENTITY_MISMATCH; return 0; }
  case "$BACKEND_STATE" in
    Running) printf '%s' RUNNING ;;
    Stopped) printf '%s' DRIFT_REPAIRABLE ;;
    *) printf '%s' UNKNOWN ;;
  esac
}

tailscale_preclaim_state() {
  command -v tailscale >/dev/null 2>&1 || { printf '%s' FRESH; return 0; }
  TS_PRECLAIM="$(tailscale status --self --peers=false --json 2>/dev/null)" || { printf '%s' UNKNOWN; return 0; }
  if printf '%s' "$TS_PRECLAIM" | grep -Eq '"Self"[[:space:]]*:[[:space:]]*null'; then
    printf '%s' FRESH
    return 0
  fi
  PRECLAIM_BACKEND="$(printf '%s' "$TS_PRECLAIM" | grep -Eo '"BackendState"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\\1/')"
  case "$PRECLAIM_BACKEND" in
    NeedsLogin|NoState) printf '%s' FRESH ;;
    Running|Stopped) printf '%s' EXISTING ;;
    *) printf '%s' UNKNOWN ;;
  esac
}

live_tailscale_ready() {
  [ "$(tailscale_self_state "$1")" = RUNNING ]
}

checkpoint_is_compliant() {
  [ -r "$CHECKPOINT_FILE" ] || return 1
  [ "$(json_file_value "$CHECKPOINT_FILE" schema)" = 'fleet-enroll-checkpoint/v1' ] || return 1
  [ "$(json_file_value "$CHECKPOINT_FILE" status)" = COMPLIANT ] || return 1
  [ -r "$CHECKPOINT_DIR/enrollment-report.json" ] || return 1

  CHECKPOINT_NODE_ID="$(json_file_value "$CHECKPOINT_FILE" node_id)"
  CHECKPOINT_NODE_UID="$(json_file_value "$CHECKPOINT_FILE" node_uid)"
  REPORT_NODE_ID="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" node_id)"
  REPORT_NODE_UID="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" node_uid)"
  CHECKPOINT_IDENTITY_KIND="$(json_file_value "$CHECKPOINT_FILE" identity_kind)"
  REPORT_IDENTITY_KIND="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" identity_kind)"

  # Older canonical checkpoints predate identity_kind. Provisional enrollment
  # deliberately has no durable UID: reconcile its exact enrollment binding
  # instead of sending a successfully joined node back to the claim path.
  [ -n "$CHECKPOINT_IDENTITY_KIND" ] || CHECKPOINT_IDENTITY_KIND=canonical
  [ -n "$REPORT_IDENTITY_KIND" ] || REPORT_IDENTITY_KIND=canonical

  [ -n "$CHECKPOINT_NODE_ID" ] && [ "$CHECKPOINT_NODE_ID" = "$REPORT_NODE_ID" ] || return 1
  [ "$CHECKPOINT_IDENTITY_KIND" = "$REPORT_IDENTITY_KIND" ] || return 1
  case "$CHECKPOINT_IDENTITY_KIND" in
    canonical)
      [ -n "$CHECKPOINT_NODE_UID" ] && [ "$CHECKPOINT_NODE_UID" = "$REPORT_NODE_UID" ] || return 1
      ;;
    provisional)
      [ -z "$CHECKPOINT_NODE_UID" ] && [ -z "$REPORT_NODE_UID" ] || return 1
      CHECKPOINT_ENROLLMENT_ID="$(json_file_value "$CHECKPOINT_FILE" enrollment_id)"
      REPORT_ENROLLMENT_ID="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" enrollment_id)"
      [ "$CHECKPOINT_ENROLLMENT_ID" = "$REPORT_ENROLLMENT_ID" ] || return 1
      printf '%s' "$CHECKPOINT_ENROLLMENT_ID" | grep -Eq '^enroll-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || return 1
      printf '%s' "$CHECKPOINT_NODE_ID" | grep -Eq '^fleet-bootstrap-[0-9a-f]{12}$' || return 1
      ;;
    *) return 1 ;;
  esac
  live_tailscale_ready "$CHECKPOINT_NODE_ID" || return 1
  package_installed curl && package_installed ca-certificates || return 1
  return 0
}

checkpoint_write() {
  install -d -m 0700 -o root -g root "$CHECKPOINT_DIR"
  CHECKPOINT_TMP="$CHECKPOINT_FILE.$$"
  cat > "$CHECKPOINT_TMP" <<EOF
{"schema":"fleet-enroll-checkpoint/v1","phase":"$1","status":"$2","identity_kind":"\${IDENTITY_KIND:-canonical}","enrollment_id":"\${ENROLLMENT_ID:-}","node_id":"$NODE_ID","node_uid":"$NODE_UID","os_family":"$OS_FAMILY","os_id":"$OS_ID","os_version_id":"$OS_VERSION_ID","profile":"managed-linux","ssh_host_key_sha256":"$SSH_HOST_KEY_SHA","components":{"packages":"$PACKAGES_STATE","tailscale":"$TAILSCALE_STATE"}}
EOF
  chmod 0600 "$CHECKPOINT_TMP"
  chown root:root "$CHECKPOINT_TMP"
  mv -f "$CHECKPOINT_TMP" "$CHECKPOINT_FILE"
}

fail() {
  printf '%s\\n' "fleet-enroll: $*" >&2
  exit 1
}

if [ -z "$BROKER_ORIGIN" ]; then
  checkpoint_is_compliant || fail 'deployment broker origin is required before bootstrap effects'
else
  printf '%s' "$BROKER_ORIGIN" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$' || fail 'deployment broker origin must be exact HTTPS origin'
fi

if [ "$(id -u)" -ne 0 ]; then
  case "$0" in
    /*) FLEET_BOOTSTRAP_SELF="$0" ;;
    *) FLEET_BOOTSTRAP_SELF="$(pwd)/$0" ;;
  esac
  if [ ! -f "$FLEET_BOOTSTRAP_SELF" ] || [ ! -r "$FLEET_BOOTSTRAP_SELF" ]; then
    fail 'root privileges are required; use the published downloader-to-file launcher so bootstrap can elevate safely'
  fi
  if command -v sudo >/dev/null 2>&1; then
    exec sudo env GHOSTFLEET_BROKER_ORIGIN="$BROKER_ORIGIN" GHOSTFLEET_ENROLLMENT_URL="$ENROLLMENT_URL" sh "$FLEET_BOOTSTRAP_SELF"
  fi
  if command -v su >/dev/null 2>&1; then
    export FLEET_BOOTSTRAP_SELF
    exec su -c 'exec sh "$FLEET_BOOTSTRAP_SELF"' root
  fi
  fail 'root privileges are required and neither sudo nor su is available'
fi

if [ "$(uname -s)" != 'Linux' ]; then
  fail 'unsupported operating system: Linux is required'
fi

if [ ! -r /etc/os-release ]; then
  fail 'cannot identify Linux distribution: /etc/os-release is missing'
fi

. /etc/os-release
OS_ID="\${ID:-unknown}"
OS_ID_LIKE="\${ID_LIKE:-}"
OS_VERSION_ID="\${VERSION_ID:-unknown}"
VERSION_CODENAME="\${VERSION_CODENAME:-}"
UBUNTU_CODENAME="\${UBUNTU_CODENAME:-}"
if [ "$OS_ID" = "ubuntu" ] && [ -n "$UBUNTU_CODENAME" ]; then
  OS_CODENAME="$UBUNTU_CODENAME"
else
  OS_CODENAME="$VERSION_CODENAME"
fi
case " $OS_ID $OS_ID_LIKE " in
  *' debian '*|*' ubuntu '*) OS_FAMILY='debian-family' ;;
  *) fail "unsupported OS family: id=$OS_ID id_like=$OS_ID_LIKE" ;;
esac

# One-click v0 Phase 0: local read-only safety/compatibility preflight.
# This runs after the single root ceremony but before package install/update,
# provider claim, service mutation, credential request or network mutation.
bootstrap_phase0_preflight() {
  command -v systemctl >/dev/null 2>&1 || fail 'preflight failed: systemd/systemctl is required'
  [ -d /run/systemd/system ] || fail 'preflight failed: systemd is not the active init system'
  command -v sha256sum >/dev/null 2>&1 || fail 'preflight failed: sha256sum is required'

  APPLIANCE_KIND=generic-linux
  if [ -e /etc/openmediavault/config.xml ] || [ -d /etc/openmediavault ]; then
    APPLIANCE_KIND=openmediavault
  fi

  DOCKER_SOCKET_HINT=absent
  [ -S /var/run/docker.sock ] && DOCKER_SOCKET_HINT=present

  NOPASSWD_HINT=absent
  if grep -Rqs -- 'NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null; then
    NOPASSWD_HINT=present
  fi

  PREFLIGHT_MATERIAL="$(printf '%s\n' "$OS_FAMILY" "$OS_ID" "$OS_VERSION_ID" "$(uname -m)" "$APPLIANCE_KIND" "$DOCKER_SOCKET_HINT" "$NOPASSWD_HINT")"
  PRECHECK_DIGEST="sha256:$(printf '%s' "$PREFLIGHT_MATERIAL" | sha256sum | awk '{print $1}')"
  unset PREFLIGHT_MATERIAL

  printf '%s\n' "fleet-enroll: preflight PASS os=$OS_ID/$OS_VERSION_ID arch=$(uname -m) appliance=$APPLIANCE_KIND docker_socket=$DOCKER_SOCKET_HINT nopasswd_hint=$NOPASSWD_HINT" >&2
}
bootstrap_phase0_preflight

bootstrap_transport_baseline() {
  if command -v curl >/dev/null 2>&1 && package_installed ca-certificates; then
    return 0
  fi
  printf '%s\n' 'fleet-enroll: installing bootstrap transport baseline (curl ca-certificates) from distribution base repositories' >&2
  apt-get update -y || fail 'bootstrap transport baseline failed: apt-get update failed; install curl ca-certificates then rerun'
  apt-get install -y --no-install-recommends curl ca-certificates || fail 'bootstrap transport baseline failed: cannot install curl ca-certificates; install them then rerun'
  command -v curl >/dev/null 2>&1 || fail 'bootstrap transport baseline failed: curl still absent after install'
}
bootstrap_transport_baseline

tailscale_apt_compliant() {
  EXPECTED_TAILSCALE="deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/$OS_ID $OS_CODENAME main"
  [ -r /usr/share/keyrings/tailscale-archive-keyring.gpg ] || return 1
  [ -s /usr/share/keyrings/tailscale-archive-keyring.gpg ] || return 1
  [ -r /etc/apt/sources.list.d/tailscale.list ] || return 1
  grep -Fxq "$EXPECTED_TAILSCALE" /etc/apt/sources.list.d/tailscale.list || return 1
}

ensure_tailscale_apt_source() {
  if tailscale_apt_compliant; then return 0; fi
  case "$OS_CODENAME" in
    bullseye|bookworm|trixie|focal|jammy|noble|oracular|plucky|questing|resolute) ;;
    *) fail "unsupported OS release for Tailscale repository: id=$OS_ID codename=$OS_CODENAME (allowed: bullseye,bookworm,trixie,focal,jammy,noble,resolute,oracular,plucky,questing)" ;;
  esac
  printf '%s\n' "fleet-enroll: configuring official Tailscale APT repository for $OS_ID/$OS_CODENAME" >&2
  install -d -m 0755 /usr/share/keyrings
  install -d -m 0755 /etc/apt/sources.list.d
  TMP_KEY="$(mktemp)"
  TMP_LIST="$(mktemp)"
  if ! curl -fsSL "https://pkgs.tailscale.com/stable/$OS_ID/$OS_CODENAME.noarmor.gpg" -o "$TMP_KEY"; then
    rm -f "$TMP_KEY" "$TMP_LIST"
    fail "failed to fetch Tailscale signing key from official origin (https://pkgs.tailscale.com)"
  fi
  [ -s "$TMP_KEY" ] || { rm -f "$TMP_KEY" "$TMP_LIST"; fail "Tailscale signing key is empty after fetch"; }
  install -m 0644 "$TMP_KEY" /usr/share/keyrings/tailscale-archive-keyring.gpg
  if ! curl -fsSL "https://pkgs.tailscale.com/stable/$OS_ID/$OS_CODENAME.tailscale-keyring.list" -o "$TMP_LIST"; then
    rm -f "$TMP_KEY" "$TMP_LIST"
    fail "failed to fetch Tailscale APT source from official origin"
  fi
  grep -q "pkgs.tailscale.com" "$TMP_LIST" || { rm -f "$TMP_KEY" "$TMP_LIST"; fail "Tailscale APT source verification failed"; }
  install -m 0644 "$TMP_LIST" /etc/apt/sources.list.d/tailscale.list
  rm -f "$TMP_KEY" "$TMP_LIST"
  APT_UPDATE_NEEDED=true
}

if checkpoint_is_compliant; then
  printf '%s\\n' 'fleet-enroll: already converged; no enrollment credentials requested' >&2
  exit 0
fi

# Credential-free host preparation before claim to minimize key hold time (R0 #88: 600s expiry)
APT_UPDATE_NEEDED=false
if ! tailscale_apt_compliant; then
  ensure_tailscale_apt_source
fi
if [ "$APT_UPDATE_NEEDED" = true ]; then
  apt-get update -y
  APT_UPDATE_NEEDED=false
fi
if ! package_installed curl || ! package_installed ca-certificates; then
  apt-get update -y
  apt-get install -y --no-install-recommends curl ca-certificates
fi
if ! command -v tailscale >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends tailscale
  systemctl enable --now tailscaled
elif ! systemctl is-active --quiet tailscaled 2>/dev/null; then
  systemctl enable --now tailscaled
fi

case "$(tailscale_preclaim_state)" in
  FRESH) ;;
  EXISTING) fail 'existing Tailscale identity/state detected before claim; reconcile it before enrollment' ;;
  *) fail 'cannot prove fresh Tailscale state before claim; refusing Enrollment Code consumption' ;;
esac

install -d -m 0700 -o root -g root /run/fleet

if [ ! -c /dev/tty ]; then
  fail '/dev/tty is required for Enrollment Code input'
fi

# FE1 is a short-lived, single-use pairing code, not a password. Keep terminal
# echo enabled so the Human can see/correct transcription errors. Reading from
# /dev/tty keeps the code out of shell argv and shell history.
printf 'Enrollment code (visible; FE1-XXXX-XXXX or XXXX-XXXX): ' > /dev/tty
if ! IFS= read -r ENROLL_CODE < /dev/tty; then
  fail 'failed to read Enrollment Code from /dev/tty'
fi

[ -n "$ENROLL_CODE" ] || fail 'Enrollment Code must not be empty'

CLAIM_URL="$BROKER_ORIGIN/v1/enroll/claim"
[ -n "$ENROLLMENT_URL" ] && CLAIM_URL="$ENROLLMENT_URL/claim"
if ! CLAIM_JSON="$(printf '%s' "$ENROLL_CODE" | curl -fsS \\
  --connect-timeout 10 \\
  --max-time 30 \\
  --header 'content-type: text/plain' \\
  --header "x-fleet-os-family: $OS_FAMILY" \\
  --header "x-fleet-os-id: $OS_ID" \\
  --header "x-ghostfleet-preflight-digest: $PRECHECK_DIGEST" \\
  --data-binary @- \\
  "$CLAIM_URL")"; then
  unset ENROLL_CODE
  fail 'claim denied: Enrollment Code is invalid, expired, replayed, or does not match this OS profile'
fi
unset ENROLL_CODE

json_get() {
  printf '%s' "$1" | grep -o '"'$2'":"[^"]*"' | sed 's/^"[^"]*":"//; s/"$//'
}

RESUME_SESSION="$(json_get "$CLAIM_JSON" resume_session)"
[ -n "$RESUME_SESSION" ] || fail 'broker did not return a resume session'
TS_AUTHKEY="$(json_get "$CLAIM_JSON" auth_key)"
[ -n "$TS_AUTHKEY" ] || fail 'broker did not return a one-time credential'

IDENTITY_KIND="$(json_get "$CLAIM_JSON" identity_kind)"
[ -n "$IDENTITY_KIND" ] || IDENTITY_KIND=canonical
ENROLLMENT_ID="$(json_get "$CLAIM_JSON" enrollment_id)"
NODE_ID="$(json_get "$CLAIM_JSON" node_id)"
NODE_UID="$(json_get "$CLAIM_JSON" node_uid)"

case "$IDENTITY_KIND" in
  canonical) [ -n "$NODE_UID" ] || fail 'canonical enrollment returned no immutable node_uid' ;;
  provisional)
    [ -n "$ENROLLMENT_ID" ] || fail 'provisional enrollment returned no enrollment_id'
    [ -z "$NODE_UID" ] || fail 'provisional enrollment must not carry durable node_uid'
    case "$NODE_ID" in fleet-bootstrap-????????????) ;; *) fail 'invalid provisional bootstrap hostname' ;; esac
    ;;
  *) fail 'broker returned unknown identity_kind' ;;
esac

detect_live_components() {
  PACKAGES_STATE=ABSENT
  package_installed curl && package_installed ca-certificates && PACKAGES_STATE=COMPLIANT

  case "$(tailscale_self_state "$NODE_ID")" in
    RUNNING) TAILSCALE_STATE=COMPLIANT ;;
    ABSENT|NOT_LOGGED_IN) TAILSCALE_STATE=ABSENT ;;
    IDENTITY_MISMATCH) TAILSCALE_STATE=CONFLICT ;;
    DRIFT_REPAIRABLE) TAILSCALE_STATE=DRIFT_REPAIRABLE ;;
    *) TAILSCALE_STATE=UNKNOWN ;;
  esac

}
detect_live_components
case "$TAILSCALE_STATE" in
  *CONFLICT*|*UNKNOWN*) fail 'live ownership or identity conflict detected; refusing credential consumption' ;;
esac

SSH_HOST_KEY_SHA=

if [ "$TAILSCALE_STATE" != COMPLIANT ]; then
  printf '%s' "$TS_AUTHKEY" > /run/fleet/ts-authkey
  trap 'rm -f /run/fleet/ts-authkey' EXIT
  chmod 0600 /run/fleet/ts-authkey
  chown root:root /run/fleet/ts-authkey
  unset TS_AUTHKEY

  tailscale up --authkey=file:/run/fleet/ts-authkey --hostname "$NODE_ID"
  rm -f /run/fleet/ts-authkey
  trap - EXIT
  live_tailscale_ready "$NODE_ID" ||
    fail 'Tailscale is not ready after repair'
  TAILSCALE_STATE=COMPLIANT
  checkpoint_write VERIFY IN_PROGRESS
else
  unset TS_AUTHKEY
fi

SSH_HOST_KEY_SHA="$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}' || true)"

IDENTITY_EVIDENCE_B64=
IDENTITY_EVIDENCE_SHA=
if [ "$IDENTITY_KIND" = provisional ]; then
  EVIDENCE_FILE=/run/fleet/identity-evidence.txt
  : > "$EVIDENCE_FILE"
  evidence_line() {
    key="$1"; value="$2"
    encoded="$(printf '%s' "$value" | base64 -w0)"
    printf '%s\t%s\n' "$key" "$encoded" >> "$EVIDENCE_FILE"
  }
  bounded_file() {
    [ -r "$1" ] || return 0
    tr '\r\n\t' '   ' < "$1" | head -c 512
  }
  evidence_line schema fleet-hardware-evidence/v1
  evidence_line captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for field in sys_vendor product_name product_version product_serial product_uuid; do
    evidence_line "dmi.$field" "$(bounded_file "/sys/class/dmi/id/$field")"
  done
  evidence_line block "$(lsblk -dn -o NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,RM 2>/dev/null | head -c 8192 || true)"
  PCI_EVIDENCE=
  for dev in /sys/bus/pci/devices/*; do
    [ -d "$dev" ] || continue
    vendor="$(bounded_file "$dev/vendor")"
    device="$(bounded_file "$dev/device")"
    class="$(bounded_file "$dev/class")"
    PCI_EVIDENCE="$PCI_EVIDENCE$(basename "$dev") $vendor $device $class\n"
  done
  evidence_line pci "$PCI_EVIDENCE"
  IDENTITY_EVIDENCE_B64="$(base64 -w0 "$EVIDENCE_FILE")"
  [ \${#IDENTITY_EVIDENCE_B64} -le 65536 ] || fail 'identity evidence exceeds protected completion bound'
  IDENTITY_EVIDENCE_SHA="sha256:$(printf '%s' "$IDENTITY_EVIDENCE_B64" | sha256sum | awk '{print $1}')"
fi

REPORT_DIR="$CHECKPOINT_DIR"
install -d -m 0700 -o root -g root "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/enrollment-report.json"
BOOTSTRAP_VERSION="v2-r1-$(date -u +%Y%m%d)"
cat > "$REPORT_FILE" <<EOF
{
  "identity_kind": "$IDENTITY_KIND",
  "enrollment_id": "$ENROLLMENT_ID",
  "node_id": "$NODE_ID",
  "node_uid": "$NODE_UID",
  "os_id": "$OS_ID",
  "os_version_id": "$OS_VERSION_ID",
  "ssh_host_key_sha256": "$SSH_HOST_KEY_SHA",
  "bootstrap_version": "$BOOTSTRAP_VERSION"
}
EOF
chmod 0600 "$REPORT_FILE"
chown root:root "$REPORT_FILE"

if ! printf '{"resume_session":"%s","report":{"identity_kind":"%s","enrollment_id":"%s","node_id":"%s","os_id":"%s","os_version_id":"%s","ssh_host_key_sha256":"%s","bootstrap_version":"%s","identity_evidence_b64":"%s","identity_evidence_sha256":"%s"}}' "$RESUME_SESSION" "$IDENTITY_KIND" "$ENROLLMENT_ID" "$NODE_ID" "$OS_ID" "$OS_VERSION_ID" "$SSH_HOST_KEY_SHA" "$BOOTSTRAP_VERSION" "$IDENTITY_EVIDENCE_B64" "$IDENTITY_EVIDENCE_SHA" | curl -fsS --connect-timeout 10 --max-time 30 --header 'content-type: application/json' --data-binary @- "$BROKER_ORIGIN/v1/enroll/complete" >/dev/null; then
  fail 'completion report failed'
fi

checkpoint_write CHECKPOINT COMPLIANT

if [ "$IDENTITY_KIND" = provisional ]; then
  printf '%s\\n' "fleet-enroll: provisional bootstrap complete for $NODE_ID; durable identity finalization is pending"
else
  printf '%s\\n' "fleet-enroll: bootstrap complete for $NODE_ID ($NODE_UID)"
fi
`;
