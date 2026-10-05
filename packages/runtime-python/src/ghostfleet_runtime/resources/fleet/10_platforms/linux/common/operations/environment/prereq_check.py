#!/usr/bin/env python3
"""Read-only managed-Linux host prerequisite checker.

Consumes ``host-prerequisites.yaml`` and reports, per requested group, whether
each declared prerequisite is currently satisfied. It performs no host mutation,
installs nothing, and asserts nothing about a host it did not probe.

Exit codes
----------
0   every *required* prerequisite of the requested groups is satisfied
3   at least one required prerequisite is unsatisfied (plan is actionable)
64  usage error
66  prerequisite manifest missing or malformed

The probe is injectable so the deterministic test suite can exercise every
branch without depending on the host it runs on.
"""

from __future__ import annotations

import argparse
import json
import shutil
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    import yaml
except ImportError:  # pragma: no cover - PyYAML is a declared dependency
    yaml = None  # type: ignore[assignment]

MANIFEST_NAME = "host-prerequisites.yaml"
MANIFEST_KIND = "FLEET_LINUX_HOST_PREREQUISITES"
SUPPORTED_SCHEMA_VERSIONS = ("1.0.0",)

EXIT_OK = 0
EXIT_MISSING = 3
EXIT_USAGE = 64
EXIT_NO_MANIFEST = 66

PRESENT = "PRESENT"
ABSENT = "ABSENT"
UNKNOWN = "UNKNOWN"

PROBE_TYPES = ("command", "any_command", "path")

IS_LINUX = sys.platform.startswith("linux")


class PrerequisiteError(RuntimeError):
    def __init__(self, code: int, detail: str = "") -> None:
        self.code = code
        super().__init__(f"{code}: {detail}" if detail else str(code))


@dataclass(frozen=True)
class Prerequisite:
    identifier: str
    kind: str
    required: bool
    required_by: tuple[str, ...]
    installable_by_repo: bool
    probe: dict[str, Any]
    note: str | None


@dataclass(frozen=True)
class Result:
    identifier: str
    state: str
    required: bool
    required_by: tuple[str, ...]
    installable_by_repo: bool
    detail: str
    note: str | None


Probe = Callable[[dict[str, Any]], tuple[str, str]]


def manifest_path(base: Path | None = None) -> Path:
    root = Path(base) if base else Path(__file__).resolve().parent
    return root / MANIFEST_NAME


