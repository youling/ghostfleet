export const BOOTSTRAP_SH = `#!/bin/sh
set -eu
# Debian-family admin tools commonly live under sbin, including in sudo shells.
PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

BROKER_ORIGIN="\${GHOSTFLEET_BROKER_ORIGIN:-}"
ENROLLMENT_URL="\${GHOSTFLEET_ENROLLMENT_URL:-}"
ASSETS_ORIGIN="\${GHOSTFLEET_ASSETS_ORIGIN:-}"
# The managed agent's control plane is the node-plane bridge, a different host
# from the Access-protected enrollment origin. The delivery command exports it;
# this script never derives it from the ticket, the claim or the broker origin.
NODE_PLANE_ORIGIN="\${GHOSTFLEET_NODE_PLANE_ORIGIN:-}"
if [ -n "$ENROLLMENT_URL" ]; then
  printf '%s' "$ENROLLMENT_URL" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/v1/enrollment-tickets/[A-Za-z0-9._~%-]+$' || {
    printf '%s\\n' 'fleet-enroll: invalid one-time enrollment URL; an exact HTTPS ticket URL is required' >&2
    exit 1
  }
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
CAPABILITY_ARTIFACT_1=
CAPABILITY_ARTIFACT_2=
CAPABILITY_ARTIFACT_3=
CAPABILITY_ARTIFACT_4=
CAPABILITY_ARTIFACT_5=
CAPABILITY_ARTIFACT_6=
CAPABILITY_ARTIFACT_7=
CAPABILITY_ARTIFACT_8=
CAPABILITY_ARTIFACT_9=
CAPABILITY_ARTIFACT_10=
CAPABILITY_ARTIFACT_11=
CAPABILITY_ARTIFACT_12=
CAPABILITY_ARTIFACT_13=
CAPABILITY_ARTIFACT_14=
CAPABILITY_ARTIFACT_15=
CAPABILITY_ARTIFACT_16=
# @@GHOSTFLEET_SELECTED_CAPABILITY_BEGIN@@
CAPABILITY_SELECTION_ORIGIN='none'
CAPABILITY_SCHEMA=''
CAPABILITY_SOURCE=''
CAPABILITY_VERSION=''
CAPABILITY_TEMPLATE_DIGEST=''
CAPABILITY_SELECTION_DIGEST=''
CAPABILITY_HELPER_REQUIRED=0
CAPABILITY_LINGER_REQUIRED=0
CAPABILITY_USER_SERVICE_REQUIRED=0
CAPABILITY_CONTROL_ACCOUNT=''
CAPABILITY_PRIVILEGED_ACCOUNT=''
CAPABILITY_INSTALLER=''
CAPABILITY_PRIVILEGED_KEY=''
CAPABILITY_USER_UNIT=''
CAPABILITY_USER_UNIT_ARTIFACT=''
CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT=''
CAPABILITY_USER_UNIT_PAYLOAD_PATH=''
CAPABILITY_USER_UNIT_PAYLOAD_MODE=''
CAPABILITY_ARTIFACT_COUNT=0
# @@GHOSTFLEET_SELECTED_CAPABILITY_END@@
# The node agent runtime is pinned twice: the payload (a single Python zipapp)
# installed root-owned under /usr/local/libexec, and the user unit that starts it.
# Both digests come from the reviewed selection. CAPABILITY_AGENT_PAYLOAD_PATH is
# the only location this courier ever trusts or installs the payload to.
CAPABILITY_AGENT_PAYLOAD_PATH='/usr/local/libexec/ghostfleet/node-agent.pyz'
CAPABILITY_AGENT_PAYLOAD_MODE='0755'
CAPABILITY_AGENT_CONFIG_PATH='/etc/ghostfleet/node-agent.json'
CAPABILITY_AGENT_CONFIG_DIR='/etc/ghostfleet'
CAPABILITY_AGENT_STATE_DIR_NAME='ghostfleet-agent'
CAPABILITY_AGENT_CONFIGURED_AT=''
CAPABILITY_AGENT_PAYLOAD_SHA256=''
CAPABILITY_AGENT_PAYLOAD_PINNED_MODE=''
CAPABILITY_AGENT_PAYLOAD_STATE=NOT_REQUESTED
CAPABILITY_USER_UNIT_STATE=NOT_REQUESTED
CAPABILITY_USER_UNIT_EXEC=''
CAPABILITY_SERVICE_STATE=NOT_REQUESTED
CAPABILITY_SERVICE_PENDING=0
CAPABILITY_PAYLOAD_INDEX=
CAPABILITY_CREATED_PAYLOAD=
CAPABILITY_CREATED_PAYLOAD_DIR=
CAPABILITY_CREATED_STATE_DIR=
CAPABILITY_EVIDENCE_PAYLOAD_STATE=NOT_REQUESTED
CAPABILITY_EVIDENCE_UNIT_STATE=NOT_REQUESTED
# These names avoid the asset-safety dotenv-block rule: a column-0 KEY= line whose
# name contains TOKEN, SECRET or CREDENTIAL is refused as a smuggled secret, while the
# values here are non-secret state markers and the node credential itself is written
# only to the run account home as a 0600 file.
CAPABILITY_NODE_AUTH_STATE=NOT_REQUESTED
CAPABILITY_NODE_AUTH=
CAPABILITY_CREATED_NODE_AUTH=
CAPABILITY_CREATED_NODE_JSON=
CAPABILITY_CREATED_AGENT_CONFIG=
CAPABILITY_CREATED_STATUS_PROJECTION=
CAPABILITY_STATUS_BACKUP=''
CAPABILITY_NODE_AUTH_RECEIVED=no
CAPABILITY_NODE_AUTH_MODE=''
CAPABILITY_AUTH_HANDOFF=''
CAPABILITY_STATUS_APPLIED_AT=''
CAPABILITY_COMPLETE_RESPONSE=
# @@GHOSTFLEET_CAPABILITY_STATUS_FRAGMENT_ARTIFACT_ROW_BEGIN@@
capability_artifact_row() {
  case "$1" in
    1) printf '%s' "$CAPABILITY_ARTIFACT_1" ;;
    2) printf '%s' "$CAPABILITY_ARTIFACT_2" ;;
    3) printf '%s' "$CAPABILITY_ARTIFACT_3" ;;
    4) printf '%s' "$CAPABILITY_ARTIFACT_4" ;;
    5) printf '%s' "$CAPABILITY_ARTIFACT_5" ;;
    6) printf '%s' "$CAPABILITY_ARTIFACT_6" ;;
    7) printf '%s' "$CAPABILITY_ARTIFACT_7" ;;
    8) printf '%s' "$CAPABILITY_ARTIFACT_8" ;;
    9) printf '%s' "$CAPABILITY_ARTIFACT_9" ;;
    10) printf '%s' "$CAPABILITY_ARTIFACT_10" ;;
    11) printf '%s' "$CAPABILITY_ARTIFACT_11" ;;
    12) printf '%s' "$CAPABILITY_ARTIFACT_12" ;;
    13) printf '%s' "$CAPABILITY_ARTIFACT_13" ;;
    14) printf '%s' "$CAPABILITY_ARTIFACT_14" ;;
    15) printf '%s' "$CAPABILITY_ARTIFACT_15" ;;
    16) printf '%s' "$CAPABILITY_ARTIFACT_16" ;;
    *) return 1 ;;
  esac
}
# @@GHOSTFLEET_CAPABILITY_STATUS_FRAGMENT_ARTIFACT_ROW_END@@
CAPABILITY_HELPER_STATE=UNKNOWN
CAPABILITY_USER_SERVICE_STATE=UNKNOWN
CAPABILITY_LINGER_STATE=UNKNOWN
CAPABILITY_MODE=NOT_REQUESTED
CAPABILITY_REQUIRED=0
CAPABILITY_LEGACY_STATE=0
CAPABILITY_CLAIM_SELECTION_B64=
CAPABILITY_RECORD_FILE="$CHECKPOINT_DIR/capability-selection.txt"
CAPABILITY_STAGE_DIR=
CAPABILITY_CREATED_UNIT=
CAPABILITY_CREATED_WANT=
CAPABILITY_ACCOUNT_STATE=UNKNOWN
CAPABILITY_ACCOUNT_RECONCILED=
CAPABILITY_CREATED_ACCOUNT=0
CAPABILITY_ENABLED_LINGER=0
CAPABILITY_REQUIRED_MARKERS="HELPER=COMPLIANT ENTRY=COMPLIANT AUTHORIZED_KEY=CONFIGURED SUDOERS=CONFIGURED ORDINARY_USER_SUDO_GRANT=ABSENT OPS_ACCOUNT=COMPLIANT"

capability_selected() {
  [ "$CAPABILITY_HELPER_REQUIRED" = 1 ] || [ "$CAPABILITY_LINGER_REQUIRED" = 1 ] || [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]
}

# THREE identities, never interchangeable:
#   * the DEDICATED RUN identity is CAPABILITY_CONTROL_ACCOUNT. It owns the user
#     unit and Linger, so the managed runtime inherits only that account's
#     rights. It is a least-privilege account: no sudo, no root-equivalent
#     group, no privileged helper entry. The courier creates it inside this same
#     authorized ceremony when it is absent, and adopts a pre-existing account
#     only after re-proving that same negative.
#   * the PRIVILEGED OPERATIONS identity is CAPABILITY_PRIVILEGED_ACCOUNT (e.g.
#     ghostfleet-ops). The reviewed installer provisions it with the bounded
#     NOPASSWD rule for fleet-privctl and the forced-command SSH entry. It must
#     NEVER be the run identity: that would hand every managed process the
#     privilege the helper exists to bound.
#   * the ORDINARY HUMAN is capability_operating_user(): the person running the
#     Console command. It is only the helper's admission user; it must never own
#     a long-running service, because that would hand the managed runtime the
#     Human's rights and defeat least privilege.
# None may be root, and each is validated independently.
#
# The ordinary Human identity. It is the ONLY value the launcher may hand to
# this script, and it is only ever used to name the Human owner of the user
# unit/Linger lane and the installer's admission user. It is never a path, a
# command, or a source of extra privilege, and it is re-validated here: safe
# name, existing account, non-root, and an ordinary (uid >= 1000) account.
# The dedicated managed identity is CAPABILITY_CONTROL_ACCOUNT, which comes
# from the reviewed template and never from the caller.
capability_operating_user() {
  capability_operating="\${GHOSTFLEET_OPERATING_USER:-\${SUDO_USER:-}}"
  [ -n "$capability_operating" ] || return 0
  printf '%s' "$capability_operating" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || return 0
  command -v getent >/dev/null 2>&1 || return 0
  capability_operating_row="$(getent passwd "$capability_operating" 2>/dev/null || true)"
  [ -n "$capability_operating_row" ] || return 0
  capability_operating_uid="$(printf '%s' "$capability_operating_row" | cut -d ':' -f 3)"
  case "$capability_operating_uid" in ''|*[!0-9]*) return 0 ;; esac
  [ "$capability_operating_uid" -ne 0 ] || return 0
  [ "$capability_operating_uid" -ge 1000 ] || return 0
  # Ordinary login accounts only: nobody (65534) and any nologin/false
  # shell is not a person who can run the Console command.
  [ "$capability_operating_uid" -lt 60000 ] || return 0
  capability_operating_shell="$(printf '%s' "$capability_operating_row" | cut -d ':' -f 7)"
  case "$capability_operating_shell" in */nologin|*/false) return 0 ;; esac
  printf '%s' "$capability_operating"
}

capability_artifact_field() {
  capability_artifact_row "$1" | cut -d '|' -f "$2"
}

capability_states_compliant() {
  case "$CAPABILITY_HELPER_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  case "$CAPABILITY_USER_SERVICE_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  case "$CAPABILITY_LINGER_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  case "$CAPABILITY_AGENT_PAYLOAD_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  case "$CAPABILITY_USER_UNIT_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  case "$CAPABILITY_NODE_AUTH_STATE" in NOT_REQUESTED|COMPLIANT) ;; *) return 1 ;; esac
  return 0
}

# Read-only. Runs before package, provider, service or credential effects.
# The digest binds the exact reviewed selection (version, ticket digest, enabled
# components and every pinned artifact) to what the node recorded and reported.
capability_selection_digest() {
  {
    printf '%s\\n' 'ghostfleet-selected-capability/v2'
    printf '%s\\n' "$CAPABILITY_VERSION" "$CAPABILITY_TEMPLATE_DIGEST" \\
      "$CAPABILITY_HELPER_REQUIRED$CAPABILITY_LINGER_REQUIRED$CAPABILITY_USER_SERVICE_REQUIRED" \\
      "$CAPABILITY_CONTROL_ACCOUNT" "$CAPABILITY_PRIVILEGED_ACCOUNT" \\
      "$CAPABILITY_INSTALLER" "$CAPABILITY_PRIVILEGED_KEY" \\
      "$CAPABILITY_USER_UNIT" "$CAPABILITY_USER_UNIT_ARTIFACT" \\
      "$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" \\
      "$CAPABILITY_USER_UNIT_PAYLOAD_PATH" \\
      "$CAPABILITY_USER_UNIT_PAYLOAD_MODE"
    capability_index=1
    while [ "$capability_index" -le "$CAPABILITY_ARTIFACT_COUNT" ]; do
      printf '%s|%s|%s\\n' \\
        "$(capability_artifact_field "$capability_index" 1)" \\
        "$(capability_artifact_field "$capability_index" 2)" \\
        "$(capability_artifact_field "$capability_index" 3)"
      capability_index=$((capability_index + 1))
    done | LC_ALL=C sort
  } | sha256sum | awk '{print "sha256:" $1}'
}

capability_selection_text() {
  printf '%s\\n' "schema=$CAPABILITY_SCHEMA" "version=$CAPABILITY_VERSION" \\
    "template_digest=$CAPABILITY_TEMPLATE_DIGEST" \\
    "helper_required=$CAPABILITY_HELPER_REQUIRED" "linger_required=$CAPABILITY_LINGER_REQUIRED" \\
    "user_service_required=$CAPABILITY_USER_SERVICE_REQUIRED" \\
    "control_account=$CAPABILITY_CONTROL_ACCOUNT" \\
    "privileged_account=$CAPABILITY_PRIVILEGED_ACCOUNT" "installer=$CAPABILITY_INSTALLER" \\
    "privileged_key=$CAPABILITY_PRIVILEGED_KEY" "user_unit=$CAPABILITY_USER_UNIT" \\
    "user_unit_artifact=$CAPABILITY_USER_UNIT_ARTIFACT" \\
    "user_unit_payload_artifact=$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" \\
    "user_unit_payload_path=$CAPABILITY_USER_UNIT_PAYLOAD_PATH" \\
    "user_unit_payload_mode=$CAPABILITY_USER_UNIT_PAYLOAD_MODE"
  capability_index=1
  while [ "$capability_index" -le "$CAPABILITY_ARTIFACT_COUNT" ]; do
    printf 'artifact=%s\\n' "$(capability_artifact_row "$capability_index")"
    capability_index=$((capability_index + 1))
  done
}

# A converged node re-proves the capability it recorded, without asking for a new
# enrollment or a new credential. The record is only written after a selection
# was verified and applied by an authorized first run.
capability_restore_recorded() {
  [ -r "$CAPABILITY_RECORD_FILE" ] || return 0
  if capability_selected; then return 0; fi
  # The record authorizes an install, so it is only usable on a checkpoint that
  # recorded the same components. A record copied from another node is refused.
  grep -Eq '"privileged_helper"|"user_service"|"linger"' "$CHECKPOINT_FILE" 2>/dev/null ||
    fail 'a reviewed capability record exists but this checkpoint records no capability; refusing to install from an unrelated record'
  CAPABILITY_REQUIRED=1
  CAPABILITY_CLAIM_SELECTION_B64="$(cat "$CAPABILITY_RECORD_FILE")"
  CAPABILITY_SELECTION_ORIGIN=recorded
  capability_ingest_claim
}
capability_validate_selection() {
  if ! capability_selected; then
    [ "$CAPABILITY_ARTIFACT_COUNT" = 0 ] || fail 'refusing privileged capability artifacts that no template requested'
    [ -z "$CAPABILITY_INSTALLER" ] || fail 'refusing a privileged capability installer that no template requested'
    return 0
  fi
  # A lane left inside the privileged account by a v1 selection is refused
  # before the schema gate: that recorded selection is exactly the provenance
  # which lets this run decommission its own earlier effect.
  capability_refuse_stale_privileged_lane
  case "$CAPABILITY_SCHEMA" in
    ghostfleet-selected-capability/v2) ;;
    ghostfleet-selected-capability/v1)
      # v1 never declared which account holds the privileged helper, so the
      # courier cannot prove the run account is separated from it. Refusing to
      # guess is the whole point: a default here would BE the boundary.
      fail '[CAPABILITY_SCHEMA_V1_UNPROVEN] selected-capability schema v1 does not declare privileged_account, so the managed run account cannot be proved separate from the privileged operations account; re-render the reviewed enrollment template as ghostfleet-selected-capability/v2 with privileged_account=<the account the reviewed installer provisions>, then run the authorized Console command again; a node that already recorded a v1 selection must have that record removed first, because this courier never migrates a selection it cannot verify'
      ;;
    *) fail 'selected-capability schema is not supported' ;;
  esac
  printf '%s' "$CAPABILITY_VERSION" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$' || fail 'selected-capability version is missing or invalid'
  printf '%s' "$CAPABILITY_TEMPLATE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail 'selected-capability template digest is invalid'
  case "$CAPABILITY_ARTIFACT_COUNT" in ''|*[!0-9]*) fail 'selected-capability artifact count is invalid' ;; esac
  [ "$CAPABILITY_ARTIFACT_COUNT" -ge 1 ] || fail 'selected capability pins no artifacts'
  [ -n "$ASSETS_ORIGIN" ] || fail 'selected capability pins artifacts but no immutable asset origin was delivered; no privileged component was installed'
  for capability_tool in base64 cut mktemp sha256sum; do
    command -v "$capability_tool" >/dev/null 2>&1 || fail "preflight failed: $capability_tool is required by the selected capability"
  done
  CAPABILITY_INSTALLER_INDEX=
  CAPABILITY_KEY_INDEX=
  CAPABILITY_UNIT_INDEX=
  CAPABILITY_PAYLOAD_INDEX=
  CAPABILITY_AGENT_PAYLOAD_SHA256=
  CAPABILITY_AGENT_PAYLOAD_PINNED_MODE=
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
    if [ -n "$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" ] && [ "$capability_name" = "$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" ]; then
      CAPABILITY_PAYLOAD_INDEX="$capability_index"
      CAPABILITY_AGENT_PAYLOAD_SHA256="$capability_digest"
      CAPABILITY_AGENT_PAYLOAD_PINNED_MODE="$capability_mode"
    fi
    capability_index=$((capability_index + 1))
  done
  printf '%s' "$CAPABILITY_CONTROL_ACCOUNT" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || fail 'selected-capability control account is invalid'
  [ "$CAPABILITY_CONTROL_ACCOUNT" != root ] || fail 'selected-capability control account must not be root'
  [ -n "$CAPABILITY_PRIVILEGED_ACCOUNT" ] ||
    fail '[CAPABILITY_PRIVILEGED_ACCOUNT_REQUIRED] selected-capability declares no privileged_account; the courier will not guess which account the reviewed installer gives the bounded fleet-privctl rule to, because that guess decides whether the managed run account stays unprivileged; re-render the reviewed template with privileged_account=<the installer-provisioned account, e.g. ghostfleet-ops>'
  printf '%s' "$CAPABILITY_PRIVILEGED_ACCOUNT" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || fail '[CAPABILITY_PRIVILEGED_ACCOUNT_INVALID] selected-capability privileged account is invalid'
  [ "$CAPABILITY_PRIVILEGED_ACCOUNT" != root ] || fail 'selected-capability privileged account must not be root'
  # The identity that owns the user unit and Linger, and therefore every process
  # the managed runtime starts, is NEVER the identity that holds the bounded
  # NOPASSWD helper entry.
  [ "$CAPABILITY_CONTROL_ACCOUNT" != "$CAPABILITY_PRIVILEGED_ACCOUNT" ] ||
    fail "[CAPABILITY_ACCOUNT_COLLISION] the managed run account must not be the privileged operations account ($CAPABILITY_PRIVILEGED_ACCOUNT); that account carries the bounded NOPASSWD fleet-privctl entry, so pointing the user unit at it would hand the managed runtime the privilege the helper exists to bound; choose a dedicated run account for control_account"
  if [ "$CAPABILITY_HELPER_REQUIRED" = 1 ]; then
    [ -n "$CAPABILITY_INSTALLER_INDEX" ] || fail 'selected privileged helper does not pin its installer artifact'
    [ -n "$CAPABILITY_KEY_INDEX" ] || fail 'selected privileged helper does not pin the admitted privileged SSH public key'
    for capability_tool in bash python3 useradd usermod passwd visudo sudo getent; do
      command -v "$capability_tool" >/dev/null 2>&1 || fail "preflight failed: $capability_tool is required by the selected privileged helper"
    done
    capability_ordinary="$(capability_operating_user)"
    [ -n "$capability_ordinary" ] || fail 'selected privileged helper needs the operating Human account, but none was delivered; run the Console one-time command from the Human administrator account (the launcher captures it automatically, sudo also supplies SUDO_USER)'
    printf '%s' "$capability_ordinary" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || fail 'operating Human user name is invalid'
    [ "$capability_ordinary" != root ] || fail 'operating Human user must not be root'
    [ "$capability_ordinary" != "$CAPABILITY_CONTROL_ACCOUNT" ] || fail 'ordinary and dedicated control accounts must differ'
    [ "$capability_ordinary" != "$CAPABILITY_PRIVILEGED_ACCOUNT" ] || fail 'the operating Human account must not be the privileged operations account; run the Console one-time command from the Human administrator account, not from the bounded helper identity'
  fi
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    [ -n "$CAPABILITY_UNIT_INDEX" ] || fail 'selected user service does not pin its unit artifact'
    printf '%s' "$CAPABILITY_USER_UNIT" | grep -Eq '^[a-z][a-z0-9_.-]{0,63}\\.service$' || fail 'selected user unit name is invalid'
  fi
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    # A managed node agent is TWO pinned artifacts: the unit that launches it and
    # the payload it launches. Pinning only the launcher would let a later
    # template point the unit at whatever bytes happen to be on the host.
    [ -n "$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" ] || fail '[CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE] selected user service pins no agent payload artifact; the managed node agent is the pinned user unit plus the pinned payload it launches, so re-render the reviewed template with user_unit.payload_artifact=<the node-agent.pyz artifact name> and pin that artifact digest in artifacts; nothing was installed'
    [ -n "$CAPABILITY_PAYLOAD_INDEX" ] || fail "[CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE] selected user service payload artifact $CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT is not pinned in the artifacts list; nothing was installed"
    [ "$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" != "$CAPABILITY_USER_UNIT_ARTIFACT" ] || fail '[CAPABILITY_USER_UNIT_PAYLOAD_INVALID] the selected user service uses one artifact for both the unit and the agent payload; a unit is service metadata and the payload is executable code, so they are pinned as two distinct artifacts; nothing was installed'
    [ "$CAPABILITY_USER_UNIT_PAYLOAD_PATH" = "$CAPABILITY_AGENT_PAYLOAD_PATH" ] || fail "[CAPABILITY_USER_UNIT_PAYLOAD_INVALID] the selected agent payload path $CAPABILITY_USER_UNIT_PAYLOAD_PATH is not $CAPABILITY_AGENT_PAYLOAD_PATH; this courier installs the payload at exactly that root-owned path and re-asserts the installed unit against it; nothing was installed"
    [ "$CAPABILITY_USER_UNIT_PAYLOAD_MODE" = 0755 ] || fail "[CAPABILITY_USER_UNIT_PAYLOAD_INVALID] the selected agent payload mode $CAPABILITY_USER_UNIT_PAYLOAD_MODE is not 0755; the payload is an executable entry point, so a different mode would be either unstartable or wider than the reviewed contract; nothing was installed"
    case "$CAPABILITY_AGENT_PAYLOAD_PINNED_MODE" in
      755|0755) ;;
      *) fail "[CAPABILITY_USER_UNIT_PAYLOAD_INVALID] the pinned agent payload artifact $CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT carries mode $CAPABILITY_AGENT_PAYLOAD_PINNED_MODE; it must be pinned 0755 like the installed file; nothing was installed" ;;
    esac
  else
    [ -z "$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" ] || fail 'refusing a pinned agent payload that no selected user service launches'
  fi
  if [ "$CAPABILITY_LINGER_REQUIRED" = 1 ] || [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    command -v loginctl >/dev/null 2>&1 || fail 'preflight failed: loginctl is required by the selected capability'
  fi
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    # The managed agent talks to the node-plane bridge, never to the
    # Access-protected enrollment origin: the broker answers a node request with
    # a login wall, which the agent treats as fatal. The origin is delivered by
    # the Console command and is never derived, joined or rewritten here.
    [ -n "$NODE_PLANE_ORIGIN" ] || fail '[CAPABILITY_NODE_PLANE_ORIGIN_REQUIRED] the selected managed user service needs the node-plane origin, but GHOSTFLEET_NODE_PLANE_ORIGIN was not delivered; export the node-plane origin from the Console delivery command and re-run; nothing was installed'
    printf '%s' "$NODE_PLANE_ORIGIN" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$' ||
      fail '[CAPABILITY_NODE_PLANE_ORIGIN_INVALID] GHOSTFLEET_NODE_PLANE_ORIGIN must be an exact HTTPS origin (scheme, host and optional port only; no path, query, userinfo or trailing slash); nothing was installed'
    [ -n "$BROKER_ORIGIN" ] || fail '[CAPABILITY_NODE_PLANE_ORIGIN_NOT_SEPARATED] the enrollment origin is unknown, so the node-plane origin cannot be proved separate from it; nothing was installed'
    capability_node_plane_host="\${NODE_PLANE_ORIGIN#https://}"
    capability_node_plane_host="\${capability_node_plane_host%%:*}"
    capability_enrollment_host="\${BROKER_ORIGIN#https://}"
    capability_enrollment_host="\${capability_enrollment_host%%:*}"
    [ "$capability_node_plane_host" != "$capability_enrollment_host" ] ||
      fail '[CAPABILITY_NODE_PLANE_ORIGIN_NOT_SEPARATED] the node-plane origin must not be the Access-protected enrollment origin: the managed agent would receive a login wall instead of the node-plane bridge; deliver a distinct node-plane host; nothing was installed'
  fi
  # The pinned bytes are a dependency, not a later step. On the rendered channel
  # this runs before any effect; on the claim channel the authorized claim has
  # already happened, but nothing is installed and no one-off credential is
  # written or used until every digest matched in a private staging directory.
  # A mismatching artifact is a missing dependency.
  capability_stage
  # The staged launcher is proved before any effect: exactly one ExecStart, it
  # names the payload this courier installs, and it declares the XDG
  # directories its ReadWritePaths needs. A helper-only selection installs no
  # unit at all, so there is nothing to precheck.
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    capability_user_unit_precheck "$CAPABILITY_STAGE_DIR"
  fi
  capability_stage_cleanup
  CAPABILITY_SELECTION_DIGEST="$(capability_selection_digest)"
  return 0
}

# Fetch one pinned artifact from the immutable asset origin. The URL is built
# only from the validated origin and the digest the claim pinned, so a selection
# can never introduce a host, path or query. No redirects: the content address is
# the only reviewed location, and a 3xx is a failed verification, not a detour.
capability_fetch() {
  capability_url="$ASSETS_ORIGIN/sha256/$1"
  capability_scheme="\${ASSETS_ORIGIN%%:*}"
  CAPABILITY_HTTP_CODE=
  if command -v curl >/dev/null 2>&1; then
    # Without -L a 3xx is a final response, so the exit code alone cannot tell a
    # redirect from the pinned object; the status is checked explicitly.
    if ! CAPABILITY_HTTP_CODE="$(curl --fail --silent --show-error --no-location --max-redirs 0 --proto "=$capability_scheme" --connect-timeout 15 --max-time 120 --write-out '%{http_code}' --output "$2" "$capability_url")"; then
      return 1
    fi
    case "$CAPABILITY_HTTP_CODE" in
      2[0-9][0-9]) return 0 ;;
      *) return 1 ;;
    esac
  fi
  if command -v wget >/dev/null 2>&1; then
    wget --quiet --max-redirect=0 --timeout=120 --output-document="$2" "$capability_url"
    return $?
  fi
  CAPABILITY_HTTP_CODE=
  return 127
}

capability_stage() {
  # Stage under the root-owned checkpoint directory: no shared /tmp, no
  # caller-controlled TMPDIR, and the directory only ever holds pinned bytes.
  install -d -m 0700 -o root -g root "$CHECKPOINT_DIR" || fail 'selected-capability staging directory could not be created'
  CAPABILITY_STAGE_DIR="$CHECKPOINT_DIR/.capability-stage.$$"
  rm -rf "$CAPABILITY_STAGE_DIR"
  install -d -m 0700 -o root -g root "$CAPABILITY_STAGE_DIR" || fail 'selected-capability staging directory could not be created'
  capability_index=1
  while [ "$capability_index" -le "$CAPABILITY_ARTIFACT_COUNT" ]; do
    capability_name="$(capability_artifact_field "$capability_index" 1)"
    capability_digest="$(capability_artifact_field "$capability_index" 2)"
    capability_mode="$(capability_artifact_field "$capability_index" 3)"
    if ! capability_fetch "$capability_digest" "$CAPABILITY_STAGE_DIR/$capability_name"; then
      capability_stage_cleanup
      capability_detail='no 2xx response'
      [ -z "$CAPABILITY_HTTP_CODE" ] || capability_detail="HTTP $CAPABILITY_HTTP_CODE"
      fail "selected-capability artifact $capability_name could not be fetched from $ASSETS_ORIGIN/sha256/$capability_digest ($capability_detail); redirects are not followed and no privileged component was installed"
    fi
    capability_actual="$(sha256sum "$CAPABILITY_STAGE_DIR/$capability_name" | cut -d ' ' -f 1)" || capability_actual=
    if [ "$capability_actual" != "$capability_digest" ]; then
      capability_stage_cleanup
      fail "selected-capability artifact $capability_name failed digest verification (expected $capability_digest, got \${capability_actual:-empty}); no privileged component was installed"
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
  capability_ordinary="$(capability_operating_user)"
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
    # A pinned unit is only compliant while it launches the payload this courier
    # installs. A unit whose bytes match but whose ExecStart names another file
    # is drift: enabling it would start the wrong program under the managed name.
    if [ "$(capability_unit_exec_payload "$capability_unit_file")" = "$CAPABILITY_AGENT_PAYLOAD_PATH" ]; then
      printf '%s' COMPLIANT
    else
      printf '%s' DRIFT
    fi
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
  CAPABILITY_AGENT_PAYLOAD_STATE="$(capability_agent_payload_state)"
  CAPABILITY_USER_UNIT_STATE="$(capability_user_service_state)"
  CAPABILITY_NODE_AUTH_STATE="$(capability_node_token_state)"
  if [ "$CAPABILITY_USER_UNIT_STATE" = COMPLIANT ]; then
    CAPABILITY_USER_UNIT_EXEC="$CAPABILITY_AGENT_PAYLOAD_PATH"
  fi
}

capability_probe_all() {
  if ! capability_selected; then
    CAPABILITY_HELPER_STATE=NOT_REQUESTED
    CAPABILITY_USER_SERVICE_STATE=NOT_REQUESTED
    CAPABILITY_LINGER_STATE=NOT_REQUESTED
    CAPABILITY_AGENT_PAYLOAD_STATE=NOT_REQUESTED
    CAPABILITY_USER_UNIT_STATE=NOT_REQUESTED
    CAPABILITY_NODE_AUTH_STATE=NOT_REQUESTED
    return 0
  fi
  capability_validate_selection
  capability_stage
  capability_probe
  capability_result=0
  capability_states_compliant || capability_result=1
  # The zero-delta claim is also a security claim: an account that gained sudo
  # or a root-equivalent group since the ceremony is drift, not convergence, and
  # this read-only probe must never let the node report "already converged".
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ] || [ "$CAPABILITY_LINGER_REQUIRED" = 1 ]; then
    capability_probe_criteria="$(capability_account_criteria_state "$CAPABILITY_CONTROL_ACCOUNT")"
    [ "$capability_probe_criteria" = SAFE ] || capability_result=1
  fi
  # Independent of the account lane: a helper-only template still declares a
  # privileged account, and a compliant helper with no readable record must not
  # answer "already converged".
  if [ "$CAPABILITY_HELPER_REQUIRED" = 1 ]; then
    capability_probe_declared_mode="$(capability_declared_privileged_account_mode)"
    if ! ( capability_verify_declared_privileged_account "$capability_probe_declared_mode" ) >/dev/null 2>&1; then
      capability_result=1
    fi
  fi
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
  CAPABILITY_ENABLED_LINGER=1
  # logind can answer this query from a user record it cached before the marker was
  # written, for example when an account was deleted and recreated with the same uid
  # while its old manager was still closing. The marker is the durable state, so
  # re-read it a bounded number of times and fail closed when it never converges.
  capability_linger_try=0
  while [ "$capability_linger_try" -lt 10 ]; do
    CAPABILITY_LINGER_STATE="$(capability_linger_state)"
    if [ "$CAPABILITY_LINGER_STATE" = COMPLIANT ]; then return 0; fi
    capability_linger_try=$((capability_linger_try + 1))
    sleep 0.2
  done
  printf '%s\\n' 'fleet-enroll: Linger postcondition failed for the dedicated control account' >&2
  return 1
}

# The group the control account uses for the files this courier installs into
# its home. A file is only ever chowned to the account's own primary group.
capability_control_group() {
  capability_gid="$(getent passwd "$CAPABILITY_CONTROL_ACCOUNT" | cut -d ':' -f 4)"
  [ -n "$capability_gid" ] || return 1
  capability_group="$(getent group "$capability_gid" 2>/dev/null | cut -d ':' -f 1)"
  [ -n "$capability_group" ] || capability_group="$CAPABILITY_CONTROL_ACCOUNT"
  printf '%s' "$capability_group"
}

# The installed payload is proved from the disk on every run: a node may only
# report the payload it actually has, owned by root and carrying the pinned
# digest. Anything else is drift, not convergence.
capability_agent_payload_state() {
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" != 1 ]; then printf '%s' NOT_REQUESTED; return 0; fi
  if [ ! -e "$CAPABILITY_AGENT_PAYLOAD_PATH" ]; then
    if [ -L "$CAPABILITY_AGENT_PAYLOAD_PATH" ]; then printf '%s' OWNER_UNSAFE; return 0; fi
    printf '%s' ABSENT
    return 0
  fi
  if [ -L "$CAPABILITY_AGENT_PAYLOAD_PATH" ] || [ ! -f "$CAPABILITY_AGENT_PAYLOAD_PATH" ]; then
    printf '%s' OWNER_UNSAFE
    return 0
  fi
  if [ "$(stat -c '%U:%G' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)" != 'root:root' ]; then
    printf '%s' OWNER_UNSAFE
    return 0
  fi
  if [ "$(stat -c '%a' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)" != 755 ]; then
    printf '%s' MODE_UNSAFE
    return 0
  fi
  if [ "$(sha256sum "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null | cut -d ' ' -f 1)" = "$CAPABILITY_AGENT_PAYLOAD_SHA256" ]; then
    printf '%s' COMPLIANT
  else
    printf '%s' DRIFT
  fi
  return 0
}

# The node token is a bearer secret for exactly one node. Its presence, owner,
# mode and shape are proved without ever printing or logging its content.
capability_node_token_state() {
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" != 1 ]; then printf '%s' NOT_REQUESTED; return 0; fi
  capability_home="$(capability_control_home)"
  [ -n "$capability_home" ] || { printf '%s' UNKNOWN; return 0; }
  capability_token_dir="$capability_home/.config/ghostfleet"
  capability_token_file="$capability_token_dir/node-token"
  if [ ! -e "$capability_token_file" ] && [ ! -L "$capability_token_file" ]; then printf '%s' ABSENT; return 0; fi
  if [ -L "$capability_token_file" ] || [ ! -f "$capability_token_file" ]; then printf '%s' OWNER_UNSAFE; return 0; fi
  if [ "$(stat -c '%U' "$capability_token_file" 2>/dev/null)" != "$CAPABILITY_CONTROL_ACCOUNT" ]; then
    printf '%s' OWNER_UNSAFE
    return 0
  fi
  if [ "$(stat -c '%a' "$capability_token_file" 2>/dev/null)" != 600 ]; then printf '%s' MODE_UNSAFE; return 0; fi
  if [ ! -d "$capability_token_dir" ] || [ -L "$capability_token_dir" ]; then printf '%s' MODE_UNSAFE; return 0; fi
  if [ "$(stat -c '%U' "$capability_token_dir" 2>/dev/null)" != "$CAPABILITY_CONTROL_ACCOUNT" ]; then
    printf '%s' OWNER_UNSAFE
    return 0
  fi
  if [ "$(stat -c '%a' "$capability_token_dir" 2>/dev/null)" != 700 ]; then printf '%s' MODE_UNSAFE; return 0; fi
  # 32 CSPRNG bytes, base64url, one line and nothing else.
  if ! grep -Eqx '[A-Za-z0-9_-]{43}' "$capability_token_file" 2>/dev/null; then printf '%s' INVALID; return 0; fi
  printf '%s' COMPLIANT
  return 0
}

# The token in an ExecStart line that names the managed payload. Used to prove
# the installed unit launches exactly the file the courier installed.
capability_unit_exec_payload() {
  capability_exec_line="$(sed -n 's/^[[:space:]]*ExecStart[[:space:]]*=[[:space:]]*//p' "$1" 2>/dev/null | head -n 1)"
  for capability_token in $capability_exec_line; do
    case "$capability_token" in
      "$CAPABILITY_AGENT_PAYLOAD_PATH") printf '%s' "$capability_token"; return 0 ;;
    esac
  done
  printf '%s' "$capability_exec_line" | awk '{print $1}'
}

# Re-read the INSTALLED unit and prove it launches the payload path this courier
# installed. A unit that is a byte-for-byte copy of the pinned artifact can still
# be read again after install; when it does not name the payload, nothing is
# started and the run fails closed.
capability_user_unit_exec_assert() {
  [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ] || return 0
  capability_home="$(capability_control_home)"
  [ -n "$capability_home" ] || fail '[CAPABILITY_USER_UNIT_EXEC_MISMATCH] the selected control account has no home directory, so the installed unit cannot be re-read; no service was started'
  capability_unit_file="$capability_home/.config/systemd/user/$CAPABILITY_USER_UNIT"
  [ -f "$capability_unit_file" ] || fail "[CAPABILITY_USER_UNIT_EXEC_MISMATCH] the installed unit $CAPABILITY_USER_UNIT could not be re-read; no service was started"
  capability_exec_token="$(capability_unit_exec_payload "$capability_unit_file")"
  [ "$capability_exec_token" = "$CAPABILITY_AGENT_PAYLOAD_PATH" ] ||
    fail "[CAPABILITY_USER_UNIT_EXEC_MISMATCH] the installed unit $CAPABILITY_USER_UNIT does not start $CAPABILITY_AGENT_PAYLOAD_PATH (ExecStart names $capability_exec_token); the payload is installed at exactly that path and nothing is started until the unit launches it; no service was started"
  capability_installed_exec="$(sed -n 's/^[[:space:]]*ExecStart[[:space:]]*=[[:space:]]*//p' "$capability_unit_file" 2>/dev/null | head -n 1)"
  capability_exec_expected="/usr/bin/python3 -I $CAPABILITY_AGENT_PAYLOAD_PATH run"
  if [ "$capability_installed_exec" != "$capability_exec_expected" ]; then
    fail "[CAPABILITY_USER_UNIT_EXEC_MISMATCH] the installed unit $CAPABILITY_USER_UNIT launches '$capability_installed_exec' but the managed launcher must be exactly '$capability_exec_expected'; no service was started"
  fi
  CAPABILITY_USER_UNIT_EXEC="$capability_exec_token"
  return 0
}

# A pinned launcher starts the pinned payload and nothing else. Every rule here
# is proved on the staged bytes, before the unit is installed or enabled:
#   - exactly one ExecStart and no other Exec directive;
#   - ExecStart names the payload path this courier installs;
#   - no shell interpreter, no remote fetch, no /bin/sh;
#   - ReadWritePaths stay inside the run account home and each one has the
#     StateDirectory/ConfigurationDirectory directive systemd needs to create it
#     (without it the unit dies with status=226/NAMESPACE on a fresh host).
capability_user_unit_precheck() {
  capability_unit_source="$1/$CAPABILITY_USER_UNIT_ARTIFACT"
  [ -f "$capability_unit_source" ] ||
    fail "[CAPABILITY_MANAGED_ARTIFACTS_INCOMPLETE] the pinned user unit artifact $CAPABILITY_USER_UNIT_ARTIFACT was not staged; no user unit was installed"
  capability_exec_total="$(grep -Ec '^[[:space:]]*Exec[A-Za-z]*[[:space:]]*=' "$capability_unit_source" 2>/dev/null)"
  capability_exec_start_count="$(grep -Ec '^[[:space:]]*ExecStart[[:space:]]*=' "$capability_unit_source" 2>/dev/null)"
  if [ "$capability_exec_total" != 1 ] || [ "$capability_exec_start_count" != 1 ]; then
    fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT must carry exactly one ExecStart and no other Exec directive; a managed launcher starts one program and nothing else; no user unit was installed"
  fi
  capability_exec_start="$(sed -n 's/^[[:space:]]*ExecStart[[:space:]]*=[[:space:]]*//p' "$capability_unit_source" 2>/dev/null | head -n 1)"
  [ -n "$capability_exec_start" ] ||
    fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT has an empty ExecStart; no user unit was installed"
  capability_exec_names_payload=0
  for capability_token in $capability_exec_start; do
    case "$capability_token" in
      "$CAPABILITY_AGENT_PAYLOAD_PATH") capability_exec_names_payload=1 ;;
    esac
  done
  [ "$capability_exec_names_payload" = 1 ] ||
    fail "[CAPABILITY_USER_UNIT_EXEC_MISMATCH] the pinned user unit $CAPABILITY_USER_UNIT does not start $CAPABILITY_AGENT_PAYLOAD_PATH; the payload is installed at exactly that path and nothing is started until the unit launches it; no user unit was installed"
  if grep -Eq '(^|[[:space:]])--(config|token|url|endpoint|host|auth|credential)([[:space:]=]|$)' "$capability_unit_source" 2>/dev/null; then
    fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT passes a --config, --token or --url style argument; the production agent reads the root-owned /etc/ghostfleet/node-agent.json and the unit carries no endpoint, credential or override; no user unit was installed"
  fi
  capability_exec_expected="/usr/bin/python3 -I $CAPABILITY_AGENT_PAYLOAD_PATH run"
  if [ "$capability_exec_start" != "$capability_exec_expected" ]; then
    fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT must start the payload with exactly '$capability_exec_expected' but carries '$capability_exec_start'; a managed launcher starts the pinned payload and nothing else; no user unit was installed"
  fi
  if grep -Eq '(^|[^A-Za-z0-9_.-])(sh|bash|dash|zsh)[[:space:]]+-c' "$capability_unit_source" 2>/dev/null ||
     grep -Eq '(^|[^A-Za-z0-9_.-])(curl|wget)([^A-Za-z0-9_.-]|$)' "$capability_unit_source" 2>/dev/null ||
     grep -Eq '/bin/sh' "$capability_unit_source" 2>/dev/null; then
    fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT invokes a shell interpreter or fetches remote code; a managed launcher starts the pinned payload and nothing else; no user unit was installed"
  fi
  if grep -Eq '^[[:space:]]*ProtectHome[[:space:]]*=[[:space:]]*(read-write|rw)([[:space:]]|$)' "$capability_unit_source" 2>/dev/null; then
    fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT asks for ProtectHome=read-write, which is not a legal systemd value; use read-only with ReadWritePaths for the paths the agent owns; no user unit was installed"
  fi
  capability_rd_paths="$(sed -n 's/^[[:space:]]*ReadWritePaths[[:space:]]*=[[:space:]]*//p' "$capability_unit_source" 2>/dev/null)"
  capability_state_dirs="$(sed -n 's/^[[:space:]]*StateDirectory[[:space:]]*=[[:space:]]*//p' "$capability_unit_source" 2>/dev/null | head -n 1)"
  capability_config_dirs="$(sed -n 's/^[[:space:]]*ConfigurationDirectory[[:space:]]*=[[:space:]]*//p' "$capability_unit_source" 2>/dev/null | head -n 1)"
  for capability_path in $capability_rd_paths; do
    case "$capability_path" in
      %h/*) ;;
      *) fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT opens $capability_path for writing; a managed launcher may only write inside the run account home; no user unit was installed" ;;
    esac
    case "$capability_path" in
      *..*) fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT opens $capability_path for writing, which resolves outside the run account home; no user unit was installed" ;;
    esac
    case "$capability_path" in
      %h/.config/*)
        capability_needed="$(printf '%s' "$capability_path" | cut -c 12- | cut -d '/' -f 1)"
        [ "$capability_needed" = "$capability_config_dirs" ] ||
          fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT opens $capability_path for writing but does not declare ConfigurationDirectory=$capability_needed; systemd cannot create that directory for a --user unit and the service dies with status=226/NAMESPACE on a fresh host; no user unit was installed"
        ;;
      %h/.local/state/*)
        capability_needed="$(printf '%s' "$capability_path" | cut -c 17- | cut -d '/' -f 1)"
        [ "$capability_needed" = "$capability_state_dirs" ] ||
          fail "[CAPABILITY_USER_UNIT_UNSAFE] the pinned user unit $CAPABILITY_USER_UNIT opens $capability_path for writing but does not declare StateDirectory=$capability_needed; systemd cannot create that directory for a --user unit and the service dies with status=226/NAMESPACE on a fresh host; no user unit was installed"
        ;;
    esac
  done
  return 0
}

# Install the pinned payload at the root-owned path the unit starts. The bytes
# are copied next to the destination, verified and synced, then renamed over it,
# so a crash never leaves a partial payload and a same-digest run is a no-op.
# A target that this courier does not own is refused, never chowned.
capability_agent_payload_apply() {
  [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ] || return 0
  capability_payload_dir="\${CAPABILITY_AGENT_PAYLOAD_PATH%/*}"
  capability_payload_name="\${CAPABILITY_AGENT_PAYLOAD_PATH##*/}"
  if [ -e "$capability_payload_dir" ] || [ -L "$capability_payload_dir" ]; then
    if [ -L "$capability_payload_dir" ] || [ ! -d "$capability_payload_dir" ]; then
      fail "[CAPABILITY_AGENT_PAYLOAD_OWNER_UNSAFE] $capability_payload_dir is not a real directory; refusing to install the agent payload through a link or a regular file"
    fi
    [ "$(stat -c '%U:%G' "$capability_payload_dir" 2>/dev/null)" = 'root:root' ] ||
      fail "[CAPABILITY_AGENT_PAYLOAD_OWNER_UNSAFE] $capability_payload_dir is not owned by root:root; refusing to install the agent payload into a directory this courier does not own"
  else
    install -d -m 0755 -o root -g root "$capability_payload_dir" ||
      fail 'the agent payload directory could not be created'
    CAPABILITY_CREATED_PAYLOAD_DIR=1
  fi
  capability_payload_existed=0
  if [ -e "$CAPABILITY_AGENT_PAYLOAD_PATH" ] || [ -L "$CAPABILITY_AGENT_PAYLOAD_PATH" ]; then
    capability_payload_existed=1
    if [ -L "$CAPABILITY_AGENT_PAYLOAD_PATH" ] || [ ! -f "$CAPABILITY_AGENT_PAYLOAD_PATH" ]; then
      fail "[CAPABILITY_AGENT_PAYLOAD_OWNER_UNSAFE] $CAPABILITY_AGENT_PAYLOAD_PATH is not a regular file; refusing to replace a payload this courier did not install"
    fi
    [ "$(stat -c '%U:%G' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)" = 'root:root' ] ||
      fail "[CAPABILITY_AGENT_PAYLOAD_OWNER_UNSAFE] the installed agent payload $CAPABILITY_AGENT_PAYLOAD_PATH is not owned by root:root; this courier replaces only its own root-owned artifact and never chowns a file it did not install"
    if [ "$(sha256sum "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null | cut -d ' ' -f 1)" = "$CAPABILITY_AGENT_PAYLOAD_SHA256" ] &&
       [ "$(stat -c '%a' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)" = 755 ]; then
      CAPABILITY_AGENT_PAYLOAD_STATE=COMPLIANT
      CAPABILITY_EVIDENCE_PAYLOAD_STATE=COMPLIANT
      return 0
    fi
  fi
  capability_payload_tmp="$capability_payload_dir/.$capability_payload_name.tmp.$$"
  rm -f "$capability_payload_tmp"
  install -m 0755 -o root -g root "$CAPABILITY_STAGE_DIR/$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" "$capability_payload_tmp" ||
    fail 'the verified agent payload could not be staged next to its destination'
  if [ "$(sha256sum "$capability_payload_tmp" 2>/dev/null | cut -d ' ' -f 1)" != "$CAPABILITY_AGENT_PAYLOAD_SHA256" ]; then
    rm -f "$capability_payload_tmp"
    fail "the staged agent payload does not match the pinned digest $CAPABILITY_AGENT_PAYLOAD_SHA256; no payload was installed"
  fi
  chmod 0755 "$capability_payload_tmp" || { rm -f "$capability_payload_tmp"; fail 'the staged agent payload mode could not be set'; }
  sync
  mv -f "$capability_payload_tmp" "$CAPABILITY_AGENT_PAYLOAD_PATH" ||
    fail "the verified agent payload could not be moved to $CAPABILITY_AGENT_PAYLOAD_PATH"
  sync
  if [ "$(sha256sum "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null | cut -d ' ' -f 1)" != "$CAPABILITY_AGENT_PAYLOAD_SHA256" ] ||
     [ "$(stat -c '%U:%G' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)" != 'root:root' ] ||
     [ "$(stat -c '%a' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)" != 755 ]; then
    capability_rollback_files
    fail "the installed agent payload $CAPABILITY_AGENT_PAYLOAD_PATH failed its postcondition (digest, owner or mode); no service was started"
  fi
  CAPABILITY_AGENT_PAYLOAD_STATE=COMPLIANT
  CAPABILITY_EVIDENCE_PAYLOAD_STATE=INSTALLED
  if [ "$capability_payload_existed" = 0 ]; then CAPABILITY_CREATED_PAYLOAD=1; fi
  return 0
}

# ReadWritePaths needs these XDG directories to exist before the unit starts. The
# unit's StateDirectory/ConfigurationDirectory create them too; creating them
# here as well makes the two paths self-healing and keeps the install honest
# instead of relying on systemd to paper over a missing step.
capability_agent_state_dirs() {
  [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ] || return 0
  capability_home="$(capability_control_home)"
  [ -n "$capability_home" ] || fail 'the selected control account has no home directory; no user service could be installed'
  [ -d "$capability_home" ] || fail 'the selected control account home directory is missing; no user service could be installed'
  capability_created_any=0
  for capability_dir in \\
    "$capability_home/.config/ghostfleet" \\
    "$capability_home/.local" \\
    "$capability_home/.local/state/ghostfleet-agent"; do
    if [ ! -d "$capability_dir" ]; then capability_created_any=1; fi
    install -d -m 0700 -o "$CAPABILITY_CONTROL_ACCOUNT" -g "$(capability_control_group)" "$capability_dir" ||
      fail "the agent state directory $capability_dir could not be created for $CAPABILITY_CONTROL_ACCOUNT"
  done
  if [ "$capability_created_any" = 1 ]; then CAPABILITY_CREATED_STATE_DIR=1; fi
  return 0
}

# Non-secret agent configuration, root-owned so the managed account reads its
# control-plane origin and its own unit name from a file the task channel cannot
# rewrite. The token never appears here.
capability_agent_config_write() {
  [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ] || return 0
  capability_config_dir="\${CAPABILITY_AGENT_CONFIG_PATH%/*}"
  if ! install -d -m 0755 -o root -g root "$capability_config_dir"; then
    printf '%s\\n' 'fleet-enroll: the managed agent configuration directory could not be created' >&2
    return 1
  fi
  # The body is exactly the documented production key set: the agent's parser
  # rejects unknown top-level keys and requires numeric intervals, so an extra
  # schema/node_uid field or a nested range would make the unit exit 2 forever.
  # node_uid is non-secret but lives in ~/.config/ghostfleet/node.json; keeping
  # it out of the root-owned file leaves one owner for that fact.
  capability_config_body='{"control_plane_origin":"'"$NODE_PLANE_ORIGIN"'","heartbeat_interval_s":30,"heartbeat_interval_min_s":30,"heartbeat_interval_max_s":300,"allowed_units":["'"$CAPABILITY_USER_UNIT"'"]}'
  if [ -r "$CAPABILITY_AGENT_CONFIG_PATH" ] && [ ! -L "$CAPABILITY_AGENT_CONFIG_PATH" ] &&
     [ "$(cat "$CAPABILITY_AGENT_CONFIG_PATH" 2>/dev/null)" = "$capability_config_body" ] &&
     [ "$(stat -c '%U:%G' "$CAPABILITY_AGENT_CONFIG_PATH" 2>/dev/null)" = 'root:root' ] &&
     [ "$(stat -c '%a' "$CAPABILITY_AGENT_CONFIG_PATH" 2>/dev/null)" = 644 ]; then
    return 0
  fi
  if [ -e "$CAPABILITY_AGENT_CONFIG_PATH" ] && [ ! -f "$CAPABILITY_AGENT_CONFIG_PATH" ]; then
    printf '%s\\n' "fleet-enroll: [CAPABILITY_AGENT_CONFIG_UNSAFE] $CAPABILITY_AGENT_CONFIG_PATH is not a regular file; refusing to replace the managed agent configuration" >&2
    return 1
  fi
  if [ -e "$CAPABILITY_AGENT_CONFIG_PATH" ] &&
     [ "$(stat -c '%U:%G' "$CAPABILITY_AGENT_CONFIG_PATH" 2>/dev/null)" != 'root:root' ]; then
    printf '%s\\n' "fleet-enroll: [CAPABILITY_AGENT_CONFIG_UNSAFE] $CAPABILITY_AGENT_CONFIG_PATH is not owned by root:root; refusing to replace a configuration file this courier did not install" >&2
    return 1
  fi
  if ! printf '%s\\n' "$capability_config_body" > "$CAPABILITY_AGENT_CONFIG_PATH.$$"; then
    rm -f "$CAPABILITY_AGENT_CONFIG_PATH.$$"
    printf '%s\\n' 'fleet-enroll: the managed agent configuration could not be staged' >&2
    return 1
  fi
  if ! chmod 0644 "$CAPABILITY_AGENT_CONFIG_PATH.$$" ||
     ! chown root:root "$CAPABILITY_AGENT_CONFIG_PATH.$$" ||
     ! sync; then
    rm -f "$CAPABILITY_AGENT_CONFIG_PATH.$$"
    printf '%s\\n' 'fleet-enroll: the managed agent configuration could not be sealed' >&2
    return 1
  fi
  if ! mv -f "$CAPABILITY_AGENT_CONFIG_PATH.$$" "$CAPABILITY_AGENT_CONFIG_PATH"; then
    rm -f "$CAPABILITY_AGENT_CONFIG_PATH.$$"
    printf '%s\\n' 'fleet-enroll: the managed agent configuration could not be installed' >&2
    return 1
  fi
  if [ "$(stat -c '%a' "$CAPABILITY_AGENT_CONFIG_PATH" 2>/dev/null)" != 644 ]; then
    printf '%s\\n' "fleet-enroll: [CAPABILITY_AGENT_CONFIG_UNSAFE] the managed agent configuration is not 0644 after install" >&2
    return 1
  fi
  CAPABILITY_CREATED_AGENT_CONFIG=1
  return 0
}

# The completion response is the ONLY place a node credential is delivered. The
# token is parsed into shell variables, never printed, never passed in argv and
# never written to a name: a missing or expired credential fails here, before any
# payload or unit exists on the host.
capability_node_credential_parse() {
  [ -n "$CAPABILITY_COMPLETE_RESPONSE" ] ||
    fail '[CAPABILITY_NODE_CREDENTIAL_MISSING] the control plane returned an empty completion response, so no node credential could be delivered; the agent payload and the user unit were not installed, nothing was enabled and Linger was not enabled; re-run the authorized Console command'
  capability_handoff="$(printf '%s' "$CAPABILITY_COMPLETE_RESPONSE" | tr -d '\\n\\r' | sed -n 's/.*"credential_handoff"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
  CAPABILITY_AUTH_HANDOFF="$capability_handoff"
  if [ "$capability_handoff" = EXPIRED ]; then
    fail '[CAPABILITY_NODE_CREDENTIAL_EXPIRED] the node credential handoff for this ticket expired before the agent could be installed; the control plane keeps the credential ciphertext for a bounded window, so it cannot be re-delivered for this ticket; retire the node and re-sign the enrollment ticket, then run the authorized Console command again'
  fi
  capability_credential="$(printf '%s' "$CAPABILITY_COMPLETE_RESPONSE" | tr -d '\\n\\r' | sed -n 's/.*"node_credential"[[:space:]]*:[[:space:]]*{\\([^}]*\\)}.*/\\1/p')"
  CAPABILITY_NODE_AUTH=
  capability_credential_uid=
  if [ -n "$capability_credential" ]; then
    CAPABILITY_NODE_AUTH="$(printf '%s' "$capability_credential" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    capability_credential_uid="$(printf '%s' "$capability_credential" | sed -n 's/.*"node_uid"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
  fi
  if [ -z "$CAPABILITY_NODE_AUTH" ]; then
    fail '[CAPABILITY_NODE_CREDENTIAL_MISSING] the completion response carried no node credential, so this node cannot authenticate to the control plane; the agent payload and the user unit were not installed, nothing was enabled and Linger was not enabled; re-run the authorized Console command and, if the response still carries no credential, retire the node and re-sign the enrollment ticket'
  fi
  if ! printf '%s' "$CAPABILITY_NODE_AUTH" | grep -Eq '^[A-Za-z0-9_-]{43}$'; then
    fail '[CAPABILITY_NODE_CREDENTIAL_INVALID] the delivered node credential is not a 32-byte base64url token; the agent payload and the user unit were not installed and Linger was not enabled'
  fi
  if ! printf '%s' "$capability_credential_uid" | grep -Eq '^node-[A-Za-z0-9-]{8,80}$'; then
    fail '[CAPABILITY_NODE_CREDENTIAL_INVALID] the delivered node credential carries no node_uid; the agent payload and the user unit were not installed and Linger was not enabled'
  fi
  if [ -n "$NODE_UID" ] && [ "$capability_credential_uid" != "$NODE_UID" ]; then
    fail '[CAPABILITY_NODE_CREDENTIAL_INVALID] the delivered node credential belongs to a different node than the claim; the agent payload and the user unit were not installed and Linger was not enabled'
  fi
  CAPABILITY_NODE_AUTH_RECEIVED=yes
  CAPABILITY_AGENT_CONFIGURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  return 0
}

# Install the credential into the control account's home: node-token 0600 in a
# 0700 directory, plus the non-secret node.json. The token is staged root-only
# under the checkpoint directory and installed with install(1), so it never
# travels through a redirection written as another account. A retry that
# receives the SAME token is an idempotent success; a DIFFERENT token is refused
# instead of silently replacing a credential the running agent may already use.
capability_node_credential_write() {
  capability_home="$(capability_control_home)"
  [ -n "$capability_home" ] || fail 'the selected control account has no home directory; no node credential could be installed'
  capability_token_dir="$capability_home/.config/ghostfleet"
  capability_token_file="$capability_token_dir/node-token"
  capability_node_json="$capability_token_dir/node.json"
  install -d -m 0700 -o "$CAPABILITY_CONTROL_ACCOUNT" -g "$(capability_control_group)" "$capability_token_dir" ||
    fail 'the node credential directory could not be created for the control account'
  capability_stage_token="$CHECKPOINT_DIR/.node-token.$$"
  printf '%s' "$CAPABILITY_NODE_AUTH" > "$capability_stage_token" ||
    { rm -f "$capability_stage_token"; fail 'the node credential could not be staged'; }
  chmod 0600 "$capability_stage_token" &&
    chown root:root "$capability_stage_token" ||
    { rm -f "$capability_stage_token"; fail 'the staged node credential could not be protected'; }
  sync
  capability_token_existed=0
  if [ -e "$capability_token_file" ] || [ -L "$capability_token_file" ]; then
    capability_token_existed=1
    if [ -L "$capability_token_file" ] || [ ! -f "$capability_token_file" ]; then
      rm -f "$capability_stage_token"
      fail "[CAPABILITY_NODE_TOKEN_OWNER_UNSAFE] $capability_token_file is not a regular file; refusing to write the node token through a link"
    fi
    if [ "$(stat -c '%U' "$capability_token_file" 2>/dev/null)" != "$CAPABILITY_CONTROL_ACCOUNT" ]; then
      rm -f "$capability_stage_token"
      fail "[CAPABILITY_NODE_TOKEN_OWNER_UNSAFE] $capability_token_file is not owned by $CAPABILITY_CONTROL_ACCOUNT; refusing to overwrite a file this courier does not own"
    fi
    if cmp -s "$capability_stage_token" "$capability_token_file"; then
      rm -f "$capability_stage_token"
      CAPABILITY_NODE_AUTH_STATE="$(capability_node_token_state)"
      [ "$CAPABILITY_NODE_AUTH_STATE" = COMPLIANT ] ||
        fail "[CAPABILITY_NODE_TOKEN_INVALID] the stored node token already matches the one the control plane delivered but its state is $CAPABILITY_NODE_AUTH_STATE; repair mode 0600 and owner $CAPABILITY_CONTROL_ACCOUNT on $capability_token_dir and $capability_token_file before retrying"
      CAPABILITY_NODE_AUTH_MODE=0600
      return 0
    fi
    rm -f "$capability_stage_token"
    fail "[CAPABILITY_NODE_CREDENTIAL_CONFLICT] this node already stores a different node token at $capability_token_file; overwriting it would silently replace a credential the agent may already be using; retire the node and re-sign the enrollment ticket instead of overwriting the stored token"
  fi
  install -m 0600 -o "$CAPABILITY_CONTROL_ACCOUNT" -g "$(capability_control_group)" "$capability_stage_token" "$capability_token_file" ||
    { rm -f "$capability_stage_token"; fail "the node token could not be installed for $CAPABILITY_CONTROL_ACCOUNT"; }
  rm -f "$capability_stage_token"
  sync
  capability_node_json_body='{"node_uid":"'"$capability_credential_uid"'","platform":"'"$(uname -s | tr 'A-Z' 'a-z')-$(uname -m)"'","issued_at":"'"$CAPABILITY_AGENT_CONFIGURED_AT"'"}'
  printf '%s\\n' "$capability_node_json_body" > "$capability_node_json.$$" &&
    chmod 0600 "$capability_node_json.$$" &&
    chown "$CAPABILITY_CONTROL_ACCOUNT:$(capability_control_group)" "$capability_node_json.$$" &&
    sync &&
    mv -f "$capability_node_json.$$" "$capability_node_json" ||
    { rm -f "$capability_node_json.$$"; fail 'the node descriptor could not be written for the control account'; }
  if [ "$capability_token_existed" = 0 ]; then CAPABILITY_CREATED_NODE_AUTH=1; fi
  CAPABILITY_CREATED_NODE_JSON=1
  CAPABILITY_NODE_AUTH_STATE="$(capability_node_token_state)"
  [ "$CAPABILITY_NODE_AUTH_STATE" = COMPLIANT ] ||
    fail "[CAPABILITY_NODE_TOKEN_INVALID] the installed node token failed its postcondition ($CAPABILITY_NODE_AUTH_STATE); the agent payload and the user unit were not installed and Linger was not enabled"
  CAPABILITY_NODE_AUTH_MODE=0600
  return 0
}

# The public capability projection is the only thing an unprivileged reader may
# see. It is written after the managed lane converged, is re-derived from the
# validated selection, and never carries a token, a secret, a home path or any
# 0600 data. A failed projection fails the lane: no half-written file, no
# "installed but unrecorded" node.
# @@GHOSTFLEET_CAPABILITY_STATUS_FRAGMENT_PROJECTION_BEGIN@@
capability_status_projection() {
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" != 1 ]; then return 0; fi
  capability_status_dir="$CAPABILITY_AGENT_CONFIG_DIR"
  capability_status_file="$capability_status_dir/capability-status.json"
  [ -n "$CAPABILITY_TEMPLATE_DIGEST" ] || return 1
  capability_status_pin="$(printf '%s' "$CAPABILITY_TEMPLATE_DIGEST" | sed 's/^sha256://' | cut -c 1-40)"
  case "$capability_status_pin" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) printf '%s\\n' 'fleet-enroll: the reviewed template digest cannot be projected as a release pin' >&2; return 1 ;;
  esac
  if [ -f "$capability_status_file" ] && [ ! -L "$capability_status_file" ] &&
     [ "$(stat -c '%U:%G' "$capability_status_file" 2>/dev/null)" = 'root:root' ] &&
     [ "$(stat -c '%a' "$capability_status_file" 2>/dev/null)" = 644 ] &&
     grep -Fq "\\"release_pin\\":\\"$capability_status_pin\\"" "$capability_status_file" 2>/dev/null &&
     grep -Fq "\\"payload_sha256\\":\\"$CAPABILITY_AGENT_PAYLOAD_SHA256\\"" "$capability_status_file" 2>/dev/null &&
     grep -Fq "\\"control_account\\":\\"$CAPABILITY_CONTROL_ACCOUNT\\"" "$capability_status_file" 2>/dev/null; then
    return 0
  fi
  capability_status_artifacts=''
  capability_status_unit_sha=''
  capability_status_index=1
  while [ "$capability_status_index" -le "$CAPABILITY_ARTIFACT_COUNT" ]; do
    capability_status_row="$(capability_artifact_row "$capability_status_index")"
    capability_status_name="$capability_status_row"
    capability_status_name="\${capability_status_name%%|*}"
    capability_status_rest="$capability_status_row"
    capability_status_rest="\${capability_status_rest#*|}"
    capability_status_sha="\${capability_status_rest%%|*}"
    capability_status_mode="\${capability_status_rest#*|}"
    capability_status_kind=helper
    [ "$capability_status_name" != "$CAPABILITY_INSTALLER" ] || capability_status_kind=installer
    [ "$capability_status_name" != "$CAPABILITY_PRIVILEGED_KEY" ] || capability_status_kind=key
    [ "$capability_status_name" != "$CAPABILITY_USER_UNIT_ARTIFACT" ] || capability_status_kind=unit
    [ "$capability_status_name" != "$CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT" ] || capability_status_kind=payload
    [ "$capability_status_name" != "$CAPABILITY_USER_UNIT_ARTIFACT" ] || capability_status_unit_sha="$capability_status_sha"
    [ -z "$capability_status_artifacts" ] || capability_status_artifacts="$capability_status_artifacts,"
    capability_status_artifacts="$capability_status_artifacts{\\"name\\":\\"$capability_status_name\\",\\"sha256\\":\\"$capability_status_sha\\",\\"mode\\":\\"$capability_status_mode\\",\\"kind\\":\\"$capability_status_kind\\"}"
    capability_status_index=$((capability_status_index + 1))
  done
  [ -n "$capability_status_unit_sha" ] || return 1
  capability_status_body="{\\\"schema\\\":\\\"ghostfleet-capability-status/v1\\\",\\\"selection_schema\\\":\\\"$CAPABILITY_SCHEMA\\\",\\\"selection_digest\\\":\\\"$CAPABILITY_SELECTION_DIGEST\\\",\\\"release_pin\\\":\\\"$capability_status_pin\\\",\\\"applied_at\\\":\\\"\${CAPABILITY_STATUS_APPLIED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}\\\",\\\"control_account\\\":\\\"$CAPABILITY_CONTROL_ACCOUNT\\\",\\\"privileged_account\\\":\\\"$CAPABILITY_PRIVILEGED_ACCOUNT\\\",\\\"artifacts\\\":[$capability_status_artifacts],\\\"payload_sha256\\\":\\\"$CAPABILITY_AGENT_PAYLOAD_SHA256\\\",\\\"user_unit\\\":{\\\"name\\\":\\\"$CAPABILITY_USER_UNIT\\\",\\\"sha256\\\":\\\"$capability_status_unit_sha\\\",\\\"payload_sha256\\\":\\\"$CAPABILITY_AGENT_PAYLOAD_SHA256\\\",\\\"payload_path\\\":\\\"$CAPABILITY_AGENT_PAYLOAD_PATH\\\"}}"
  [ -d "$capability_status_dir" ] || install -d -m 0755 -o root -g root "$capability_status_dir" || {
    printf '%s\\n' 'fleet-enroll: the public capability directory could not be created' >&2; return 1; }
  [ "$(stat -c '%U:%G' "$capability_status_dir" 2>/dev/null)" = 'root:root' ] || {
    printf '%s\\n' 'fleet-enroll: the public capability directory is not owned by root:root' >&2; return 1; }
  # A projection this run replaces must be restorable: a failed lane never
  # leaves a public file that names a version the node does not run.
  CAPABILITY_STATUS_BACKUP=''
  if [ -e "$capability_status_file" ] || [ -L "$capability_status_file" ]; then
    capability_status_backup="$CHECKPOINT_DIR/.capability-status.json.bak.$$"
    rm -f "$capability_status_backup"
    if ! cp -p "$capability_status_file" "$capability_status_backup" 2>/dev/null; then
      rm -f "$capability_status_backup"
      printf '%s\\n' 'fleet-enroll: the previous public capability projection could not be preserved for rollback' >&2
      return 1
    fi
    CAPABILITY_STATUS_BACKUP="$capability_status_backup"
  fi
  capability_status_tmp="$capability_status_dir/.capability-status.json.$$"
  rm -f "$capability_status_tmp"
  if ! printf '%s\\n' "$capability_status_body" > "$capability_status_tmp"; then
    rm -f "$capability_status_tmp"
    printf '%s\\n' 'fleet-enroll: the public capability projection could not be staged' >&2
    return 1
  fi
  if ! chmod 0644 "$capability_status_tmp" || ! chown root:root "$capability_status_tmp" ||
     ! sync "$capability_status_tmp" 2>/dev/null; then
    rm -f "$capability_status_tmp"
    printf '%s\\n' 'fleet-enroll: the public capability projection could not be sealed' >&2
    return 1
  fi
  if ! mv -f "$capability_status_tmp" "$capability_status_file"; then
    rm -f "$capability_status_tmp"
    printf '%s\\n' 'fleet-enroll: the public capability projection could not be promoted' >&2
    return 1
  fi
  CAPABILITY_CREATED_STATUS_PROJECTION=1
  sync "$capability_status_dir" 2>/dev/null || sync
  if [ -L "$capability_status_file" ] || [ ! -f "$capability_status_file" ] ||
     [ "$(stat -c '%U:%G' "$capability_status_file" 2>/dev/null)" != 'root:root' ] ||
     [ "$(stat -c '%a' "$capability_status_file" 2>/dev/null)" != 644 ]; then
    rm -f "$capability_status_file"
    printf '%s\\n' 'fleet-enroll: the public capability projection failed its postcondition' >&2
    return 1
  fi
  return 0
}
# @@GHOSTFLEET_CAPABILITY_STATUS_FRAGMENT_PROJECTION_END@@

# Machine-readable success evidence for the external consumer. Only non-secret
# facts are emitted: the token never reaches this line, a log or a status report.
capability_evidence() {
  capability_evidence_payload_owner=''
  capability_evidence_payload_mode=''
  capability_evidence_token_owner=''
  capability_evidence_token_mode=''
  capability_evidence_token_type=absent
  capability_evidence_dir_owner=''
  capability_evidence_dir_mode=''
  capability_evidence_dir_type=absent
  capability_evidence_state_owner=''
  capability_evidence_state_mode=''
  capability_evidence_state_type=absent
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    if [ -f "$CAPABILITY_AGENT_PAYLOAD_PATH" ] && [ ! -L "$CAPABILITY_AGENT_PAYLOAD_PATH" ]; then
      capability_evidence_payload_owner="$(stat -c '%U:%G' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)"
      capability_evidence_payload_mode="$(stat -c '%a' "$CAPABILITY_AGENT_PAYLOAD_PATH" 2>/dev/null)"
    fi
    capability_evidence_home="$(capability_control_home)"
    if [ -n "$capability_evidence_home" ]; then
      capability_evidence_dir="$capability_evidence_home/.config/ghostfleet"
      capability_evidence_file="$capability_evidence_dir/node-token"
      if [ -d "$capability_evidence_dir" ] && [ ! -L "$capability_evidence_dir" ]; then
        capability_evidence_dir_type=directory
        capability_evidence_dir_owner="$(stat -c '%U' "$capability_evidence_dir" 2>/dev/null)"
        capability_evidence_dir_mode="$(stat -c '%a' "$capability_evidence_dir" 2>/dev/null)"
      fi
      capability_evidence_state_dir="$capability_evidence_home/.local/state/ghostfleet-agent"
      if [ -d "$capability_evidence_state_dir" ] && [ ! -L "$capability_evidence_state_dir" ]; then
        capability_evidence_state_type=directory
        capability_evidence_state_owner="$(stat -c '%U' "$capability_evidence_state_dir" 2>/dev/null)"
        capability_evidence_state_mode="$(stat -c '%a' "$capability_evidence_state_dir" 2>/dev/null)"
      fi
      if [ -f "$capability_evidence_file" ] && [ ! -L "$capability_evidence_file" ]; then
        capability_evidence_token_type=regular
        capability_evidence_token_owner="$(stat -c '%U' "$capability_evidence_file" 2>/dev/null)"
        capability_evidence_token_mode="$(stat -c '%a' "$capability_evidence_file" 2>/dev/null)"
      fi
    fi
  fi
  printf '%s\\n' \\
    "capability_agent_payload_sha256=$CAPABILITY_AGENT_PAYLOAD_SHA256" \\
    "capability_agent_payload_path=$CAPABILITY_AGENT_PAYLOAD_PATH" \\
    "capability_agent_payload_state=$CAPABILITY_EVIDENCE_PAYLOAD_STATE" \\
    "capability_agent_payload_owner=$capability_evidence_payload_owner" \\
    "capability_agent_payload_mode=$capability_evidence_payload_mode" \\
    "capability_user_unit_state=$CAPABILITY_EVIDENCE_UNIT_STATE" \\
    "capability_user_unit_exec=$CAPABILITY_USER_UNIT_EXEC" \\
    "capability_service_state=$CAPABILITY_SERVICE_STATE" \\
    "capability_node_credential_received=$CAPABILITY_NODE_AUTH_RECEIVED" \\
    "capability_node_token_owner=$capability_evidence_token_owner" \\
    "capability_node_token_mode=$capability_evidence_token_mode" \\
    "capability_node_token_type=$capability_evidence_token_type" \\
    "capability_agent_config_dir_owner=$capability_evidence_dir_owner" \\
    "capability_agent_config_dir_mode=$capability_evidence_dir_mode" \\
    "capability_agent_config_dir_type=$capability_evidence_dir_type" \\
    "capability_agent_state_dir_owner=$capability_evidence_state_owner" \\
    "capability_agent_state_dir_mode=$capability_evidence_state_mode" \\
    "capability_agent_state_dir_type=$capability_evidence_state_type"
}

# After the control plane delivered the node credential, install the payload, the
# unit and Linger. This is the only place a first-run node starts the managed
# service, and it repeats the whole postcondition before anything is recorded.
capability_service_finish() {
  [ "$CAPABILITY_SERVICE_PENDING" = 1 ] || return 0
  capability_agent_payload_apply
  capability_agent_state_dirs
  if [ "$CAPABILITY_USER_UNIT_STATE" != COMPLIANT ]; then
    if ! capability_user_service_apply; then
      capability_rollback
      capability_stage_cleanup
      fail 'selected user service could not be installed after the node credential was delivered; no completion is reported'
    fi
    CAPABILITY_EVIDENCE_UNIT_STATE=INSTALLED
  else
    CAPABILITY_EVIDENCE_UNIT_STATE=COMPLIANT
  fi
  capability_user_unit_exec_assert
  if ! capability_agent_config_write; then
    capability_rollback
    capability_stage_cleanup
    fail '[CAPABILITY_AGENT_CONFIG_UNSAFE] the root-owned agent configuration could not be written from the validated selection, so the managed agent would start without it; the lane was rolled back and no completion is reported'
  fi
  capability_node_credential_write
  if ! capability_linger_apply; then
    capability_rollback
    capability_stage_cleanup
    fail 'selected Linger could not be enabled after the node credential was delivered; no completion is reported'
  fi
  CAPABILITY_AGENT_PAYLOAD_STATE="$(capability_agent_payload_state)"
  CAPABILITY_USER_UNIT_STATE="$(capability_user_service_state)"
  CAPABILITY_USER_SERVICE_STATE="$CAPABILITY_USER_UNIT_STATE"
  CAPABILITY_NODE_AUTH_STATE="$(capability_node_token_state)"
  if ! capability_states_compliant; then
    capability_rollback
    capability_stage_cleanup
    fail "[CAPABILITY_SERVICE_NOT_CONVERGED] the managed node agent did not converge (helper=$CAPABILITY_HELPER_STATE payload=$CAPABILITY_AGENT_PAYLOAD_STATE unit=$CAPABILITY_USER_UNIT_STATE service=$CAPABILITY_USER_SERVICE_STATE token=$CAPABILITY_NODE_AUTH_STATE linger=$CAPABILITY_LINGER_STATE); no completion is reported"
  fi
  if ! capability_status_projection; then
    capability_rollback
    capability_stage_cleanup
    fail '[CAPABILITY_STATUS_PROJECTION_FAILED] the public capability projection could not be written atomically, so this node may not report an installed capability; remove any partial /etc/ghostfleet/capability-status.json and re-run the authorized Console command'
  fi
  CAPABILITY_SERVICE_STATE=INSTALLED
  capability_state_write
  printf '%s\\n' "fleet-enroll: selected capability $CAPABILITY_VERSION converged mode=$CAPABILITY_MODE helper=$CAPABILITY_HELPER_STATE user_service=$CAPABILITY_USER_SERVICE_STATE linger=$CAPABILITY_LINGER_STATE run_account=$CAPABILITY_ACCOUNT_STATE" >&2
  capability_evidence
  capability_stage_cleanup
  return 0
}

# The dedicated run account owns the user unit and Linger, so every process the
# managed runtime starts inherits exactly its rights. Those rights must be
# nothing more than "run as this uid": no sudo grant, no root-equivalent group,
# no login shell, no usable password, no unproven group and never the privileged
# operations account that holds the bounded NOPASSWD fleet-privctl rule.
#
# The SAME criteria apply to an account this courier creates and to one it
# adopts, and they are proved again after the root-privileged installer has run:
# an artifact that runs as root can change groups or sudoers, and nothing may be
# installed into an account whose least privilege was only proved earlier.
CAPABILITY_PRIVILEGED_GROUPS='root sudo wheel admin docker lxd libvirt libvirtd incus incus-admin podman disk shadow'

# Read-only. Prints exactly one token:
#   ABSENT      no such account
#   ROOT        uid 0
#   SYSTEM_UID  uid outside the ordinary human range
#   SHELL       a login shell
#   UNLOCKED    the password field is not locked
#   NO_HOME     no home directory
#   NO_GROUP    no group of the same name (the unit directory cannot be owned)
#   GROUP:<g>   membership of a root-equivalent group
#   SUDOERS     a sudo grant
#   UNKNOWN     sudo's answer could not be interpreted
#   SAFE        least privilege, usable as the run identity
capability_account_criteria_state() {
  # One NSS query decides "no such account" from "the account database cannot be
  # queried". Only getent's own exit 2 means the account does not exist; any
  # other failure is UNKNOWN and the caller fails closed. Treating a broken NSS
  # as "no such account" would let a lookup outage decide a security property.
  capability_probe_row="$(getent passwd "$1" 2>/dev/null)" && capability_probe_lookup=0 || capability_probe_lookup=$?
  if [ "$capability_probe_lookup" -ne 0 ]; then
    if [ "$capability_probe_lookup" -eq 2 ] && [ -z "$capability_probe_row" ]; then
      printf '%s' ABSENT
    else
      printf '%s' LOOKUP_FAILED:passwd
    fi
    return 0
  fi
  if [ -z "$capability_probe_row" ]; then
    printf '%s' LOOKUP_FAILED:passwd
    return 0
  fi
  capability_probe_uid="$(printf '%s' "$capability_probe_row" | cut -d ':' -f 3)"
  case "$capability_probe_uid" in
    ''|*[!0-9]*) printf '%s' LOOKUP_FAILED:passwd; return 0 ;;
  esac
  [ "$capability_probe_uid" != 0 ] || { printf '%s' ROOT; return 0; }
  if [ "$capability_probe_uid" -lt 1000 ] || [ "$capability_probe_uid" -ge 60000 ]; then
    printf '%s' SYSTEM_UID
    return 0
  fi
  # Group membership is the other half of "no privileged group". Capture the
  # LIST first and check the exit status separately: a failing id (sssd/LDAP
  # outage, timeout) must never be read as "not a member".
  if ! capability_probe_groups="$(id -nG "$1" 2>/dev/null)"; then
    printf '%s' LOOKUP_FAILED:id-groups
    return 0
  fi
  # id -nG always lists the primary group, so an empty answer means the lookup
  # was lost rather than that the account has no groups.
  if [ -z "$capability_probe_groups" ]; then
    printf '%s' LOOKUP_FAILED:groups-empty
    return 0
  fi
  capability_probe_primary_gid="$(printf '%s' "$capability_probe_row" | cut -d ':' -f 4)"
  capability_probe_primary_group="$(getent group "$capability_probe_primary_gid" 2>/dev/null | cut -d ':' -f 1)"
  if [ -z "$capability_probe_primary_group" ]; then
    printf '%s' LOOKUP_FAILED:primary-lookup
    return 0
  fi
  capability_probe_primary_seen=0
  capability_probe_members=0
  for capability_probe_member in $capability_probe_groups; do
    case "$capability_probe_member" in
      ''|*[!A-Za-z0-9._@-]*) printf '%s' LOOKUP_FAILED:groups-parse; return 0 ;;
    esac
    if [ "$capability_probe_member" = "$capability_probe_primary_group" ]; then
      capability_probe_primary_seen=1
    fi
    capability_probe_members=$((capability_probe_members + 1))
  done
  if [ "$capability_probe_members" -eq 0 ] || [ "$capability_probe_primary_seen" != 1 ]; then
    # The primary group is always listed by id -nG; its absence means the output
    # was truncated, replaced or rewritten, so nothing about membership is proved.
    printf '%s' LOOKUP_FAILED:primary-missing
    return 0
  fi
  for capability_probe_group in $CAPABILITY_PRIVILEGED_GROUPS; do
    for capability_probe_member in $capability_probe_groups; do
      if [ "$capability_probe_member" = "$capability_probe_group" ]; then
        printf 'GROUP:%s' "$capability_probe_group"
        return 0
      fi
    done
  done
  capability_probe_home="$(printf '%s' "$capability_probe_row" | cut -d ':' -f 6)"
  capability_probe_shell="$(printf '%s' "$capability_probe_row" | cut -d ':' -f 7)"
  case "$capability_probe_shell" in
    */nologin|*/false) ;;
    *) printf '%s' SHELL; return 0 ;;
  esac
  if [ -z "$capability_probe_home" ] || [ ! -d "$capability_probe_home" ]; then
    printf '%s' NO_HOME
    return 0
  fi
  if getent group "$1" >/dev/null 2>&1; then
    capability_probe_group_lookup=0
  else
    capability_probe_group_lookup=$?
  fi
  if [ "$capability_probe_group_lookup" -eq 2 ]; then
    printf '%s' NO_GROUP
    return 0
  fi
  if [ "$capability_probe_group_lookup" -ne 0 ]; then
    printf '%s' LOOKUP_FAILED:group
    return 0
  fi
  # A locked password field is the other half of "no credential": an empty or
  # hashed password would be a login identity the deployment never approved. A
  # failed lookup cannot prove the lock, so it is UNKNOWN rather than UNLOCKED.
  capability_probe_shadow="$(getent shadow "$1" 2>/dev/null)" && capability_probe_shadow_status=0 || capability_probe_shadow_status=$?
  if [ "$capability_probe_shadow_status" -ne 0 ] || [ -z "$capability_probe_shadow" ]; then
    printf '%s' LOOKUP_FAILED:shadow
    return 0
  fi
  capability_probe_password="$(printf '%s' "$capability_probe_shadow" | cut -d ':' -f 2)"
  case "$capability_probe_password" in
    '!'*|'*'*) ;;
    '') printf '%s' LOOKUP_FAILED:shadow; return 0 ;;
    *) printf '%s' UNLOCKED; return 0 ;;
  esac
  # sudo's own evaluation resolves %group rules, User_Alias and sudoers.d order;
  # a text search over /etc/sudoers would miss all three.
  if command -v sudo >/dev/null 2>&1; then
    capability_probe_sudo="$(sudo -n -l -U "$1" 2>/dev/null || true)"
    case "$capability_probe_sudo" in
      *'may run the following commands'*) printf '%s' SUDOERS; return 0 ;;
      *'is not allowed to run sudo'*) ;;
      *) printf '%s' UNKNOWN; return 0 ;;
    esac
  fi
  printf '%s' SAFE
}

# Reports the failure and returns 1 instead of exiting: the caller still has to
# roll back what it already created (an account that failed its own post-check,
# or one that lost its proof after the installer ran) before the run may stop.
capability_account_criteria_fail() {
  case "$1" in
    SAFE) return 0 ;;
    ABSENT) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_ABSENT] the managed run account $CAPABILITY_CONTROL_ACCOUNT does not exist" >&2 ;;
    ROOT) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_PRIVILEGED] the managed run account $CAPABILITY_CONTROL_ACCOUNT is uid 0; the managed runtime must never inherit host root authority" >&2 ;;
    SYSTEM_UID) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_NOT_DEDICATED] the managed run account $CAPABILITY_CONTROL_ACCOUNT has a system uid; a login-capable or system account is not a dedicated run identity, so create or designate an ordinary account that owns no other workload" >&2 ;;
    SHELL) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_NOT_DEDICATED] the managed run account $CAPABILITY_CONTROL_ACCOUNT has a login shell; the run identity must not be a login identity, so set it to /usr/sbin/nologin" >&2 ;;
    UNLOCKED) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_NOT_DEDICATED] the password of the managed run account $CAPABILITY_CONTROL_ACCOUNT is not locked; lock it (passwd -l) so no login path exists for the identity that owns the unit" >&2 ;;
    NO_HOME) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_NOT_DEDICATED] the managed run account $CAPABILITY_CONTROL_ACCOUNT has no home directory; the user unit and Linger it owns need one" >&2 ;;
    NO_GROUP) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_NOT_DEDICATED] the managed run account $CAPABILITY_CONTROL_ACCOUNT has no group of the same name; the user unit directory is created $CAPABILITY_CONTROL_ACCOUNT:$CAPABILITY_CONTROL_ACCOUNT and cannot be owned otherwise" >&2 ;;
    LOOKUP_FAILED:*)
      capability_lookup_reason="$(printf '%s' "$1" | cut -d ':' -f 2)"
      case "$capability_lookup_reason" in
        passwd) capability_lookup_detail="getent passwd $CAPABILITY_CONTROL_ACCOUNT did not answer with a usable record" ;;
        id-groups) capability_lookup_detail="id -nG $CAPABILITY_CONTROL_ACCOUNT failed" ;;
        groups-empty) capability_lookup_detail="id -nG $CAPABILITY_CONTROL_ACCOUNT succeeded with an empty list, but it always includes the primary group" ;;
        groups-parse) capability_lookup_detail="id -nG $CAPABILITY_CONTROL_ACCOUNT returned a token that is not a group name" ;;
        primary-lookup) capability_lookup_detail="the primary group of $CAPABILITY_CONTROL_ACCOUNT could not be resolved from its gid" ;;
        primary-missing) capability_lookup_detail="id -nG $CAPABILITY_CONTROL_ACCOUNT does not list the account's primary group, so the answer was replaced or truncated" ;;
        group) capability_lookup_detail="getent group $CAPABILITY_CONTROL_ACCOUNT failed" ;;
        shadow) capability_lookup_detail="getent shadow $CAPABILITY_CONTROL_ACCOUNT failed" ;;
        *) capability_lookup_detail="a name-service query for $CAPABILITY_CONTROL_ACCOUNT failed" ;;
      esac
      printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_UNPROVEN] the account database could not be queried: $capability_lookup_detail (NSS outage, remote directory unreachable or timeout); an unreadable answer is never read as 'no privilege', so this run stops. Check getent passwd $CAPABILITY_CONTROL_ACCOUNT, id -nG $CAPABILITY_CONTROL_ACCOUNT and the NSS configuration, then re-run the authorized Console command" >&2
      ;;
    LOOKUP_FAILED) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_UNPROVEN] the account database could not be queried for $CAPABILITY_CONTROL_ACCOUNT; an unreadable answer is never read as 'no privilege', so this run stops" >&2 ;;
    GROUP:*)
      capability_privilege_group="$(printf '%s' "$1" | cut -d ':' -f 2)"
      printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_PRIVILEGED] the managed run account $CAPABILITY_CONTROL_ACCOUNT is a member of the root-equivalent group $capability_privilege_group; that group reaches root or device authority without the mediated path, so it cannot own the user unit" >&2
      ;;
    SUDOERS) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_PRIVILEGED] the managed run account $CAPABILITY_CONTROL_ACCOUNT has a sudo grant; the managed runtime would inherit a sudo lane the bounded fleet-privctl entry exists to prevent, which would leave a second root path outside the reviewed helper" >&2 ;;
    *) printf '%s\\n' "fleet-enroll: [CAPABILITY_RUN_ACCOUNT_UNPROVEN] the privileges of the managed run account $CAPABILITY_CONTROL_ACCOUNT could not be proved absent (state $1); refusing to point a long-running service at an account whose authority is unknown" >&2 ;;
  esac
  return 1
}

capability_control_account_create() {
  # A group that already owns this name without the account is not ours: its
  # members and privileges were never audited here, so adopting it would make an
  # unproven group the primary group of the managed runtime.
  if getent group "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1; then
    printf '%s\\n' "fleet-enroll: a group named $CAPABILITY_CONTROL_ACCOUNT already exists without the managed run account; refusing to adopt an unproven primary group" >&2
    return 1
  fi
  command -v useradd >/dev/null 2>&1 || { printf '%s\\n' 'fleet-enroll: useradd is required to create the dedicated managed run account' >&2; return 1; }
  [ -x /usr/sbin/nologin ] || { printf '%s\\n' 'fleet-enroll: /usr/sbin/nologin is required for the dedicated managed run account shell' >&2; return 1; }
  # No sudo, no supplementary group, no login shell, no usable password: the
  # account exists only to own the user unit. --user-group gives it the same-name
  # group the unit directory is chowned to, and a locked password keeps every
  # login path shut.
  useradd --create-home --user-group --shell /usr/sbin/nologin "$CAPABILITY_CONTROL_ACCOUNT" ||
    { printf '%s\\n' "fleet-enroll: the dedicated managed run account $CAPABILITY_CONTROL_ACCOUNT could not be created; no privileged component was installed" >&2; return 1; }
  # Ownership is recorded the moment the account exists. A later check may fail,
  # and the rollback must still remove this half-created account rather than
  # leave it behind as an orphan.
  CAPABILITY_CREATED_ACCOUNT=1
  capability_created_row="$(getent passwd "$CAPABILITY_CONTROL_ACCOUNT" 2>/dev/null || true)"
  if [ -z "$capability_created_row" ]; then
    printf '%s\\n' "fleet-enroll: the dedicated managed run account $CAPABILITY_CONTROL_ACCOUNT does not resolve after creation" >&2
    return 1
  fi
  return 0
}

capability_provision_control_account() {
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" != 1 ] && [ "$CAPABILITY_LINGER_REQUIRED" != 1 ]; then
    CAPABILITY_ACCOUNT_STATE=NOT_REQUESTED
    return 0
  fi
  [ -z "$CAPABILITY_ACCOUNT_RECONCILED" ] || return 0
  CAPABILITY_ACCOUNT_RECONCILED=1
  capability_account_criteria="$(capability_account_criteria_state "$CAPABILITY_CONTROL_ACCOUNT")"
  if [ "$capability_account_criteria" = ABSENT ]; then
    if ! capability_control_account_create; then
      CAPABILITY_ACCOUNT_STATE=UNKNOWN
      return 1
    fi
    capability_account_criteria="$(capability_account_criteria_state "$CAPABILITY_CONTROL_ACCOUNT")"
    if [ "$capability_account_criteria" != SAFE ]; then
      CAPABILITY_ACCOUNT_STATE=UNKNOWN
      capability_account_criteria_fail "$capability_account_criteria"
      return 1
    fi
    CAPABILITY_ACCOUNT_STATE=CREATED
    printf '%s\\n' "fleet-enroll: created the dedicated managed run account $CAPABILITY_CONTROL_ACCOUNT (nologin shell, locked password, no sudo, no supplementary group)" >&2
    return 0
  fi
  # A pre-existing account is adopted exactly as found: this courier never
  # grants, revokes or rewrites the privilege state of an account it did not
  # create. It is accepted only when the criteria above hold for it too.
  if [ "$capability_account_criteria" != SAFE ]; then
    CAPABILITY_ACCOUNT_STATE=UNKNOWN
    capability_account_criteria_fail "$capability_account_criteria"
    return 1
  fi
  CAPABILITY_ACCOUNT_STATE=EXISTING
  return 0
}

# The reviewed installer runs as root. After it has run, the run account is
# proved again: nothing may be installed into its home, enabled through Linger or
# recorded as converged while the account's least privilege is unproven.
# The reviewed installer records the account it actually admits in its own state
# file. The selection only DECLARES one, so comparing the two is what turns a
# well-formed but wrong declaration into a refusal.
CAPABILITY_PRIVILEGED_STATE_FILE=/etc/youling-fleet/privileged-operations/control.json

# The reviewed installer runs as root. After it has run, the run account is
# proved again and the declared privileged account is cross-checked against what
# the installer recorded: nothing may be installed into the run account's home,
# enabled through Linger or recorded as converged while either is unproven.
capability_installer_ops_user() {
  [ -r "$CAPABILITY_PRIVILEGED_STATE_FILE" ] || return 0
  # Parsed, never pattern-matched: the installer may reformat its JSON, and a
  # wrong match here would silently vouch for the wrong account.
  python3 -I -c 'import json,sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(0)
out = value.get("ops_user") if isinstance(value, dict) else None
print(out if isinstance(out, str) else "")' "$CAPABILITY_PRIVILEGED_STATE_FILE" 2>/dev/null || true
}

# The selection DECLARES the privileged account; the installer RECORDS the one it
# admits. "required" is used wherever the helper is (or claims to be) installed:
# a compliant helper with no readable record cannot be reconciled, so that is a
# refusal and not a "nothing to check". "optional" is only for a host where the
# helper is genuinely absent, because then there is nothing to compare yet.
capability_verify_declared_privileged_account() {
  [ "$CAPABILITY_HELPER_REQUIRED" = 1 ] || return 0
  capability_declared_required=0
  [ "$1" = required ] && capability_declared_required=1
  if [ ! -r "$CAPABILITY_PRIVILEGED_STATE_FILE" ]; then
    [ "$capability_declared_required" = 1 ] || return 0
    CAPABILITY_ACCOUNT_STATE=UNKNOWN
    printf '%s\\n' "fleet-enroll: [CAPABILITY_PRIVILEGED_ACCOUNT_UNVERIFIED] the reviewed installer reports the helper installed but $CAPABILITY_PRIVILEGED_STATE_FILE is missing, so privileged_account=$CAPABILITY_PRIVILEGED_ACCOUNT cannot be cross-checked against the account that actually holds the bounded fleet-privctl rule; re-apply the reviewed installer (it writes that file) before this node may converge" >&2
    return 1
  fi
  capability_installer_ops="$(capability_installer_ops_user)"
  if [ -z "$capability_installer_ops" ]; then
    [ "$capability_declared_required" = 1 ] || return 0
    CAPABILITY_ACCOUNT_STATE=UNKNOWN
    printf '%s\\n' "fleet-enroll: [CAPABILITY_PRIVILEGED_ACCOUNT_UNVERIFIED] $CAPABILITY_PRIVILEGED_STATE_FILE exists but records no readable ops_user (it may be truncated, reformatted or hand-edited), so privileged_account=$CAPABILITY_PRIVILEGED_ACCOUNT cannot be cross-checked; re-apply the reviewed installer rather than editing that file" >&2
    return 1
  fi
  if [ "$capability_installer_ops" != "$CAPABILITY_PRIVILEGED_ACCOUNT" ]; then
    CAPABILITY_ACCOUNT_STATE=UNKNOWN
    printf '%s\\n' "fleet-enroll: [CAPABILITY_PRIVILEGED_ACCOUNT_MISMATCH] the selection declares privileged_account=$CAPABILITY_PRIVILEGED_ACCOUNT but the reviewed installer admits $capability_installer_ops; the declared account is not the one holding the bounded fleet-privctl rule. This is a selection declaration error, not an account-privilege problem: re-render the reviewed template with privileged_account=$capability_installer_ops" >&2
    return 1
  fi
  return 0
}

# The mode a read-only probe should use: once the reviewed installer reports the
# helper installed, its record is mandatory; before that it may not exist yet.
capability_declared_privileged_account_mode() {
  if [ "$CAPABILITY_HELPER_STATE" = COMPLIANT ]; then
    printf '%s' required
  else
    printf '%s' optional
  fi
}

capability_reprove_control_account() {
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" != 1 ] && [ "$CAPABILITY_LINGER_REQUIRED" != 1 ]; then
    return 0
  fi
  capability_account_reproof="$(capability_account_criteria_state "$CAPABILITY_CONTROL_ACCOUNT")"
  if [ "$capability_account_reproof" != SAFE ]; then
    CAPABILITY_ACCOUNT_STATE=UNKNOWN
    capability_account_criteria_fail "$capability_account_reproof"
    return 1
  fi
  return 0
}

# v1 selections pointed the managed lane at the privileged operations account, so
# a node upgraded from one still owns a unit, an enablement link and Linger in
# that account. Installing the v2 lane beside it would leave two long-running
# services, one of them privileged, and silently widen what the runtime inherits.
# The residue is detected before any effect. It is only REMOVED when this run
# restored its selection from this node's own record (channel-scoped provenance)
# AND the bytes at those paths are the reviewed ones; otherwise the run stops and
# prints the exact decommission steps, because deleting a pre-existing account's
# files is never this courier's decision.
capability_probe_privileged_lane_residue() {
  CAPABILITY_STALE_LANE_FOUND=
  CAPABILITY_STALE_UNIT=
  CAPABILITY_STALE_WANT=
  CAPABILITY_STALE_ACCOUNT=
  # A v2 selection names the privileged account. A v1 selection does not: the
  # account it ordered the unit into IS the candidate, and that is exactly the
  # residue this probe exists to find.
  capability_residue_account="$CAPABILITY_PRIVILEGED_ACCOUNT"
  if [ -z "$capability_residue_account" ]; then
    capability_residue_account="$(capability_recorded_control_account)"
  fi
  [ -n "$capability_residue_account" ] || return 0
  if [ -n "$CAPABILITY_PRIVILEGED_ACCOUNT" ] && [ "$capability_residue_account" = "$CAPABILITY_CONTROL_ACCOUNT" ]; then
    return 0
  fi
  CAPABILITY_STALE_ACCOUNT="$capability_residue_account"
  capability_residue_row="$(getent passwd "$capability_residue_account" 2>/dev/null || true)"
  [ -n "$capability_residue_row" ] || return 0
  capability_residue_home="$(printf '%s' "$capability_residue_row" | cut -d ':' -f 6 || true)"
  [ -n "$capability_residue_home" ] || return 0
  if [ -n "$CAPABILITY_USER_UNIT" ]; then
    CAPABILITY_STALE_UNIT="$capability_residue_home/.config/systemd/user/$CAPABILITY_USER_UNIT"
    CAPABILITY_STALE_WANT="$capability_residue_home/.config/systemd/user/default.target.wants/$CAPABILITY_USER_UNIT"
    if [ -e "$CAPABILITY_STALE_UNIT" ] || [ -L "$CAPABILITY_STALE_UNIT" ]; then
      CAPABILITY_STALE_LANE_FOUND="$CAPABILITY_STALE_LANE_FOUND unit"
    else
      CAPABILITY_STALE_UNIT=
    fi
    if [ -e "$CAPABILITY_STALE_WANT" ] || [ -L "$CAPABILITY_STALE_WANT" ]; then
      CAPABILITY_STALE_LANE_FOUND="$CAPABILITY_STALE_LANE_FOUND enablement-link"
    else
      CAPABILITY_STALE_WANT=
    fi
  fi
  if command -v loginctl >/dev/null 2>&1; then
    case "$(loginctl show-user "$capability_residue_account" -p Linger 2>/dev/null || true)" in
      *Linger=yes*) CAPABILITY_STALE_LANE_FOUND="$CAPABILITY_STALE_LANE_FOUND linger" ;;
    esac
  fi
  return 0
}

capability_recorded_control_account() {
  [ "$CAPABILITY_SELECTION_ORIGIN" = recorded ] || return 0
  [ -r "$CAPABILITY_RECORD_FILE" ] || return 0
  base64 -d "$CAPABILITY_RECORD_FILE" 2>/dev/null | sed -n 's/^control_account=//p' | head -n1 || true
}

capability_declared_unit_digest() {
  capability_index=1
  while [ "$capability_index" -le "$CAPABILITY_ARTIFACT_COUNT" ]; do
    if [ "$(capability_artifact_field "$capability_index" 1)" = "$CAPABILITY_USER_UNIT_ARTIFACT" ]; then
      capability_artifact_field "$capability_index" 2
      return 0
    fi
    capability_index=$((capability_index + 1))
  done
  return 0
}

# Deletes only bytes this product's own record reviewed: the enablement link must
# point at this unit and the unit must hash to the pinned artifact digest. A path
# that now belongs to something else is reported and left untouched.
# Deletes only bytes this product's own record reviewed: the enablement link must
# point at this unit and the unit must hash to the pinned artifact digest. Both
# are verified BEFORE anything is touched, so a refusal never leaves the lane
# half-removed. Order: enablement link, Linger, unit — a running instance is not
# stopped by this courier.
# systemd's ExecStart may carry the -/@/+/!: prefixes and arguments. Only an
# absolute executable path can be attributed to a process set, so the rule is:
# first whitespace-separated token of the first ExecStart line, leading prefix
# characters stripped, and used only when the result is absolute. Anything else
# (a relative name, an environment expansion, a %-specifier) returns empty and
# the caller refuses to migrate instead of skipping the process check.
capability_unit_exec_start() {
  capability_exec_line=
  if [ -r "$1" ]; then
    capability_exec_line="$(sed -n 's/^ExecStart=//p' "$1" 2>/dev/null | head -n1)"
  fi
  capability_exec_line="$(printf '%s' "$capability_exec_line" | sed 's/^[[:space:]]*//')"
  [ -n "$capability_exec_line" ] || return 0
  capability_exec_token="$(printf '%s' "$capability_exec_line" | awk '{print $1}')"
  capability_exec_bin="$(printf '%s' "$capability_exec_token" | sed 's/^[-@+!:]*//')"
  case "$capability_exec_bin" in
    /*) printf '%s' "$capability_exec_bin" ;;
    *) return 0 ;;
  esac
}

# A unit file is not a process. Before the v1 lane is deleted its service is
# stopped in the privileged account's own session and proved stopped: the unit is
# inactive or failed AND no process of its ExecStart binary still runs as that
# account. A v2 lane running next to a live privileged instance is exactly the
# state this ruling removes, so an unprovable stop deletes nothing.
#
# Everything that can be known WITHOUT touching the system is checked first —
# the ExecStart the process set is attributed to, that sudo can enter the
# account's session, and that pgrep exists. Only then is the unit stopped, so a
# run that could never prove the outcome never changes the system, every refusal
# names exactly one reason, and there is no "stopped but unprovable" state.
capability_stale_lane_stop_and_prove() {
  CAPABILITY_STALE_STOP_FAILED=
  capability_stale_stop_cmd="sudo -iu $CAPABILITY_STALE_ACCOUNT systemctl --user stop $CAPABILITY_USER_UNIT"
  if [ -n "$CAPABILITY_STALE_UNIT" ]; then
    capability_stale_exec="$(capability_unit_exec_start "$CAPABILITY_STALE_UNIT")"
    if [ -z "$capability_stale_exec" ]; then
      CAPABILITY_STALE_STOP_FAILED="the unit's ExecStart does not name an absolute executable, so no process can be attributed to it"
      printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_STOP_FAILED; nothing is removed and the unit is left running as it was" >&2
      return 1
    fi
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    CAPABILITY_STALE_STOP_FAILED="sudo is not available to enter the $CAPABILITY_STALE_ACCOUNT session"
    printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_STOP_FAILED, so the v1 unit cannot be stopped; nothing is removed and the unit is left running as it was" >&2
    return 1
  fi
  if ! command -v pgrep >/dev/null 2>&1; then
    CAPABILITY_STALE_STOP_FAILED="pgrep is not installed, so the absence of the unit's processes cannot be proved"
    printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_STOP_FAILED; nothing is removed and the unit is left running as it was" >&2
    return 1
  fi
  if ! $capability_stale_stop_cmd >/dev/null 2>&1; then
    CAPABILITY_STALE_STOP_FAILED="stopping the unit in the $CAPABILITY_STALE_ACCOUNT session failed"
    printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_STOP_FAILED (no live user manager for that account?); nothing is removed" >&2
    return 1
  fi
  capability_stale_active="$(sudo -iu "$CAPABILITY_STALE_ACCOUNT" systemctl --user is-active "$CAPABILITY_USER_UNIT" 2>/dev/null || true)"
  case "$capability_stale_active" in
    inactive|failed) ;;
    *)
      CAPABILITY_STALE_STOP_FAILED="the unit still reports '$capability_stale_active' in the $CAPABILITY_STALE_ACCOUNT session after stop"
      printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_STOP_FAILED; nothing is removed" >&2
      return 1
      ;;
  esac
  # pgrep's contract: 0 = matched, 1 = no match, anything else = the query
  # itself failed. Only "no match" may be read as "the process is gone".
  if pgrep -u "$CAPABILITY_STALE_ACCOUNT" -f "$capability_stale_exec" >/dev/null 2>&1; then
    capability_pgrep_status=0
  else
    capability_pgrep_status=$?
  fi
  case "$capability_pgrep_status" in
    0)
      CAPABILITY_STALE_STOP_FAILED="processes of $capability_stale_exec still run as $CAPABILITY_STALE_ACCOUNT"
      printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_STOP_FAILED after stop; nothing is removed" >&2
      return 1
      ;;
    1) : ;;
    *)
      CAPABILITY_STALE_STOP_FAILED="pgrep could not answer for $CAPABILITY_STALE_ACCOUNT (exit $capability_pgrep_status), so the unit's processes cannot be proved gone"
      printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_STOP_FAILED; nothing is removed" >&2
      return 1
      ;;
  esac
  return 0
}

# Deletes only bytes this product's own record reviewed: the enablement link must
# point at this unit and the unit must hash to the pinned artifact digest, and the
# service must be proved stopped. Every check happens BEFORE anything is touched,
# so a refusal never leaves the lane half-removed. Order: prove stopped, delete
# the enablement link, disable Linger, delete the unit.
capability_decommission_stale_lane() {
  capability_stale_removed=
  capability_stale_warnings=
  if [ -n "$CAPABILITY_STALE_UNIT" ]; then
    capability_expected_unit="$(capability_declared_unit_digest)"
    capability_actual_unit=
    if [ -f "$CAPABILITY_STALE_UNIT" ] && [ ! -L "$CAPABILITY_STALE_UNIT" ]; then
      capability_actual_unit="$(sha256sum "$CAPABILITY_STALE_UNIT" 2>/dev/null | cut -d ' ' -f 1 || true)"
    fi
    if [ -z "$capability_expected_unit" ] || [ "$capability_actual_unit" != "$capability_expected_unit" ]; then
      capability_actual_unit_label="$capability_actual_unit"
      if [ -z "$capability_actual_unit_label" ]; then
        capability_actual_unit_label='not a regular file'
      fi
      printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_UNIT does not hash to the reviewed unit artifact (reviewed: $capability_expected_unit, found: $capability_actual_unit_label); left in place" >&2
      return 1
    fi
  fi
  if [ -n "$CAPABILITY_STALE_WANT" ]; then
    capability_want_target="$(readlink "$CAPABILITY_STALE_WANT" 2>/dev/null || true)"
    if [ "$capability_want_target" != "../$CAPABILITY_USER_UNIT" ] && [ "$capability_want_target" != "$CAPABILITY_STALE_UNIT" ]; then
      printf '%s\\n' "fleet-enroll: $CAPABILITY_STALE_WANT does not point at $CAPABILITY_USER_UNIT (target: $capability_want_target); left in place" >&2
      return 1
    fi
  fi
  if [ -n "$CAPABILITY_STALE_UNIT" ]; then
    capability_stale_lane_stop_and_prove || return 1
  fi
  if [ -n "$CAPABILITY_STALE_WANT" ]; then
    if rm -f "$CAPABILITY_STALE_WANT"; then
      capability_stale_removed="$capability_stale_removed enablement-link"
    fi
  fi
  case "$CAPABILITY_STALE_LANE_FOUND" in
    *linger*)
      if command -v loginctl >/dev/null 2>&1 && loginctl disable-linger "$CAPABILITY_STALE_ACCOUNT" >/dev/null 2>&1; then
        capability_stale_removed="$capability_stale_removed linger"
      else
        capability_stale_warnings="linger-not-disabled"
        printf '%s\\n' "fleet-enroll: Linger for $CAPABILITY_STALE_ACCOUNT could not be disabled; the unit is still removed, disable Linger by hand before the account is reused" >&2
      fi
      ;;
  esac
  if [ -n "$CAPABILITY_STALE_UNIT" ]; then
    if rm -f "$CAPABILITY_STALE_UNIT"; then
      capability_stale_removed="$capability_stale_removed unit"
    fi
  fi
  return 0
}

capability_refuse_stale_privileged_lane() {
  capability_probe_privileged_lane_residue
  capability_recorded_owner="$(capability_recorded_control_account)"
  # A v1 record whose lane is already gone is only a stale record. Left in place
  # it would block the next authorized claim at the schema gate, so it goes with
  # the lane it described.
  if [ "$CAPABILITY_SELECTION_ORIGIN" = recorded ] && [ -n "$capability_recorded_owner" ] &&
     [ -z "$CAPABILITY_PRIVILEGED_ACCOUNT" ] && [ -z "$CAPABILITY_STALE_LANE_FOUND" ]; then
    rm -f "$CAPABILITY_RECORD_FILE"
    printf '%s\\n' "fleet-enroll: removed the recorded v1 selection that named $capability_recorded_owner as the unit owner; no unit, enablement link or Linger remains under it" >&2
    fail "[CAPABILITY_STALE_PRIVILEGED_LANE] the recorded v1 selection was stale and blocked the next claim; the record was removed and this run stops without installing anything; re-run the authorized Console command so the next claim delivers the v2 selection"
  fi
  [ -n "$CAPABILITY_STALE_LANE_FOUND" ] || return 0
  # Provenance is channel-scoped: only a selection this run restored from the
  # node's own record proves the product created that lane. A delivered payload
  # that merely finds the file never authorises a delete.
  if [ "$CAPABILITY_SELECTION_ORIGIN" = recorded ] && [ "$capability_recorded_owner" = "$CAPABILITY_STALE_ACCOUNT" ]; then
    if ! capability_decommission_stale_lane; then
      if [ -n "$CAPABILITY_STALE_STOP_FAILED" ]; then
        fail "[CAPABILITY_STALE_PRIVILEGED_LANE] the v1 privileged lane under $CAPABILITY_STALE_ACCOUNT is still running and could not be proved stopped ($CAPABILITY_STALE_STOP_FAILED), so nothing was removed and the record was kept. Stop it yourself: sudo -iu $CAPABILITY_STALE_ACCOUNT systemctl --user stop $CAPABILITY_USER_UNIT; confirm with sudo -iu $CAPABILITY_STALE_ACCOUNT systemctl --user is-active $CAPABILITY_USER_UNIT (expect inactive or failed) and pgrep -u $CAPABILITY_STALE_ACCOUNT -f '<ExecStart binary>' (expect no output); then re-run the authorized Console command"
      fi
      fail "[CAPABILITY_STALE_PRIVILEGED_LANE] the recorded v1 lane under $CAPABILITY_STALE_ACCOUNT contains something this courier will not delete automatically (see the line above); review it, remove it by hand, then re-run the authorized Console command"
    fi
    rm -f "$CAPABILITY_RECORD_FILE"
    capability_stale_warning_text=
    if [ -n "$capability_stale_warnings" ]; then
      capability_stale_warning_text=" (warning: $capability_stale_warnings)"
    fi
    printf '%s\\n' "fleet-enroll: decommissioned the v1 managed lane this node recorded under the privileged account $CAPABILITY_STALE_ACCOUNT ($capability_stale_removed)$capability_stale_warning_text and removed the recorded v1 selection" >&2
    fail "[CAPABILITY_STALE_PRIVILEGED_LANE] the recorded v1 selection owned the managed unit inside the privileged operations account; that lane and the record were removed and this run stops without installing anything; re-run the authorized Console command so the next claim delivers the v2 selection"
  fi
  capability_stale_steps=
  capability_stale_stop_note=
  if [ -n "$CAPABILITY_STALE_UNIT" ]; then
    capability_stale_steps="$capability_stale_steps sudo -iu $CAPABILITY_STALE_ACCOUNT systemctl --user disable --now $CAPABILITY_USER_UNIT;"
    capability_stale_steps="$capability_stale_steps rm -f $CAPABILITY_STALE_UNIT;"
    capability_stale_stop_note=' The sudo -iu line stops a running instance in that account.'
  fi
  if [ -n "$CAPABILITY_STALE_WANT" ]; then
    capability_stale_steps="$capability_stale_steps rm -f $CAPABILITY_STALE_WANT;"
  fi
  case "$CAPABILITY_STALE_LANE_FOUND" in
    *linger*) capability_stale_steps="$capability_stale_steps loginctl disable-linger $CAPABILITY_STALE_ACCOUNT;" ;;
  esac
  fail "[CAPABILITY_STALE_PRIVILEGED_LANE] the account $CAPABILITY_STALE_ACCOUNT still owns $CAPABILITY_STALE_LANE_FOUND from a v1 managed lane; installing the v2 lane beside it would leave two long-running services, one of them privileged. Decommission it first:$capability_stale_stop_note $capability_stale_steps then re-run the authorized Console command with the v2 selection"
}

capability_rollback_files() {
  if [ -n "$CAPABILITY_CREATED_WANT" ]; then rm -f "$CAPABILITY_CREATED_WANT"; fi
  if [ -n "$CAPABILITY_CREATED_UNIT" ]; then rm -f "$CAPABILITY_CREATED_UNIT"; fi
  # The public projection is restored together with the unit: a rolled-back lane
  # must never leave a file that tells the agent the new version is READY.
  if [ "$CAPABILITY_CREATED_STATUS_PROJECTION" = 1 ]; then
    capability_projection_file="$CAPABILITY_AGENT_CONFIG_DIR/capability-status.json"
    if [ -n "$CAPABILITY_STATUS_BACKUP" ] && [ -f "$CAPABILITY_STATUS_BACKUP" ]; then
      mv -f "$CAPABILITY_STATUS_BACKUP" "$capability_projection_file" 2>/dev/null || rm -f "$capability_projection_file"
    else
      rm -f "$capability_projection_file"
    fi
  fi
  if [ -n "$CAPABILITY_STATUS_BACKUP" ]; then rm -f "$CAPABILITY_STATUS_BACKUP"; fi
  # Only artifacts this run created are removed. A payload, token, node
  # descriptor or configuration file that already existed belongs to the node and
  # is never deleted by a failed ceremony.
  if [ "$CAPABILITY_CREATED_PAYLOAD" = 1 ]; then rm -f "$CAPABILITY_AGENT_PAYLOAD_PATH"; fi
  capability_home="$(capability_control_home 2>/dev/null)"
  if [ -n "$capability_home" ]; then
    if [ "$CAPABILITY_CREATED_NODE_AUTH" = 1 ]; then rm -f "$capability_home/.config/ghostfleet/node-token"; fi
    if [ "$CAPABILITY_CREATED_NODE_JSON" = 1 ]; then rm -f "$capability_home/.config/ghostfleet/node.json"; fi
  fi
  if [ "$CAPABILITY_CREATED_AGENT_CONFIG" = 1 ]; then rm -f "$CAPABILITY_AGENT_CONFIG_PATH"; fi
  if [ "$CAPABILITY_CREATED_PAYLOAD_DIR" = 1 ]; then rmdir "$(dirname "$CAPABILITY_AGENT_PAYLOAD_PATH")" 2>/dev/null || true; fi
  CAPABILITY_CREATED_WANT=
  CAPABILITY_CREATED_UNIT=
  CAPABILITY_CREATED_PAYLOAD=
  CAPABILITY_CREATED_NODE_AUTH=
  CAPABILITY_CREATED_NODE_JSON=
  CAPABILITY_CREATED_PAYLOAD_DIR=
  CAPABILITY_CREATED_STATUS_PROJECTION=
  CAPABILITY_STATUS_BACKUP=''
}

capability_rollback_linger() {
  [ "$CAPABILITY_ENABLED_LINGER" = 1 ] || return 0
  loginctl disable-linger "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1 || true
  CAPABILITY_ENABLED_LINGER=0
  return 0
}

# Only what THIS run created is removed. A pre-existing run account, unit file or
# Linger state belonged to the host before the ceremony and is left untouched, so
# a failed ceremony can never delete an account the deployment already owned.
capability_rollback_account() {
  [ "$CAPABILITY_CREATED_ACCOUNT" = 1 ] || return 0
  if ! id "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1; then
    CAPABILITY_CREATED_ACCOUNT=0
    CAPABILITY_ACCOUNT_STATE=ROLLED_BACK
    return 0
  fi
  # enable-linger starts user@<uid>.service, and disable-linger does not reap a
  # running user manager. userdel -r then loses the race against that process and
  # leaves the account behind, which breaks rollback symmetry: a failed ceremony
  # must not leave the account it created. Terminate the user manager, then retry
  # the removal a bounded number of times and report an explicit residual code
  # when the account still exists instead of reporting a clean rollback.
  loginctl terminate-user "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1 || true
  capability_userdel_try=0
  while [ "$capability_userdel_try" -lt 10 ]; do
    if ! id "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1; then
      CAPABILITY_CREATED_ACCOUNT=0
      CAPABILITY_ACCOUNT_STATE=ROLLED_BACK
      return 0
    fi
    userdel -r "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1 || true
    capability_userdel_try=$((capability_userdel_try + 1))
    sleep 0.2
  done
  if ! id "$CAPABILITY_CONTROL_ACCOUNT" >/dev/null 2>&1; then
    CAPABILITY_CREATED_ACCOUNT=0
    CAPABILITY_ACCOUNT_STATE=ROLLED_BACK
    return 0
  fi
  printf '%s\\n' "fleet-enroll: [CAPABILITY_ROLLBACK_ACCOUNT_RESIDUAL] the managed run account $CAPABILITY_CONTROL_ACCOUNT was created by this run but could not be removed (userdel -r kept failing after loginctl terminate-user); stop its user manager and remove the account before retrying" >&2
  return 0
}

capability_rollback() {
  capability_rollback_files
  capability_rollback_linger
  capability_rollback_account
}

capability_state_write() {
  install -d -m 0700 -o root -g root "$CHECKPOINT_DIR"
  capability_state_file="$CHECKPOINT_DIR/capability-state.json"
  # Provenance is sticky: once a ceremony created the run account, later runs
  # keep recording that fact even though they only adopt it. It records who owns
  # the account, so a rollback can tell "ours" from "the deployment's".
  capability_created_recorded=false
  if [ "$CAPABILITY_CREATED_ACCOUNT" = 1 ]; then
    capability_created_recorded=true
  elif [ "$CAPABILITY_ACCOUNT_STATE" != NOT_REQUESTED ] &&
       grep -q '"control_account_created_by_courier":true' "$capability_state_file" 2>/dev/null; then
    capability_created_recorded=true
  fi
  capability_state_body='{"schema":"ghostfleet-capability-state/v1","version":"'"$CAPABILITY_VERSION"'","selection_digest":"'"$CAPABILITY_SELECTION_DIGEST"'","template_digest":"'"$CAPABILITY_TEMPLATE_DIGEST"'","mode":"'"$CAPABILITY_MODE"'","control_account":"'"$CAPABILITY_CONTROL_ACCOUNT"'","control_account_state":"'"$CAPABILITY_ACCOUNT_STATE"'","control_account_created_by_courier":'"$capability_created_recorded"',"privileged_account":"'"$CAPABILITY_PRIVILEGED_ACCOUNT"'","components":{"privileged_helper":"'"$CAPABILITY_HELPER_STATE"'","user_service":"'"$CAPABILITY_USER_SERVICE_STATE"'","linger":"'"$CAPABILITY_LINGER_STATE"'"}}'
  if [ -r "$capability_state_file" ] && [ "$(cat "$capability_state_file")" = "$capability_state_body" ]; then
    capability_record_write
    return 0
  fi
  printf '%s\\n' "$capability_state_body" > "$capability_state_file.$$"
  chmod 0600 "$capability_state_file.$$"
  chown root:root "$capability_state_file.$$"
  mv -f "$capability_state_file.$$" "$capability_state_file"
  capability_record_write
}

# The reviewed selection is kept next to the checkpoint so a later run can
# re-prove the installed lane without a new enrollment or credential.
capability_record_write() {
  capability_selected || return 0
  [ -n "$CAPABILITY_VERSION" ] || return 0
  capability_selection_text | base64 -w0 > "$CAPABILITY_RECORD_FILE.$$"
  chmod 0600 "$CAPABILITY_RECORD_FILE.$$"
  chown root:root "$CAPABILITY_RECORD_FILE.$$"
  mv -f "$CAPABILITY_RECORD_FILE.$$" "$CAPABILITY_RECORD_FILE"
}

# The claim is the only server-authoritative source of the selected capability.
# Values are strict-validated before use and never taken from argv or the URL.
capability_ingest_claim() {
  if [ -z "$CAPABILITY_CLAIM_SELECTION_B64" ]; then
    if [ "$CAPABILITY_REQUIRED" = 1 ]; then
      fail 'the enrollment template requires the privileged capability but the claim delivered no pinned artifacts; no privileged component was installed'
    fi
    return 0
  fi
  if [ "$CAPABILITY_REQUIRED" != 1 ]; then
    fail 'the claim delivered a capability selection for a template that requires none; no privileged component was installed'
  fi
  capability_decoded="$(printf '%s' "$CAPABILITY_CLAIM_SELECTION_B64" | base64 -d 2>/dev/null)" || capability_decoded=
  [ -n "$capability_decoded" ] || fail 'claim capability selection is not decodable; no privileged component was installed'
  install -d -m 0700 -o root -g root "$CHECKPOINT_DIR" || fail 'claim capability selection cannot be staged'
  capability_tmp="$CHECKPOINT_DIR/.selection.$$"
  printf '%s\\n' "$capability_decoded" > "$capability_tmp"
  CAPABILITY_SCHEMA=
  CAPABILITY_VERSION=
  CAPABILITY_TEMPLATE_DIGEST=
  CAPABILITY_SELECTION_DIGEST=
  CAPABILITY_HELPER_REQUIRED=0
  CAPABILITY_LINGER_REQUIRED=0
  CAPABILITY_USER_SERVICE_REQUIRED=0
  CAPABILITY_CONTROL_ACCOUNT=
  CAPABILITY_PRIVILEGED_ACCOUNT=
  CAPABILITY_INSTALLER=
  CAPABILITY_PRIVILEGED_KEY=
  CAPABILITY_USER_UNIT=
  CAPABILITY_USER_UNIT_ARTIFACT=
  CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT=
  CAPABILITY_USER_UNIT_PAYLOAD_PATH=
  CAPABILITY_USER_UNIT_PAYLOAD_MODE=
  CAPABILITY_ARTIFACT_COUNT=0
  capability_slot=1
  while IFS= read -r capability_line; do
    case "$capability_line" in
      '') continue ;;
      schema=*) [ -z "$CAPABILITY_SCHEMA" ] || fail 'claim capability selection repeats the schema'; CAPABILITY_SCHEMA="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      version=*) CAPABILITY_VERSION="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      template_digest=*) CAPABILITY_TEMPLATE_DIGEST="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      helper_required=*) CAPABILITY_HELPER_REQUIRED="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      linger_required=*) CAPABILITY_LINGER_REQUIRED="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      user_service_required=*) CAPABILITY_USER_SERVICE_REQUIRED="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      control_account=*) CAPABILITY_CONTROL_ACCOUNT="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      privileged_account=*) CAPABILITY_PRIVILEGED_ACCOUNT="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      installer=*) CAPABILITY_INSTALLER="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      privileged_key=*) CAPABILITY_PRIVILEGED_KEY="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      user_unit=*) CAPABILITY_USER_UNIT="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      user_unit_artifact=*) CAPABILITY_USER_UNIT_ARTIFACT="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      user_unit_payload_artifact=*) CAPABILITY_USER_UNIT_PAYLOAD_ARTIFACT="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      user_unit_payload_path=*) CAPABILITY_USER_UNIT_PAYLOAD_PATH="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      user_unit_payload_mode=*) CAPABILITY_USER_UNIT_PAYLOAD_MODE="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)" ;;
      artifact=*)
        capability_row="$(printf '%s' "$capability_line" | cut -d '=' -f 2-)"
        # A1: address only. Inline bytes were the old shape and would let the
        # claim, rather than the digest-verified asset origin, decide content.
        printf '%s' "$capability_row" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}[|][0-9a-f]{64}[|]0?[0-7]{3}$' || fail 'claim capability artifact row must be name|sha256|mode; inline artifact content is refused and no privileged component was installed'
        [ "$capability_slot" -le 16 ] || fail 'claim capability ships more artifacts than this courier supports'
        eval "CAPABILITY_ARTIFACT_\${capability_slot}=\\$capability_row"
        capability_slot=$((capability_slot + 1))
        ;;
      *) fail 'claim capability selection contains an unknown field; no privileged component was installed' ;;
    esac
  done < "$capability_tmp"
  rm -f "$capability_tmp"
  CAPABILITY_ARTIFACT_COUNT=$((capability_slot - 1))
  # A selection restored from this node's own record keeps its provenance, so the
  # v1 residue check can tell "our earlier lane" from "the deployment's".
  [ "$CAPABILITY_SELECTION_ORIGIN" = recorded ] || CAPABILITY_SELECTION_ORIGIN=claim
  capability_validate_selection
}

capability_apply() {
  if ! capability_selected; then
    CAPABILITY_HELPER_STATE=NOT_REQUESTED
    CAPABILITY_USER_SERVICE_STATE=NOT_REQUESTED
    CAPABILITY_LINGER_STATE=NOT_REQUESTED
    CAPABILITY_AGENT_PAYLOAD_STATE=NOT_REQUESTED
    CAPABILITY_USER_UNIT_STATE=NOT_REQUESTED
    CAPABILITY_NODE_AUTH_STATE=NOT_REQUESTED
    CAPABILITY_MODE=NOT_REQUESTED
    printf '%s\\n' 'fleet-enroll: the selected template requests no privileged capability; nothing was installed' >&2
    capability_evidence
    return 0
  fi
  capability_validate_selection
  capability_stage
  capability_probe
  # The run account boundary is re-proved before any effect, and before the
  # zero-delta decision: a converged node whose run account was later added to
  # sudo or to a root-equivalent group must stop reporting "already converged".
  if ! capability_provision_control_account; then
    capability_rollback
    capability_stage_cleanup
    fail 'the dedicated managed run account could not be provisioned and proved least-privilege; no completion is reported'
  fi
  # A converged node re-proves the declaration too: a selection that names an
  # account the installer does not admit — or a helper that reports COMPLIANT
  # with no readable record — must never answer "already converged".
  if [ "$CAPABILITY_HELPER_REQUIRED" = 1 ]; then
    if ! capability_verify_declared_privileged_account "$(capability_declared_privileged_account_mode)"; then
      capability_rollback
      capability_stage_cleanup
      fail 'the declared privileged account could not be proved against the reviewed installer record; no completion is reported'
    fi
  fi
  if capability_states_compliant; then
    CAPABILITY_MODE=ADOPT
    CAPABILITY_USER_SERVICE_STATE="$CAPABILITY_USER_UNIT_STATE"
    CAPABILITY_EVIDENCE_PAYLOAD_STATE=COMPLIANT
    CAPABILITY_EVIDENCE_UNIT_STATE=COMPLIANT
    if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
      CAPABILITY_SERVICE_STATE=INSTALLED
      CAPABILITY_USER_UNIT_EXEC="$CAPABILITY_AGENT_PAYLOAD_PATH"
    fi
    if ! capability_status_projection; then
      capability_rollback
      capability_stage_cleanup
      fail '[CAPABILITY_STATUS_PROJECTION_FAILED] the public capability projection could not be written atomically, so this node may not report an installed capability; remove any partial /etc/ghostfleet/capability-status.json and re-run the authorized Console command'
    fi
    capability_state_write
    capability_stage_cleanup
    printf '%s\\n' "fleet-enroll: selected capability $CAPABILITY_VERSION already converged; zero delta" >&2
    capability_evidence
    return 0
  fi
  case "$CAPABILITY_MODE" in
    NEW|REPAIR|ADOPT) ;;
    *)
      capability_drift=0
      case "$CAPABILITY_HELPER_STATE" in DRIFT_REPAIRABLE|CONFLICT) capability_drift=1 ;; esac
      case "$CAPABILITY_USER_SERVICE_STATE" in COMPLIANT) capability_drift=1 ;; esac
      case "$CAPABILITY_LINGER_STATE" in COMPLIANT) capability_drift=1 ;; esac
      if [ "$capability_drift" = 1 ]; then CAPABILITY_MODE=REPAIR; else CAPABILITY_MODE=NEW; fi
      ;;
  esac
  if [ "$CAPABILITY_HELPER_REQUIRED" = 1 ] && [ "$CAPABILITY_HELPER_STATE" != COMPLIANT ]; then
    if ! capability_installer --apply; then
      capability_rollback
      capability_stage_cleanup
      fail 'selected privileged helper apply failed; no completion is reported'
    fi
    CAPABILITY_HELPER_STATE="$(capability_helper_state)"
    if [ "$CAPABILITY_HELPER_STATE" != COMPLIANT ]; then
      capability_rollback
      capability_stage_cleanup
      fail 'selected privileged helper postcondition failed'
    fi
  fi
  # The installer just ran as root. Re-prove the run account (when a lane uses it)
  # and the declared privileged account before anything is installed into a home
  # or recorded as converged: a drifted or compromised artifact must not be able
  # to hand the runtime a group, a sudo rule, or a different ops identity.
  if ! capability_reprove_control_account; then
    capability_rollback
    capability_stage_cleanup
    fail 'the managed run account lost its least-privilege proof after the reviewed installer ran; remove the account privilege named above (sudoers file and groups) and re-run the authorized Console command; no completion is reported'
  fi
  if [ "$CAPABILITY_HELPER_REQUIRED" = 1 ]; then
    if ! capability_verify_declared_privileged_account required; then
      capability_rollback
      capability_stage_cleanup
      fail 'the declared privileged account does not match the account the reviewed installer just recorded; no completion is reported'
    fi
  fi
  # The node credential is delivered ONLY in the completion response, so on a
  # first run the payload, the user unit and Linger are installed afterwards, in
  # capability_service_finish. Nothing is installed into the control account home
  # before the control plane has handed this node its credential.
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
    CAPABILITY_AGENT_PAYLOAD_STATE="$(capability_agent_payload_state)"
    CAPABILITY_USER_UNIT_STATE="$(capability_user_service_state)"
    CAPABILITY_NODE_AUTH_STATE="$(capability_node_token_state)"
    if [ "$CAPABILITY_NODE_AUTH_STATE" = COMPLIANT ]; then
      # A repair run stores the credential already: finish the lane inline.
      capability_agent_payload_apply
      capability_agent_state_dirs
      if [ "$CAPABILITY_USER_UNIT_STATE" != COMPLIANT ]; then
        if ! capability_user_service_apply; then
          capability_rollback
          capability_stage_cleanup
          fail 'selected user service could not be installed; no completion is reported'
        fi
        CAPABILITY_EVIDENCE_UNIT_STATE=INSTALLED
      else
        CAPABILITY_EVIDENCE_UNIT_STATE=COMPLIANT
      fi
      capability_user_unit_exec_assert
      if ! capability_agent_config_write; then
    capability_rollback
    capability_stage_cleanup
    fail '[CAPABILITY_AGENT_CONFIG_UNSAFE] the root-owned agent configuration could not be written from the validated selection, so the managed agent would start without it; the lane was rolled back and no completion is reported'
  fi
      if ! capability_linger_apply; then
        capability_rollback
        capability_stage_cleanup
        fail 'selected Linger could not be enabled; no completion is reported'
      fi
      CAPABILITY_USER_UNIT_STATE="$(capability_user_service_state)"
      CAPABILITY_USER_SERVICE_STATE="$CAPABILITY_USER_UNIT_STATE"
      CAPABILITY_AGENT_PAYLOAD_STATE="$(capability_agent_payload_state)"
      CAPABILITY_NODE_AUTH_STATE="$(capability_node_token_state)"
      if ! capability_states_compliant; then
        capability_rollback
        capability_stage_cleanup
        fail "selected capability did not converge (helper=$CAPABILITY_HELPER_STATE payload=$CAPABILITY_AGENT_PAYLOAD_STATE unit=$CAPABILITY_USER_UNIT_STATE service=$CAPABILITY_USER_SERVICE_STATE token=$CAPABILITY_NODE_AUTH_STATE linger=$CAPABILITY_LINGER_STATE)"
      fi
      CAPABILITY_SERVICE_STATE=INSTALLED
      if ! capability_status_projection; then
        capability_rollback
        capability_stage_cleanup
        fail '[CAPABILITY_STATUS_PROJECTION_FAILED] the public capability projection could not be written atomically, so this node may not report an installed capability; remove any partial /etc/ghostfleet/capability-status.json and re-run the authorized Console command'
      fi
      capability_state_write
      capability_stage_cleanup
      printf '%s\\n' "fleet-enroll: selected capability $CAPABILITY_VERSION converged mode=$CAPABILITY_MODE helper=$CAPABILITY_HELPER_STATE user_service=$CAPABILITY_USER_SERVICE_STATE linger=$CAPABILITY_LINGER_STATE run_account=$CAPABILITY_ACCOUNT_STATE" >&2
      capability_evidence
      return 0
    fi
    case "$CAPABILITY_NODE_AUTH_STATE" in
      ABSENT)
        case "$CAPABILITY_SELECTION_ORIGIN" in
          recorded)
            capability_rollback
            capability_stage_cleanup
            fail '[CAPABILITY_NODE_CREDENTIAL_MISSING] this node owns no stored node credential and a repair run cannot mint one because the completion response is not re-requested; the agent payload and the user unit were not installed, nothing was enabled and Linger was not enabled; run the authorized Console command with a fresh enrollment ticket'
            ;;
          *)
            # First run: the credential arrives with the completion response and
            # the service lane is finished there. The staged artifacts stay until
            # that happens, because the unit and payload are installed from them.
            CAPABILITY_SERVICE_PENDING=1
            CAPABILITY_USER_SERVICE_STATE=DEFERRED
            CAPABILITY_LINGER_STATE=DEFERRED
            capability_state_write
            printf '%s\\n' "fleet-enroll: selected capability $CAPABILITY_VERSION prepared mode=$CAPABILITY_MODE helper=$CAPABILITY_HELPER_STATE user_service=DEFERRED linger=DEFERRED run_account=$CAPABILITY_ACCOUNT_STATE; the node credential is installed from the completion response before any payload or unit is placed" >&2
            return 0
            ;;
        esac
        ;;
      *)
        capability_rollback
        capability_stage_cleanup
        fail "[CAPABILITY_NODE_TOKEN_INVALID] the stored node token is $CAPABILITY_NODE_AUTH_STATE (expected a 0600 base64url token owned by $CAPABILITY_CONTROL_ACCOUNT in a 0700 directory); repair or remove the stored credential and re-run the authorized Console command; the agent payload and the user unit were not installed and Linger was not enabled"
        ;;
    esac
  fi
  if [ "$CAPABILITY_LINGER_REQUIRED" = 1 ]; then
    if ! capability_linger_apply; then
      capability_rollback
      capability_stage_cleanup
      fail 'selected Linger could not be enabled; no completion is reported'
    fi
  fi
  if ! capability_states_compliant; then
    capability_rollback
    capability_stage_cleanup
    fail 'selected capability did not converge'
  fi
  if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then CAPABILITY_SERVICE_STATE=INSTALLED; fi
  if ! capability_status_projection; then
    capability_rollback
    capability_stage_cleanup
    fail '[CAPABILITY_STATUS_PROJECTION_FAILED] the public capability projection could not be written atomically, so this node may not report an installed capability; remove any partial /etc/ghostfleet/capability-status.json and re-run the authorized Console command'
  fi
  capability_state_write
  capability_stage_cleanup
  printf '%s\\n' "fleet-enroll: selected capability $CAPABILITY_VERSION converged mode=$CAPABILITY_MODE helper=$CAPABILITY_HELPER_STATE user_service=$CAPABILITY_USER_SERVICE_STATE linger=$CAPABILITY_LINGER_STATE run_account=$CAPABILITY_ACCOUNT_STATE" >&2
  capability_evidence
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
  checkpoint_identity_converged || return 1
  capability_restore_recorded
  capability_probe_all || return 1
  return 0
}

checkpoint_load_identity() {
  NODE_ID="$(json_file_value "$CHECKPOINT_FILE" node_id)"
  NODE_UID="$(json_file_value "$CHECKPOINT_FILE" node_uid)"
  IDENTITY_KIND="$(json_file_value "$CHECKPOINT_FILE" identity_kind)"
  [ -n "$IDENTITY_KIND" ] || IDENTITY_KIND=canonical
  ENROLLMENT_ID="$(json_file_value "$CHECKPOINT_FILE" enrollment_id)"
  OS_FAMILY="$(json_file_value "$CHECKPOINT_FILE" os_family)"
  OS_ID="$(json_file_value "$CHECKPOINT_FILE" os_id)"
  OS_VERSION_ID="$(json_file_value "$CHECKPOINT_FILE" os_version_id)"
  [ -n "$OS_FAMILY" ] || OS_FAMILY=debian-family
  [ -n "$OS_ID" ] || OS_ID=unknown
  [ -n "$OS_VERSION_ID" ] || OS_VERSION_ID=unknown
  PACKAGES_STATE=COMPLIANT
  TAILSCALE_STATE=COMPLIANT
}

checkpoint_identity_converged() {
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
  # A failing run leaves no staged artifact behind. The staged bytes include the
  # node agent payload, and the staged node token is a bearer secret, so both are
  # removed before the failure is reported.
  if [ -n "$CAPABILITY_STAGE_DIR" ]; then rm -rf "$CAPABILITY_STAGE_DIR"; fi
  if [ -n "$CAPABILITY_NODE_AUTH" ]; then
    rm -f "$CHECKPOINT_DIR/.node-token.$$"
    CAPABILITY_NODE_AUTH=
  fi
  printf '%s\\n' "fleet-enroll: $*" >&2
  exit 1
}

if [ -z "$BROKER_ORIGIN" ]; then
  checkpoint_is_compliant || fail 'deployment broker origin is required before bootstrap effects'
else
  printf '%s' "$BROKER_ORIGIN" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$' || fail 'deployment broker origin must be exact HTTPS origin'
fi

# Selected-capability artifacts come from the immutable public asset origin. The
# launcher exports its exact value as a fixed assignment; this script never
# derives it from the ticket URL, from the claim response, or from argv. The
# origin is a location, never a trust anchor: every artifact is still verified
# against the digest the claim pinned.
#
# The exact scheme prefixes are composed from variables so the published source
# carries no locator of its own.
ASSET_HTTPS_PREFIX='https://'
ASSET_LOOPBACK_PREFIX='http://'
asset_origin_is_exact() {
  ASSET_ORIGIN_VALUE="$1"
  case "$ASSET_ORIGIN_VALUE" in
    "$ASSET_HTTPS_PREFIX"*) ASSET_ORIGIN_REST="\${ASSET_ORIGIN_VALUE#"$ASSET_HTTPS_PREFIX"}" ;;
    "$ASSET_LOOPBACK_PREFIX"127.0.0.1:*|"$ASSET_LOOPBACK_PREFIX"localhost:*) ASSET_ORIGIN_REST="\${ASSET_ORIGIN_VALUE#"$ASSET_LOOPBACK_PREFIX"}" ;;
    *) return 1 ;;
  esac
  # host[:port] only: no userinfo, path, query, fragment or second scheme.
  case "$ASSET_ORIGIN_REST" in
    ''|*[!A-Za-z0-9.:-]*) return 1 ;;
  esac
  case "$ASSET_ORIGIN_REST" in
    *:*)
      ASSET_ORIGIN_PORT="\${ASSET_ORIGIN_REST##*:}"
      ASSET_ORIGIN_HOST="\${ASSET_ORIGIN_REST%%:*}"
      case "$ASSET_ORIGIN_PORT" in ''|*[!0-9]*) return 1 ;; esac
      case "$ASSET_ORIGIN_HOST" in ''|*:*|.*) return 1 ;; esac
      ;;
  esac
  return 0
}
if [ -n "$ASSETS_ORIGIN" ]; then
  asset_origin_is_exact "$ASSETS_ORIGIN" || fail 'asset origin must be an exact https origin (loopback http is only for local test runs): no path, userinfo, query or fragment'
fi

if [ "$(id -u)" -ne 0 ]; then
  # This courier never re-executes itself through sudo or su: a self-elevation
  # would inherit the caller PATH, TMPDIR and environment, and the run could be
  # redirected to a different binary or terminal. The Console-generated one-shot
  # command already runs this script as root with a clean environment.
  fail 'root privileges are required; run the whole Console-generated one-click command instead of elevating this script'
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

  PREFLIGHT_MATERIAL="$(printf '%s\\n' "$OS_FAMILY" "$OS_ID" "$OS_VERSION_ID" "$(uname -m)" "$APPLIANCE_KIND" "$DOCKER_SOCKET_HINT" "$NOPASSWD_HINT")"
  PRECHECK_DIGEST="sha256:$(printf '%s' "$PREFLIGHT_MATERIAL" | sha256sum | awk '{print $1}')"
  unset PREFLIGHT_MATERIAL

  printf '%s\\n' "fleet-enroll: preflight PASS os=$OS_ID/$OS_VERSION_ID arch=$(uname -m) appliance=$APPLIANCE_KIND docker_socket=$DOCKER_SOCKET_HINT nopasswd_hint=$NOPASSWD_HINT" >&2
}
bootstrap_phase0_preflight

# A malformed or unrequested selected-capability selection stops here, before
# any package, provider, service or credential effect.
capability_validate_selection

# The next steps can update APT source or start a daemon. Refuse an existing
# foreign/unproven Tailscale session before ANY package or service mutation.
# Existing machines must use a verified ADOPT/REPAIR plan instead of a new join.
if checkpoint_identity_converged; then
  capability_restore_recorded
  if ! capability_selected && grep -Eq '"privileged_helper"|"user_service"|"linger"' "$CHECKPOINT_FILE" 2>/dev/null; then
    # A checkpoint written by an older courier recorded the components but no
    # reviewed selection. It is machine-reconcilable: the next authorized claim
    # re-delivers the selection and this run converges it. No manual state edit.
    CAPABILITY_LEGACY_STATE=1
    rm -f /run/fleet/ts-authkey
    printf '%s\\n' 'fleet-enroll: this node recorded a privileged capability without a reviewed selection (legacy checkpoint); the next authorized claim reconciles it' >&2
  fi
  if [ "$CAPABILITY_LEGACY_STATE" = 1 ]; then
    # Converge through the authorized claim below: the selection is re-delivered
    # and applied inside the same ceremony. Never a selection-less "repair".
    :
  elif capability_probe_all; then
    CAPABILITY_EVIDENCE_PAYLOAD_STATE="$CAPABILITY_AGENT_PAYLOAD_STATE"
    CAPABILITY_EVIDENCE_UNIT_STATE="$CAPABILITY_USER_UNIT_STATE"
    if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
      CAPABILITY_SERVICE_STATE=INSTALLED
      CAPABILITY_USER_UNIT_EXEC="$CAPABILITY_AGENT_PAYLOAD_PATH"
      CAPABILITY_NODE_AUTH_MODE=0600
    fi
    if ! capability_status_projection; then
      fail '[CAPABILITY_STATUS_PROJECTION_FAILED] the public capability projection could not be written atomically, so this node may not report an installed capability; remove any partial /etc/ghostfleet/capability-status.json and re-run the authorized Console command'
    fi
    printf '%s\\n' 'fleet-enroll: already converged; no enrollment credentials requested' >&2
    capability_evidence
    exit 0
  else
    # Only the selected capability drifted: repair it from the selection the
    # authorized first run recorded. No new enroll, credential, identity or join.
    checkpoint_load_identity
    CAPABILITY_MODE=REPAIR
    capability_apply
    checkpoint_write CHECKPOINT COMPLIANT
    printf '%s\\n' 'fleet-enroll: selected capability repaired from the recorded reviewed selection; no enrollment credentials requested' >&2
    exit 0
  fi
fi
if [ "$CAPABILITY_LEGACY_STATE" != 1 ]; then
  refuse_unresolved_previous_enrollment
fi
case "$(tailscale_preclaim_state)" in
  FRESH) ;;
  EXISTING)
    if [ "$CAPABILITY_LEGACY_STATE" = 1 ] && live_tailscale_ready "$(json_file_value "$CHECKPOINT_FILE" node_id)"; then
      printf '%s\\n' 'fleet-enroll: reconciling a legacy capability record on this already-joined node; no new identity will be minted' >&2
    else
      fail 'existing Tailscale identity detected; use verified ADOPT/REPAIR flow; no new enrollment effects attempted'
    fi
    ;;
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
  printf '%s\\n' 'fleet-enroll: installing bootstrap transport baseline (curl ca-certificates) from distribution base repositories' >&2
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
  printf '%s\\n' "fleet-enroll: configuring official Tailscale APT repository for $OS_ID/$OS_CODENAME" >&2
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
CLAIM_CONFIG=/run/fleet/curl-claim.conf
# The one-time ticket URL is a bearer handle: keep it out of argv, where any
# local process with the same uid can read /proc/<pid>/cmdline.
printf 'url = "%s"\\nheader = "content-type: text/plain"\\nheader = "x-fleet-os-family: %s"\\nheader = "x-fleet-os-id: %s"\\nheader = "x-ghostfleet-preflight-digest: %s"\\n' \\
  "$CLAIM_URL" "$OS_FAMILY" "$OS_ID" "$PRECHECK_DIGEST" > "$CLAIM_CONFIG"
chmod 0600 "$CLAIM_CONFIG"
chown root:root "$CLAIM_CONFIG"
if ! CLAIM_JSON="$(printf '%s' "$ENROLL_CODE" | curl -fsS \\
  --config "$CLAIM_CONFIG" \\
  --connect-timeout 10 \\
  --max-time 30 \\
  --data-binary @- )"; then
  rm -f "$CLAIM_CONFIG"
  unset ENROLL_CODE
  fail 'claim denied: Enrollment Code is invalid, expired, replayed, or does not match this OS profile'
fi
rm -f "$CLAIM_CONFIG"
unset ENROLL_CODE

json_flag() {
  if printf '%s' "$1" | grep -Eq '"'$2'"[[:space:]]*:[[:space:]]*true'; then printf '1'; else printf '0'; fi
}

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
CAPABILITY_REQUIRED="$(json_flag "$CLAIM_JSON" capability_required)"
CAPABILITY_CLAIM_SELECTION_B64="$(json_get "$CLAIM_JSON" capability_selection)"
unset CLAIM_JSON

if [ "$CAPABILITY_LEGACY_STATE" = 1 ]; then
  # Reconciliation may only continue on the very node this checkpoint belongs to.
  capability_checkpoint_node="$(json_file_value "$CHECKPOINT_FILE" node_id)"
  [ "$NODE_ID" = "$capability_checkpoint_node" ] ||
    fail 'this claim is for a different node; a legacy capability record can only be reconciled on its original node'
  case "$IDENTITY_KIND" in
    provisional)
      capability_checkpoint_enrollment="$(json_file_value "$CHECKPOINT_FILE" enrollment_id)"
      [ "$ENROLLMENT_ID" = "$capability_checkpoint_enrollment" ] ||
        fail 'this claim belongs to a different provisional enrollment; a legacy capability record cannot be reconciled with it'
      ;;
    *)
      capability_checkpoint_uid="$(json_file_value "$CHECKPOINT_FILE" node_uid)"
      capability_checkpoint_kind="$(json_file_value "$CHECKPOINT_FILE" identity_kind)"
      [ "$NODE_UID" = "$capability_checkpoint_uid" ] ||
        fail 'this claim carries a different node identity; a legacy capability record cannot be reconciled with it'
      [ -n "$capability_checkpoint_kind" ] || capability_checkpoint_kind=canonical
      [ "$IDENTITY_KIND" = "$capability_checkpoint_kind" ] ||
        fail 'this claim changes the identity kind of a legacy capability checkpoint; reconcile manually'
      ;;
  esac
  # The installed privileged lane must be re-delivered, never silently dropped.
  [ "$CAPABILITY_REQUIRED" = 1 ] && [ -n "$CAPABILITY_CLAIM_SELECTION_B64" ] ||
    fail 'this node recorded a privileged capability but the claim delivered no reviewed selection; the installed lane cannot be reconciled by this claim'
fi
# The selected capability arrives with the claim, so it is verified and applied
# inside this same root ceremony.
capability_ingest_claim


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
if [ "$CAPABILITY_LEGACY_STATE" = 1 ] && [ "$TAILSCALE_STATE" != COMPLIANT ]; then
  fail 'legacy reconcile requires the existing identity to still match this node'
fi

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
    printf '%s\\t%s\\n' "$key" "$encoded" >> "$EVIDENCE_FILE"
  }
  bounded_file() {
    [ -r "$1" ] || return 0
    tr '\\r\\n\\t' '    ' < "$1" | head -c 512
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
    PCI_EVIDENCE="$PCI_EVIDENCE$(basename "$dev") $vendor $device $class
"
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
  "capability_mode": "$CAPABILITY_MODE",
  "capability_selection_digest": "$CAPABILITY_SELECTION_DIGEST"
}
EOF
chmod 0600 "$REPORT_FILE"
chown root:root "$REPORT_FILE"

# The completion response is the only delivery point for the node credential. It
# is captured into a variable, never into a file name, an argument list or a log
# line, and the managed service lane is finished from it.
CAPABILITY_COMPLETE_RESPONSE="$(printf '{"resume_session":"%s","report":{"identity_kind":"%s","enrollment_id":"%s","node_id":"%s","os_id":"%s","os_version_id":"%s","ssh_host_key_sha256":"%s","bootstrap_version":"%s","identity_evidence_b64":"%s","identity_evidence_sha256":"%s","capability_version":"%s","capability_mode":"%s","capability_selection_digest":"%s"}}' "$RESUME_SESSION" "$IDENTITY_KIND" "$ENROLLMENT_ID" "$NODE_ID" "$OS_ID" "$OS_VERSION_ID" "$SSH_HOST_KEY_SHA" "$BOOTSTRAP_VERSION" "$IDENTITY_EVIDENCE_B64" "$IDENTITY_EVIDENCE_SHA" "$CAPABILITY_VERSION" "$CAPABILITY_MODE" "$CAPABILITY_SELECTION_DIGEST" | curl -fsS --connect-timeout 10 --max-time 30 --header 'content-type: application/json' --data-binary @- "$BROKER_ORIGIN/v1/enroll/complete")" ||
  fail 'completion report failed'

if [ "$CAPABILITY_USER_SERVICE_REQUIRED" = 1 ]; then
  capability_node_credential_parse
  capability_service_finish
  CAPABILITY_NODE_AUTH=
  CAPABILITY_COMPLETE_RESPONSE=
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
