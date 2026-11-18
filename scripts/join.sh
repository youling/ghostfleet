#!/bin/sh
# GhostFleet one-time enrollment bootstrap v1.
# The build replaces the two installer constants; this file is then SHA-256
# addressed and verified by the Panel-generated command before execution.
set -eu
umask 077

INSTALLER_SHA256='@INSTALLER_SHA256@'
INSTALLER_BYTES='@INSTALLER_BYTES@'
PYTHON3='/usr/bin/python3'
OS_RELEASE='/etc/os-release'
DEBIAN_CA='/etc/ssl/certs/ca-certificates.crt'
REDHAT_CA='/etc/pki/tls/certs/ca-bundle.crt'

fail() {
  printf 'GF_BOOTSTRAP_ERROR %s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' 'Usage: join.sh --origin https://host --ticket ticket-UUID [--replace]' >&2
}

origin=''
ticket=''
replace=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --origin)
      [ "$#" -ge 2 ] || { usage; fail INVALID_ARGUMENTS; }
      origin=$2; shift 2 ;;
    --ticket)
      [ "$#" -ge 2 ] || { usage; fail INVALID_ARGUMENTS; }
      ticket=$2; shift 2 ;;
    --replace)
      [ "$replace" -eq 0 ] || { usage; fail INVALID_ARGUMENTS; }
      replace=1; shift ;;
    *)
      usage; fail INVALID_ARGUMENTS ;;
  esac
done

case "$origin" in
  https://*) ;;
  *) fail INVALID_ORIGIN ;;
esac
case "$origin" in
  *[!A-Za-z0-9:/._-]*|https://*/*) fail INVALID_ORIGIN ;;
esac
case "$ticket" in
  ticket-????????-????-4???-????-????????????) ;;
  *) fail INVALID_TICKET ;;
esac
case "$ticket" in
  *[!0-9a-f-]*) fail INVALID_TICKET ;;
esac
case "$INSTALLER_SHA256" in
  *[!0-9a-f]*|'') fail INVALID_PINNED_INSTALLER ;;
esac
[ "${#INSTALLER_SHA256}" -eq 64 ] || fail INVALID_PINNED_INSTALLER
case "$INSTALLER_BYTES" in
  *[!0-9]*|'') fail INVALID_PINNED_INSTALLER ;;
esac
[ "$INSTALLER_BYTES" -gt 0 ] && [ "$INSTALLER_BYTES" -le 262144 ] || fail INVALID_PINNED_INSTALLER

# The verified shell file may be launched by an ordinary operator account.
# Elevate this exact local file, not an unverified network stream.
if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo /bin/sh "$0" --origin "$origin" --ticket "$ticket" ${replace:+}
  fi
  fail ROOT_REQUIRED_RUN_IN_ROOT_SHELL
fi

[ -r /dev/tty ] || fail INTERACTIVE_TERMINAL_REQUIRED
command -v sha256sum >/dev/null 2>&1 || fail SHA256SUM_REQUIRED

tmp=$(mktemp -d "${TMPDIR:-/tmp}/ghostfleet-join.XXXXXX") || fail TEMP_DIRECTORY_FAILED
chmod 0700 "$tmp"
cleanup() { rm -rf "$tmp"; }
trap cleanup 0
trap 'exit 130' HUP INT TERM

fetch_https() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --proto '=https' --tlsv1.2 --max-redirs 0 \
      -H 'User-Agent: GhostFleet-Bootstrap/1' "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$destination" --user-agent='GhostFleet-Bootstrap/1' "$url"
  else
    fail CURL_OR_WGET_REQUIRED
  fi
}

# Validate the platform even when dependencies happen to exist. This keeps the
# bootstrap's supported-host contract explicit and avoids guessing package APIs.
[ -r "$OS_RELEASE" ] || fail OS_RELEASE_UNAVAILABLE
# shellcheck disable=SC1090
. "$OS_RELEASE"
distro=${ID:-unknown}
case "$distro" in
  debian|ubuntu)
    package_manager=apt-get
    ca_bundle=$DEBIAN_CA ;;
  fedora|rhel|rocky|almalinux|centos|ol|amzn)
    package_manager=dnf
    ca_bundle=$REDHAT_CA ;;
  *)
    fail UNSUPPORTED_DISTRIBUTION ;;
esac

packages=''
[ -x "$PYTHON3" ] || packages="$packages python3"
[ -s "$ca_bundle" ] || packages="$packages ca-certificates"

if [ -n "$packages" ]; then
  command -v "$package_manager" >/dev/null 2>&1 || fail PACKAGE_MANAGER_UNAVAILABLE
  printf '%s\n' 'GhostFleet: installing only missing bootstrap prerequisites.'
  case "$package_manager" in
    apt-get)
      # Refresh package indexes only. --no-upgrade prevents replacing already
      # installed packages; no upgrade/dist-upgrade or repository mutation.
      DEBIAN_FRONTEND=noninteractive apt-get update -qq || fail APT_INDEX_UPDATE_FAILED
      # Intentional word splitting: packages contains only the two fixed names.
      # shellcheck disable=SC2086
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends --no-upgrade $packages || fail APT_DEPENDENCY_INSTALL_FAILED
      ;;
    dnf)
      # Install only missing prerequisites; never run a system-wide dnf upgrade.
      # shellcheck disable=SC2086
      dnf -y -q --setopt=install_weak_deps=False install $packages || fail DNF_DEPENDENCY_INSTALL_FAILED
      ;;
  esac
else
  printf '%s\n' 'GhostFleet: Python and CA bundle already present; skipping package manager.'
fi

[ -x "$PYTHON3" ] || fail PYTHON3_STILL_MISSING
[ -s "$ca_bundle" ] || fail CA_BUNDLE_STILL_MISSING

installer_url="$origin/bootstrap/$INSTALLER_SHA256.py"
installer_file="$tmp/installer.py"
fetch_https "$installer_url" "$installer_file" || fail INSTALLER_DOWNLOAD_FAILED
actual_bytes=$(wc -c < "$installer_file" | tr -d '[:space:]')
[ "$actual_bytes" = "$INSTALLER_BYTES" ] || fail INSTALLER_SIZE_MISMATCH
actual_sha=$(sha256sum "$installer_file" | awk '{print $1}')
[ "$actual_sha" = "$INSTALLER_SHA256" ] || fail INSTALLER_HASH_MISMATCH

printf '%s\n' 'GhostFleet: verified installer; entering one-time enrollment.'
set -- "$PYTHON3" -I "$installer_file" install --origin "$origin" --ticket "$ticket"
[ "$replace" -eq 0 ] || set -- "$@" --replace
"$@"
