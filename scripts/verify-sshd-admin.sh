#!/bin/sh
set -eu
SSHD_BIN=\${SSHD_BIN:-sshd}
SSHD_CONFIG=\${SSHD_CONFIG:-}
SSH_TEST_CONTEXT=\${SSH_TEST_CONTEXT:-user=root,host=localhost,addr=127.0.0.1}
if ! command -v "$SSHD_BIN" >/dev/null 2>&1; then
  echo "ERROR: sshd not found; install OpenSSH server first." >&2
  exit 2
fi
set --
if [ -n "$SSHD_CONFIG" ]; then set -- -f "$SSHD_CONFIG"; fi
if ! "$SSHD_BIN" -t "$@"; then
  echo "ERROR: sshd -t rejected the effective configuration; no reload attempted." >&2
  exit 1
fi
if ! effective=$("$SSHD_BIN" -T "$@" -C "$SSH_TEST_CONTEXT" 2>&1); then
  echo "ERROR: sshd -T could not evaluate context '$SSH_TEST_CONTEXT'." >&2
  printf '%s\n' "$effective" >&2
  exit 1
fi
value() { printf '%s\n' "$effective" | awk -v key="$1" '$1 == key { print $2; exit }'; }
permit_root=$(value permitrootlogin)
pubkey=$(value pubkeyauthentication)
password=$(value passwordauthentication)
keyboard=$(value kbdinteractiveauthentication)
methods=$(value authenticationmethods)
failed=0
case "$permit_root" in
  prohibit-password|without-password) ;;
  *) echo "FAIL permitrootlogin: expected prohibit-password/without-password; got '\${permit_root:-missing}'" >&2; failed=1 ;;
esac
[ "$pubkey" = yes ] || { echo "FAIL pubkeyauthentication: got '\${pubkey:-missing}'" >&2; failed=1; }
[ "$password" = no ] || { echo "FAIL passwordauthentication: got '\${password:-missing}'" >&2; failed=1; }
[ "$keyboard" = no ] || { echo "FAIL kbdinteractiveauthentication: got '\${keyboard:-missing}'" >&2; failed=1; }
[ "$methods" = publickey ] || { echo "FAIL authenticationmethods: got '\${methods:-missing}'" >&2; failed=1; }
if [ "$failed" -ne 0 ]; then
  echo "ERROR: effective sshd policy does not match GhostFleet admin profile." >&2
  echo "Inspect Include order, earlier drop-ins, Match rules and OS/vendor-managed config." >&2
  echo "No file was changed and no sshd reload/restart was attempted." >&2
  exit 1
fi
printf '%s\n' "SSHD_ADMIN_PROFILE_OK context=$SSH_TEST_CONTEXT"