def load_manifest(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise PrerequisiteError(EXIT_NO_MANIFEST, "PyYAML unavailable")
    if not path.is_file():
        raise PrerequisiteError(EXIT_NO_MANIFEST, f"manifest not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise PrerequisiteError(EXIT_NO_MANIFEST, "manifest must be a mapping")
    if data.get("kind") != MANIFEST_KIND:
        raise PrerequisiteError(EXIT_NO_MANIFEST, f"unexpected kind: {data.get('kind')!r}")
    if data.get("schema_version") not in SUPPORTED_SCHEMA_VERSIONS:
        raise PrerequisiteError(
            EXIT_NO_MANIFEST, f"unsupported schema_version: {data.get('schema_version')!r}"
        )
    return data


def _validate(data: dict[str, Any]) -> None:
    groups = data.get("groups")
    if not isinstance(groups, dict) or not groups:
        raise PrerequisiteError(EXIT_NO_MANIFEST, "groups must be a non-empty mapping")
    entries = data.get("prerequisites")
    if not isinstance(entries, list) or not entries:
        raise PrerequisiteError(EXIT_NO_MANIFEST, "prerequisites must be a non-empty list")
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise PrerequisiteError(EXIT_NO_MANIFEST, "each prerequisite must be a mapping")
        identifier = entry.get("id")
        if not isinstance(identifier, str) or not identifier:
            raise PrerequisiteError(EXIT_NO_MANIFEST, "prerequisite id is required")
        if identifier in seen:
            raise PrerequisiteError(EXIT_NO_MANIFEST, f"duplicate prerequisite id: {identifier}")
        seen.add(identifier)
        if entry.get("kind") not in ("command", "path"):
            raise PrerequisiteError(EXIT_NO_MANIFEST, f"{identifier}: unsupported kind")
        probe = entry.get("probe")
        if not isinstance(probe, dict) or probe.get("type") not in PROBE_TYPES:
            raise PrerequisiteError(EXIT_NO_MANIFEST, f"{identifier}: unsupported probe")
        targets = entry.get("required_by")
        if not isinstance(targets, list) or not targets:
            raise PrerequisiteError(EXIT_NO_MANIFEST, f"{identifier}: required_by is required")
        for group in targets:
            if group not in groups:
                raise PrerequisiteError(EXIT_NO_MANIFEST, f"{identifier}: unknown group {group!r}")
        if not isinstance(entry.get("required"), bool):
            raise PrerequisiteError(EXIT_NO_MANIFEST, f"{identifier}: required must be a boolean")
        if not isinstance(entry.get("installable_by_repo"), bool):
            raise PrerequisiteError(
                EXIT_NO_MANIFEST, f"{identifier}: installable_by_repo must be a boolean"
            )


def host_probe(spec: dict[str, Any]) -> tuple[str, str]:
    """Default probe against the live host. Read-only by construction.

    A command probe only produces PRESENT on a Linux host. On any other platform
    a PATH hit means something else entirely (``docker.exe`` on Windows is not
    evidence about a managed Linux node), so the answer is UNKNOWN. The checker
    must never report a satisfied prerequisite it did not actually verify.
    """
    kind = spec.get("type")
    if kind in ("command", "any_command"):
        if not IS_LINUX:
            return (UNKNOWN, f"host platform {sys.platform} cannot verify Linux capabilities")
        if kind == "command":
            name = str(spec.get("name", ""))
            return (PRESENT, name) if shutil.which(name) else (ABSENT, name)
        names = [str(item) for item in spec.get("names", [])]
        for name in names:
            if shutil.which(name):
                return (PRESENT, name)
        return (ABSENT, "|".join(names))
    if kind == "path":
        path = str(spec.get("path", ""))
        target = Path(path)
        if spec.get("glob"):
            import glob as globlib

            hits = globlib.glob(path)
            return (PRESENT, path) if hits else (ABSENT, path)
        if not target.exists():
            return (ABSENT, path)
        if spec.get("require_char_device") and not _is_char_device(target):
            return (ABSENT, f"{path} (not a character device)")
        return (PRESENT, path)
    return (UNKNOWN, f"unsupported probe type: {kind!r}")


def _is_char_device(target: Path) -> bool:
    try:
        return stat.S_ISCHR(target.stat().st_mode)
    except OSError:
        return False


def check(
    data: dict[str, Any],
    groups: Iterable[str],
    probe: Probe = host_probe,
) -> list[Result]:
    _validate(data)
    wanted = tuple(groups)
    if not wanted:
        raise PrerequisiteError(EXIT_USAGE, "at least one group is required")
    unknown = [group for group in wanted if group not in data["groups"]]
    if unknown:
        raise PrerequisiteError(EXIT_USAGE, f"unknown group(s): {unknown}")

    results: list[Result] = []
    for entry in data["prerequisites"]:
        targets = tuple(entry["required_by"])
        if not any(group in targets for group in wanted):
            continue
        state, detail = probe(entry["probe"])
        if state not in (PRESENT, ABSENT, UNKNOWN):
            state = UNKNOWN
        results.append(
            Result(
                identifier=entry["id"],
                state=state,
                required=bool(entry["required"]),
                required_by=targets,
                installable_by_repo=bool(entry["installable_by_repo"]),
                detail=detail,
                note=entry.get("note"),
            )
        )
    results.sort(key=lambda item: (not item.required, item.identifier))
    return results


def render_text(results: list[Result], groups: tuple[str, ...]) -> str:
    lines = [f"groups: {', '.join(groups)}", ""]
    width = max((len(item.identifier) for item in results), default=4)
    for item in results:
        flag = "required" if item.required else "optional"
        origin = "repo-installable" if item.installable_by_repo else "operator-provided"
        lines.append(
            f"  {item.state:7s} {item.identifier:<{width}}  [{flag}] [{origin}]  {item.detail}"
        )
        if item.note and item.state != PRESENT:
            lines.append(f"           note: {item.note}")
    missing = [item.identifier for item in results if item.required and item.state != PRESENT]
    unverifiable = [item.identifier for item in results if item.state == UNKNOWN]
    lines.append("")
    if missing:
        lines.append(f"MISSING_REQUIRED={len(missing)} {' '.join(missing)}")
    else:
        lines.append("MISSING_REQUIRED=0")
    if unverifiable:
        lines.append(f"UNVERIFIABLE={len(unverifiable)} {' '.join(unverifiable)}")
    lines.append("READ_ONLY=TRUE HOST_MUTATION=NONE")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="prereq_check.py",
        description="Read-only managed-Linux host prerequisite check.",
    )
    parser.add_argument("--manifest", default=None, help="path to host-prerequisites.yaml")
    parser.add_argument(
        "--group",
        action="append",
        dest="groups",
        help="group to check; repeatable. Omit to check every declared group.",
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    args = parser.parse_args(argv)

    try:
        path = Path(args.manifest) if args.manifest else manifest_path()
        data = load_manifest(path)
        groups = tuple(args.groups) if args.groups else tuple(data["groups"])
        results = check(data, groups)
    except PrerequisiteError as exc:
        print(f"prereq_check: {exc}", file=sys.stderr)
        return exc.code

    if args.json:
        print(
            json.dumps(
                {
                    "groups": list(groups),
                    "read_only": True,
                    "host_mutation": False,
                    "results": [
                        {
                            "id": item.identifier,
                            "state": item.state,
                            "required": item.required,
                            "required_by": list(item.required_by),
                            "installable_by_repo": item.installable_by_repo,
                            "detail": item.detail,
                            "note": item.note,
                        }
                        for item in results
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(render_text(results, groups))

    return EXIT_MISSING if any(item.required and item.state != PRESENT for item in results) else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
