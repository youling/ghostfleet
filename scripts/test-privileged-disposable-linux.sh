#!/usr/bin/env bash
# Effectful Linux verification; GitHub-hosted ephemeral VM ONLY. No Fleet/NAS.
set -Eeuo pipefail
IFS=$'\n\t'
if [[ "$(id -u)" -ne 0 || "$GITHUB_ACTIONS" != true ||
      "$RUNNER_ENVIRONMENT" != github-hosted ||
      "$GHOSTFLEET_DISPOSABLE_TEST_CONFIRMED" != 1 ||
      -z "$GITHUB_WORKSPACE" ]]; then
  echo "DENIED: disposable GitHub-hosted root runner required" >&2
  exit 3
fi
if [[ -d /etc/openmediavault || -e /etc/openmediavault/config.xml ]]; then
  echo "DENIED: OMV must not be the disposable test target" >&2
  exit 3
fi
ordinary="$GHOSTFLEET_TEST_ORDINARY_USER"
[[ "$ordinary" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$ordinary" != root &&
   "$ordinary" != ghostfleet-ops ]] || exit 3
id "$ordinary" >/dev/null
if id ghostfleet-ops >/dev/null 2>&1 || [[ -e /etc/youling-fleet/privileged-operations/control.json ]]; then
  echo "DENIED: preexisting managed account or state" >&2
  exit 3
fi

root="$GITHUB_WORKSPACE/packages/runtime-python/src/ghostfleet_runtime/resources/fleet/10_platforms/linux/common/operations/privileged"
installer="$root/managed-linux-privileged-operations.sh"
[[ -r "$installer" && -r "$root/fleet_privctl.py" &&
   -r "$root/fleet_privileged_ssh_entry.py" ]] || exit 3
for tool in ssh-keygen python3 visudo sudo useradd usermod passwd; do
  command -v "$tool" >/dev/null || exit 3
done

private_dir="$(mktemp -d)"
trap 'rm -rf "$private_dir"' EXIT
chmod 0700 "$private_dir"
ssh-keygen -q -t ed25519 -N '' -C 'synthetic-fleet-CI' -f "$private_dir/key"
ssh-keygen -q -t ed25519 -N '' -C 'synthetic-unapproved-rotation' -f "$private_dir/other"
export FLEET_CONTROL_ORDINARY_USER="$ordinary"
export FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE="$private_dir/key.pub"

preflight="$(bash "$installer" --check)"
[[ "$preflight" == *"OPS_ACCOUNT=ABSENT_OR_DRIFT"* &&
   "$preflight" == *"AUTHORIZED_KEY=ABSENT_OR_DRIFT"* ]] || exit 1
! id ghostfleet-ops >/dev/null 2>&1 || { echo "Read-only check made an account" >&2; exit 1; }

bash "$installer" --apply >/dev/null
after="$(bash "$installer" --check)"
for expected in 'OPS_ACCOUNT=COMPLIANT' 'HELPER=COMPLIANT' 'ENTRY=COMPLIANT' \
                'AUTHORIZED_KEY=CONFIGURED' 'SUDOERS=CONFIGURED' \
                'ORDINARY_USER_SUDO_GRANT=ABSENT' 'OMV_SSH_GROUP=NOT_APPLICABLE'; do
  [[ "$after" == *"$expected"* ]] || { echo "Missing verified state: $expected" >&2; exit 1; }
