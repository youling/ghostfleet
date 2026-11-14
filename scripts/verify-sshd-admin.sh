#!/bin/sh
set -eu
SSHD_BIN=${SSHD_BIN:-/usr/sbin/sshd}
SSHD_CONFIG=${SSHD_CONFIG:-}
SSH_TEST_CONTEXT=${SSH_TEST_CONTEXT:-user=root,host=localhost,addr=127.0.0.1}
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
value_list() { printf '%s\n' "$effective" | awk -v key="$1" '$1 == key { $1=""; sub(/^[[:space:]]+/, ""); print; exit }'; }
permit_root=$(value permitrootlogin)
pubkey=$(value pubkeyauthentication)
password=$(value passwordauthentication)
keyboard=$(value kbdinteractiveauthentication)
methods=$(value authenticationmethods)
allowgroups=$(value_list allowgroups)
allowusers=$(value_list allowusers)
denyusers=$(value_list denyusers)
denygroups=$(value_list denygroups)
root_groups=$(id -Gn root 2>/dev/null || true)
failed=0
case "$permit_root" in
  prohibit-password|without-password|yes)
    # "yes" is accepted only because the independent checks below require
    # publickey as the sole AuthenticationMethods entry and disable password
    # and keyboard-interactive authentication. This supports OMV's UI-managed
    # PermitRootLogin=yes setting without pretending a later drop-in wins.
    ;;
  *) echo "FAIL permitrootlogin: expected prohibit-password/without-password, or yes with publickey-only AuthenticationMethods; got '${permit_root:-missing}'" >&2; failed=1 ;;
esac
[ "$pubkey" = yes ] || { echo "FAIL pubkeyauthentication: got '${pubkey:-missing}'" >&2; failed=1; }
[ "$password" = no ] || { echo "FAIL passwordauthentication: got '${password:-missing}'" >&2; failed=1; }
[ "$keyboard" = no ] || { echo "FAIL kbdinteractiveauthentication: got '${keyboard:-missing}'" >&2; failed=1; }
[ "$methods" = publickey ] || { echo "FAIL authenticationmethods: expected exactly publickey; got '${methods:-missing}'" >&2; failed=1; }
if [ -n "$allowgroups" ]; then
  allowed=0
  for group in $allowgroups; do
    case " $root_groups " in *" $group "*) allowed=1 ;; esac
    [ "$group" = "*" ] && allowed=1
  done
  [ "$allowed" -eq 1 ] || { echo "FAIL allowgroups: root is not a member of any allowed group ('$allowgroups'; root groups: '$root_groups')" >&2; failed=1; }
fi
if [ -n "$allowusers" ]; then
  case " $allowusers " in *" root "*) ;; *) echo "FAIL allowusers: root is not explicitly allowed ('$allowusers')" >&2; failed=1 ;; esac
fi
case " $denyusers " in *" root "*) echo "FAIL denyusers: root is explicitly denied" >&2; failed=1 ;; esac
for group in $denygroups; do
  case " $root_groups " in *" $group "*) echo "FAIL denygroups: root belongs to denied group '$group'" >&2; failed=1 ;; esac
done
if [ "$failed" -ne 0 ]; then
  echo "ERROR: effective sshd policy does not admit a root public-key-only session." >&2
  echo "Inspect Include order, OMV Services > SSH settings, AllowGroups/AllowUsers, DenyUsers/DenyGroups and Match rules." >&2
  echo "No file was changed and no sshd reload/restart was attempted." >&2
  exit 1
fi
printf '%s\n' "SSHD_ADMIN_PROFILE_OK context=$SSH_TEST_CONTEXT permitrootlogin=$permit_root"
