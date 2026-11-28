#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
export GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool=/opt/ghostfleet-lab-toolchain/bin
[[ $(id -u) != 0 && $(findmnt -n -o FSTYPE -T "$root/out") == ext4 ]]

[[ $("$tool/node" --version) == v22.23.5 ]]
[[ $("$tool/tsc" --version) == 'Version 5.9.3' ]]
[[ $(python3 --version) == 'Python 3.13.5' ]]
[[ $(rustc --version) == 'rustc 1.85.1 '* ]]
[[ $(git --version) == 'git version 2.47.3' ]]
readelf_version=$(readelf --version)
[[ ${readelf_version%%$'\n'*} == 'GNU readelf (GNU Binutils for Debian) 2.44' ]]

versions='platform=debian13-amd64 node=22.23.5 typescript=5.9.3 python=3.13.5 rustc=1.85.1 git=2.47.3 readelf=2.44'
if [[ $# == 1 && $1 == --versions ]]; then
    printf 'F02_VERSIONS_PASS %s\n' "$versions"
    exit 0
fi
[[ $# == 0 ]]
scratch=$(mktemp -d "$root/out/run.XXXXXXXX")

"$tool/tsc" --strict --target ES2022 --module CommonJS --outDir "$scratch" "$root/sample.ts"
"$tool/node" "$scratch/sample.js" > "$scratch/node.out"
python3 -m venv "$scratch/venv"
"$scratch/venv/bin/python" -I "$root/sample.py" > "$scratch/python.out"
rustc --emit=obj -C panic=abort -C opt-level=2 -C relocation-model=static -o "$scratch/sample.o" "$root/sample.rs"
ld --build-id=none --no-dynamic-linker -z noexecstack -e _start "$scratch/sample.o" -o "$scratch/sample-elf"
"$scratch/sample-elf" > "$scratch/rust.out"
readelf -h -W -l "$scratch/sample-elf" > "$scratch/elf.txt"
readelf -d "$scratch/sample-elf" >> "$scratch/elf.txt"
grep -Fq 'ELF64' "$scratch/elf.txt"
grep -Fq 'Advanced Micro Devices X86-64' "$scratch/elf.txt"
if grep -Eq 'INTERP|\(NEEDED\)' "$scratch/elf.txt"; then
    echo 'Expected a standalone ELF' >&2
    exit 1
fi
cmp "$scratch/node.out" "$scratch/python.out"
cmp "$scratch/python.out" "$scratch/rust.out"
printf '%s\n' 'GhostFleet fixture 42' | cmp - "$scratch/rust.out"

git -c init.defaultBranch=main -C "$scratch" init --quiet
object=$(git -C "$scratch" hash-object -w "$root/in/sample.txt")
git -C "$scratch" cat-file blob "$object" > "$scratch/exchange.out"
cmp "$root/in/sample.txt" "$scratch/exchange.out"
[[ ! -w "$root/in" && ! -w "$root/in/sample.txt" ]]
sha256sum "$scratch/sample.js" "$scratch/sample-elf" "$scratch/node.out" "$scratch/exchange.out" |
    sed -e "s#  $scratch/#  #"
printf 'F02_RUNTIME_PASS %s exchange=byte_exact\n' "$versions"
