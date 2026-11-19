#!/usr/bin/env python3
"""Read-only OMV8 local Phase 0 facts. NOT an enrollment or install entry point."""
from __future__ import annotations

import argparse
import grp
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = "ghostfleet-omv8-phase0-readonly/v1"

def read_text(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as stream:
            data = stream.read(32769)
            # Truncated mountinfo/mdstat must fail closed, never look complete.
            return data if len(data) <= 32768 else None
    except (OSError, UnicodeError):
        return None

def os_release(data: str | None) -> dict[str, str]:
    result = {}
    for line in (data or "").splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if match:
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            result[match.group(1)] = value
    return result

def readonly_command(argv: tuple[str, ...]) -> tuple[int, str]:
    """Fixed read-only commands only; no shell, network, writes or raw stderr."""
    if argv[0] == "/usr/bin/dpkg-query":
        if argv[1:] != ("-W", "-f=${Version}", "openmediavault"):
            raise ValueError("DPKG_QUERY_NOT_ALLOWLISTED")
    elif argv[0] == "/usr/bin/systemctl":
        if (len(argv) != 6 or argv[1:4] != ("show", "--no-pager", "-p")
                or argv[4] not in ("LoadState", "ActiveState")
                or argv[5] not in ("ssh.service", "tailscaled.service", "docker.service")):
            raise ValueError("SYSTEMCTL_QUERY_NOT_ALLOWLISTED")
    else:
        raise ValueError("COMMAND_NOT_ALLOWLISTED")
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, check=False,
                              timeout=4, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"})
        return proc.returncode, proc.stdout[:1024]
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""

def unit_state(name: str, field: str = "LoadState") -> str:
    code, out = readonly_command(("/usr/bin/systemctl", "show", "--no-pager",
                                  "-p", field, name))
    values = ("loaded", "not-found", "masked", "error") if field == "LoadState" else (
        "active", "inactive", "failed", "activating", "deactivating"
    )
    match = re.search(r"^" + re.escape(field) + r"=(" + "|".join(values) + r")\s*$", out, re.M)
    return match.group(1) if code == 0 and match else "unknown"


def docker_group_size() -> int | None:
    try:
        return len(grp.getgrnam("docker").gr_mem)
    except KeyError:
        return 0
    except OSError:
        return None

def collect() -> dict[str, object]:
    """Local bounded read-only collection; reports no hostpaths, data or secrets."""
    osdata = os_release(read_text("/etc/os-release"))
    rc, pkg = readonly_command(("/usr/bin/dpkg-query", "-W", "-f=${Version}",
                                "openmediavault"))
    mdstat = read_text("/proc/mdstat")
    mountinfo = read_text("/proc/self/mountinfo")
    return {
        "os_id": osdata.get("ID", "unknown"),
        "os_version": osdata.get("VERSION_ID", "unknown"),
        "omv_version": pkg.strip() if rc == 0 else None,
        "omv_marker": Path("/etc/openmediavault/config.xml").is_file(),
        "systemd_pid1": (read_text("/proc/1/comm") or "").strip() == "systemd",
        "systemd_runtime": Path("/run/systemd/system").is_dir(),
        "root_euid": os.geteuid() == 0,
        "ssh_unit": unit_state("ssh.service"),
        "ssh_active": unit_state("ssh.service", "ActiveState"),
        "tailscaled_unit": unit_state("tailscaled.service"),
        "tailscaled_active": unit_state("tailscaled.service", "ActiveState"),
        "docker_unit": unit_state("docker.service"),
        "docker_active": unit_state("docker.service", "ActiveState"),
        "sudo_available": Path("/usr/bin/sudo").is_file(),
        "su_available": Path("/usr/bin/su").is_file(),
        "docker_group_members": docker_group_size(),
        "docker_socket": Path("/run/docker.sock").exists() or Path("/var/run/docker.sock").exists(),
        "mount_count": len(mountinfo.splitlines()) if mountinfo is not None else None,
        "mdstat_available": mdstat is not None,
        "md_arrays_active": bool(re.search(r"(?m)^md[0-9]+\s*:\s*active", mdstat or "")),
    }

def assess(facts: dict[str, object]) -> dict[str, object]:
    """Pure classification. No path from this function authorizes mutation."""
    failures = []
    if facts.get("os_id") != "debian" or facts.get("os_version") != "13":
        failures.append("DEBIAN_13_NOT_PROVEN")
    version = facts.get("omv_version")
    if not isinstance(version, str) or not re.match(r"^8(?:[.+~:-]|$)", version):
        failures.append("OMV8_PACKAGE_NOT_PROVEN")
    if facts.get("omv_marker") is not True:
        failures.append("OMV_MARKER_MISSING")
    if facts.get("systemd_pid1") is not True or facts.get("systemd_runtime") is not True:
        failures.append("SYSTEMD_NOT_PROVEN")
    if facts.get("root_euid") is not True:
        failures.append("LOCAL_ROOT_CEREMONY_NOT_PROVEN")
    if facts.get("mount_count") is None or facts.get("mdstat_available") is not True:
        failures.append("STORAGE_FACTS_UNAVAILABLE")
    for unit in ("ssh_unit", "tailscaled_unit", "docker_unit"):
        if facts.get(unit) == "unknown":
            failures.append("UNIT_STATE_UNAVAILABLE_" + unit.upper())
        active = unit.replace("_unit", "_active")
        if facts.get(unit) == "loaded" and facts.get(active, "unknown") == "unknown":
            failures.append("UNIT_ACTIVE_STATE_UNAVAILABLE_" + active.upper())

    hints = []
    if facts.get("docker_socket") is True:
        hints.append("DOCKER_SOCKET_PRESENT_DO_NOT_ATTACH")
    if facts.get("md_arrays_active") is True:
        hints.append("MD_RAID_ACTIVE_DO_NOT_TOUCH")
    if facts.get("ssh_unit") != "loaded":
        hints.append("SSH_REQUIRES_OWNER_REVIEW")
    if facts.get("tailscaled_unit") != "loaded":
        hints.append("TAILSCALE_NOT_YET_CONFIGURED")
    if facts.get("docker_unit") == "loaded":
        hints.append("DOCKER_WORKLOAD_MAY_BE_PRESENT")
    if facts.get("docker_group_members") is None or facts.get("docker_group_members", 0) > 0:
        hints.append("DOCKER_GROUP_MEMBERSHIP_REQUIRES_REVIEW")
    if facts.get("ssh_unit") == "loaded" and facts.get("ssh_active") != "active":
        hints.append("SSH_SERVICE_NOT_ACTIVE")
    if facts.get("sudo_available") is not True and facts.get("su_available") is not True:
        hints.append("NO_SUDO_OR_SU_TOOL")

    return {
        "schema": SCHEMA,
        "compatibility": "BLOCKED" if failures else "FACTS_READY",
        "blockers": sorted(failures),
        "safety_hints": sorted(hints),
        "service_status": {k: {"load": facts.get(k + "_unit", "unknown"),
                               "active": facts.get(k + "_active", "unknown")}
                           for k in ("ssh", "tailscaled", "docker")},
        "privilege_tools": {"sudo_available": facts.get("sudo_available") is True,
                            "su_available": facts.get("su_available") is True},
        "storage": {"mount_count": facts.get("mount_count"),
                    "mdstat_readable": facts.get("mdstat_available") is True,
                    "active_md_raid_detected": facts.get("md_arrays_active") is True},
        "owner_storage_attestation": "NOT_PERFORMED",
        "root_ceremony_authorization": "NOT_ASSERTED",
        "bootstrap_phase0_wired": False,
        "installation_permitted": False,
        "jit_helper_in_scope": False,
    }

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only OMV8 Phase 0; never installs")
    parser.add_argument("--check", action="store_true", required=True)
    parser.parse_args(argv)
    report = assess(collect())
    print(json.dumps(report, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
    # A standalone facts tool never turns a NAS into an authorized target.
    return 4 if report["compatibility"] == "BLOCKED" else 3

if __name__ == "__main__":
    sys.exit(main())
