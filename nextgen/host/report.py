#!/usr/bin/env python3
"""Resolve the activated slot once and run the immutable reporter entry point."""
import argparse
import os
from pathlib import Path
import re
import sys

ROOT = Path("/var/lib/ghostfleet-nextgen/software")
SLOT = re.compile(r"[a-z0-9.+~]+_[a-f0-9]{64}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--release-root", type=Path, default=ROOT)
    parser.add_argument("--allow-local-fixture", action="store_true")
    args = parser.parse_args()
    try:
        root = args.release_root.resolve(strict=True)
        slot = (root / "current").resolve(strict=True)
        if slot.parent != root / "releases" or not SLOT.fullmatch(slot.name):
            raise ValueError
        reporter = slot / "node.py"
        if reporter.is_symlink() or not reporter.is_file():
            raise ValueError
        options = ["--allow-local-fixture"] if args.allow_local_fixture else []
        os.execv(sys.executable, [sys.executable, "-I", str(reporter), *options, "report",
                                 "--identity", str(args.identity), "--release-root", str(root)])
    except (OSError, ValueError):
        print("ACTIVE_REPORTER_UNAVAILABLE", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
