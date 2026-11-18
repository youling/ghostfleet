#!/bin/sh
# Synthetic tests for the POSIX join bootstrap. CI runs this harness as root;
# temporary copies substitute only OS/package paths and disable the TTY check.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir -p "$fixture/bin" "$fixture/root" "$fixture/tmp"
installer_source="$fixture/installer.py"
printf '%s\n' 'synthetic pinned installer payload' > "$installer_source"
installer_sha=$(sha256sum "$installer_source" | awk '{print $1}')
installer_bytes=$(wc -c < "$installer_source" | tr -d '[:space:]')
python_path="$fixture/root/bin/python3"
template="$repo_dir/scripts/join.sh"
script="$fixture/join.sh"
log="$fixture/commands.log"

sed \
  -e "s|@INSTALLER_SHA256@|$installer_sha|g" \
  -e "s|@INSTALLER_BYTES@|$installer_bytes|g" \
  -e "s|/usr/bin/python3|$python_path|g" \
  -e "s|/etc/os-release|$fixture/root/os-release|g" \
  -e "s|/etc/ssl/certs/ca-certificates.crt|$fixture/root/debian-ca.crt|g" \
  -e "s|/etc/pki/tls/certs/ca-bundle.crt|$fixture/root/redhat-ca.crt|g" \
  -e "s|PATH=/usr/sbin:/usr/bin:/sbin:/bin|PATH=$fixture/bin:/usr/bin:/bin|g" \
  -e "s|\[ -r /dev/tty \] && \[ -t 0 \] || fail INTERACTIVE_TERMINAL_REQUIRED|: # TTY is covered by the production guard|g" \
  "$template" > "$script"
chmod 0700 "$script"

cat > "$fixture/bin/curl" <<'EOF'
#!/bin/sh
set -eu
out=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ]
printf '%s\n' curl >> "$GF_TEST_LOG"
cp "$GF_TEST_INSTALLER_SOURCE" "$out"
EOF
chmod 0755 "$fixture/bin/curl"

cat > "$fixture/bin/wget" <<'EOF'
#!/bin/sh
set -eu
out=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -O) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ]
printf '%s\n' wget >> "$GF_TEST_LOG"
cp "$GF_TEST_INSTALLER_SOURCE" "$out"
EOF
chmod 0755 "$fixture/bin/wget"

cat > "$fixture/bin/apt-get" <<'EOF'
#!/bin/sh
set -eu
printf 'apt-get %s\n' "$*" >> "$GF_TEST_LOG"
case "$1" in
  update)
    [ "${GF_APT_UPDATE_RC:-0}" -eq 0 ] || exit 17
    ;;
  install)
    [ "${GF_APT_INSTALL_RC:-0}" -eq 0 ] || exit 18
    mkdir -p "$(dirname "$GF_TEST_PYTHON")"
    cat > "$GF_TEST_PYTHON" <<'PY'
#!/bin/sh
printf 'python3 %s\n' "$*" >> "$GF_TEST_LOG"
PY
    chmod 0755 "$GF_TEST_PYTHON"
    ;;
  *) exit 19 ;;
esac
EOF
chmod 0755 "$fixture/bin/apt-get"

cat > "$fixture/bin/dnf" <<'EOF'
#!/bin/sh
set -eu
printf 'dnf %s\n' "$*" >> "$GF_TEST_LOG"
[ "$1" = '-y' ] || exit 20
case "$*" in
  *' install '*)
    [ "${GF_DNF_INSTALL_RC:-0}" -eq 0 ] || exit 21
    mkdir -p "$(dirname "$GF_TEST_PYTHON")"
    cat > "$GF_TEST_PYTHON" <<'PY'
#!/bin/sh
printf 'python3 %s\n' "$*" >> "$GF_TEST_LOG"
PY
    chmod 0755 "$GF_TEST_PYTHON"
    ;;
  *) exit 22 ;;
esac
EOF
chmod 0755 "$fixture/bin/dnf"

export GF_TEST_LOG="$log"
export GF_TEST_INSTALLER_SOURCE="$installer_source"
export GF_TEST_PYTHON="$python_path"
export TMPDIR="$fixture/tmp"
PATH="$fixture/bin:/usr/bin:/bin"
export PATH

