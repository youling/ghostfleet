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
account_exists() { [ -f "$state/accounts/$1" ]; }
account_home() { cut -d'|' -f1 "$state/accounts/$1"; }
account_shell() { cut -d'|' -f2 "$state/accounts/$1"; }
account_uid() { if [ -f "$state/uids/$1" ]; then cat "$state/uids/$1"; else printf '1234\n'; fi; }

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
    case "$url" in
      */claim)
        record "curl claim"
        cat "$state/claim.json"
        ;;
      */v1/enroll/complete)
        cat > "$state/complete-body.json"
        record "curl complete"
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
    arguments=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o|-g) shift 2 ;;
        -o*|-g*) shift ;;
        *) arguments+=("$1"); shift ;;
      esac
    done
    exec /usr/bin/install "${arguments[@]}"
    ;;
  chown) record "chown $*" ;;
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
          # Any other account (the operating Human) is resolved for real, so the
          # strict name/uid/shell validation sees a genuine account.
          for candidate in /usr/bin/getent /bin/getent; do
            if [ -x "$candidate" ]; then exec "$candidate" "$@"; fi
          done
          exit 1
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