done
[[ "$(id -u ghostfleet-ops)" -ne 0 ]] || exit 1
[[ "$(stat -c '%U:%G:%a' /var/lib/ghostfleet-ops/.ssh)" == root:root:700 ]] || exit 1
[[ "$(stat -c '%U:%G:%a' /var/lib/ghostfleet-ops/.ssh/authorized_keys)" == root:root:600 ]] || exit 1
[[ "$(stat -c '%U:%G:%a' /etc/sudoers.d/90-youling-fleet-privileged-operations)" == root:root:440 ]] || exit 1
line="$(cat /var/lib/ghostfleet-ops/.ssh/authorized_keys)"
[[ "$line" == restrict,command=\"/usr/local/libexec/youling-fleet/fleet-privileged-ssh-entry\"' ssh-ed25519 '* ]] || exit 1
visudo -cf /etc/sudoers.d/90-youling-fleet-privileged-operations >/dev/null

# Real negative evidence on this disposable VM: a valid restricted key
# must not conceal an extra unrestricted key or unsafe file permissions.
keys=/var/lib/ghostfleet-ops/.ssh/authorized_keys
cp "$keys" "$private_dir/authorized_keys.original"
cat "$private_dir/other.pub" >> "$keys"
unsafe="$(bash "$installer" --check)"
[[ "$unsafe" == *"AUTHORIZED_KEY=ABSENT_OR_DRIFT"* ]] || {
  echo "FAIL: extra unrestricted authorized key was reported configured" >&2
  exit 1
}
install -o root -g root -m 0600 "$private_dir/authorized_keys.original" "$keys"
[[ "$(bash "$installer" --check)" == *"AUTHORIZED_KEY=CONFIGURED"* ]] || exit 1
chmod 0644 "$keys"
unsafe="$(bash "$installer" --check)"
[[ "$unsafe" == *"AUTHORIZED_KEY=ABSENT_OR_DRIFT"* ]] || {
  echo "FAIL: group-readable authorized_keys was reported configured" >&2
  exit 1
}
chmod 0600 "$keys"
[[ "$(bash "$installer" --check)" == *"AUTHORIZED_KEY=CONFIGURED"* ]] || exit 1

# A valid target behind a symlink is not an admitted SSH identity.
# Run only within the guarded GitHub-hosted disposable Ubuntu VM.
install -o root -g root -m 0600 "$private_dir/authorized_keys.original" "$private_dir/authorized_keys.target"
rm "$keys"
ln -s "$private_dir/authorized_keys.target" "$keys"
unsafe="$(bash "$installer" --check)"
[[ "$unsafe" == *"AUTHORIZED_KEY=ABSENT_OR_DRIFT"* ]] || {
  echo "FAIL: symlinked authorized_keys was reported configured" >&2
  exit 1
}
cmp -s "$private_dir/authorized_keys.original" "$private_dir/authorized_keys.target" || exit 1
rm "$keys"
install -o root -g root -m 0600 "$private_dir/authorized_keys.target" "$keys"
[[ "$(bash "$installer" --check)" == *"AUTHORIZED_KEY=CONFIGURED"* ]] || exit 1

# A valid forced-command key under a group-writable parent directory is
# not an admitted identity, even when the key file itself remains 0600.
ops_home=/var/lib/ghostfleet-ops
[[ "$(stat -c '%a' "$ops_home")" == 755 ]] || exit 1
chmod 0775 "$ops_home"
unsafe="$(bash "$installer" --check)"
chmod 0755 "$ops_home"
[[ "$unsafe" == *"AUTHORIZED_KEY=ABSENT_OR_DRIFT"* ]] || {
  echo "FAIL: group-writable ops home was reported configured" >&2
  exit 1
}
[[ "$(bash "$installer" --check)" == *"AUTHORIZED_KEY=CONFIGURED"* ]] || exit 1

python3 -I - <<'PY'
import hashlib, json, pathlib
state=json.loads(pathlib.Path('/etc/youling-fleet/privileged-operations/control.json').read_text())
assert state['schema']=='youling-fleet-privileged-operations-local/v2'
assert state['ordinary_user'] not in ('', 'root', 'ghostfleet-ops')
for field,path in (
 ('helper_sha256','/usr/local/libexec/youling-fleet/fleet-privctl'),
 ('entry_sha256','/usr/local/libexec/youling-fleet/fleet-privileged-ssh-entry'),
):
 assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()==state[field]
PY

before_key="$(sha256sum /var/lib/ghostfleet-ops/.ssh/authorized_keys)"
before_state="$(sha256sum /etc/youling-fleet/privileged-operations/control.json)"
uid="$(id -u ghostfleet-ops)"
bash "$installer" --apply >/dev/null
[[ "$(id -u ghostfleet-ops)" == "$uid" ]] || exit 1
[[ "$(sha256sum /var/lib/ghostfleet-ops/.ssh/authorized_keys)" == "$before_key" ]] || exit 1
[[ "$(sha256sum /etc/youling-fleet/privileged-operations/control.json)" == "$before_state" ]] || exit 1

export FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE="$private_dir/other.pub"
if bash "$installer" --apply >/dev/null 2>&1; then
  echo "Unapproved key rotation succeeded" >&2; exit 1
fi
[[ "$(sha256sum /var/lib/ghostfleet-ops/.ssh/authorized_keys)" == "$before_key" ]] || exit 1
[[ "$(sha256sum /etc/youling-fleet/privileged-operations/control.json)" == "$before_state" ]] || exit 1

# The generation/profile identity pair must be well formed before ANY apply
# effect. Use the original approved key here so rotation denial cannot mask
# an incorrectly accepted malformed generation pin.
export FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE="$private_dir/key.pub"
if bad_pin_log="$(FLEET_PRIVILEGED_GENERATION="$(printf '%064d' 0)" \
  FLEET_PRIVILEGED_PROFILE_GENERATION='sha256:invalid' \
  bash "$installer" --apply 2>&1)"; then
  echo "Malformed v3 identity pin unexpectedly accepted" >&2
  exit 1
fi
[[ "$bad_pin_log" == *"invalid v3 generation pins"* ]] || {
  echo "Malformed v3 identity pin rejected for an unexpected reason" >&2
  exit 1
}
[[ "$(sha256sum /var/lib/ghostfleet-ops/.ssh/authorized_keys)" == "$before_key" ]] || exit 1
[[ "$(sha256sum /etc/youling-fleet/privileged-operations/control.json)" == "$before_state" ]] || exit 1
# Exercise the OMV-specific _ssh admission branch on THIS synthetic runner.
# An empty marker directory is not OMV; never create it outside this VM.
export FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE="$private_dir/key.pub"
before_ordinary_groups="$(id -nG "$ordinary")"
install -d -m 0755 /etc/openmediavault
if ! getent group _ssh >/dev/null 2>&1; then
  # Missing group must prevent apply; no sudoers/key drift may result.
  if bash "$installer" --apply >/dev/null 2>&1; then
    echo "OMV marker with missing _ssh group was accepted" >&2; exit 1
  fi
  [[ "$(sha256sum /var/lib/ghostfleet-ops/.ssh/authorized_keys)" == "$before_key" ]] || exit 1
  groupadd --system _ssh
fi
pre_omv="$(bash "$installer" --check)"
[[ "$pre_omv" == *"OMV_SSH_GROUP=NOT_MEMBER"* ]] || exit 1
bash "$installer" --apply >/dev/null
post_omv="$(bash "$installer" --check)"
[[ "$post_omv" == *"OMV_SSH_GROUP=MEMBER"* ]] || exit 1
id -nG ghostfleet-ops | tr ' ' '\n' | grep -qx '_ssh'
[[ "$(id -nG "$ordinary")" == "$before_ordinary_groups" ]] || exit 1
echo "PASS ephemeral Ubuntu real helper install/check/reapply/key-rotation-denial and synthetic OMV _ssh branch; actual OMV SSH/systemd/NAS NOT_RUN"