reset_case() {
  rm -f "$log" "$python_path" "$fixture/root/debian-ca.crt" "$fixture/root/redhat-ca.crt"
  : > "$log"
  unset GF_APT_UPDATE_RC GF_APT_INSTALL_RC GF_DNF_INSTALL_RC
}
run_ok() {
  if ! "$script" --origin https://node.example.invalid --ticket ticket-11111111-1111-4111-8111-111111111111 "$@" > "$fixture/stdout" 2> "$fixture/stderr"; then
    cat "$fixture/stdout" "$fixture/stderr" >&2
    return 1
  fi
  grep -F 'python3 -I' "$log" >/dev/null
  ! grep -E '(^|[[:space:]])(upgrade|dist-upgrade)([[:space:]]|$)' "$log" >/dev/null
  ! grep -E '(^|[[:space:]])(ssh|systemctl|tailscale|cloudflared)([[:space:]]|$)' "$log" >/dev/null
  ! grep -F '12345678' "$log" >/dev/null
}
run_fail() {
  expected=$1
  shift
  if "$script" --origin https://node.example.invalid --ticket ticket-11111111-1111-4111-8111-111111111111 > "$fixture/stdout" 2> "$fixture/stderr"; then
    printf 'expected failure %s but command succeeded\n' "$expected" >&2
    exit 1
  fi
  grep -F "GF_BOOTSTRAP_ERROR $expected" "$fixture/stderr" >/dev/null || {
    cat "$fixture/stdout" "$fixture/stderr" >&2
    exit 1
  }
}

# Existing Python + CA bundle: fast path must not call apt or dnf.
reset_case
printf 'ID=debian\n' > "$fixture/root/os-release"
: > "$fixture/root/debian-ca.crt"
mkdir -p "$fixture/root/bin"
cat > "$python_path" <<'PY'
#!/bin/sh
printf 'python3 %s\n' "$*" >> "$GF_TEST_LOG"
PY
chmod 0755 "$python_path"
run_ok --replace
! grep -E '^(apt-get|dnf) ' "$log" >/dev/null
grep -F -- '--replace' "$log" >/dev/null
printf 'PASS python-present-fast-path\n'

# Debian minimal image: install only python3; no broad upgrade.
reset_case
printf 'ID=debian\n' > "$fixture/root/os-release"
run_ok
grep -F 'apt-get update -qq' "$log" >/dev/null
grep -F 'apt-get install -y -qq --no-install-recommends --no-upgrade python3' "$log" >/dev/null
printf 'PASS debian-missing-python\n'

# Debian missing Python and CA bundle: both fixed packages are requested.
reset_case
printf 'ID=ubuntu\n' > "$fixture/root/os-release"
run_ok
grep -F 'python3 ca-certificates' "$log" >/dev/null
printf 'PASS debian-missing-ca-bundle\n'

# Fedora/RHEL-family uses DNF and does not call apt.
reset_case
printf 'ID=fedora\n' > "$fixture/root/os-release"
run_ok
grep -F 'dnf -y -q --setopt=install_weak_deps=False install python3' "$log" >/dev/null
! grep -F 'apt-get ' "$log" >/dev/null
printf 'PASS dnf-missing-python\n'

# Unsupported distro fails before any package manager or installer download.
reset_case
printf 'ID=alpine\n' > "$fixture/root/os-release"
run_fail UNSUPPORTED_DISTRIBUTION
[ ! -s "$log" ]
printf 'PASS unsupported-distro-fails-closed\n'

# apt index failure stops before install, download, or ticket claim.
reset_case
printf 'ID=debian\n' > "$fixture/root/os-release"
GF_APT_UPDATE_RC=1
export GF_APT_UPDATE_RC
run_fail APT_INDEX_UPDATE_FAILED
! grep -F 'apt-get install' "$log" >/dev/null
! grep -F 'curl' "$log" >/dev/null
printf 'PASS apt-index-failure-stops\n'

# apt package failure stops before download/claim.
reset_case
printf 'ID=debian\n' > "$fixture/root/os-release"
GF_APT_INSTALL_RC=1
export GF_APT_INSTALL_RC
run_fail APT_DEPENDENCY_INSTALL_FAILED
! grep -F 'curl' "$log" >/dev/null
printf 'PASS apt-install-failure-stops\n'

# The bootstrap itself contains no SSH/provider/OMV mutation or upgrade command.
if grep -E 'apt-get[[:space:]]+(upgrade|dist-upgrade)|dnf[[:space:]]+upgrade|authorized_keys|systemctl|tailscale|cloudflared|omv-rpc|/etc/ssh' "$template" >/dev/null; then
  printf 'bootstrap contains a forbidden host/provider mutation\n' >&2
  exit 1
fi
printf 'JOIN_BOOTSTRAP_TESTS_OK cases=7\n'
