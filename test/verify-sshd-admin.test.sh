#!/bin/sh
# Real OpenSSH configuration tests. Never starts, reloads or stops a daemon.
set -eu
SSHD_BIN=${SSHD_BIN:-/usr/sbin/sshd}
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT HUP INT TERM
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_key"
mkdir "$fixture_dir/sshd_config.d"
case_count=0

new_config() {
  rm -f "$fixture_dir/sshd_config.d/00-cloud-init.conf"
  cp "$repo_dir/config/sshd/00-ghostfleet-admin.conf.example" "$fixture_dir/sshd_config.d/00-ghostfleet-admin.conf"
  cat > "$fixture_dir/sshd_config" <<EOF
Port 2222
ListenAddress 127.0.0.1
HostKey $fixture_dir/host_key
PidFile $fixture_dir/sshd.pid
UsePAM no
# Simulate an OS-owned authentication baseline. The GhostFleet drop-in
# must override these only for root, not for ordinary accounts.
PasswordAuthentication yes
KbdInteractiveAuthentication yes
AuthenticationMethods any
PubkeyAuthentication no
Include $fixture_dir/sshd_config.d/*.conf
EOF
}

check_profile() {
  case_name=$1
  expected=$2
  # Negative cases must first be valid OpenSSH configurations, not syntax errors.
  "$SSHD_BIN" -t -f "$fixture_dir/sshd_config"
  "$SSHD_BIN" -T -f "$fixture_dir/sshd_config" -C user=root,host=localhost,addr=127.0.0.1 > "$fixture_dir/effective"
  actual=0
  SSHD_BIN="$SSHD_BIN" SSHD_CONFIG="$fixture_dir/sshd_config" \
    SSH_TEST_CONTEXT=user=root,host=localhost,addr=127.0.0.1 \
    sh "$repo_dir/scripts/verify-sshd-admin.sh" > "$fixture_dir/result" 2>&1 || actual=$?
  if [ "$actual" -ne "$expected" ]; then
    printf 'FAIL %s: expected exit %s, got %s\n' "$case_name" "$expected" "$actual" >&2
    cat "$fixture_dir/result" >&2
    exit 1
  fi
  if [ -n "${3:-}" ] && ! grep -F -- "$3" "$fixture_dir/result" >/dev/null; then
    printf 'FAIL %s: missing expected diagnostic\n' "$case_name" >&2
    cat "$fixture_dir/result" >&2
    exit 1
  fi
  case_count=$((case_count + 1))
  printf 'PASS %s\n' "$case_name"
}

effective_value() {
  context=$1
  keyword=$2
  "$SSHD_BIN" -T -f "$fixture_dir/sshd_config" -C "$context" |
    awk -v key="$keyword" '
      tolower($1) == key {
        $1 = ""
        sub(/^[[:space:]]+/, "")
        sub(/[[:space:]]+$/, "")
        print
        exit
      }'
}

expect_effective_value() {
  context=$1
  keyword=$2
  expected=$3
  actual=$(effective_value "$context" "$keyword")
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL effective %s for %s: expected "%s", got "%s"\n' "$keyword" "$context" "$expected" "$actual" >&2
    exit 1
  fi
  case_count=$((case_count + 1))
  printf 'PASS effective %s for %s = %s\n' "$keyword" "$context" "$actual"
}

prepend_config() {
  { printf '%s\n' "$@"; cat "$fixture_dir/sshd_config"; } > "$fixture_dir/sshd_config.new"
  mv "$fixture_dir/sshd_config.new" "$fixture_dir/sshd_config"
}

new_config
check_profile baseline 0
root_context=user=root,host=localhost,addr=127.0.0.1
ordinary_context=user=nobody,host=localhost,addr=127.0.0.1
expect_effective_value "$root_context" pubkeyauthentication yes
expect_effective_value "$root_context" passwordauthentication no
expect_effective_value "$root_context" kbdinteractiveauthentication no
expect_effective_value "$root_context" authenticationmethods publickey
expect_effective_value "$ordinary_context" pubkeyauthentication no
expect_effective_value "$ordinary_context" passwordauthentication yes
expect_effective_value "$ordinary_context" kbdinteractiveauthentication yes
expect_effective_value "$ordinary_context" authenticationmethods any

new_config
printf '%s\n' 'PasswordAuthentication yes' > "$fixture_dir/sshd_config.d/00-cloud-init.conf"
check_profile earlier-global-password-setting 0

new_config
printf '%s\n' 'Match User root' '    PasswordAuthentication yes' > "$fixture_dir/sshd_config.d/00-cloud-init.conf"
check_profile earlier-root-match-password-setting 1

new_config
printf '%s\n' 'Match User root' '    KbdInteractiveAuthentication yes' > "$fixture_dir/sshd_config.d/00-cloud-init.conf"
check_profile earlier-root-match-keyboard-authentication 1

new_config
printf '%s\n' 'HostbasedAuthentication yes' 'AuthenticationMethods publickey hostbased' > "$fixture_dir/sshd_config.d/00-cloud-init.conf"
check_profile earlier-global-alternative-authentication 0

new_config
printf '%s\n' 'Match User root' '    HostbasedAuthentication yes' '    AuthenticationMethods publickey hostbased' > "$fixture_dir/sshd_config.d/00-cloud-init.conf"
check_profile earlier-root-match-alternative-authentication 1

new_config
prepend_config 'PermitRootLogin yes' 'AllowGroups root ghostfleet_fixture_excluded'
check_profile omv-main-config-key-only-root 0

new_config
prepend_config 'PermitRootLogin yes' 'AllowGroups ghostfleet_fixture_excluded'
check_profile omv-main-config-excludes-root 1

new_config
printf '%s\n' 'AllowUsers nobody root' >> "$fixture_dir/sshd_config"
check_profile allowusers-root-second 0
new_config
printf '%s\n' 'DenyUsers nobody root' >> "$fixture_dir/sshd_config"
check_profile denyusers-root-second 1
new_config
printf '%s\n' 'AllowGroups ghostfleet_fixture_excluded root' >> "$fixture_dir/sshd_config"
check_profile allowgroups-root-second 0
new_config
printf '%s\n' 'DenyGroups ghostfleet_fixture_excluded root' >> "$fixture_dir/sshd_config"
check_profile denygroups-root-second 1

new_config
printf '%s\n' 'AllowUsers *' >> "$fixture_dir/sshd_config"
check_profile allowusers-star 0
new_config
printf '%s\n' 'DenyUsers *' >> "$fixture_dir/sshd_config"
check_profile denyusers-star 1
new_config
printf '%s\n' 'AllowGroups *' >> "$fixture_dir/sshd_config"
check_profile allowgroups-star 0
new_config
printf '%s\n' 'DenyGroups *' >> "$fixture_dir/sshd_config"
check_profile denygroups-star 1

new_config
printf '%s\n' 'DenyUsers root@127.0.0.1' >> "$fixture_dir/sshd_config"
check_profile user-at-host-remains-unknown 1 'UNKNOWN denyusers'
new_config
printf '%s\n' 'AllowUsers r*' >> "$fixture_dir/sshd_config"
check_profile partial-pattern-remains-unknown 1 'UNKNOWN allowusers'

new_config
for context in user=nobody,host=localhost,addr=127.0.0.1 user=root,user=nobody,host=localhost,addr=127.0.0.1; do
  actual=0
  SSHD_BIN="$SSHD_BIN" SSHD_CONFIG="$fixture_dir/sshd_config" SSH_TEST_CONTEXT="$context" \
    sh "$repo_dir/scripts/verify-sshd-admin.sh" > "$fixture_dir/result" 2>&1 || actual=$?
  [ "$actual" -eq 2 ] || { cat "$fixture_dir/result" >&2; exit 1; }
  case_count=$((case_count + 1))
  printf 'PASS reject-context %s\n' "$context"
done

printf 'SSHD_ADMIN_TESTS_OK cases=%s\n' "$case_count"
