"""Explicit candidate entrypoint; legacy bootstrap never invokes this implicitly."""
from __future__ import annotations
import argparse
import json
import os
import sys

from ghostfleet_runtime.control.enrollment_attempt import AttemptError
from .converger import Converger
from .system import LinuxSystem


def main(argv=None):
    parser = argparse.ArgumentParser(description="Candidate Fleet Linux primary converger (no lifecycle promotion)")
    parser.add_argument("--config", required=True, help="Absolute root-owned private projection/config JSON")
    parser.add_argument("--apply", action="store_true", help="Explicitly apply only the observed bounded primary delta")
    args = parser.parse_args(argv)
    try:
        if sys.platform != "linux" or os.geteuid() != 0:
            raise AttemptError("LINUX_ROOT_REQUIRED")
        system = LinuxSystem()
        config = system.read_json(args.config, secret=True)
        engine = Converger(system, config)
        if args.apply:
            result = engine.run()
        else:
            # Plan is read-only and incomplete when the daemon cannot be read;
            # it does not assert proof/acceptance or open an attempt session.
            result = {"outcome": "PLAN_ONLY_NOT_VERIFIED", "plan": engine.plan_readonly()}
        print(json.dumps(result, sort_keys=True))
        return 0
    except AttemptError as exc:
        print(json.dumps({"outcome": "RECONCILE_REQUIRED", "reason": exc.code}), file=sys.stderr)
        return 2
    except Exception:
        # Never expose a private config, response, credential or exception text.
        print('{"outcome":"RECONCILE_REQUIRED","reason":"LOCAL_OUTCOME_UNKNOWN"}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
