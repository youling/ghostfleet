#!/bin/sh
# Local HTTPS, real curl/wget and Panel-command regressions; no root required.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sh -n "$repo_dir/scripts/join.sh"
exec python3 "$repo_dir/test/test_join_bootstrap.py"
