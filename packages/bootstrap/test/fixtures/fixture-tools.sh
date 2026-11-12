#!/usr/bin/env bash
# Synthetic fixture for the published bootstrap courier. Every command here
# replaces one privileged host tool so the real courier script can run the whole
# first-root ceremony without root, a provider, or a network.
#
# Account state is modelled, not real: ${FIXTURE_STATE}/accounts/<name> holds
# "<home>|<shell>", groups/<name> the account's group list, sudo-grant/<name>,
# unlocked/<name> and linger/<name> the corresponding facts. A test seeds any of
# them to stand for a host that already had that account.
set -u
name="$(basename "$0")"
state="${FIXTURE_STATE:?FIXTURE_STATE is required}"
home_root="${FIXTURE_HOME_ROOT:-$state/homes}"
record() { printf '%s\n' "$*" >> "$state/calls.log"; }
# Ownership is modelled, not real: every command here runs as the test user, so
# an install into root:root would be indistinguishable from the current user.
# Every write that names an owner records it here and the stat stub answers from
# it, which lets the courier's ownership postconditions be asserted without root.
owner_marker() { printf '%s|%s\n' "$1" "$2" >> "$state/stat-owner.tsv"; }
owner_lookup() { grep -F "$1|" "$state/stat-owner.tsv" 2>/dev/null | tail -n1 | cut -d'|' -f2-; }
account_exists() { [ -f "$state/accounts/$1" ]; }
account_home() { cut -d'|' -f1 "$state/accounts/$1"; }
account_shell() { cut -d'|' -f2 "$state/accounts/$1"; }
# Deterministic per-name uid so distinct accounts never share a gid; an explicit
# uids/<name> file wins (tests use it for the system-uid case).
account_uid() {
  if [ -f "$state/uids/$1" ]; then cat "$state/uids/$1"; return 0; fi
  printf '%s\n' "$((1000 + $(printf '%s' "$1" | cksum | cut -d' ' -f1) % 500))"
}

