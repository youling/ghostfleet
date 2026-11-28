#!/usr/bin/env bash
# Optional owner-operated example for disposable Debian tooling targets.
set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C DEBIAN_FRONTEND=noninteractive
unset APT_CONFIG

die() { printf '{"result":"BLOCKED","error":"%s"}\n' "$1"; exit 1; }
[[ $# == 2 && $(id -u) == 0 && $2 =~ ^[a-f0-9]{64}$ ]] || die INVALID_OWNER_INPUT
. /etc/os-release
[[ $ID == debian && $VERSION_ID == 13 && $(dpkg --print-architecture) == amd64 ]] || die UNSUPPORTED_PLATFORM
supply=$(realpath -e -- "$1")
[[ "$supply" == "$1" && -d "$supply" && $(stat -c '%u:%a' "$supply") == 0:700 ]] || die SUPPLY_MUST_BE_ROOT_PRIVATE
directory=$supply
while :; do
    status=$(stat -c '%u:%a' "$directory")
    mode=${status#*:}
    [[ ${status%%:*} == 0 && ! -L "$directory" ]] || die UNSAFE_SUPPLY_PARENT
    if (( (8#$mode & 022) != 0 )); then
        [[ "$directory" == /var/tmp || "$directory" == /tmp ]] && (( (8#$mode & 01000) != 0 )) || die UNSAFE_SUPPLY_PARENT
    fi
    [[ "$directory" != / ]] || break
    directory=$(dirname -- "$directory")
done
cd "$supply"
[[ -f SHA256SUMS && ! -L SHA256SUMS ]] || die MISSING_MANIFEST
actual=$(sha256sum SHA256SUMS)
[[ ${actual%% *} == "$2" ]] || die MANIFEST_NOT_APPROVED
sha256sum --check --strict --status SHA256SUMS || die SUPPLY_DIGEST_MISMATCH

package_changed=0
node_ts_changed=0
prefix=/opt/ghostfleet-lab-toolchain
node_archives=(npm/node-linux-x64-*.tgz)
typescript_archives=(npm/typescript-*.tgz)
[[ ${#node_archives[@]} == 1 && ${#typescript_archives[@]} == 1 ]] || die INVALID_NPM_SUPPLY
node_archive=${node_archives[0]}
typescript_archive=${typescript_archives[0]}
[[ -f "$node_archive" && -f "$typescript_archive" ]] || die MISSING_NPM_ARCHIVE
node_version=${node_archive#npm/node-linux-x64-}
node_version=${node_version%.tgz}
typescript_version=${typescript_archive#npm/typescript-}
typescript_version=${typescript_version%.tgz}
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$typescript_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die INVALID_NPM_VERSION
sources=$(sha256sum "$node_archive" "$typescript_archive")

verify_npm() {
    local dest=$1
    [[ $(stat -c '%u:%a' "$dest") == 0:755 && ! -L "$dest" && $(<"$dest/.sources") == "$sources" ]] &&
        (cd "$dest" && sha256sum --check --strict --status .installed.sha256) &&
        [[ $("$dest/bin/node" --version) == "v$node_version" && $("$dest/bin/tsc" --version) == "Version $typescript_version" ]]
}

[[ -d /run/ghostfleet-lab-toolchain ]] || install -d -m0700 /run/ghostfleet-lab-toolchain
exec 9>>/run/ghostfleet-lab-toolchain/restore.lock
flock -x 9
if [[ -e "$prefix" || -L "$prefix" ]]; then
    verify_npm "$prefix" || die NPM_INSTALL_CONFLICT
else
    node_ts_changed=1
fi

declare -A versions=()
pending=()
while IFS=$'\t' read -r name version archive; do
    [[ "$name" =~ ^[a-z0-9][a-z0-9.+-]+$ && "$version" =~ ^[a-zA-Z0-9:.+~_-]+$ &&
       "$archive" =~ ^apt/[[:alnum:]_.+%~-]+\.deb$ && -f "$archive" && ! -L "$archive" && ! -v "versions[$name]" ]] || die INVALID_PACKAGE_ENTRY
    [[ $(dpkg-deb -f "$archive" Package) == "$name" && $(dpkg-deb -f "$archive" Version) == "$version" ]] || die PACKAGE_IDENTITY_MISMATCH
    versions[$name]=$version
    if [[ $(dpkg-query -W -f='${db:Status-Status}:${Version}' "$name" 2>/dev/null || :) != "installed:$version" ]]; then
        pending+=("$supply/$archive")
    fi
done < packages.tsv
for name in binutils git python3 python3.13 python3-venv rustc; do
    [[ -v "versions[$name]" ]] || die INCOMPLETE_TOOLCHAIN
done

if ((${#pending[@]})); then
    [[ -f baseline.status.sha256 && ! -L baseline.status.sha256 ]] || die MISSING_BASELINE_PIN
    baseline=$(<baseline.status.sha256)
    [[ "$baseline" =~ ^[a-f0-9]{64}$ ]] || die BAD_BASELINE_PIN
    audit=$(dpkg --audit 2>&1) || die DPKG_AUDIT_FAILED
    [[ -z "$audit" ]] || die DPKG_BASELINE_DIRTY
    current=$(sha256sum /var/lib/dpkg/status)
    [[ ${current%% *} == "$baseline" ]] || die CLEAN_BASELINE_MISMATCH
    empty=/run/ghostfleet-lab-toolchain/empty-apt
    [[ -d "$empty" ]] || install -d -m0700 "$empty"
    [[ -z $(find "$empty" -mindepth 1 -print -quit) ]] || die APT_OFFLINE_DIRECTORY_NOT_EMPTY
    offline=( -o Dir::Etc::sourcelist=/dev/null -o "Dir::Etc::sourceparts=$empty" -o "Dir::State::lists=$empty"
              -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= )
    plan=$(apt-get "${offline[@]}" --simulate --no-install-recommends --no-remove install "${pending[@]}") || die APT_PLAN_FAILED
    awk -F '\t' 'NR == FNR { planned[$1] = $2; next }
        /^Remv / { exit 1 }
        /^(Inst|Conf) / {
            split($0, fields, / +/)
            version = fields[3] ~ /^\[/ ? fields[4] : fields[3]
            sub(/^\(/, "", version)
            if (!(fields[2] in planned) || planned[fields[2]] != version) exit 1
        }' packages.tsv - <<< "$plan" || die UNAPPROVED_APT_PLAN
    current=$(sha256sum /var/lib/dpkg/status)
    [[ ${current%% *} == "$baseline" ]] || die CLEAN_BASELINE_CHANGED_DURING_PLAN
    apt-get "${offline[@]}" --yes --no-install-recommends --no-remove install "${pending[@]}" >&2 || die APT_APPLY_FAILED
    package_changed=${#pending[@]}
fi
for name in "${!versions[@]}"; do
    [[ $(dpkg-query -W -f='${db:Status-Status}:${Version}' "$name") == "installed:${versions[$name]}" ]] || die APT_READBACK_MISMATCH
done

if ((node_ts_changed)); then
    stage=$(mktemp -d /opt/.ghostfleet-lab-toolchain.XXXXXXXX)
    trap 'rm -rf -- "$stage"' EXIT
    install -d -m0755 "$stage/bin" "$stage/typescript"
    tar -xf "$node_archive" --no-same-owner -C "$stage/bin" --strip-components=2 package/bin/node
    tar -xf "$typescript_archive" --no-same-owner -C "$stage/typescript" --strip-components=1
    cat > "$stage/bin/tsc" <<'TS'
#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/bin/node" "$root/typescript/lib/tsc.js" "$@"
TS
    chmod 0755 "$stage" "$stage/bin/node" "$stage/bin/tsc"
    printf '%s\n' "$sources" > "$stage/.sources"
    (cd "$stage" && find bin typescript -type f -print0 | sort -z | xargs -0 sha256sum > .installed.sha256)
    verify_npm "$stage" || die NPM_READBACK_MISMATCH
    mv -T -- "$stage" "$prefix"
    trap - EXIT
fi

result=UNCHANGED
if ((package_changed || node_ts_changed)); then result=APPLIED; fi
printf '{"result":"%s","apt_packages_changed":%s,"node_typescript_changed":%s,"manifest_sha256":"%s"}\n' \
    "$result" "$package_changed" "$node_ts_changed" "$2"
