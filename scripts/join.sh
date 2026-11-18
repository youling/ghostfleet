#!/bin/sh
# GhostFleet Linux join bootstrap — POSIX sh, pinned by the generated Console command.
# It installs only Python 3 when absent, then verifies and runs the pinned reporter.
set -eu

INSTALLER_SHA256='__GHOSTFLEET_INSTALLER_SHA256__'
ORIGIN=
TICKET=
REPLACE=0
WORKDIR=

fail() {
  printf 'GF_JOIN_ERROR %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$WORKDIR" ]; then rm -rf "$WORKDIR"; fi
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --origin)
      [ "$#" -ge 2 ] || fail ORIGIN_ARGUMENT_REQUIRED
      ORIGIN=$2
      shift 2
      ;;
    --ticket)
      [ "$#" -ge 2 ] || fail TICKET_ARGUMENT_REQUIRED
      TICKET=$2
      shift 2
      ;;
    --replace)
      REPLACE=1
      shift
      ;;
    --help)
      printf '%s\n' 'Usage: join.sh --origin https://node.example.invalid --ticket ticket-... [--replace]'
      exit 0
      ;;
    *)
      fail UNSUPPORTED_ARGUMENT
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail ROOT_CEREMONY_REQUIRED
[ -t 0 ] || fail INTERACTIVE_TERMINAL_REQUIRED
[ -n "$TICKET" ] || fail TICKET_REQUIRED
case "$TICKET" in ticket-*) ;; *) fail INVALID_TICKET_SHAPE ;; esac
# OMV owns its package/configuration lifecycle. Its local read-only Phase 0 is
# an instance-owner gate and must happen before this generic bootstrap mutates packages.
if [ -e /etc/openmediavault/config.xml ] || command -v omv-salt >/dev/null 2>&1; then
  fail OMV_PHASE0_REQUIRED_BEFORE_PACKAGE_MUTATION
fi
case "$ORIGIN" in https://?*) authority=${ORIGIN#https://} ;; *) fail INVALID_HTTPS_ORIGIN ;; esac
case "$authority" in
  ''|*/*|*'?'*|*'#'*|*'@'*|*[!A-Za-z0-9.:-]*) fail INVALID_HTTPS_ORIGIN ;;
esac

python_ready() {
  [ -x /usr/bin/python3 ] || return 1
  /usr/bin/python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

if [ -x /usr/bin/python3 ]; then
  python_ready || fail PYTHON3_TOO_OLD_OR_BROKEN
else
  [ -r /etc/os-release ] || fail OS_RELEASE_REQUIRED
  . /etc/os-release
  distro_id=${ID:-}
  version_id=${VERSION_ID:-}
  major=${version_id%%.*}
  case "$major" in ''|*[!0-9]*) fail UNSUPPORTED_DISTRIBUTION_VERSION ;; esac

  case "$distro_id" in
    debian)
      [ "$major" -ge 12 ] || fail UNSUPPORTED_DEBIAN_VERSION
      command -v apt-get >/dev/null 2>&1 || fail APT_GET_NOT_FOUND
      printf '%s\n' 'GhostFleet: Python 3 missing; refreshing apt metadata and installing only python3.'
      apt-get update -qq || fail APT_UPDATE_FAILED
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 || fail APT_PYTHON3_INSTALL_FAILED
      ;;
    ubuntu)
      [ "$major" -ge 22 ] || fail UNSUPPORTED_UBUNTU_VERSION
      command -v apt-get >/dev/null 2>&1 || fail APT_GET_NOT_FOUND
      printf '%s\n' 'GhostFleet: Python 3 missing; refreshing apt metadata and installing only python3.'
      apt-get update -qq || fail APT_UPDATE_FAILED
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 || fail APT_PYTHON3_INSTALL_FAILED
      ;;
    fedora)
      [ "$major" -ge 40 ] || fail UNSUPPORTED_FEDORA_VERSION
      command -v dnf >/dev/null 2>&1 || fail DNF_NOT_FOUND
      printf '%s\n' 'GhostFleet: Python 3 missing; installing only python3 with dnf.'
      dnf install -y --setopt=install_weak_deps=False python3 || fail DNF_PYTHON3_INSTALL_FAILED
      ;;
    rhel|rocky|almalinux|ol|centos)
      [ "$major" -ge 10 ] || fail UNSUPPORTED_RHEL_FAMILY_VERSION
      command -v dnf >/dev/null 2>&1 || fail DNF_NOT_FOUND
      printf '%s\n' 'GhostFleet: Python 3 missing; installing only python3 with dnf.'
      dnf install -y --setopt=install_weak_deps=False python3 || fail DNF_PYTHON3_INSTALL_FAILED
      ;;
    *)
      fail UNSUPPORTED_DISTRIBUTION
      ;;
  esac
  python_ready || fail PYTHON3_INSTALL_DID_NOT_PROVIDE_SUPPORTED_RUNTIME
fi

command -v curl >/dev/null 2>&1 || fail CURL_REQUIRED
command -v sha256sum >/dev/null 2>&1 || fail SHA256SUM_REQUIRED
case "$INSTALLER_SHA256" in
  ''|*[!0-9a-f]*) fail INVALID_PINNED_INSTALLER_DIGEST ;;
esac
[ "${#INSTALLER_SHA256}" -eq 64 ] || fail INVALID_PINNED_INSTALLER_DIGEST

WORKDIR=$(mktemp -d /tmp/ghostfleet-join.XXXXXX) || fail TEMP_DIR_FAILED
printf '%s\n' 'GhostFleet: downloading the pinned standard-library reporter.'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 \
  --output "$WORKDIR/heartbeat.py" "$ORIGIN/bootstrap/$INSTALLER_SHA256.py" || fail INSTALLER_DOWNLOAD_FAILED
size=$(wc -c < "$WORKDIR/heartbeat.py") || fail INSTALLER_SIZE_READ_FAILED
[ "$size" -le 262144 ] || fail INSTALLER_TOO_LARGE
actual=$(sha256sum "$WORKDIR/heartbeat.py") || fail INSTALLER_HASH_CHECK_FAILED
actual=${actual%% *}
[ "$actual" = "$INSTALLER_SHA256" ] || fail INSTALLER_HASH_MISMATCH

printf '%s\n' 'GhostFleet: verified installer. Enter the one-time code when prompted; input is hidden.'
if [ "$REPLACE" -eq 1 ]; then
  /usr/bin/python3 -I "$WORKDIR/heartbeat.py" install --origin "$ORIGIN" --ticket "$TICKET" --replace
else
  /usr/bin/python3 -I "$WORKDIR/heartbeat.py" install --origin "$ORIGIN" --ticket "$TICKET"
fi
