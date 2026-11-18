#!/bin/sh
# GhostFleet one-time enrollment bootstrap v1.
# The build pins the Python installer; the Panel pins this complete shell file.
set -eu
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

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
  printf '%s\n' 'Usage: join.sh --origin https://example.invalid --ticket ticket-UUID [--replace]' >&2
}

origin=''
ticket=''
replace=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --origin)
      [ "$#" -ge 2 ] && [ -z "$origin" ] || { usage; fail INVALID_ARGUMENTS; }
      origin=$2; shift 2 ;;
    --ticket)
      [ "$#" -ge 2 ] && [ -z "$ticket" ] || { usage; fail INVALID_ARGUMENTS; }
      ticket=$2; shift 2 ;;
    --replace)
      [ "$replace" -eq 0 ] || { usage; fail INVALID_ARGUMENTS; }
      replace=1; shift ;;
    *)
      usage; fail INVALID_ARGUMENTS ;;
  esac
done

https_prefix='https://'
case "$origin" in
  "$https_prefix"[A-Za-z0-9]*) ;;
  *) fail INVALID_ORIGIN ;;
esac
case "$origin" in
  *[!A-Za-z0-9:/._-]*|"$https_prefix"*/*) fail INVALID_ORIGIN ;;
esac
hostport=${origin#"$https_prefix"}
case "$hostport" in
  *:*)
    host=${hostport%:*}; port=${hostport##*:}
    case "$host" in ''|*:*) fail INVALID_ORIGIN ;; esac
    case "$port" in ''|*[!0-9]*) fail INVALID_ORIGIN ;; esac
    [ "${#port}" -le 5 ] && [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || fail INVALID_ORIGIN ;;
esac
case "$ticket" in
  ticket-????????-????-4???-[89ab]???-????????????) ;;
  *) fail INVALID_TICKET ;;
esac
# The fixed positions above require four separators. Removing them must leave
# exactly 32 hex digits; an extra '-' inside a group must not reach apt/dnf/yum.
uuid_hex=$(printf '%s' "${ticket#ticket-}" | tr -d '-')
[ "${#uuid_hex}" -eq 32 ] || fail INVALID_TICKET
case "$uuid_hex" in
  *[!0-9a-f]*) fail INVALID_TICKET ;;
esac
case "$INSTALLER_SHA256" in
  *[!0-9a-f]*|'') fail INVALID_PINNED_INSTALLER ;;
esac
[ "${#INSTALLER_SHA256}" -eq 64 ] || fail INVALID_PINNED_INSTALLER
case "$INSTALLER_BYTES" in
  *[!0-9]*|'') fail INVALID_PINNED_INSTALLER ;;
esac
[ "${#INSTALLER_BYTES}" -le 6 ] && [ "$INSTALLER_BYTES" -gt 0 ] && [ "$INSTALLER_BYTES" -le 262144 ] || fail INVALID_PINNED_INSTALLER

[ "$(uname -s)" = Linux ] || fail LINUX_REQUIRED
[ -r /dev/tty ] && [ -t 0 ] || fail INTERACTIVE_TERMINAL_REQUIRED
command -v sha256sum >/dev/null 2>&1 || fail SHA256SUM_REQUIRED
if command -v curl >/dev/null 2>&1; then
  downloader=curl
elif command -v wget >/dev/null 2>&1; then
  downloader=wget
else
  fail CURL_OR_WGET_REQUIRED
fi

# OS metadata is a trusted local system file. Unknown distributions fail before
# privilege elevation or package effects, even on the Python-present fast path.
[ -r "$OS_RELEASE" ] || fail OS_RELEASE_UNAVAILABLE
# shellcheck disable=SC1090
. "$OS_RELEASE"
distro=${ID:-unknown}
case "$distro" in
  debian|ubuntu) family=debian; ca_bundle=$DEBIAN_CA ;;
  fedora|rhel|rocky|almalinux|centos|ol|amzn) family=redhat; ca_bundle=$REDHAT_CA ;;
  *) fail UNSUPPORTED_DISTRIBUTION ;;
esac
# TLS trust is needed to download this shim in the first place. Never promise
# to repair it after that download or bypass verification to reach a package.
[ -r "$ca_bundle" ] && [ -s "$ca_bundle" ] || fail CA_BUNDLE_REQUIRED

python_version_ok() {
  "$PYTHON3" -I -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}
needs_python=1
if [ -e "$PYTHON3" ] || [ -L "$PYTHON3" ]; then
  [ -x "$PYTHON3" ] || fail PYTHON3_NOT_EXECUTABLE
  python_version_ok || fail PYTHON3_VERSION_UNSUPPORTED
  needs_python=0
fi

package_manager=''
if [ "$needs_python" -eq 1 ]; then
  case "$family" in
    debian)
      command -v apt-get >/dev/null 2>&1 || fail PACKAGE_MANAGER_UNAVAILABLE
      package_manager=apt-get ;;
    redhat)
      if command -v dnf >/dev/null 2>&1; then
        package_manager=dnf
      elif command -v yum >/dev/null 2>&1; then
        package_manager=yum
      else
        fail PACKAGE_MANAGER_UNAVAILABLE
      fi ;;
  esac
fi

# Elevate the already verified local file only after all read-only preflight.
if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail ROOT_REQUIRED_RUN_IN_ROOT_SHELL
  if [ "$replace" -eq 1 ]; then
    exec sudo /bin/sh "$0" --origin "$origin" --ticket "$ticket" --replace
  else
    exec sudo /bin/sh "$0" --origin "$origin" --ticket "$ticket"
  fi
fi

tmp=$(mktemp -d /tmp/ghostfleet-join.XXXXXX) || fail TEMP_DIRECTORY_FAILED
chmod 0700 "$tmp"
cleanup() { rm -rf "$tmp"; }
trap cleanup 0
trap 'exit 130' HUP INT TERM

fetch_https() {
  url=$1
  destination=$2
  case "$downloader" in
    curl)
      # -q must be first: a user curlrc must not enable redirects or insecure TLS.
      status=$(curl -q -fsS --proto '=https' --tlsv1.2 --max-redirs 0 \
        --connect-timeout 10 --max-time 60 --cacert "$ca_bundle" \
        --max-filesize "$INSTALLER_BYTES" -w '%{http_code}' \
        -H 'User-Agent: GhostFleet-Bootstrap/1' "$url" -o "$destination") || return 1
      [ "$status" = 200 ] ;;
    wget)
      wget --no-config -q --https-only --max-redirect=0 --timeout=30 --tries=1 \
        --ca-certificate="$ca_bundle" -O "$destination" \
        --user-agent='GhostFleet-Bootstrap/1' "$url" ;;
  esac
}

if [ "$needs_python" -eq 1 ]; then
  printf '%s\n' 'GhostFleet: installing missing system Python 3 only.'
  case "$package_manager" in
    apt-get)
      DEBIAN_FRONTEND=noninteractive apt-get update -qq || fail APT_INDEX_UPDATE_FAILED
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends --no-upgrade python3 || fail APT_DEPENDENCY_INSTALL_FAILED ;;
    dnf)
      dnf -y -q --setopt=install_weak_deps=False install python3 || fail DNF_DEPENDENCY_INSTALL_FAILED ;;
    yum)
      yum -y -q install python3 || fail YUM_DEPENDENCY_INSTALL_FAILED ;;
  esac
else
  printf '%s\n' 'GhostFleet: Python 3.10+ already present; skipping package manager.'
fi

[ -x "$PYTHON3" ] || fail PYTHON3_STILL_MISSING
python_version_ok || fail PYTHON3_VERSION_UNSUPPORTED

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
