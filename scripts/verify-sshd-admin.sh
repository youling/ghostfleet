#!/bin/sh
set -eu
# Never expand sshd's wildcard tokens against the current working directory.
set -f
SSHD_BIN=${SSHD_BIN:-/usr/sbin/sshd}
SSHD_CONFIG=${SSHD_CONFIG:-}
SSH_TEST_CONTEXT=${SSH_TEST_CONTEXT:-user=root,host=localhost,addr=127.0.0.1}
# Evaluate the effective root context, including Match User root. Non-root
# authentication policy is deliberately left to the operating system.
if ! printf '%s\n' "$SSH_TEST_CONTEXT" | awk -F, '
  { for (i=1; i<=NF; i++) if ($i ~ /^user=/) { count++; user=$i } }
  END { exit !(count == 1 && user == "user=root") }'; then
  echo "ERROR: the admin verifier requires exactly one user=root in SSH_TEST_CONTEXT." >&2
  exit 2
fi
if ! command -v "$SSHD_BIN" >/dev/null 2>&1; then
  echo "ERROR: sshd not found; install OpenSSH server first." >&2
  exit 2
fi
set --
if [ -n "$SSHD_CONFIG" ]; then set -- -f "$SSHD_CONFIG"; fi
if ! "$SSHD_BIN" -t "$@"; then
  echo "ERROR: sshd -t rejected the configuration; no reload attempted." >&2
  exit 1
fi
if ! effective=$("$SSHD_BIN" -T "$@" -C "$SSH_TEST_CONTEXT" 2>&1); then
  echo "ERROR: sshd -T could not evaluate context '$SSH_TEST_CONTEXT'." >&2
  printf '%s\n' "$effective" >&2
  exit 1
fi
# Preserve complete values AND repeated list directives. Keyword case may vary
# between OpenSSH dump versions; arguments remain case-sensitive.
value() {
  printf '%s\n' "$effective" | awk -v key="$1" '
    tolower($1) == key {
      $1 = ""
      sub(/^[[:space:]]+/, "")
      sub(/[[:space:]]+$/, "")
      print
    }'
}
permit_root=$(value permitrootlogin)
pubkey=$(value pubkeyauthentication)
password=$(value passwordauthentication)
keyboard=$(value kbdinteractiveauthentication)
methods=$(value authenticationmethods)
failed=0
case "$permit_root" in
  prohibit-password|without-password|yes) ;;
  *) echo "FAIL permitrootlogin: root login is not enabled" >&2; failed=1 ;;
esac
[ "$pubkey" = yes ] || { echo "FAIL pubkeyauthentication: expected yes" >&2; failed=1; }
[ "$password" = no ] || { echo "FAIL passwordauthentication: expected no" >&2; failed=1; }
[ "$keyboard" = no ] || { echo "FAIL kbdinteractiveauthentication: expected no" >&2; failed=1; }
[ "$methods" = publickey ] || { echo "FAIL authenticationmethods: expected exactly publickey; got '${methods:-missing}'" >&2; failed=1; }

if ! root_groups=$(id -Gn root); then
  echo "ERROR: could not resolve root's group membership." >&2
  exit 2
fi

# A bounded static check, not OpenSSH's pattern/login engine. Exact names and a
# standalone '*' are supported; any other pattern remains UNKNOWN.
check_admission() {
  directive=$1
  members=$2
  entries=$(value "$directive")
  [ -n "$entries" ] || return 0
  matched=0
  unknown=0
  for entry in $entries; do
    if [ "$entry" = '*' ]; then
      matched=1
    elif printf '%s\n' "$entry" | LC_ALL=C awk '/^[A-Za-z0-9_.-]+[$]?$/ { ok=1 } END { exit !ok }'; then
      for member in $members; do
        [ "$entry" != "$member" ] || matched=1
      done
    else
      echo "UNKNOWN $directive: unsupported pattern; use OpenSSH login evidence." >&2
      unknown=1
    fi
  done
  if [ "$unknown" -ne 0 ]; then
    failed=1
    return 0
  fi
  case "$directive" in
    allow*) [ "$matched" -eq 1 ] || { echo "FAIL $directive: no matching root identity" >&2; failed=1; } ;;
    deny*) [ "$matched" -eq 0 ] || { echo "FAIL $directive: root identity is denied" >&2; failed=1; } ;;
  esac
}
check_admission allowusers root
check_admission denyusers root
check_admission allowgroups "$root_groups"
check_admission denygroups "$root_groups"

if [ "$failed" -ne 0 ]; then
  echo "ERROR: root public-key profile failed or admission pattern is UNKNOWN." >&2
  echo "Inspect effective Include/Match and OS/vendor-managed settings; do not edit generated files blindly." >&2
  echo "No file was changed and no sshd reload/restart was attempted." >&2
  exit 1
fi
printf '%s\n' "SSHD_ADMIN_PROFILE_OK context=$SSH_TEST_CONTEXT permitrootlogin=$permit_root"
printf '%s\n' "NON_ROOT_AUTH_POLICY=OS_OWNED_NOT_ASSERTED"
printf '%s\n' "LOGIN_NOT_TESTED: authorized_keys, PAM/account state, forced commands and live sessions require separate evidence."
