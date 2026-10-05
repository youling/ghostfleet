#!/usr/bin/env python3
"""Opt-in candidate entrypoint; install the pinned Fleet Python package first."""
from ghostfleet_runtime.linux.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
