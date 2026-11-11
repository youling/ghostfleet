export const BOOTSTRAP_SH = `#!/bin/sh
set -eu
# Debian-family admin tools commonly live under sbin, including in sudo shells.
PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

BROKER_ORIGIN="\${GHOSTFLEET_BROKER_ORIGIN:-}"
ENROLLMENT_URL="\${GHOSTFLEET_ENROLLMENT_URL:-}"
if [ -n "$ENROLLMENT_URL" ]; then
  ENROLLMENT_SCHEME="\${ENROLLMENT_URL%%:*}"
  [ "$ENROLLMENT_SCHEME" = https ] || { printf '%s\\n' 'fleet-enroll: invalid one-time enrollment URL scheme' >&2; exit 1; }
  case "$ENROLLMENT_URL" in
    */v1/enrollment-tickets/*) ;;
    *) printf '%s\\n' 'fleet-enroll: invalid one-time enrollment URL path' >&2; exit 1 ;;
  esac
  [ -n "$BROKER_ORIGIN" ] || BROKER_ORIGIN="\${ENROLLMENT_URL%%/v1/enrollment-tickets/*}"
fi
CHECKPOINT_DIR="\${GHOSTFLEET_CHECKPOINT_DIR:-/var/lib/fleet}"
CHECKPOINT_FILE="$CHECKPOINT_DIR/enrollment-checkpoint.json"
# @@GHOSTFLEET_CAPABILITY_SECTION_BEGIN@@
# ---------------------------------------------------------------------------
# Selected-capability lane. Everything between the sentinels below is DATA ONLY:
# the deployment renders it from the reviewed enrollment template, together with
# the exact artifact version and SHA-256 digests. The default selects nothing, so
# the published courier never installs a privileged component the template did
# not request. Installation happens inside this same root ceremony; it never
# asks for a second password and never mints a second identity.
# @@GHOSTFLEET_SELECTED_CAPABILITY_BEGIN@@
CAPABILITY_SCHEMA=''
CAPABILITY_SOURCE=''
CAPABILITY_VERSION=''
CAPABILITY_TEMPLATE_DIGEST=''
CAPABILITY_SELECTION_DIGEST=''
CAPABILITY_HELPER_REQUIRED=0
CAPABILITY_LINGER_REQUIRED=0
CAPABILITY_USER_SERVICE_REQUIRED=0
CAPABILITY_CONTROL_ACCOUNT=''
CAPABILITY_INSTALLER=''
CAPABILITY_PRIVILEGED_KEY=''
CAPABILITY_USER_UNIT=''
CAPABILITY_USER_UNIT_ARTIFACT=''
CAPABILITY_ARTIFACT_COUNT=0
capability_artifact_row() {
  return 1
}
# @@GHOSTFLEET_SELECTED_CAPABILITY_END@@
CAPABILITY_HELPER_STATE=UNKNOWN
CAPABILITY_USER_SERVICE_STATE=UNKNOWN
CAPABILITY_LINGER_STATE=UNKNOWN
CAPABILITY_MODE=NOT_REQUESTED
CAPABILITY_STAGE_DIR=
CAPABILITY_CREATED_UNIT=
CAPABILITY_CREATED_WANT=
CAPABILITY_REQUIRED_MARKERS="HELPER=COMPLIANT ENTRY=COMPLIANT AUTHORIZED_KEY=CONFIGURED SUDOERS=CONFIGURED ORDINARY_USER_SUDO_GRANT=ABSENT OPS_ACCOUNT=COMPLIANT"

capability_selected() {
  [ "$CAPABILITY_HELPER_REQUIRED" = 1 ] || [ "$CAPABILITY_LINGER_REQUIRED" = 1 ] || [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]
}

capability_ordinary_user() {
  if [ -n "\${GHOSTFLEET_CONTROL_ORDINARY_USER:-}" ]; then
    printf '%s' "$GHOSTFLEET_CONTROL_ORDINARY_USER"
  elif [ -n "\${SUDO_USER:-}" ]; then
    printf '%s' "$SUDO_USER"
  fi
  return 0
}

capability_artifact_field() {
  capability_artifact_row "$1" | cut -d '|' -f "$2"
}

capability_states_compliant() {
  case "$CAPABILITY_HELPER_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  case "$CAPABILITY_USER_SERVICE_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  case "$CAPABILITY_LINGER_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  return 0
}

# Read-only. Runs before package, provider, service or credential effects.
capability_validate_selection() {
  if ! capability_selected; then
    [ "$CAPABILITY_ARTIFACT_COUNT" = 0 ] || fail 'refusing privileged capability artifacts that no template requested'
    [ -z "$CAPABILITY_INSTALLER" ] || fail 'refusing a privileged capability installer that no template requested'
    return 0
  fi
  [ "$CAPABILITY_SCHEMA" = 'ghostfleet-selected-capability/v1' ] || fail 'selected-capability schema is not supported'
  printf '%s' "$CAPABILITY_VERSION" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$' || fail 'selected-capability version is missing or invalid'
  printf '%s' "$CAPABILITY_TEMPLATE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail 'selected-capability template digest is invalid'
  case "$CAPABILITY_ARTIFACT_COUNT" in ''|*[!0-9]*) fail 'selected-capability artifact count is invalid' ;; esac
  [ "$CAPABILITY_ARTIFACT_COUNT" -ge 1 ] || fail 'selected capability pins no artifacts'
  for capability_tool in base64 cut mktemp sha256sum; do
    command -v "$capability_tool" >/dev/null 2>&1 || fail "preflight failed: $capability_tool is required by the selected capability"
  done
  CAPABILITY_INSTALLER_INDEX=
  CAPABILITY_KEY_INDEX=
  CAPABILITY_UNIT_INDEX=
  capability_index=1
  while [ "$capability_index" -le "$CAPABILITY_ARTIFACT_COUNT" ]; do
    capability_row="$(capability_artifact_row "$capability_index")" || capability_row=
    [ -n "$capability_row" ] || fail "selected-capability artifact $capability_index is missing"
    capability_name="$(printf '%s' "$capability_row" | cut -d '|' -f 1)"
    capability_digest="$(printf '%s' "$capability_row" | cut -d '|' -f 2)"
    capability_mode="$(printf '%s' "$capability_row" | cut -d '|' -f 3)"
    printf '%s' "$capability_name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' || fail "selected-capability artifact $capability_index name is invalid"
    printf '%s' "$capability_digest" | grep -Eq '^[0-9a-f]{64}$' || fail "selected-capability artifact $capability_name digest is invalid"
    printf '%s' "$capability_mode" | grep -Eq '^0?[0-7]{3}$' || fail "selected-capability artifact $capability_name mode is invalid"
    [ "$capability_name" != "$CAPABILITY_INSTALLER" ] || CAPABILITY_INSTALLER_INDEX="$capability_index"
    [ "$capability_name" != "$CAPABILITY_PRIVILEGED_KEY" ] || CAPABILITY_KEY_INDEX="$capability_index"
    [ "$capability_name" != "$CAPABILITY_USER_UNIT_ARTIFACT" ] || CAPABILITY_UNIT_INDEX="$capability_index"
    capability_index=$((capability_index + 1))
  done
  if [ "$CAPABILITY_HELPER_REQUIRED" = 1 ]; then
    [ -n "$CAPABILITY_INSTALLER_INDEX" ] || fail 'selected privileged helper does not pin its installer artifact'
    [ -n "$CAPABILITY_KEY_INDEX" ] || fail 'selected privileged helper does not pin the admitted privileged SSH public key'
    printf '%s' "$CAPABILITY_CONTROL_ACCOUNT" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || fail 'selected-capability control account is invalid'
    [ "$CAPABILITY_CONTROL_ACCOUNT" != root ] || fail 'selected-capability control account must not be root'
    for capability_tool in bash python3 useradd usermod passwd visudo sudo getent; do
      command -v "$capability_tool" >/dev/null 2>&1 || fail "preflight failed: $capability_tool is required by the selected privileged helper"
    done
    capability_ordinary="$(capability_ordinary_user)"
    [ -n "$capability_ordinary" ] || fail 'selected privileged helper needs the ordinary control user; run the courier from the Human administrator account'
    printf '%s' "$capability_ordinary" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || fail 'ordinary control user is invalid'
    [ "$capability_ordinary" != root ] || fail 'ordinary control user must not be root'
    [ "$capability_ordinary" != "$CAPABILITY_CONTROL_ACCOUNT" ] || fail 'ordinary and dedicated control accounts must differ'
  fi
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    [ -n "$CAPABILITY_UNIT_INDEX" ] || fail 'selected user service does not pin its unit artifact'
    printf '%s' "$CAPABILITY_USER_UNIT" | grep -Eq '^[a-z][a-z0-9_.-]{0,63}\\.service$' || fail 'selected user unit name is invalid'
  fi
  if [ "$CAPABILITY_LINGER_REQUIRED" = 1 ] || [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    command -v loginctl >/dev/null 2>&1 || fail 'preflight failed: loginctl is required by the selected capability'
  fi
  # The pinned bytes are a dependency, not a later step: prove every digest in a
  # private staging directory before ANY package, provider, service or credential
  # effect. A mismatching artifact is a missing dependency.
  capability_stage
  capability_stage_cleanup
  return 0
}

capability_stage() {
  CAPABILITY_STAGE_DIR="$(mktemp -d)"
  [ -n "$CAPABILITY_STAGE_DIR" ] && [ -d "$CAPABILITY_STAGE_DIR" ] || fail 'selected-capability staging directory could not be created'
  chmod 0700 "$CAPABILITY_STAGE_DIR"
  capability_index=1
  while [ "$capability_index" -le "$CAPABILITY_ARTIFACT_COUNT" ]; do
    capability_name="$(capability_artifact_field "$capability_index" 1)"
    capability_digest="$(capability_artifact_field "$capability_index" 2)"
    capability_mode="$(capability_artifact_field "$capability_index" 3)"
    capability_actual=
    if capability_artifact_field "$capability_index" 4 | base64 -d > "$CAPABILITY_STAGE_DIR/$capability_name" 2>/dev/null; then
      capability_actual="$(sha256sum "$CAPABILITY_STAGE_DIR/$capability_name" | cut -d ' ' -f 1)"
    fi
    if [ "$capability_actual" != "$capability_digest" ]; then
      capability_stage_cleanup
      fail "selected-capability artifact $capability_name failed digest verification"
    fi
    chmod "$capability_mode" "$CAPABILITY_STAGE_DIR/$capability_name"
    capability_index=$((capability_index + 1))
  done
}

capability_stage_cleanup() {
  if [ -n "$CAPABILITY_STAGE_DIR" ] && [ -d "$CAPABILITY_STAGE_DIR" ]; then
    rm -rf "$CAPABILITY_STAGE_DIR"
  fi
  CAPABILITY_STAGE_DIR=
}

capability_installer() {
  capability_ordinary="$(capability_ordinary_user)"
  FLEET_CONTROL_ORDINARY_USER="$capability_ordinary" \\
    FLEET_CONTROL_PRIVILEGED_SSH_PUBLIC_KEY_FILE="$CAPABILITY_STAGE_DIR/$CAPABILITY_PRIVILEGED_KEY" \\
    bash "$CAPABILITY_STAGE_DIR/$CAPABILITY_INSTALLER" "$1"
}

capability_markers_ok() {
  for capability_marker in $CAPABILITY_REQUIRED_MARKERS; do
    printf '%s\\n' "$1" | grep -qx "$capability_marker" || return 1
  done
  return 0
}

capability_helper_state() {
  if [ "$CAPABILITY_HELPER_REQUIRED" != 1 ]; then printf '%s' NOT_REQUESTED; return 0; fi
  capability_output="$(capability_installer --check 2>/dev/null)" || capability_output=
  if capability_markers_ok "$capability_output"; then printf '%s' COMPLIANT; return 0; fi
  case "$capability_output" in
    *HELPER=ABSENT_OR_DRIFT*)
      case "$capability_output" in
        *OPS_ACCOUNT=ABSENT_OR_DRIFT*)
          case "$capability_output" in
            *AUTHORIZED_KEY=ABSENT_OR_DRIFT*) printf '%s' ABSENT; return 0 ;;
          esac
          ;;
      esac
      ;;
  esac
  printf '%s' DRIFT_REPAIRABLE
  return 0
}

capability_control_home() {
  getent passwd "$CAPABILITY_CONTROL_ACCOUNT" | cut -d ':' -f 6
}

capability_user_service_state() {
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" != 1 ]; then printf '%s' NOT_REQUESTED; return 0; fi
  capability_home="$(capability_control_home)"
  [ -n "$capability_home" ] || { printf '%s' UNKNOWN; return 0; }
  capability_unit_file="$capability_home/.config/systemd/user/$CAPABILITY_USER_UNIT"
  capability_want_file="$capability_home/.config/systemd/user/default.target.wants/$CAPABILITY_USER_UNIT"
  if [ -f "$capability_unit_file" ] && [ -L "$capability_want_file" ] &&
     [ "$(sha256sum "$capability_unit_file" | cut -d ' ' -f 1)" = "$(capability_artifact_field "$CAPABILITY_UNIT_INDEX" 2)" ]; then
    printf '%s' COMPLIANT
  else
    printf '%s' ABSENT
  fi
  return 0
}

capability_linger_state() {
  if [ "$CAPABILITY_LINGER_REQUIRED" != 1 ]; then printf '%s' NOT_REQUESTED; return 0; fi
  if ! id "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1; then printf '%s' ABSENT; return 0; fi
  capability_linger="$(loginctl show-user "$CAPABILITY_CONTROL_ACCOUNT" -p Linger 2>/dev/null)" || capability_linger=
  case "$capability_linger" in
    *Linger=yes*) printf '%s' COMPLIANT ;;
    *) printf '%s' ABSENT ;;
  esac
  return 0
}

capability_probe() {
  CAPABILITY_HELPER_STATE="$(capability_helper_state)"
  CAPABILITY_USER_SERVICE_STATE="$(capability_user_service_state)"
  CAPABILITY_LINGER_STATE="$(capability_linger_state)"
}

capability_probe_all() {
  if ! capability_selected; then
    CAPABILITY_HELPER_STATE=NOT_REQUESTED
    CAPABILITY_USER_SERVICE_STATE=NOT_REQUESTED
    CAPABILITY_LINGER_STATE=NOT_REQUESTED
    return 0
  fi
  capability_validate_selection
  capability_stage
  capability_probe
  capability_result=0
  capability_states_compliant || capability_result=1
  capability_stage_cleanup
  return "$capability_result"
}

capability_user_service_apply() {
  capability_home="$(capability_control_home)"
  [ -n "$capability_home" ] || { printf '%s\\n' 'fleet-enroll: selected control account has no home directory' >&2; return 1; }
  [ -d "$capability_home" ] || { printf '%s\\n' 'fleet-enroll: selected control account home directory is missing' >&2; return 1; }
  capability_userdir="$capability_home/.config/systemd/user"
  capability_wantdir="$capability_userdir/default.target.wants"
  install -d -m 0755 -o "$CAPABILITY_CONTROL_ACCOUNT" -g "$CAPABILITY_CONTROL_ACCOUNT" \\
    "$capability_home/.config" "$capability_home/.config/systemd" "$capability_userdir" "$capability_wantdir" ||
    { printf '%s\\n' 'fleet-enroll: selected user service directories could not be created' >&2; return 1; }
  capability_unit_file="$capability_userdir/$CAPABILITY_USER_UNIT"
  capability_want_file="$capability_wantdir/$CAPABILITY_USER_UNIT"
  if [ ! -e "$capability_unit_file" ]; then CAPABILITY_CREATED_UNIT="$capability_unit_file"; fi
  if [ ! -L "$capability_want_file" ]; then CAPABILITY_CREATED_WANT="$capability_want_file"; fi
  install -m 0644 -o "$CAPABILITY_CONTROL_ACCOUNT" -g "$CAPABILITY_CONTROL_ACCOUNT" \\
    "$CAPABILITY_STAGE_DIR/$CAPABILITY_USER_UNIT_ARTIFACT" "$capability_unit_file" ||
    { printf '%s\\n' 'fleet-enroll: selected user service unit could not be installed' >&2; return 1; }
  ln -sfn "../$CAPABILITY_USER_UNIT" "$capability_want_file" ||
    { printf '%s\\n' 'fleet-enroll: selected user service could not be enabled' >&2; return 1; }
  [ "$(sha256sum "$capability_unit_file" | cut -d ' ' -f 1)" = "$(capability_artifact_field "$CAPABILITY_UNIT_INDEX" 2)" ] ||
    { printf '%s\\n' 'fleet-enroll: selected user service unit digest does not match the reviewed artifact' >&2; return 1; }
  return 0
}

capability_linger_apply() {
  if [ "$CAPABILITY_LINGER_STATE" = COMPLIANT ]; then return 0; fi
  loginctl enable-linger "$CAPABILITY_CONTROL_ACCOUNT" ||
    { printf '%s\\n' 'fleet-enroll: Linger could not be enabled for the dedicated control account' >&2; return 1; }
  CAPABILITY_LINGER_STATE="$(capability_linger_state)"
  [ "$CAPABILITY_LINGER_STATE" = COMPLIANT ] ||
    { printf '%s\\n' 'fleet-enroll: Linger postcondition failed for the dedicated control account' >&2; return 1; }
  return 0
}

capability_rollback_files() {
  if [ -n "$CAPABILITY_CREATED_WANT" ]; then rm -f "$CAPABILITY_CREATED_WANT"; fi
  if [ -n "$CAPABILITY_CREATED_UNIT" ]; then rm -f "$CAPABILITY_CREATED_UNIT"; fi
  CAPABILITY_CREATED_WANT=
  CAPABILITY_CREATED_UNIT=
}

capability_state_write() {
  install -d -m 0700 -o root -g root "$CHECKPOINT_DIR"
  capability_state_file="$CHECKPOINT_DIR/capability-state.json"
  capability_state_body="{\\"schema\\":\\"ghostfleet-capability-state/v1\\",\\"version\\":\\"$CAPABILITY_VERSION\\",\\"selection_digest\\":\\"$CAPABILITY_SELECTION_DIGEST\\",\\"template_digest\\":\\"$CAPABILITY_TEMPLATE_DIGEST\\",\\"mode\\":\\"$CAPABILITY_MODE\\",\\"components\\":{\\"privileged_helper\\":\\"$CAPABILITY_HELPER_STATE\\",\\"user_service\\":\\"$CAPABILITY_USER_SERVICE_STATE\\",\\"linger\\":\\"$CAPABILITY_LINGER_STATE\\"}}"
  if [ -r "$capability_state_file" ] && [ "$(cat "$capability_state_file")" = "$capability_state_body" ]; then return 0; fi
  printf '%s\\n' "$capability_state_body" > "$capability_state_file.$$"
  chmod 0600 "$capability_state_file.$$"
  chown root:root "$capability_state_file.$$"
  mv -f "$capability_state_file.$$" "$capability_state_file"
}

# Install exactly the capability the reviewed template selected, inside the
# single authorized root ceremony. Partial application is reported as a failure
# and never as completion.
capability_apply() {
  if ! capability_selected; then
    CAPABILITY_HELPER_STATE=NOT_REQUESTED
    CAPABILITY_USER_SERVICE_STATE=NOT_REQUESTED
    CAPABILITY_LINGER_STATE=NOT_REQUESTED
    CAPABILITY_MODE=NOT_REQUESTED
    printf '%s\\n' 'fleet-enroll: the selected template requests no privileged capability; nothing was installed' >&2
    return 0
  fi
  capability_validate_selection
  capability_stage
  capability_probe
  if capability_states_compliant; then
    CAPABILITY_MODE=ADOPT
    capability_state_write
    capability_stage_cleanup
    printf '%s\\n' "fleet-enroll: selected capability $CAPABILITY_VERSION already converged; zero delta" >&2
    return 0
  fi
  capability_drift=0
  case "$CAPABILITY_HELPER_STATE" in DRIFT_REPAIRABLE|CONFLICT) capability_drift=1 ;; esac
  case "$CAPABILITY_USER_SERVICE_STATE" in COMPLIANT) capability_drift=1 ;; esac
  case "$CAPABILITY_LINGER_STATE" in COMPLIANT) capability_drift=1 ;; esac
  if [ "$capability_drift" = 1 ]; then CAPABILITY_MODE=REPAIR; else CAPABILITY_MODE=NEW; fi
  if [ "$CAPABILITY_HELPER_REQUIRED" = 1 ] && [ "$CAPABILITY_HELPER_STATE" != COMPLIANT ]; then
    if ! capability_installer --apply; then
      capability_stage_cleanup
      fail 'selected privileged helper apply failed; no completion is reported'
    fi
    CAPABILITY_HELPER_STATE="$(capability_helper_state)"
    if [ "$CAPABILITY_HELPER_STATE" != COMPLIANT ]; then
      capability_stage_cleanup
      fail 'selected privileged helper postcondition failed'
    fi
  fi
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ] && [ "$CAPABILITY_USER_SERVICE_STATE" != COMPLIANT ]; then
    if ! capability_user_service_apply; then
      capability_rollback_files
      capability_stage_cleanup
      fail 'selected user service could not be installed; no completion is reported'
    fi
    CAPABILITY_USER_SERVICE_STATE="$(capability_user_service_state)"
    if [ "$CAPABILITY_USER_SERVICE_STATE" != COMPLIANT ]; then
      capability_rollback_files
      capability_stage_cleanup
      fail 'selected user service postcondition failed'
    fi
  fi
  if [ "$CAPABILITY_LINGER_REQUIRED" = 1 ]; then
    if ! capability_linger_apply; then
      capability_rollback_files
      capability_stage_cleanup
      fail 'selected Linger could not be enabled; no completion is reported'
    fi
  fi
  if ! capability_states_compliant; then
    capability_rollback_files
    capability_stage_cleanup
    fail 'selected capability did not converge'
  fi
  capability_state_write
  capability_stage_cleanup
  printf '%s\\n' "fleet-enroll: selected capability $CAPABILITY_VERSION converged mode=$CAPABILITY_MODE helper=$CAPABILITY_HELPER_STATE user_service=$CAPABILITY_USER_SERVICE_STATE linger=$CAPABILITY_LINGER_STATE" >&2
  return 0
}
# @@GHOSTFLEET_CAPABILITY_SECTION_END@@

# V2 R1 Courier is a convergence engine. Checkpoint data is a resume hint only: every
# component used by the zero-delta path is re-proved from the live machine.
# This whole section is mutation-free and runs before /dev/tty, broker claim,
# or any credential request.
json_file_value() {
  JSON_FILE_QUOTED="$(grep -Eo '"'$2'"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -n1 || true)"
  if [ -n "$JSON_FILE_QUOTED" ]; then
    printf '%s' "$JSON_FILE_QUOTED" | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"[[:space:]]*$//'
  else
    grep -Eo '"'$2'"[[:space:]]*:[[:space:]]*[a-z]+' "$1" 2>/dev/null | head -n1 | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*//'
  fi
}

package_installed() {
  dpkg-query -W -f='\${Status}' "$1" 2>/dev/null | grep -qx 'install ok installed'
}

tailscale_self_state() {
  command -v tailscale >/dev/null 2>&1 || { printf '%s' ABSENT; return 0; }
  # Ask Tailscale for the local machine only.  This removes Peer[] from the
  # observation boundary, so a peer hostname can never satisfy self identity.
  TS_STATUS="$(tailscale status --self --peers=false --json 2>/dev/null)" || { printf '%s' UNKNOWN; return 0; }
  if printf '%s' "$TS_STATUS" | grep -Eq '"Self"[[:space:]]*:[[:space:]]*null'; then
    printf '%s' NOT_LOGGED_IN
    return 0
  fi
  SELF_HOST="$(printf '%s' "$TS_STATUS" | grep -Eo '"HostName"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\\1/')"
  BACKEND_STATE="$(printf '%s' "$TS_STATUS" | grep -Eo '"BackendState"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\\1/')"
  [ -n "$BACKEND_STATE" ] || { printf '%s' UNKNOWN; return 0; }
  case "$BACKEND_STATE" in
    NeedsLogin|NoState) printf '%s' NOT_LOGGED_IN; return 0 ;;
  esac
  [ -n "$SELF_HOST" ] || { printf '%s' UNKNOWN; return 0; }
  [ "$SELF_HOST" = "$1" ] || { printf '%s' IDENTITY_MISMATCH; return 0; }
  case "$BACKEND_STATE" in
    Running) printf '%s' RUNNING ;;
    Stopped) printf '%s' DRIFT_REPAIRABLE ;;
    *) printf '%s' UNKNOWN ;;
  esac
}

tailscale_preclaim_state() {
  # An absent binary is fresh only if no prior daemon state survives.
  if ! command -v tailscale >/dev/null 2>&1; then
    if [ -e /var/lib/tailscale/tailscaled.state ] || [ -L /var/lib/tailscale/tailscaled.state ]; then
      printf '%s' UNKNOWN
    else
      printf '%s' FRESH
    fi
    return 0
  fi
  TS_PRECLAIM="$(tailscale status --self --peers=false --json 2>/dev/null)" || { printf '%s' UNKNOWN; return 0; }
  # NeedsLogin, NoState and Self=null do NOT prove a never-enrolled host.
  if printf '%s' "$TS_PRECLAIM" | grep -Eq '"Self"[[:space:]]*:[[:space:]]*null'; then
    printf '%s' UNKNOWN
    return 0
  fi
  PRECLAIM_BACKEND="$(printf '%s' "$TS_PRECLAIM" | grep -Eo '"BackendState"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\\1/')"
  case "$PRECLAIM_BACKEND" in
    Running|Stopped) printf '%s' EXISTING ;;
    *) printf '%s' UNKNOWN ;;
  esac
}

live_tailscale_ready() {
  [ "$(tailscale_self_state "$1")" = RUNNING ]
}

checkpoint_is_compliant() {
  [ -r "$CHECKPOINT_FILE" ] || return 1
  [ "$(json_file_value "$CHECKPOINT_FILE" schema)" = 'fleet-enroll-checkpoint/v1' ] || return 1
  [ "$(json_file_value "$CHECKPOINT_FILE" status)" = COMPLIANT ] || return 1
  [ -r "$CHECKPOINT_DIR/enrollment-report.json" ] || return 1

  CHECKPOINT_NODE_ID="$(json_file_value "$CHECKPOINT_FILE" node_id)"
  CHECKPOINT_NODE_UID="$(json_file_value "$CHECKPOINT_FILE" node_uid)"
  REPORT_NODE_ID="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" node_id)"
  REPORT_NODE_UID="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" node_uid)"
  CHECKPOINT_IDENTITY_KIND="$(json_file_value "$CHECKPOINT_FILE" identity_kind)"
  REPORT_IDENTITY_KIND="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" identity_kind)"

  # Older canonical checkpoints predate identity_kind. Provisional enrollment
  # deliberately has no durable UID: reconcile its exact enrollment binding
  # instead of sending a successfully joined node back to the claim path.
  [ -n "$CHECKPOINT_IDENTITY_KIND" ] || CHECKPOINT_IDENTITY_KIND=canonical
  [ -n "$REPORT_IDENTITY_KIND" ] || REPORT_IDENTITY_KIND=canonical

  [ -n "$CHECKPOINT_NODE_ID" ] && [ "$CHECKPOINT_NODE_ID" = "$REPORT_NODE_ID" ] || return 1
  [ "$CHECKPOINT_IDENTITY_KIND" = "$REPORT_IDENTITY_KIND" ] || return 1
  case "$CHECKPOINT_IDENTITY_KIND" in
    canonical)
      [ -n "$CHECKPOINT_NODE_UID" ] && [ "$CHECKPOINT_NODE_UID" = "$REPORT_NODE_UID" ] || return 1
      ;;
    provisional)
      [ -z "$CHECKPOINT_NODE_UID" ] && [ -z "$REPORT_NODE_UID" ] || return 1
      CHECKPOINT_ENROLLMENT_ID="$(json_file_value "$CHECKPOINT_FILE" enrollment_id)"
      REPORT_ENROLLMENT_ID="$(json_file_value "$CHECKPOINT_DIR/enrollment-report.json" enrollment_id)"
      [ "$CHECKPOINT_ENROLLMENT_ID" = "$REPORT_ENROLLMENT_ID" ] || return 1
      printf '%s' "$CHECKPOINT_ENROLLMENT_ID" | grep -Eq '^enroll-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || return 1
      printf '%s' "$CHECKPOINT_NODE_ID" | grep -Eq '^fleet-bootstrap-[0-9a-f]{12}$' || return 1
      ;;
    *) return 1 ;;
  esac
  live_tailscale_ready "$CHECKPOINT_NODE_ID" || return 1
  package_installed curl && package_installed ca-certificates || return 1
  # The selected capability is part of convergence: a converged-looking host
  # whose privileged lane drifted is not a zero-delta host.
  capability_probe_all || return 1
  return 0
}

checkpoint_write() {
  install -d -m 0700 -o root -g root "$CHECKPOINT_DIR"
  CHECKPOINT_TMP="$CHECKPOINT_FILE.$$"
  CHECKPOINT_COMPONENTS='"packages":"'"$PACKAGES_STATE"'","tailscale":"'"$TAILSCALE_STATE"'"'
  if capability_selected; then
    CHECKPOINT_COMPONENTS="$CHECKPOINT_COMPONENTS"',"privileged_helper":"'"$CAPABILITY_HELPER_STATE"'","user_service":"'"$CAPABILITY_USER_SERVICE_STATE"'","linger":"'"$CAPABILITY_LINGER_STATE"'"'
  fi
  cat > "$CHECKPOINT_TMP" <<EOF
{"schema":"fleet-enroll-checkpoint/v1","phase":"$1","status":"$2","identity_kind":"\${IDENTITY_KIND:-canonical}","enrollment_id":"\${ENROLLMENT_ID:-}","node_id":"$NODE_ID","node_uid":"$NODE_UID","os_family":"$OS_FAMILY","os_id":"$OS_ID","os_version_id":"$OS_VERSION_ID","profile":"managed-linux","ssh_host_key_sha256":"$SSH_HOST_KEY_SHA","components":{$CHECKPOINT_COMPONENTS}}
EOF
  chmod 0600 "$CHECKPOINT_TMP"
  chown root:root "$CHECKPOINT_TMP"
  mv -f "$CHECKPOINT_TMP" "$CHECKPOINT_FILE"
}

refuse_unresolved_previous_enrollment() {
  # Durable attempt/checkpoint records and a leftover one-off credential are
  # never proof of a fresh host, even if Tailscale now reports NeedsLogin.
  # Symlink checks also catch dangling paths without following them.
  for marker in "$CHECKPOINT_FILE" "$CHECKPOINT_DIR/enrollment-report.json" "$CHECKPOINT_DIR/capability-state.json" /run/fleet/ts-authkey; do
    if [ -e "$marker" ] || [ -L "$marker" ]; then
      fail 'prior enrollment state unresolved; reconcile original node/attempt (ADOPT/REPAIR); no new one-off key'
    fi
  done
}

fail() {
  printf '%s\\n' "fleet-enroll: $*" >&2
  exit 1
}

if [ -z "$BROKER_ORIGIN" ]; then
  checkpoint_is_compliant || fail 'deployment broker origin is required before bootstrap effects'
else
  printf '%s' "$BROKER_ORIGIN" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$' || fail 'deployment broker origin must be exact HTTPS origin'
fi

if [ "$(id -u)" -ne 0 ]; then
  case "$0" in
    /*) FLEET_BOOTSTRAP_SELF="$0" ;;
    *) FLEET_BOOTSTRAP_SELF="$(pwd)/$0" ;;
  esac
  if [ ! -f "$FLEET_BOOTSTRAP_SELF" ] || [ ! -r "$FLEET_BOOTSTRAP_SELF" ]; then
    fail 'root privileges are required; use the published downloader-to-file launcher so bootstrap can elevate safely'
  fi
  if command -v sudo >/dev/null 2>&1; then
    exec sudo env GHOSTFLEET_BROKER_ORIGIN="$BROKER_ORIGIN" GHOSTFLEET_ENROLLMENT_URL="$ENROLLMENT_URL" sh "$FLEET_BOOTSTRAP_SELF"
  fi
  if command -v su >/dev/null 2>&1; then
    export FLEET_BOOTSTRAP_SELF
    exec su -c 'exec sh "$FLEET_BOOTSTRAP_SELF"' root
  fi
  fail 'root privileges are required and neither sudo nor su is available'
fi

if [ "$(uname -s)" != 'Linux' ]; then
  fail 'unsupported operating system: Linux is required'
fi

if [ ! -r /etc/os-release ]; then
  fail 'cannot identify Linux distribution: /etc/os-release is missing'
fi

. /etc/os-release
OS_ID="\${ID:-unknown}"
OS_ID_LIKE="\${ID_LIKE:-}"
OS_VERSION_ID="\${VERSION_ID:-unknown}"
VERSION_CODENAME="\${VERSION_CODENAME:-}"
UBUNTU_CODENAME="\${UBUNTU_CODENAME:-}"
if [ "$OS_ID" = "ubuntu" ] && [ -n "$UBUNTU_CODENAME" ]; then
  OS_CODENAME="$UBUNTU_CODENAME"
else
  OS_CODENAME="$VERSION_CODENAME"
fi
case " $OS_ID $OS_ID_LIKE " in
  *' debian '*|*' ubuntu '*) OS_FAMILY='debian-family' ;;
  *) fail "unsupported OS family: id=$OS_ID id_like=$OS_ID_LIKE" ;;
esac

# One-click v0 Phase 0: local read-only safety/compatibility preflight.
# This runs after the single root ceremony but before package install/update,
# provider claim, service mutation, credential request or network mutation.
bootstrap_phase0_preflight() {
  command -v systemctl >/dev/null 2>&1 || fail 'preflight failed: systemd/systemctl is required'
  [ -d /run/systemd/system ] || fail 'preflight failed: systemd is not the active init system'
  command -v sha256sum >/dev/null 2>&1 || fail 'preflight failed: sha256sum is required'
  command -v dpkg-query >/dev/null 2>&1 || fail 'preflight failed: dpkg-query is required'
  command -v apt-get >/dev/null 2>&1 || fail 'preflight failed: apt-get is required'
  command -v ssh-keygen >/dev/null 2>&1 || fail 'preflight failed: ssh-keygen is required for host identity evidence'

  # Verify the real host identity before package/service/provider effects.
  SSH_HOST_KEY_PATH=
  for candidate in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
    if [ -r "$candidate" ] && [ -s "$candidate" ]; then SSH_HOST_KEY_PATH="$candidate"; break; fi
  done
  [ -n "$SSH_HOST_KEY_PATH" ] || fail 'preflight failed: no readable SSH host public key; identity evidence cannot be established'
  SSH_HOST_KEY_SHA="$(ssh-keygen -lf "$SSH_HOST_KEY_PATH" 2>/dev/null | awk 'NF >= 2 {print $2; exit}')"
  [ -n "$SSH_HOST_KEY_SHA" ] || fail 'preflight failed: SSH host public key fingerprint could not be verified'

  APPLIANCE_KIND=generic-linux
  if [ -e /etc/openmediavault/config.xml ] || [ -d /etc/openmediavault ]; then
    APPLIANCE_KIND=openmediavault
  fi

  DOCKER_SOCKET_HINT=absent
  [ -S /var/run/docker.sock ] && DOCKER_SOCKET_HINT=present

  NOPASSWD_HINT=absent
  if grep -Rqs -- 'NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null; then
    NOPASSWD_HINT=present
  fi

  PREFLIGHT_MATERIAL="$(printf '%s\n' "$OS_FAMILY" "$OS_ID" "$OS_VERSION_ID" "$(uname -m)" "$APPLIANCE_KIND" "$DOCKER_SOCKET_HINT" "$NOPASSWD_HINT")"
  PRECHECK_DIGEST="sha256:$(printf '%s' "$PREFLIGHT_MATERIAL" | sha256sum | awk '{print $1}')"
  unset PREFLIGHT_MATERIAL

  printf '%s\n' "fleet-enroll: preflight PASS os=$OS_ID/$OS_VERSION_ID arch=$(uname -m) appliance=$APPLIANCE_KIND docker_socket=$DOCKER_SOCKET_HINT nopasswd_hint=$NOPASSWD_HINT" >&2
}
bootstrap_phase0_preflight

# A malformed or unrequested selected-capability selection stops here, before
# any package, provider, service or credential effect.
capability_validate_selection

# The next steps can update APT source or start a daemon. Refuse an existing
# foreign/unproven Tailscale session before ANY package or service mutation.
# Existing machines must use a verified ADOPT/REPAIR plan instead of a new join.
if checkpoint_is_compliant; then
  printf '%s\\n' 'fleet-enroll: already converged; no enrollment credentials requested' >&2
  exit 0
fi
refuse_unresolved_previous_enrollment
case "$(tailscale_preclaim_state)" in
  FRESH) ;;
  EXISTING) fail 'existing Tailscale identity detected; use verified ADOPT/REPAIR flow; no new enrollment effects attempted' ;;
  *) fail 'Tailscale identity unknown before setup; reconcile before enrollment effects' ;;
esac
[ -c /dev/tty ] || fail '/dev/tty required before any enrollment package effects'
if [ -e /etc/openmediavault/config.xml ] || [ -d /etc/openmediavault ]; then
  printf '%s\\n' 'fleet-enroll: OMV-owned SSH/storage configuration is outside this bootstrap scope' >&2
fi

bootstrap_transport_baseline() {
  if command -v curl >/dev/null 2>&1 && package_installed ca-certificates; then
    return 0
  fi
  printf '%s\n' 'fleet-enroll: installing bootstrap transport baseline (curl ca-certificates) from distribution base repositories' >&2
  apt-get update -y || fail 'bootstrap transport baseline failed: apt-get update failed; install curl ca-certificates then rerun'
  apt-get install -y --no-install-recommends curl ca-certificates || fail 'bootstrap transport baseline failed: cannot install curl ca-certificates; install them then rerun'
  command -v curl >/dev/null 2>&1 || fail 'bootstrap transport baseline failed: curl still absent after install'
}
bootstrap_transport_baseline

tailscale_apt_compliant() {
  EXPECTED_TAILSCALE="deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/$OS_ID $OS_CODENAME main"
  [ -r /usr/share/keyrings/tailscale-archive-keyring.gpg ] || return 1
  [ -s /usr/share/keyrings/tailscale-archive-keyring.gpg ] || return 1
  [ -r /etc/apt/sources.list.d/tailscale.list ] || return 1
  grep -Fxq "$EXPECTED_TAILSCALE" /etc/apt/sources.list.d/tailscale.list || return 1
}

ensure_tailscale_apt_source() {
  if tailscale_apt_compliant; then return 0; fi
  case "$OS_CODENAME" in
    bullseye|bookworm|trixie|focal|jammy|noble|oracular|plucky|questing|resolute) ;;
    *) fail "unsupported OS release for Tailscale repository: id=$OS_ID codename=$OS_CODENAME (allowed: bullseye,bookworm,trixie,focal,jammy,noble,resolute,oracular,plucky,questing)" ;;
  esac
  printf '%s\n' "fleet-enroll: configuring official Tailscale APT repository for $OS_ID/$OS_CODENAME" >&2
  install -d -m 0755 /usr/share/keyrings
  install -d -m 0755 /etc/apt/sources.list.d
  TMP_KEY="$(mktemp)"
  TMP_LIST="$(mktemp)"
  if ! curl -fsSL "https://pkgs.tailscale.com/stable/$OS_ID/$OS_CODENAME.noarmor.gpg" -o "$TMP_KEY"; then
    rm -f "$TMP_KEY" "$TMP_LIST"
    fail "failed to fetch Tailscale signing key from official origin (https://pkgs.tailscale.com)"
  fi
  [ -s "$TMP_KEY" ] || { rm -f "$TMP_KEY" "$TMP_LIST"; fail "Tailscale signing key is empty after fetch"; }
  install -m 0644 "$TMP_KEY" /usr/share/keyrings/tailscale-archive-keyring.gpg
  if ! curl -fsSL "https://pkgs.tailscale.com/stable/$OS_ID/$OS_CODENAME.tailscale-keyring.list" -o "$TMP_LIST"; then
    rm -f "$TMP_KEY" "$TMP_LIST"
    fail "failed to fetch Tailscale APT source from official origin"
  fi
  grep -q "pkgs.tailscale.com" "$TMP_LIST" || { rm -f "$TMP_KEY" "$TMP_LIST"; fail "Tailscale APT source verification failed"; }
  install -m 0644 "$TMP_LIST" /etc/apt/sources.list.d/tailscale.list
  rm -f "$TMP_KEY" "$TMP_LIST"
  APT_UPDATE_NEEDED=true
}

# Credential-free host preparation after read-only preclaim guards, before
# the short-lived key is minted (R0 #88: 600s expiry).
APT_UPDATE_NEEDED=false
if ! tailscale_apt_compliant; then
  ensure_tailscale_apt_source
fi
if [ "$APT_UPDATE_NEEDED" = true ]; then
  apt-get update -y
  APT_UPDATE_NEEDED=false
fi
if ! package_installed curl || ! package_installed ca-certificates; then
  apt-get update -y
  apt-get install -y --no-install-recommends curl ca-certificates
fi
if ! command -v tailscale >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends tailscale
  systemctl enable --now tailscaled
elif ! systemctl is-active --quiet tailscaled 2>/dev/null; then
  systemctl enable --now tailscaled
fi

install -d -m 0700 -o root -g root /run/fleet

# The enrollment code is short-lived and single-use, not a password. Keep
# terminal echo enabled so the Human can see/correct transcription errors.
# One-time ticket URLs use an eight-digit decimal code; the legacy broker
# fallback retains its deployment-specific historical formats.
if [ -n "$ENROLLMENT_URL" ]; then
  printf 'Enrollment code (visible; 8 digits): ' > /dev/tty
else
  printf 'Enrollment code (visible; FE1-XXXX-XXXX or XXXX-XXXX): ' > /dev/tty
fi
if ! IFS= read -r ENROLL_CODE < /dev/tty; then
  fail 'failed to read Enrollment Code from /dev/tty'
fi

[ -n "$ENROLL_CODE" ] || fail 'Enrollment Code must not be empty'

CLAIM_URL="$BROKER_ORIGIN/v1/enroll/claim"
[ -n "$ENROLLMENT_URL" ] && CLAIM_URL="$ENROLLMENT_URL/claim"
if ! CLAIM_JSON="$(printf '%s' "$ENROLL_CODE" | curl -fsS \\
  --connect-timeout 10 \\
  --max-time 30 \\
  --header 'content-type: text/plain' \\
  --header "x-fleet-os-family: $OS_FAMILY" \\
  --header "x-fleet-os-id: $OS_ID" \\
  --header "x-ghostfleet-preflight-digest: $PRECHECK_DIGEST" \\
  --data-binary @- \\
  "$CLAIM_URL")"; then
  unset ENROLL_CODE
  fail 'claim denied: Enrollment Code is invalid, expired, replayed, or does not match this OS profile'
fi
unset ENROLL_CODE

json_get() {
  JSON_VALUE="$(printf '%s' "$1" | grep -Eo '"'$2'"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 || true)"
  [ -n "$JSON_VALUE" ] || return 0
  printf '%s' "$JSON_VALUE" | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"[[:space:]]*$//'
}

RESUME_SESSION="$(json_get "$CLAIM_JSON" resume_session)"
[ -n "$RESUME_SESSION" ] || fail 'broker did not return a resume session'
TS_AUTHKEY="$(json_get "$CLAIM_JSON" auth_key)"
[ -n "$TS_AUTHKEY" ] || fail 'broker did not return a one-time credential'

IDENTITY_KIND="$(json_get "$CLAIM_JSON" identity_kind)"
[ -n "$IDENTITY_KIND" ] || IDENTITY_KIND=canonical
ENROLLMENT_ID="$(json_get "$CLAIM_JSON" enrollment_id)"
NODE_ID="$(json_get "$CLAIM_JSON" node_id)"
NODE_UID="$(json_get "$CLAIM_JSON" node_uid)"

case "$IDENTITY_KIND" in
  canonical) [ -n "$NODE_UID" ] || fail 'canonical enrollment returned no immutable node_uid' ;;
  provisional)
    [ -n "$ENROLLMENT_ID" ] || fail 'provisional enrollment returned no enrollment_id'
    [ -z "$NODE_UID" ] || fail 'provisional enrollment must not carry durable node_uid'
    case "$NODE_ID" in fleet-bootstrap-????????????) ;; *) fail 'invalid provisional bootstrap hostname' ;; esac
    ;;
  *) fail 'broker returned unknown identity_kind' ;;
esac
unset CLAIM_JSON

detect_live_components() {
  PACKAGES_STATE=ABSENT
  package_installed curl && package_installed ca-certificates && PACKAGES_STATE=COMPLIANT

  case "$(tailscale_self_state "$NODE_ID")" in
    RUNNING) TAILSCALE_STATE=COMPLIANT ;;
    ABSENT|NOT_LOGGED_IN) TAILSCALE_STATE=ABSENT ;;
    IDENTITY_MISMATCH) TAILSCALE_STATE=CONFLICT ;;
    DRIFT_REPAIRABLE) TAILSCALE_STATE=DRIFT_REPAIRABLE ;;
    *) TAILSCALE_STATE=UNKNOWN ;;
  esac

}
detect_live_components
case "$TAILSCALE_STATE" in
  *CONFLICT*|*UNKNOWN*|DRIFT_REPAIRABLE) fail 'Tailscale identity stopped, foreign or uncertain; reconcile without reauthentication' ;;
esac

# Preserve the Phase-0-pinned SSH host fingerprint for both completion receipts.

if [ "$TAILSCALE_STATE" != COMPLIANT ]; then
  # The one-time claim is already spent. Before effectful auth, persist a
  # credential-free original enrollment/node fence under root-owned storage.
  # A crash, rejection or uncertain join must never trigger a second key.
  checkpoint_write CONVERGE RECONCILE_REQUIRED
  printf '%s' "$TS_AUTHKEY" > /run/fleet/ts-authkey
  trap 'rm -f /run/fleet/ts-authkey' EXIT
  chmod 0600 /run/fleet/ts-authkey
  chown root:root /run/fleet/ts-authkey
  unset TS_AUTHKEY

  # The CLI must not block on a browser login or print OAuth links.
  if ! tailscale up --authkey=file:/run/fleet/ts-authkey --hostname "$NODE_ID" --timeout=90s </dev/null >/dev/null 2>&1; then
    fail 'one-off Tailscale auth rejected or uncertain; reconcile existing enrollment, never retry login'
  fi
  rm -f /run/fleet/ts-authkey
  trap - EXIT
  live_tailscale_ready "$NODE_ID" ||
    fail 'Tailscale join status uncertain; reconcile original enrollment without re-login'
  TAILSCALE_STATE=COMPLIANT
  checkpoint_write VERIFY IN_PROGRESS
else
  unset TS_AUTHKEY
fi

# The template-selected privileged capability is installed INSIDE this same
# authorized root ceremony: after the identity/join fence is satisfied and before
# any completion is reported. A template that selected nothing installs nothing.
capability_apply

# SSH_HOST_KEY_PATH and SSH_HOST_KEY_SHA were verified during read-only Phase 0.

IDENTITY_EVIDENCE_B64=
IDENTITY_EVIDENCE_SHA=
if [ "$IDENTITY_KIND" = provisional ]; then
  EVIDENCE_FILE=/run/fleet/identity-evidence.txt
  : > "$EVIDENCE_FILE"
  evidence_line() {
    key="$1"; value="$2"
    encoded="$(printf '%s' "$value" | base64 -w0)"
    printf '%s\t%s\n' "$key" "$encoded" >> "$EVIDENCE_FILE"
  }
  bounded_file() {
    [ -r "$1" ] || return 0
    tr '\r\n\t' '   ' < "$1" | head -c 512
  }
  evidence_line schema fleet-hardware-evidence/v1
  evidence_line captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for field in sys_vendor product_name product_version product_serial product_uuid; do
    evidence_line "dmi.$field" "$(bounded_file "/sys/class/dmi/id/$field")"
  done
  evidence_line block "$(lsblk -dn -o NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,RM 2>/dev/null | head -c 8192 || true)"
  PCI_EVIDENCE=
  for dev in /sys/bus/pci/devices/*; do
    [ -d "$dev" ] || continue
    vendor="$(bounded_file "$dev/vendor")"
    device="$(bounded_file "$dev/device")"
    class="$(bounded_file "$dev/class")"
    PCI_EVIDENCE="$PCI_EVIDENCE$(basename "$dev") $vendor $device $class\n"
  done
  evidence_line pci "$PCI_EVIDENCE"
  IDENTITY_EVIDENCE_B64="$(base64 -w0 "$EVIDENCE_FILE")"
  [ \${#IDENTITY_EVIDENCE_B64} -le 65536 ] || fail 'identity evidence exceeds protected completion bound'
  IDENTITY_EVIDENCE_SHA="sha256:$(printf '%s' "$IDENTITY_EVIDENCE_B64" | sha256sum | awk '{print $1}')"
fi

REPORT_DIR="$CHECKPOINT_DIR"
install -d -m 0700 -o root -g root "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/enrollment-report.json"
BOOTSTRAP_VERSION="v2-r1-$(date -u +%Y%m%d)"
cat > "$REPORT_FILE" <<EOF
{
  "identity_kind": "$IDENTITY_KIND",
  "enrollment_id": "$ENROLLMENT_ID",
  "node_id": "$NODE_ID",
  "node_uid": "$NODE_UID",
  "os_id": "$OS_ID",
  "os_version_id": "$OS_VERSION_ID",
  "ssh_host_key_sha256": "$SSH_HOST_KEY_SHA",
  "bootstrap_version": "$BOOTSTRAP_VERSION",
  "capability_version": "$CAPABILITY_VERSION",
  "capability_mode": "$CAPABILITY_MODE"
}
EOF
chmod 0600 "$REPORT_FILE"
chown root:root "$REPORT_FILE"

if ! printf '{"resume_session":"%s","report":{"identity_kind":"%s","enrollment_id":"%s","node_id":"%s","os_id":"%s","os_version_id":"%s","ssh_host_key_sha256":"%s","bootstrap_version":"%s","identity_evidence_b64":"%s","identity_evidence_sha256":"%s"}}' "$RESUME_SESSION" "$IDENTITY_KIND" "$ENROLLMENT_ID" "$NODE_ID" "$OS_ID" "$OS_VERSION_ID" "$SSH_HOST_KEY_SHA" "$BOOTSTRAP_VERSION" "$IDENTITY_EVIDENCE_B64" "$IDENTITY_EVIDENCE_SHA" | curl -fsS --connect-timeout 10 --max-time 30 --header 'content-type: application/json' --data-binary @- "$BROKER_ORIGIN/v1/enroll/complete" >/dev/null; then
  fail 'completion report failed'
fi

checkpoint_write CHECKPOINT COMPLIANT

if [ "$IDENTITY_KIND" = provisional ]; then
  printf '%s\\n' "fleet-enroll: provisional bootstrap complete for $NODE_ID; durable identity finalization is pending"
else
  printf '%s\\n' "fleet-enroll: bootstrap complete for $NODE_ID ($NODE_UID)"
fi
if capability_selected; then
  printf '%s\\n' "fleet-enroll: selected capability mode=$CAPABILITY_MODE version=$CAPABILITY_VERSION helper=$CAPABILITY_HELPER_STATE user_service=$CAPABILITY_USER_SERVICE_STATE linger=$CAPABILITY_LINGER_STATE"
fi
`;
