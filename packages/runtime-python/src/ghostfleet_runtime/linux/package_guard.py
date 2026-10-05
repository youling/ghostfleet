"""APT v1 Pre-Install-Pkgs guard, run before dpkg with APT's transaction lock.

No install/upgrade occurs here. Exact missing archives only; all provider and
family-independent convergence decisions remain outside this hook.
"""
from __future__ import annotations
import re
import sys

from .system import CommandRunner, ConvergeError, DebianFamily


def check_archives(expected, raw, runner):
    if (not expected or len(raw) > 65536 or any(not re.fullmatch(r"[a-z0-9+.-]+", k)
            or not re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]{0,127}", v) for k, v in expected.items())):
        raise ConvergeError("PACKAGE_GUARD_INPUT_INVALID")
    code, audit = runner.run(["/usr/bin/dpkg", "--audit"])
    if code or audit.strip():
        raise ConvergeError("PACKAGE_DATABASE_NOT_CLEAN")
    archives = raw.splitlines()
    if len(archives) > len(expected):
        raise ConvergeError("PACKAGE_COLLATERAL_DELTA")
    found = set()
    for archive in archives:
        if not archive.startswith("/") or any(ord(c) < 32 for c in archive):
            raise ConvergeError("PACKAGE_ARCHIVE_INVALID")
        code, metadata = runner.run(["/usr/bin/dpkg-deb", "--show", "--showformat=${Package}\t${Version}", archive])
        fields = metadata.split("\t")
        if code or len(fields) != 2 or expected.get(fields[0]) != fields[1].strip() or fields[0] in found:
            raise ConvergeError("PACKAGE_COLLATERAL_DELTA")
        if DebianFamily(runner).package(fields[0]) is not None:
            raise ConvergeError("PACKAGE_UPGRADE_FORBIDDEN")
        found.add(fields[0])
    if archives and found != set(expected):
        raise ConvergeError("PACKAGE_ARCHIVE_SET_CHANGED")


def main(argv=None):
    try:
        args = sys.argv[1:] if argv is None else argv
        expected = dict(item.split("=", 1) for item in args)
        if len(expected) != len(args):
            raise ConvergeError("PACKAGE_GUARD_INPUT_INVALID")
        check_archives(expected, sys.stdin.read(65537), CommandRunner())
        return 0
    except ConvergeError as exc:
        print(exc.code, file=sys.stderr)
    except Exception:
        print("PACKAGE_GUARD_UNKNOWN", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
