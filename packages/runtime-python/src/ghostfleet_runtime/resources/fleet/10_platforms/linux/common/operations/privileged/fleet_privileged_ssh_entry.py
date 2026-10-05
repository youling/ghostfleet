#!/usr/bin/python3 -I
"""Forced-command entrypoint for the dedicated Fleet privileged SSH principal."""
from __future__ import annotations

import os
import subprocess
import sys

MAX_REQUEST_BYTES = 32768
HELPER = "/usr/local/libexec/youling-fleet/fleet-privctl"
SUDO = "/usr/bin/sudo"


def main() -> int:
    if len(sys.argv) != 1:
        print("PRIVILEGED_ENTRY_ARGUMENTS_FORBIDDEN", file=sys.stderr)
        return 64
    if os.environ.get("SSH_ORIGINAL_COMMAND", ""):
        print("PRIVILEGED_ENTRY_ORIGINAL_COMMAND_FORBIDDEN", file=sys.stderr)
        return 64

    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not raw:
        print("PRIVILEGED_ENTRY_REQUEST_EMPTY", file=sys.stderr)
        return 64
    if len(raw) > MAX_REQUEST_BYTES:
        print("PRIVILEGED_ENTRY_REQUEST_TOO_LARGE", file=sys.stderr)
        return 64

    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
    try:
        completed = subprocess.run(
            [SUDO, "-n", "--", HELPER],
            input=raw,
            stdout=sys.stdout.buffer,
            stderr=sys.stderr.buffer,
            env=env,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        print("PRIVILEGED_ENTRY_HELPER_FAILED", file=sys.stderr)
        return 70
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
