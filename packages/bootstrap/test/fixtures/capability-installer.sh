#!/usr/bin/env bash
# Synthetic stand-in for the reviewed privileged-operations installer artifact.
# It keeps the published installer's --check/--apply contract and state markers
# so the courier's selection, verification and idempotency logic is exercised
# unchanged. It never touches a real account, key, sudoers file or service.
set -u
mode="${1:-}"
state="${FIXTURE_STATE:?FIXTURE_STATE is required}"
record() { printf '%s\n' "$*" >> "$state/installer.log"; }
[ -n "${FLEET_CONTROL_ORDINARY_USER:-}" ] || { printf 'missing ordinary user\n' >&2; exit 11; }
[ -r "${FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE:-/nonexistent}" ] || { printf 'missing privileged key\n' >&2; exit 12; }
key_sha="$(sha256sum "$FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE" | awk '{print $1}')"
record "installer $mode user=$FLEET_CONTROL_ORDINARY_USER key=$key_sha"

print_state() {
  printf 'ORDINARY_USER=%s\n' "$FLEET_CONTROL_ORDINARY_USER"
  printf 'OPS_USER=ghostfleet-ops\n'
  if [ -f "$state/installed.json" ] && grep -q '"complete":true' "$state/installed.json" && [ ! -f "$state/drift" ]; then
    printf 'OPS_ACCOUNT=COMPLIANT\n'
    printf 'HELPER=COMPLIANT\n'
    printf 'ENTRY=COMPLIANT\n'
    printf 'AUTHORIZED_KEY=CONFIGURED\n'
    printf 'SUDOERS=CONFIGURED\n'
    printf 'ORDINARY_USER_SUDO_GRANT=ABSENT\n'
  elif [ -f "$state/installed.json" ]; then
    # A half-applied install: the dedicated account exists but the helper,
    # entry, key and sudoers are not proven. It must read as drift, never as
    # completion.
    printf 'OPS_ACCOUNT=COMPLIANT\n'
    printf 'HELPER=ABSENT_OR_DRIFT\n'
    printf 'ENTRY=ABSENT_OR_DRIFT\n'
    printf 'AUTHORIZED_KEY=ABSENT_OR_DRIFT\n'
    printf 'SUDOERS=ABSENT_OR_DRIFT\n'
    printf 'ORDINARY_USER_SUDO_GRANT=ABSENT\n'
  else
    printf 'OPS_ACCOUNT=ABSENT_OR_DRIFT\n'
    printf 'HELPER=ABSENT_OR_DRIFT\n'
    printf 'ENTRY=ABSENT_OR_DRIFT\n'
    printf 'AUTHORIZED_KEY=ABSENT_OR_DRIFT\n'
    printf 'SUDOERS=ABSENT_OR_DRIFT\n'
    printf 'ORDINARY_USER_SUDO_GRANT=ABSENT\n'
  fi
}

case "$mode" in
  --check) print_state ;;
  --apply)
    applies=0
    if [ -f "$state/applies" ]; then applies="$(cat "$state/applies")"; fi
    applies=$((applies + 1))
    printf '%s' "$applies" > "$state/applies"
    if [ "${FAKE_INSTALLER_FAIL:-0}" = 1 ]; then
      printf '{"partial":true,"applies":%s}\n' "$applies" > "$state/installed.json"
      record "installer apply failed"
      exit 21
    fi
    # Stands in for a reviewed installer that drifts after review: it grants the
    # run account a root-equivalent group while it runs as root.
    if [ -n "${FAKE_INSTALLER_GRANT_ACCOUNT:-}" ]; then
      mkdir -p "$state/groups"
      printf '%s docker\n' "$FAKE_INSTALLER_GRANT_ACCOUNT" > "$state/groups/$FAKE_INSTALLER_GRANT_ACCOUNT"
    fi
    rm -f "$state/drift"
    printf '{"complete":true,"ordinary_user":"%s","key_sha256":"%s","applies":%s}\n' \
      "$FLEET_CONTROL_ORDINARY_USER" "$key_sha" "$applies" > "$state/installed.json"
    print_state
    ;;
  *) printf 'mode required\n' >&2; exit 2 ;;
esac
