#!/usr/bin/env python3
"""Read-only OMV8 local Phase 0 facts. NOT an enrollment or install entry point."""
from __future__ import annotations

import argparse
import grp
import json
import os
import pwd
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = "ghostfleet-omv8-phase0-readonly/v1"
MAX_READ = 32768
UNIT_NAMES = {
    "ssh": "ssh.service",
    "tailscaled": "tailscaled.service",
    "docker": "docker.service",
    "docker_socket": "docker.socket",
    "containerd": "containerd.service",
    "podman_socket": "podman.socket",
    "omv_engine": "openmediavault-engined.service",
    "smbd": "smbd.service",
    "nfs": "nfs-kernel-server.service",
}


def read_text(path: str) -> str | None:
    """Read bounded local text; oversized or unavailable inputs are unknown."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as stream:
            data = stream.read(MAX_READ + 1)
            return data if len(data) <= MAX_READ else None
    except (OSError, UnicodeError):
        return None


def os_release(data: str | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in (data or "").splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if match:
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            result[match.group(1)] = value
    return result


def readonly_command(argv: tuple[str, ...]) -> tuple[int, str]:
    """Fixed read-only argv only; no shell, network, writes or raw stderr."""
    if argv[0] == "/usr/bin/dpkg-query":
        if argv[1:] != ("-W", "-f=${Version}", "openmediavault"):
            raise ValueError("DPKG_QUERY_NOT_ALLOWLISTED")
    elif argv[0] == "/usr/bin/systemctl":
        if (
            len(argv) != 6
            or argv[1:4] != ("show", "--no-pager", "-p")
            or argv[4] not in ("LoadState", "ActiveState")
            or argv[5] not in UNIT_NAMES.values()
        ):
            raise ValueError("SYSTEMCTL_QUERY_NOT_ALLOWLISTED")
    else:
        raise ValueError("COMMAND_NOT_ALLOWLISTED")
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            check=False,
            timeout=4,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
        )
        return proc.returncode, proc.stdout[:1024]
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def unit_state(name: str, field: str = "LoadState") -> str:
    if name not in UNIT_NAMES.values():
        return "unknown"
    code, out = readonly_command(
        ("/usr/bin/systemctl", "show", "--no-pager", "-p", field, name)
    )
    values = (
        ("loaded", "not-found", "masked", "error")
        if field == "LoadState"
        else ("active", "inactive", "failed", "activating", "deactivating")
    )
    match = re.search(
        r"^" + re.escape(field) + r"=(" + "|".join(values) + r")\s*$", out, re.M
    )
    return match.group(1) if code == 0 and match else "unknown"


def group_member_count(group_name: str) -> int | None:
    """Count supplementary and primary-GID members without exposing usernames."""
    try:
        group = grp.getgrnam(group_name)
        members = set(group.gr_mem)
        members.update(
            entry.pw_name for entry in pwd.getpwall() if entry.pw_gid == group.gr_gid
        )
        return len(members)
    except KeyError:
        return 0
    except OSError:
        return None


def summarize_mountinfo(data: str | None) -> dict[str, object] | None:
    """Return aggregate filesystem facts only; never emit mountpoints or devices."""
    if data is None:
        return None
    filesystems: set[str] = set()
    root_filesystem = None
    lines = data.splitlines()
    for line in lines:
        before, separator, after = line.partition(" - ")
        left = before.split()
        right = after.split()
        if not separator or len(left) < 5 or len(right) < 2:
            return None
        filesystem = right[0]
        filesystems.add(filesystem)
        if left[4] == "/":
            root_filesystem = filesystem
    if root_filesystem is None:
        return None
    return {
        "mount_count": len(lines),
        "filesystem_types": sorted(filesystems),
        "root_filesystem": root_filesystem,
        "remote_mounts_present": bool(
            filesystems.intersection({"nfs", "nfs4", "cifs", "smb3", "fuse.sshfs"})
        ),
        "btrfs_present": "btrfs" in filesystems,
        "zfs_present": "zfs" in filesystems or "fuse.zfs" in filesystems,
    }


def summarize_mdstat(data: str | None) -> dict[str, object] | None:
    """Report array counts and health signals without disk/device identifiers."""
    if data is None:
        return None
    active_lines = [
        line for line in data.splitlines()
        if re.match(r"^md[0-9]+\s*:\s*active\b", line)
    ]
    degraded = any(
        re.search(r"\[[U_]*_[U_]*\]", line) is not None
        for line in data.splitlines()
    )
    maintenance = any(
        re.search(r"\b(resync|recovery|reshape|check|repair)\s*=", line) is not None
        for line in data.splitlines()
    )
    return {
        "active_array_count": len(active_lines),
        "degraded_signal": degraded,
        "maintenance_in_progress": maintenance,
    }


def collect() -> dict[str, object]:
    """Local bounded read-only collection; reports no hostpaths, data or secrets."""
    osdata = os_release(read_text("/etc/os-release"))
    rc, package = readonly_command(
        ("/usr/bin/dpkg-query", "-W", "-f=${Version}", "openmediavault")
    )
    mount_summary = summarize_mountinfo(read_text("/proc/self/mountinfo"))
    mdstat_summary = summarize_mdstat(read_text("/proc/mdstat"))
    units = {
        key: {
            "load": unit_state(name, "LoadState"),
            "active": unit_state(name, "ActiveState"),
        }
        for key, name in UNIT_NAMES.items()
    }
    return {
        "os_id": osdata.get("ID", "unknown"),
        "os_version": osdata.get("VERSION_ID", "unknown"),
        "omv_version": package.strip() if rc == 0 else None,
        "omv_marker": Path("/etc/openmediavault/config.xml").is_file(),
        "systemd_pid1": (read_text("/proc/1/comm") or "").strip() == "systemd",
        "systemd_runtime": Path("/run/systemd/system").is_dir(),
        "root_euid": os.geteuid() == 0,
        "units": units,
        "groups": {
            "docker_member_count": group_member_count("docker"),
            "ssh_member_count": group_member_count("_ssh"),
            "sudo_member_count": group_member_count("sudo"),
        },
        "privilege_tools": {
            "sudo_available": Path("/usr/bin/sudo").is_file(),
            "su_available": Path("/usr/bin/su").is_file(),
        },
        "docker_socket_present": (
            Path("/run/docker.sock").exists()
            or Path("/var/run/docker.sock").exists()
        ),
        "podman_socket_present": Path("/run/podman/podman.sock").exists(),
        "mounts": mount_summary,
        "mdstat": mdstat_summary,
    }


def assess(facts: dict[str, object]) -> dict[str, object]:
    """Pure classification. No path from this function authorizes mutation."""
    blockers: list[str] = []
    hints: list[str] = []
    if facts.get("os_id") != "debian" or facts.get("os_version") != "13":
        blockers.append("DEBIAN_13_NOT_PROVEN")
    version = facts.get("omv_version")
    if not isinstance(version, str) or not re.match(r"^8(?:[.+~:-]|$)", version):
        blockers.append("OMV8_PACKAGE_NOT_PROVEN")
    if facts.get("omv_marker") is not True:
        blockers.append("OMV_MARKER_MISSING")
    if facts.get("systemd_pid1") is not True or facts.get("systemd_runtime") is not True:
        blockers.append("SYSTEMD_NOT_PROVEN")
    if facts.get("root_euid") is not True:
        blockers.append("LOCAL_ROOT_CEREMONY_NOT_PROVEN")

    mounts = facts.get("mounts")
    mdstat = facts.get("mdstat")
    if not isinstance(mounts, dict) or not isinstance(mdstat, dict):
        blockers.append("STORAGE_FACTS_UNAVAILABLE")
    else:
        filesystem_types = mounts.get("filesystem_types")
        root_filesystem = mounts.get("root_filesystem")
        active_arrays = mdstat.get("active_array_count")
        if (
            not isinstance(filesystem_types, list)
            or not all(isinstance(item, str) for item in filesystem_types)
            or not isinstance(root_filesystem, str)
            or not isinstance(active_arrays, int)
            or not isinstance(mdstat.get("degraded_signal"), bool)
            or not isinstance(mdstat.get("maintenance_in_progress"), bool)
        ):
            blockers.append("STORAGE_FACTS_MALFORMED")
        else:
            filesystems = set(filesystem_types)
            if mounts.get("remote_mounts_present") is True:
                hints.append("REMOTE_MOUNTS_PRESENT_DO_NOT_TOUCH")
            if mounts.get("btrfs_present") is True:
                hints.append("BTRFS_PRESENT_DO_NOT_TOUCH")
            if mounts.get("zfs_present") is True:
                hints.append("ZFS_PRESENT_DO_NOT_TOUCH")
            if active_arrays > 0:
                hints.append("MD_RAID_ACTIVE_DO_NOT_TOUCH")
            if mdstat.get("degraded_signal") is True:
                hints.append("MD_RAID_DEGRADED_OWNER_REVIEW")
            if mdstat.get("maintenance_in_progress") is True:
                hints.append("MD_RAID_MAINTENANCE_IN_PROGRESS")
            if not filesystems or not root_filesystem:
                blockers.append("ROOT_FILESYSTEM_NOT_PROVEN")

    units = facts.get("units")
    if not isinstance(units, dict):
        blockers.append("SERVICE_FACTS_UNAVAILABLE")
        units = {}
    valid_units: dict[str, dict[str, str]] = {}
    for key, state in units.items():
        if not isinstance(state, dict):
            blockers.append("UNIT_STATE_INVALID_" + str(key).upper())
            continue
        load = state.get("load", "unknown")
        active = state.get("active", "unknown")
        if load not in ("loaded", "not-found", "masked", "error", "unknown"):
            blockers.append("UNIT_LOAD_VALUE_INVALID_" + str(key).upper())
        if active not in ("active", "inactive", "failed", "activating", "deactivating", "unknown"):
            blockers.append("UNIT_ACTIVE_VALUE_INVALID_" + str(key).upper())
        if load == "unknown" or active == "unknown":
            blockers.append("UNIT_STATE_UNAVAILABLE_" + str(key).upper())
        valid_units[str(key)] = {"load": str(load), "active": str(active)}
    units = valid_units

    for required in UNIT_NAMES:
        if required not in units:
            blockers.append("UNIT_FACT_MISSING_" + required.upper())
    omv_engine = units.get("omv_engine", {})
    if omv_engine.get("load") != "loaded" or omv_engine.get("active") != "active":
        blockers.append("OMV_ENGINE_NOT_ACTIVE")

    for key in ("ssh", "tailscaled", "docker", "docker_socket", "containerd", "podman_socket"):
        state = units.get(key, {})
        if state.get("load") == "loaded" and state.get("active") == "active":
            hints.append(key.upper() + "_ACTIVE_PRESERVE")
    for key in ("smbd", "nfs"):
        state = units.get(key, {})
        if state.get("load") == "loaded" and state.get("active") == "active":
            hints.append(key.upper() + "_ACTIVE_PRESERVE")

    groups = facts.get("groups")
    if not isinstance(groups, dict):
        blockers.append("GROUP_FACTS_UNAVAILABLE")
        groups = {}
    for key in ("docker_member_count", "ssh_member_count", "sudo_member_count"):
        count = groups.get(key)
        if not isinstance(count, int) or count < 0:
            blockers.append("GROUP_MEMBERSHIP_UNKNOWN_" + key.upper())
    docker_members = groups.get("docker_member_count")
    if isinstance(docker_members, int) and docker_members > 0:
        hints.append("DOCKER_GROUP_MEMBERSHIP_REQUIRES_REVIEW")
    if groups.get("ssh_member_count") == 0:
        hints.append("OMV_SSH_GROUP_EMPTY_REVIEW")
    if groups.get("sudo_member_count", 0) > 0:
        hints.append("SUDO_GROUP_MEMBERSHIP_PRESENT")

    privilege_tools = facts.get("privilege_tools")
    if not isinstance(privilege_tools, dict):
        blockers.append("PRIVILEGE_TOOL_FACTS_UNAVAILABLE")
        privilege_tools = {}
    if not privilege_tools.get("sudo_available") and not privilege_tools.get("su_available"):
        hints.append("NO_SUDO_OR_SU_TOOL")

    if facts.get("docker_socket_present") is True:
        hints.append("DOCKER_SOCKET_PRESENT_DO_NOT_ATTACH")
    if facts.get("podman_socket_present") is True:
        hints.append("PODMAN_SOCKET_PRESENT_DO_NOT_ATTACH")
    if units.get("tailscaled", {}).get("load") == "not-found":
        hints.append("TAILSCALE_NOT_YET_CONFIGURED")

    return {
        "schema": SCHEMA,
        "compatibility": "BLOCKED" if blockers else "FACTS_READY",
        "blockers": sorted(set(blockers)),
        "safety_hints": sorted(set(hints)),
        "service_status": units,
        "group_member_counts": groups,
        "privilege_tools": privilege_tools,
        "storage": {
            "mount_count": mounts.get("mount_count") if isinstance(mounts, dict) else None,
            "filesystem_types": mounts.get("filesystem_types", []) if isinstance(mounts, dict) else [],
            "root_filesystem": mounts.get("root_filesystem") if isinstance(mounts, dict) else None,
            "mdstat": mdstat if isinstance(mdstat, dict) else None,
        },
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