case "$name" in
  id)
    case "${1:-}" in
      -u)
        if [ -n "${2:-}" ]; then
          account_exists "$2" || exit 1
          account_uid "$2"
        else
          printf '0\n'
        fi
        ;;
      -nG)
        if [ -n "${2:-}" ]; then
          account_exists "$2" || exit 1
          if [ -f "$state/nss-fail/id-groups/$2" ]; then exit 1; fi
          if [ -f "$state/empty-groups/$2" ]; then exit 0; fi
          if [ -f "$state/groups/$2" ]; then cat "$state/groups/$2"; else printf '%s\n' "$2"; fi
        else
          printf 'users\n'
        fi
        ;;
      *)
        [ -n "${1:-}" ] || exit 1
        account_exists "$1" || exit 1
        ;;
    esac
    ;;
  uname)
    case "${1:-}" in
      -m) printf 'x86_64\n' ;;
      *) printf 'Linux\n' ;;
    esac
    ;;
  dpkg-query) printf 'install ok installed\n' ;;
  tailscale)
    case "${1:-}" in
      status)
        if [ -f "$state/tailscale.joined" ]; then
          printf '{"BackendState":"Running","Self":{"HostName":"%s"}}\n' "$(cat "$state/tailscale.hostname")"
        else
          printf '{"BackendState":"NeedsLogin","Self":null}\n'
        fi
        ;;
      up)
        case " $* " in
          *" --hostname ${FIXTURE_NODE_ID:-unset} "*) ;;
          *) record "tailscale-up-hostname-mismatch"; exit 9 ;;
        esac
        record "tailscale-up"
        if [ -n "${FIXTURE_AUTHKEY:-}" ] && [ -e "$FIXTURE_AUTHKEY" ]; then
          record "authkey $(stat -c '%a %U %G' "$FIXTURE_AUTHKEY")"
        fi
        printf '%s' "$FIXTURE_NODE_ID" > "$state/tailscale.hostname"
        : > "$state/tailscale.joined"
        ;;
      *) record "tailscale-unexpected $*"; exit 9 ;;
    esac
    ;;
  systemctl)
    record "systemctl $*"
    verb=
    unit=
    for argument in "$@"; do
      case "$argument" in
        -*) ;;
        *) if [ -z "$verb" ]; then verb="$argument"; elif [ -z "$unit" ]; then unit="$argument"; fi ;;
      esac
    done
    if [ "$verb" = stop ] || [ "$verb" = is-active ]; then
      state_file="$state/unit-state/$unit"
      current="$(cat "$state_file" 2>/dev/null || printf 'inactive')"
      if [ "$verb" = stop ]; then
        if [ -f "$state/stop-fails" ]; then printf 'Failed to stop %s\n' "$unit" >&2; exit 1; fi
        if [ -f "$state/stop-ineffective" ]; then printf 'active\n'; exit 0; fi
        mkdir -p "$state/unit-state"
        printf 'inactive\n' > "$state_file"
        printf 'inactive\n'
        exit 0
      fi
      printf '%s\n' "$current"
      case "$current" in active) exit 0 ;; *) exit 3 ;; esac
    fi
    ;;

  pgrep)
    record "pgrep $*"
    # pgrep's contract: 0 matched, 1 no match, other = the query failed.
    if [ -f "$state/pgrep-fails" ]; then exit 3; fi
    if [ -s "$state/unit-procs" ]; then cat "$state/unit-procs"; exit 0; fi
    exit 1
    ;;
  apt-get)
    record "apt-get $*"
    case " $* " in
      *" install "*)
        case " $* " in
          *" tailscale ")
            cp "$FIXTURE_BIN/apt-get" "$FIXTURE_BIN/tailscale"
            chmod 0755 "$FIXTURE_BIN/tailscale"
            ;;
        esac
        ;;
    esac
    ;;
  curl)
    arguments="$*"
    config=
    previous=
    for argument in "$@"; do
      if [ "$previous" = "--config" ]; then config="$argument"; fi
      previous="$argument"
    done
    url=
    for argument in "$@"; do
      case "$argument" in http*) url="$argument" ;; esac
    done
    if [ -n "$config" ] && [ -r "$config" ]; then
      url="$(sed -n 's/^url = "\(.*\)"$/\1/p' "$config" | head -n1)"
      record "curl-config mode=$(stat -c '%a' "$config")"
    fi
    record "curl-argv $arguments"
    # Pinned artifacts are fetched from a real local HTTP server: the digest
    # check and the no-redirect behavior are exercised against real curl and a
    # real content-addressed response, not against another stub.
    case "$url" in
      */sha256/*)
        record "curl-asset $url"
        exec "${FIXTURE_REAL_CURL:?FIXTURE_REAL_CURL is required}" "$@"
        ;;
    esac
    case "$url" in
      */claim)
        record "curl claim"
        cat "$state/claim.json"
        ;;
      */v1/enroll/complete)
        cat > "$state/complete-body.json"
        record "curl complete"
        # The completion response is the only place a node credential is
        # delivered. A test overrides it with state/complete-response.json
        # (expired handoff, missing credential, different token).
        if [ -f "$state/complete-response.json" ]; then
          cat "$state/complete-response.json"
        else
          complete_node_uid="$(sed -n 's/.*"node_uid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state/claim.json" | head -n1)"
          printf '{"outcome":"COMPLETE","node_credential":{"token":"%s","node_uid":"%s","handoff_id":"fixture-handoff-0001"}}\n' "${FIXTURE_NODE_TOKEN:-fixture-node-token-000000000000000000000000}" "$complete_node_uid"
        fi
        ;;
      *noarmor.gpg|*tailscale-keyring.list)
        previous=
        for argument in "$@"; do
          if [ "$previous" = "-o" ]; then printf 'pkgs.tailscale.com fixture\n' > "$argument"; fi
          previous="$argument"
        done
        ;;
      *) record "curl-unexpected $url"; exit 8 ;;
    esac
    ;;
  ssh-keygen)
    keyfile=
    for argument in "$@"; do
      case "$argument" in -*) ;; *) keyfile="$argument" ;; esac
    done
    printf '%s SHA256:fixturehostfingerprint (ED25519)\n' "$keyfile"
    ;;
  install)
    record "install $*"
    # Two passes: one strips -o/-g so the real install runs as the test user, the
    # other records the owner, the group and every destination, so the courier's
    # ownership postconditions are observable without root.
    arguments=()
    skip_next=0
    for argument in "$@"; do
      if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
      case "$argument" in
        -o|-g) skip_next=1; continue ;;
        -o*|-g*) continue ;;
      esac
      arguments+=("$argument")
    done
    owner=
    group=
    install_directory=0
    destinations=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) owner="${2:-}"; shift 2 ;;
        -g) group="${2:-}"; shift 2 ;;
        -m) shift 2 ;;
        -d|--directory) install_directory=1; shift ;;
        -o*) owner="${1#-o}"; shift ;;
        -g*) group="${1#-g}"; shift ;;
        -m*) shift ;;
        -*) shift ;;
        *) destinations+=("$1"); shift ;;
      esac
    done
    /usr/bin/install "${arguments[@]}"
    install_status=$?
    if [ "$install_status" -ne 0 ]; then exit "$install_status"; fi
    if [ -n "$owner" ] && [ "${#destinations[@]}" -gt 0 ]; then
      marker_owner="$owner:${group:-$owner}"
      if [ "$install_directory" = 1 ]; then
        for destination in "${destinations[@]}"; do owner_marker "$destination" "$marker_owner"; done
      else
        destination="${destinations[${#destinations[@]}-1]}"
        source="${destinations[0]}"
        if [ -d "$destination" ]; then
          owner_marker "$destination/$(basename "$source")" "$marker_owner"
        else
          owner_marker "$destination" "$marker_owner"
        fi
      fi
    fi
    exit 0
    ;;
  stat)
    # stat is real except for ownership queries about a modelled path: a test can
    # seed it, and an install/chown records it.
    stat_format=
    stat_target=
    stat_original=("$@")
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -c|--format|--printf) stat_format="${2:-}"; shift 2 ;;
        -c*) stat_format="${1#-c}"; shift ;;
        --format=*) stat_format="${1#--format=}"; shift ;;
        --printf=*) stat_format="${1#--printf=}"; shift ;;
        -*) shift ;;
        *) [ -n "$stat_target" ] || stat_target="$1"; shift ;;
      esac
    done
    if [ -n "$stat_target" ] && [ -f "$state/stat-owner.tsv" ]; then
      stat_owner="$(owner_lookup "$stat_target")"
      if [ -n "$stat_owner" ]; then
        case "$stat_format" in
          '%U:%G') printf '%s\n' "$stat_owner"; exit 0 ;;
          '%U') printf '%s\n' "${stat_owner%%:*}"; exit 0 ;;
          '%G') printf '%s\n' "${stat_owner##*:}"; exit 0 ;;
        esac
      fi
    fi
    exec /usr/bin/stat "${stat_original[@]}"
    ;;
  mv)
    # A rename moves the modelled ownership with the file, so the courier's
    # tmp-file-then-rename install lane stays observable after the move.
    mv_arguments=()
    mv_destination=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -fnivub*|--force|--interactive|--no-clobber|--verbose) shift ;;
        -*) shift ;;
        *) mv_arguments+=("$1"); mv_destination="$1"; shift ;;
      esac
    done
    if [ "${#mv_arguments[@]}" -ge 2 ]; then
      mv_source="${mv_arguments[0]}"
      mv_owner="$(owner_lookup "$mv_source")"
      if [ -n "$mv_owner" ]; then
        if [ -d "$mv_destination" ]; then
          owner_marker "$mv_destination/$(basename "$mv_source")" "$mv_owner"
        else
          owner_marker "$mv_destination" "$mv_owner"
        fi
      fi
    fi
    exec /usr/bin/mv "${mv_arguments[@]}"
    ;;
  chown)
    record "chown $*"
    chown_owner=
    chown_targets=()
    for argument in "$@"; do
      case "$argument" in
        -*) ;;
        *:*) [ -n "$chown_owner" ] || chown_owner="$argument" ;;
        *) chown_targets+=("$argument") ;;
      esac
    done
    if [ -n "$chown_owner" ]; then
      for chown_target in "${chown_targets[@]}"; do owner_marker "$chown_target" "$chown_owner"; done
    fi
    ;;
  useradd)
    record "useradd $*"
    account=
    account_home_value=
    account_shell_value=/usr/sbin/nologin
    create_home=0
    user_group=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --create-home|-m) create_home=1; shift ;;
        --user-group|-U) user_group=1; shift ;;
        --shell) account_shell_value="$2"; shift 2 ;;
        --home-dir|-d) account_home_value="$2"; shift 2 ;;
        --system) shift ;;
        -*) shift ;;
        *) account="$1"; shift ;;
      esac
    done
    [ -n "$account" ] || { printf 'useradd: no account name\n' >&2; exit 2; }
    if account_exists "$account"; then printf 'useradd: %s exists\n' "$account" >&2; exit 9; fi
    [ -n "$account_home_value" ] || account_home_value="$home_root/$account"
    if [ "$create_home" = 1 ]; then mkdir -p "$account_home_value"; fi
    if [ "$user_group" = 1 ]; then mkdir -p "$state/groups"; printf '%s\n' "$account" > "$state/groups/$account"; fi
    mkdir -p "$state/accounts"
    printf '%s|%s\n' "$account_home_value" "$account_shell_value" > "$state/accounts/$account"
    ;;
  userdel)
    record "userdel $*"
    account=
    for argument in "$@"; do
      case "$argument" in -*) ;; *) account="$argument" ;; esac
    done
    if ! account_exists "$account"; then printf 'userdel: %s does not exist\n' "$account" >&2; exit 6; fi
    account_home_value="$(account_home "$account")"
    rm -f "$state/accounts/$account" "$state/groups/$account" "$state/sudo-grant/$account" "$state/linger/$account"
    case "$account_home_value" in
      "$home_root"/*) rm -rf "$account_home_value" ;;
    esac
    ;;
  getent)
    case "${1:-}" in
      passwd)
        if [ -f "$state/nss-fail/passwd/${2:-}" ]; then exit 1; fi
        if account_exists "${2:-}"; then
          printf '%s:x:%s:%s::%s:%s\n' "$2" "$(account_uid "$2")" "$(account_uid "$2")" "$(account_home "$2")" "$(account_shell "$2")"
        else
          # Never fall back to the host's NSS: an unknown account is simply absent,
          # and a wedged name service cannot make the suite hang.
          exit 2
        fi
        ;;
      shadow)
        if [ -f "$state/nss-fail/shadow/${2:-}" ]; then exit 1; fi
        if account_exists "${2:-}"; then
          if [ -f "$state/unlocked/${2:-}" ]; then
            printf '%s:%s:19000:0:99999:7:::\n' "$2" '$6$fixture$synthetic'
          else
            printf '%s:!:19000:0:99999:7:::\n' "$2"
          fi
        else
          exit 2
        fi
        ;;
      group)
        if [ -f "$state/nss-fail/group/${2:-}" ]; then exit 1; fi
        case "${2:-}" in
          ''|*[!0-9]*) ;;
          *)
            # Numeric gid: resolve to the same-name group of the account that owns
            # it, so the courier can cross-check id -nG against the primary group.
            for candidate in "$state"/accounts/*; do
              [ -f "$candidate" ] || continue
              account_name="$(basename "$candidate")"
              if [ "$(account_uid "$account_name")" = "${2:-}" ]; then
                printf '%s:x:%s:\n' "$account_name" "${2:-}"
                exit 0
              fi
            done
            exit 2
            ;;
        esac
        if [ -f "$state/no-group/${2:-}" ]; then
          # getent's own convention for "key not found".
          exit 2
        fi
        if [ -f "$state/groups/${2:-}" ] || account_exists "${2:-}"; then
          printf '%s:x:1234:\n' "$2"
        else
          # Groups are never resolved against the host: a group that exists on
          # the machine running the tests must not decide the fixture outcome.
          exit 2
        fi
        ;;
      *)
        for candidate in /usr/bin/getent /bin/getent; do
          if [ -x "$candidate" ]; then exec "$candidate" "$@"; fi
        done
        exit 1
        ;;
    esac
    ;;
  loginctl)
    case "${1:-}" in
      show-user)
        if [ -f "$state/linger/${2:-}" ]; then printf 'Linger=yes\n'; else printf 'Linger=no\n'; fi
        ;;
      enable-linger)
        mkdir -p "$state/linger"
        : > "$state/linger/${2:-}"
        record "loginctl-enable-linger ${2:-}"
        ;;
      disable-linger)
        rm -f "$state/linger/${2:-}"
        record "loginctl-disable-linger ${2:-}"
        ;;
    esac
    ;;
  sudo)
    # Only the read-only privilege listing the courier performs is modelled.
    # Anything else is a real elevation attempt and must fail here.
    listing=0
    account=
    previous=
    for argument in "$@"; do
      if [ "$previous" = "-U" ]; then account="$argument"; fi
      case "$argument" in -l) listing=1 ;; esac
      previous="$argument"
    done
    if [ "$listing" = 1 ] && [ -n "$account" ]; then
      if [ -f "$state/sudo-grant/$account" ]; then
        printf 'User %s may run the following commands on fixture:\n    (root) NOPASSWD: ALL\n' "$account"
      else
        printf 'User %s is not allowed to run sudo on fixture.\n' "$account"
      fi
    elif [ "${1:-}" = "-iu" ]; then
      record "sudo $*"
      [ -n "${2:-}" ] || exit 1
      shift 2
      exec "$@"
    else
      record "sudo $*"
      printf 'sudo: a password is required\n' >&2
      exit 1
    fi
    ;;
  python3)
    # The courier parses the installer's recorded ops account with python3, so the
    # stub must produce real output rather than a recorded no-op.
    # Read-only parsing helper: not recorded, so a zero-delta run stays byte- and
    # journal-identical to the run that installed the lane.
    for candidate in /usr/bin/python3 /bin/python3; do
      if [ -x "$candidate" ]; then exec "$candidate" "$@"; fi
    done
    exit 1
    ;;
  usermod|passwd|visudo) record "$name $*" ;;
  *) record "unexpected-command $name"; exit 7 ;;
esac
exit 0
