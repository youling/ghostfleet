#!/usr/bin/env bash
# Youling Fleet — dedicated Linux privileged-operations lane (#127).
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

MODE="${1:-}"
case "$MODE" in
  --check|--apply) ;;
  *) echo "[fleet-privilege][ERROR] --check or --apply required" >&2; exit 2 ;;
esac
[[ $# -eq 1 ]] || { echo "[fleet-privilege][ERROR] no extra arguments accepted" >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { echo "[fleet-privilege][ERROR] Linux required" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || { echo "[fleet-privilege][ERROR] root required for authority-file inspection" >&2; exit 1; }

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HELPER_SRC="$SCRIPT_DIR/fleet_privctl.py"
ENTRY_SRC="$SCRIPT_DIR/fleet_privileged_ssh_entry.py"
HELPER_DIR=/usr/local/libexec/youling-fleet
HELPER_DST="$HELPER_DIR/fleet-privctl"
ENTRY_DST="$HELPER_DIR/fleet-privileged-ssh-entry"
OPS_USER=ghostfleet-ops
OPS_HOME=/var/lib/ghostfleet-ops
OPS_SSH_DIR="$OPS_HOME/.ssh"
AUTHORIZED_KEYS="$OPS_SSH_DIR/authorized_keys"
ETC_DIR=/etc/youling-fleet/privileged-operations
VAR_DIR=/var/lib/youling-fleet/privileged-operations
RECEIPT_DIR="$VAR_DIR/receipts"
STATE_FILE="$ETC_DIR/control.json"
SUDOERS_FILE=/etc/sudoers.d/90-youling-fleet-privileged-operations

die() { echo "[fleet-privilege][ERROR] $*" >&2; exit 1; }
for tool in python3 sha256sum sudo useradd usermod passwd visudo; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool required"
done
[[ -r "$HELPER_SRC" && -r "$ENTRY_SRC" ]] || die "helper sources missing"

normalize_public_key() {
  local file="$1" line alg blob extra
  [[ -r "$file" ]] || return 1
  line="$(grep -Ev '^[[:space:]]*(#|$)' "$file" | head -n1 || true)"
  [[ -n "$line" ]] || return 1
  IFS=$' \t' read -r alg blob extra <<<"$line"
  case "$alg" in
    ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ;;
    *) return 1 ;;
  esac
  [[ "$blob" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  printf '%s %s\n' "$alg" "$blob"
}

read_state_field() {
  local key="$1"
  [[ -r "$STATE_FILE" ]] || return 0
  python3 -I - "$STATE_FILE" "$key" <<'PY'
import json, pathlib, sys
try:
    value=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)
out=value.get(sys.argv[2]) if isinstance(value,dict) else None
if isinstance(out,str): print(out)
PY
}

valid_ordinary_user() {
  local user="$1"
  [[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || return 1
  [[ "$user" != root && "$user" != "$OPS_USER" ]] || return 1
  id "$user" >/dev/null 2>&1 && [[ "$(id -u "$user")" -ne 0 ]]
}

ORDINARY_USER="${FLEET_CONTROL_ORDINARY_USER:-$(read_state_field ordinary_user || true)}"
# Optional additive v3 pins. Existing v2 installs remain v2 until both are
# explicitly supplied; routine reapply preserves pins and cannot rotate them.
stored_generation="$(read_state_field generation || true)"
stored_profile="$(read_state_field profile_generation || true)"
GENERATION="${FLEET_PRIVILEGED_GENERATION:-$stored_generation}"
PROFILE_GENERATION="${FLEET_PRIVILEGED_PROFILE_GENERATION:-$stored_profile}"
if [[ -n "$GENERATION" || -n "$PROFILE_GENERATION" ]]; then
  [[ "$GENERATION" =~ ^[0-9a-f]{64}$ && "$PROFILE_GENERATION" =~ ^sha256:[0-9a-f]{64}$ ]] || die "invalid v3 generation pins"
  [[ -z "$stored_generation" || "$stored_generation" == "$GENERATION" ]] || die "generation rotation requires explicit procedure"
  [[ -z "$stored_profile" || "$stored_profile" == "$PROFILE_GENERATION" ]] || die "profile rotation requires explicit procedure"
fi
if [[ -n "$ORDINARY_USER" ]]; then
  valid_ordinary_user "$ORDINARY_USER" || die "invalid ordinary control user"
elif [[ "$MODE" == --apply ]]; then
  die "first --apply requires FLEET_CONTROL_ORDINARY_USER"
fi

digest() { [[ -r "$1" ]] && sha256sum "$1" | awk '{print $1}' || true; }
render_sudoers_digest() {
  cat <<EOF
# Managed by Youling Fleet; work legacy mechanism contract.
# binding=digest+root-owned-path
Defaults:$OPS_USER env_reset
$OPS_USER ALL=(root) NOPASSWD:NOSETENV: sha256:$1 $HELPER_DST
EOF
}
render_sudoers_path_only() {
  cat <<EOF
# Managed by Youling Fleet; work legacy mechanism contract.
# binding=root-owned-path-only (sudo/visudo digest syntax unavailable)
Defaults:$OPS_USER env_reset
$OPS_USER ALL=(root) NOPASSWD:NOSETENV: $HELPER_DST ""
EOF
}
render_authorized_key() {
  printf 'restrict,command="%s" %s youling-fleet-privileged-ops\n' "$ENTRY_DST" "$1"
}

regular_root_755() {
  [[ -f "$1" && ! -L "$1" && "$(stat -c '%U:%G:%a' "$1" 2>/dev/null || true)" == root:root:755 ]]
}
ops_account_ok() {
  id "$OPS_USER" >/dev/null 2>&1 || return 1
  [[ "$(id -u "$OPS_USER")" -ne 0 ]] || return 1
  [[ "$(getent passwd "$OPS_USER" | cut -d: -f6)" == "$OPS_HOME" ]] || return 1
  [[ "$(getent passwd "$OPS_USER" | cut -d: -f7)" == /bin/sh ]] || return 1
  passwd -S "$OPS_USER" 2>/dev/null | awk '{print $2}' | grep -Eq '^(L|LK)$'
}
print_state() {
  printf 'ORDINARY_USER=%s\n' "${ORDINARY_USER:-UNBOUND}"
  printf 'OPS_USER=%s\n' "$OPS_USER"
  ops_account_ok && echo 'OPS_ACCOUNT=COMPLIANT' || echo 'OPS_ACCOUNT=ABSENT_OR_DRIFT'
  regular_root_755 "$HELPER_DST" && echo 'HELPER=COMPLIANT' || echo 'HELPER=ABSENT_OR_DRIFT'
  regular_root_755 "$ENTRY_DST" && echo 'ENTRY=COMPLIANT' || echo 'ENTRY=ABSENT_OR_DRIFT'
  if [[ -r "$AUTHORIZED_KEYS" ]] && grep -Fq "restrict,command=\"$ENTRY_DST\"" "$AUTHORIZED_KEYS"; then
    echo 'AUTHORIZED_KEY=CONFIGURED'
  else
    echo 'AUTHORIZED_KEY=ABSENT_OR_DRIFT'
  fi
  if [[ -r "$SUDOERS_FILE" ]] && visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
    echo 'SUDOERS=CONFIGURED'
  else
    echo 'SUDOERS=ABSENT_OR_DRIFT'
  fi
  if [[ -n "$ORDINARY_USER" && -r "$SUDOERS_FILE" ]] && grep -Eq "^${ORDINARY_USER}[[:space:]]" "$SUDOERS_FILE"; then
    echo 'ORDINARY_USER_SUDO_GRANT=CONFLICT'
  else
    echo 'ORDINARY_USER_SUDO_GRANT=ABSENT'
  fi
}
if [[ "$MODE" == --check ]]; then print_state; exit 0; fi

PUB_FILE="${FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE:-}"
stored_pub=""
if [[ -r "$AUTHORIZED_KEYS" ]]; then
  stored_pub="$(awk '{
    for(i=1;i<=NF;i++) if($i ~ /^(ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)$/) {print $i" "$(i+1); exit}
  }' "$AUTHORIZED_KEYS" || true)"
fi
if [[ -n "$PUB_FILE" ]]; then
  input_pub="$(normalize_public_key "$PUB_FILE")" || die "invalid privileged SSH public key"
  [[ -z "$stored_pub" || "$stored_pub" == "$input_pub" ]] || die "key rotation requires explicit procedure"
elif [[ -n "$stored_pub" ]]; then
  input_pub="$stored_pub"
else
  die "first --apply requires FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE"
fi

assert_secure_root_dir() {
  local path="$1" meta mode
  [[ -d "$path" && ! -L "$path" ]] || die "unsafe directory $path"
  meta="$(stat -c '%U:%G:%a' "$path" 2>/dev/null || true)"
  [[ "$meta" == root:root:* ]] || die "non-root-owned directory $path"
  mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
  (( (8#$mode & 8#022) == 0 )) || die "group/world-writable directory $path"
}
ensure_root_dir_mode() {
  local path="$1" mode="$2"
  if [[ -e "$path" ]]; then
    assert_secure_root_dir "$path"
    [[ "$(stat -c '%a' "$path")" == "$mode" ]] || die "directory mode drift $path"
  else
    install -d -m "0$mode" -o root -g root "$path"
  fi
}
ensure_root_parent_dir_755_or_stricter() {
  local path="$1" mode
  if [[ -e "$path" ]]; then
    assert_secure_root_dir "$path"
    mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "directory mode drift $path"
    (( (8#$mode & 8#7000) == 0 )) || die "special mode bits forbidden $path"
    (( (8#$mode & 8#700) == 8#700 )) || die "directory owner mode drift $path"
    (( (8#$mode & 8#022) == 0 )) || die "group/world-writable directory $path"
  else
    install -d -m 0755 -o root -g root "$path"
  fi
}
assert_secure_root_dir /usr
assert_secure_root_dir /usr/local
ensure_root_dir_mode /usr/local/libexec 755
ensure_root_dir_mode "$HELPER_DIR" 755
ensure_root_parent_dir_755_or_stricter /etc/youling-fleet
ensure_root_dir_mode "$ETC_DIR" 755
ensure_root_parent_dir_755_or_stricter /var/lib/youling-fleet
ensure_root_dir_mode "$VAR_DIR" 700
ensure_root_dir_mode "$RECEIPT_DIR" 700

python3 -I - "$HELPER_SRC" "$ENTRY_SRC" <<'PY'
import pathlib, sys
for path in sys.argv[1:]:
    source=pathlib.Path(path).read_text(encoding="utf-8")
    compile(source,path,"exec")
PY
install -m 0755 -o root -g root "$HELPER_SRC" "$HELPER_DST"
install -m 0755 -o root -g root "$ENTRY_SRC" "$ENTRY_DST"

if ! id "$OPS_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$OPS_HOME" --shell /bin/sh "$OPS_USER"
fi
[[ "$(id -u "$OPS_USER")" -ne 0 ]] || die "ops account must not be root"
usermod --home "$OPS_HOME" --shell /bin/sh "$OPS_USER"
passwd -l "$OPS_USER" >/dev/null 2>&1 || die "cannot lock ops password"
chown root:root "$OPS_HOME"
chmod 0755 "$OPS_HOME"
install -d -m 0700 -o root -g root "$OPS_SSH_DIR"

expected_key="$(render_authorized_key "$input_pub")"

if [[ -r "$AUTHORIZED_KEYS" ]]; then
  existing="$(grep -Ev '^[[:space:]]*(#|$)' "$AUTHORIZED_KEYS" || true)"
  [[ "$existing" == "$expected_key" ]] || die "unexpected dedicated ops authorized_keys content"
fi
tmp="$(mktemp)"
printf '%s\n' "$expected_key" >"$tmp"
install -m 0600 -o root -g root "$tmp" "$AUTHORIZED_KEYS"
rm -f "$tmp"

helper_sha="$(digest "$HELPER_DST")"
entry_sha="$(digest "$ENTRY_DST")"
[[ "$helper_sha" =~ ^[0-9a-f]{64}$ && "$entry_sha" =~ ^[0-9a-f]{64}$ ]] || die "digest failure"

tmp_sudo="$(mktemp)"
tmp_sudo_err="$(mktemp)"
sudoers_binding="digest+root-owned-path"
render_sudoers_digest "$helper_sha" >"$tmp_sudo"
chmod 0440 "$tmp_sudo"
if ! visudo -cf "$tmp_sudo" >/dev/null 2>"$tmp_sudo_err"; then
  if grep -Fq 'digest specifications are not supported' "$tmp_sudo_err"; then
    sudoers_binding="root-owned-path-only"
    render_sudoers_path_only >"$tmp_sudo"
    chmod 0440 "$tmp_sudo"
    visudo -cf "$tmp_sudo" >/dev/null 2>"$tmp_sudo_err" || {
      cat "$tmp_sudo_err" >&2 || true
      rm -f "$tmp_sudo" "$tmp_sudo_err"
      die "sudoers fallback validation failed"
    }
  else
    cat "$tmp_sudo_err" >&2 || true
    rm -f "$tmp_sudo" "$tmp_sudo_err"
    die "sudoers validation failed"
  fi
fi
install -m 0440 -o root -g root "$tmp_sudo" "$SUDOERS_FILE"
rm -f "$tmp_sudo" "$tmp_sudo_err"

tmp_state="$(mktemp)"
python3 -I - "$tmp_state" "$ORDINARY_USER" "$OPS_USER" "$helper_sha" "$entry_sha" "$GENERATION" "$PROFILE_GENERATION" "$sudoers_binding" <<'PY'
import json, pathlib, sys
state = {
 "schema":"youling-fleet-privileged-operations-local/v2",
 "ordinary_user":sys.argv[2], "ops_user":sys.argv[3],
 "helper_sha256":sys.argv[4], "entry_sha256":sys.argv[5],
 "sudoers_binding":sys.argv[8],
}
if sys.argv[6]:
    state.update(generation=sys.argv[6], profile_generation=sys.argv[7])
pathlib.Path(sys.argv[1]).write_text(json.dumps(state,sort_keys=True,separators=(",",":"))+"\n",encoding="utf-8")
PY
install -m 0644 -o root -g root "$tmp_state" "$STATE_FILE"
rm -f "$tmp_state"

grep -Eq "^${ORDINARY_USER}[[:space:]]" "$SUDOERS_FILE" && die "ordinary user received Fleet sudo grant"
ops_account_ok || die "ops account postcondition failed"
regular_root_755 "$HELPER_DST" || die "helper postcondition failed"
regular_root_755 "$ENTRY_DST" || die "entry postcondition failed"
visudo -cf "$SUDOERS_FILE" >/dev/null || die "sudoers postcondition failed"

echo "[fleet-privilege] DEDICATED_PRIVILEGED_OPS_LANE_READY"
echo "SUDOERS_BINDING=$sudoers_binding"
print_state
