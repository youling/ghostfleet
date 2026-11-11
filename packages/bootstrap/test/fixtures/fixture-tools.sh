#!/usr/bin/env bash
# Synthetic fixture for the published bootstrap courier. Every command here
# replaces one privileged host tool so the real courier script can run the whole
# first-root ceremony without root, a provider, or a network.
set -u
name="$(basename "$0")"
state="${FIXTURE_STATE:?FIXTURE_STATE is required}"
record() { printf '%s\n' "$*" >> "$state/calls.log"; }

case "$name" in
  id)
    case "${1:-}" in
      -u)
        if [ -n "${2:-}" ]; then printf '1234\n'; else printf '0\n'; fi
        ;;
      -nG) printf 'users\n' ;;
      *)
        [ "${1:-}" = ghostfleet-ops ] && exit 0
        exit 1
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
        printf '%s' "$FIXTURE_NODE_ID" > "$state/tailscale.hostname"
        : > "$state/tailscale.joined"
        ;;
      *) record "tailscale-unexpected $*"; exit 9 ;;
    esac
    ;;
  systemctl) record "systemctl $*" ;;
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
    url=
    for argument in "$@"; do
      case "$argument" in http*) url="$argument" ;; esac
    done
    case "$url" in
      */v1/enroll/claim)
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
  getent)
    case "${1:-}" in
      passwd) [ "${2:-}" = ghostfleet-ops ] && printf 'ghostfleet-ops:x:1234:1234::%s:/bin/sh\n' "${FIXTURE_ACCOUNT_HOME:-/nonexistent}" ;;
      group) exit 0 ;;
    esac
    ;;
  loginctl)
    case "${1:-}" in
      show-user)
        if [ -f "$state/linger" ]; then printf 'Linger=yes\n'; else printf 'Linger=no\n'; fi
        ;;
      enable-linger)
        : > "$state/linger"
        record "loginctl-enable-linger ${2:-}"
        ;;
    esac
    ;;
  useradd|usermod|passwd|visudo|sudo|python3) record "$name $*" ;;
  *) record "unexpected-command $name"; exit 7 ;;
esac
exit 0
