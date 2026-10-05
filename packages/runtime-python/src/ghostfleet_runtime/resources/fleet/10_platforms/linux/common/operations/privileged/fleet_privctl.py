#!/usr/bin/python3 -I
"""Youling Fleet narrow privileged-operation helper (Linux V2 + additive V3).

Security boundary:
  dedicated forced-command SSH ops principal
    -> sudo -n exact digest-pinned helper
    -> bounded JSON request on stdin
    -> fixed typed privileged operation

No shell, arbitrary path, service name, executable, file body, or command argv is
accepted from the caller.
"""
from __future__ import annotations

import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import syslog
from typing import Any

SCHEMA = "youling-fleet-privileged-operations/v2"
SCHEMA_V3 = "youling-fleet-privileged-operations/v3"
VERSION = "3.0.0"
OPS_USER = "ghostfleet-ops"
MAX_REQUEST_BYTES = 32768
MAX_VENDOR_IDS = 16
ADB_GROUP = "ghostfleet_adb"
RULE_NAME = "70-youling-fleet-android-adb.rules"
RULE_MARKER = "# Managed by Youling Fleet fleet-privctl v2; do not edit manually."

REQUEST_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._:-]{7,79}$")
ACTOR_REF_RE = re.compile(r"^[0-9a-f]{64}$")
NODE_UID_RE = re.compile(
    r"^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
VENDOR_ID_RE = re.compile(r"^[0-9a-f]{4}$")

GROUPADD = "/usr/sbin/groupadd"
USERMOD = "/usr/sbin/usermod"
UDEVADM = "/usr/bin/udevadm"

_PRODUCTION_RULE_PATH = Path("/etc/udev/rules.d") / RULE_NAME
_PRODUCTION_NODE_REPORT = Path("/var/lib/fleet/enrollment-report.json")
_PRODUCTION_LOCK = Path("/run/lock/youling-fleet-privctl.lock")
_PRODUCTION_LOCAL_STATE = Path("/etc/youling-fleet/privileged-operations/control.json")
_PRODUCTION_RECEIPT_DIR = Path("/var/lib/youling-fleet/privileged-operations/receipts")


class PrivilegedOperationError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise PrivilegedOperationError(code)


def _test_root() -> Path | None:
    if os.geteuid() == 0 or os.environ.get("FLEET_PRIVCTL_TEST_MODE") != "1":
        return None
    raw = os.environ.get("FLEET_PRIVCTL_TEST_ROOT", "")
    if not raw:
        return None
    root = Path(raw).resolve()
    if not str(root).startswith("/tmp/"):
        return None
    return root


TEST_ROOT = _test_root()
TEST_MODE = TEST_ROOT is not None


def rule_path() -> Path:
    if TEST_MODE:
        assert TEST_ROOT is not None
        return TEST_ROOT / "etc/udev/rules.d" / RULE_NAME
    return _PRODUCTION_RULE_PATH


def node_report_path() -> Path:
    if TEST_MODE:
        assert TEST_ROOT is not None
        return TEST_ROOT / "var/lib/fleet/enrollment-report.json"
    return _PRODUCTION_NODE_REPORT


def lock_path() -> Path:
    if TEST_MODE:
        assert TEST_ROOT is not None
        return TEST_ROOT / "run/lock/youling-fleet-privctl.lock"
    return _PRODUCTION_LOCK


def local_state_path() -> Path:
    if TEST_MODE:
        assert TEST_ROOT is not None
        return TEST_ROOT / "etc/youling-fleet/privileged-operations/control.json"
    return _PRODUCTION_LOCAL_STATE


def receipt_dir() -> Path:
    if TEST_MODE:
        assert TEST_ROOT is not None
        return TEST_ROOT / "var/lib/youling-fleet/privileged-operations/receipts"
    return _PRODUCTION_RECEIPT_DIR


def _trusted_receipt_dir() -> Path:
    path = receipt_dir()
    if TEST_MODE:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path
    try:
        info = path.lstat()
    except OSError:
        fail("PRIVILEGED_RECEIPT_DIRECTORY_UNAVAILABLE")
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        fail("PRIVILEGED_RECEIPT_DIRECTORY_UNTRUSTED")
    return path


def request_digest(request: dict[str, Any]) -> str:
    payload = json.dumps(
        request, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("ascii")
    return hashlib.sha256(payload).hexdigest()


def _write_receipt(path: Path, value: dict[str, Any]) -> None:
    parent = _trusted_receipt_dir()
    payload = (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        + "\n"
    ).encode("ascii")
    tmp = parent / f".{path.name}.{os.getpid()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(tmp, flags, 0o600)
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    fail("PRIVILEGED_RECEIPT_WRITE_FAILED")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        _fsync_dir(parent)
    except PrivilegedOperationError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        fail("PRIVILEGED_RECEIPT_WRITE_FAILED")


def existing_receipt(request: dict[str, Any]) -> dict[str, Any] | None:
    parent = _trusted_receipt_dir()
    path = parent / f"{request['request_id']}.json"
    if not path.exists():
        return None
    try:
        info = path.lstat()
        value = json.loads(path.read_text(encoding="ascii"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("PRIVILEGED_RECEIPT_INVALID")
    expected_uid = os.geteuid() if TEST_MODE else 0
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != expected_uid
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        fail("PRIVILEGED_RECEIPT_UNTRUSTED")
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        fail("PRIVILEGED_RECEIPT_INVALID")
    if value.get("request_digest") != request_digest(request):
        fail("PRIVILEGED_REQUEST_ID_CONFLICT")
    state = value.get("state")
    if state == "SUCCEEDED" and isinstance(value.get("result"), dict):
        result = dict(value["result"])
        result["duplicate"] = True
        return result
    if state in {"PENDING", "UNKNOWN"}:
        fail("PRIVILEGED_REQUEST_UNKNOWN_RECONCILE_REQUIRED")
    fail("PRIVILEGED_RECEIPT_INVALID")


def write_receipt(
    request: dict[str, Any],
    *,
    state: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    path = _trusted_receipt_dir() / f"{request['request_id']}.json"
    value: dict[str, Any] = {
        "schema": SCHEMA,
        "request_id": request["request_id"],
        "actor_ref": request["actor_ref"],
        "node_uid": request["node_uid"],
        "operation": request["operation"],
        "request_digest": request_digest(request),
        "state": state,
    }
    if result is not None:
        value["result"] = result
    if error is not None:
        value["error"] = error
    _write_receipt(path, value)


def require_runtime() -> None:
    if TEST_MODE:
        assert TEST_ROOT is not None
        TEST_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        return
    if os.geteuid() != 0:
        fail("PRIVILEGED_EUID_REQUIRED")


def read_request(stream: Any = sys.stdin.buffer) -> dict[str, Any]:
    raw = stream.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        fail("PRIVILEGED_REQUEST_TOO_LARGE")
    if not raw:
        fail("PRIVILEGED_REQUEST_EMPTY")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("PRIVILEGED_REQUEST_INVALID_JSON")
    if not isinstance(value, dict):
        fail("PRIVILEGED_REQUEST_INVALID")
    allowed = {"schema", "request_id", "actor_ref", "node_uid", "operation", "vendor_ids"}
    if value.get("schema") == SCHEMA_V3:
        allowed |= {"action", "generation", "profile_generation"}
    if set(value) - allowed:
        fail("PRIVILEGED_REQUEST_UNKNOWN_FIELD")
    if value.get("schema") not in {SCHEMA, SCHEMA_V3}:
        fail("PRIVILEGED_REQUEST_SCHEMA_MISMATCH")
    return value


def dedicated_caller_identity() -> str:
    if TEST_MODE:
        user = os.environ.get("FLEET_PRIVCTL_TEST_SUDO_USER", "")
        uid_text = os.environ.get("FLEET_PRIVCTL_TEST_SUDO_UID", "12345")
        if user != OPS_USER or not uid_text.isdigit() or int(uid_text) == 0:
            fail("PRIVILEGED_OPS_CALLER_REQUIRED")
        return user

    user = os.environ.get("SUDO_USER", "")
    uid_text = os.environ.get("SUDO_UID", "")
    if user != OPS_USER or not uid_text.isdigit():
        fail("PRIVILEGED_OPS_CALLER_REQUIRED")
    try:
        entry = pwd.getpwnam(user)
    except KeyError:
        fail("PRIVILEGED_OPS_CALLER_UNKNOWN")
    if entry.pw_uid == 0 or entry.pw_uid != int(uid_text):
        fail("PRIVILEGED_OPS_CALLER_MISMATCH")
    return user


def canonical_node_uid() -> str:
    try:
        value = json.loads(node_report_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("PRIVILEGED_NODE_IDENTITY_UNAVAILABLE")
    node_uid = value.get("node_uid") if isinstance(value, dict) else None
    if not isinstance(node_uid, str) or not NODE_UID_RE.fullmatch(node_uid):
        fail("PRIVILEGED_NODE_IDENTITY_UNAVAILABLE")
    return node_uid


def validate_request(value: dict[str, Any]) -> dict[str, Any]:
    request_id = value.get("request_id")
    actor_ref = value.get("actor_ref")
    node_uid = value.get("node_uid")
    operation = value.get("operation")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        fail("PRIVILEGED_REQUEST_ID_INVALID")
    if not isinstance(actor_ref, str) or not ACTOR_REF_RE.fullmatch(actor_ref):
        fail("PRIVILEGED_ACTOR_REF_INVALID")
    if not isinstance(node_uid, str) or not NODE_UID_RE.fullmatch(node_uid):
        fail("PRIVILEGED_NODE_UID_INVALID")
    local_uid = canonical_node_uid()
    if node_uid != local_uid:
        fail("PRIVILEGED_NODE_UID_MISMATCH")
    if operation not in {"root-probe", "android-udev-access"}:
        fail("PRIVILEGED_OPERATION_NOT_ALLOWED")

    vendor_ids = value.get("vendor_ids")
    if operation == "root-probe":
        if vendor_ids not in (None, []):
            fail("PRIVILEGED_ARGUMENT_NOT_ALLOWED")
        normalized: list[str] = []
    else:
        if not isinstance(vendor_ids, list) or not vendor_ids or len(vendor_ids) > MAX_VENDOR_IDS:
            fail("PRIVILEGED_VENDOR_SET_INVALID")
        normalized_set: set[str] = set()
        for item in vendor_ids:
            if not isinstance(item, str):
                fail("PRIVILEGED_VENDOR_ID_INVALID")
            item = item.lower()
            if not VENDOR_ID_RE.fullmatch(item):
                fail("PRIVILEGED_VENDOR_ID_INVALID")
            normalized_set.add(item)
        normalized = sorted(normalized_set)
        if not normalized:
            fail("PRIVILEGED_VENDOR_SET_INVALID")

    return {
        "request_id": request_id,
        "actor_ref": actor_ref,
        "node_uid": node_uid,
        "operation": operation,
        "vendor_ids": normalized,
    }


def audit_event(
    *,
    request_id: str,
    actor_ref: str,
    node_uid: str,
    operation: str,
    ops_user: str,
    phase: str,
    result: str,
    changed: bool | None = None,
) -> None:
    record: dict[str, Any] = {
        "schema": SCHEMA,
        "request_id": request_id,
        "actor_ref": actor_ref,
        "node_uid": node_uid,
        "operation": operation,
        "ops_user": ops_user,
        "phase": phase,
        "result": result,
    }
    if changed is not None:
        record["changed"] = changed
    line = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

    if TEST_MODE:
        assert TEST_ROOT is not None
        path = TEST_ROOT / "audit.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(line + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return

    try:
        dev_log = Path("/dev/log")
        if not dev_log.exists() or not stat.S_ISSOCK(dev_log.stat().st_mode):
            fail("PRIVILEGED_AUDIT_UNAVAILABLE")
        syslog.openlog("youling-fleet-privctl", syslog.LOG_PID, syslog.LOG_AUTHPRIV)
        syslog.syslog(syslog.LOG_INFO, line)
    except PrivilegedOperationError:
        raise
    except Exception:
        fail("PRIVILEGED_AUDIT_UNAVAILABLE")


def _fixed_env() -> dict[str, str]:
    return {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}


def run_fixed(argv: list[str]) -> None:
    if TEST_MODE:
        assert TEST_ROOT is not None
        path = TEST_ROOT / "fixed-commands.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(argv, separators=(",", ":")) + "\n")
        return
    if not argv or not argv[0].startswith("/"):
        fail("PRIVILEGED_FIXED_COMMAND_INVALID")
    executable = Path(argv[0])
    try:
        info = executable.stat()
    except OSError:
        fail("PRIVILEGED_FIXED_TOOL_MISSING")
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
        fail("PRIVILEGED_FIXED_TOOL_UNTRUSTED")
    try:
        result = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_fixed_env(),
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("PRIVILEGED_FIXED_COMMAND_FAILED")
    if result.returncode != 0:
        fail("PRIVILEGED_FIXED_COMMAND_FAILED")


def _test_group_state() -> dict[str, Any]:
    assert TEST_ROOT is not None
    path = TEST_ROOT / "identity-state.json"
    if not path.exists():
        return {"groups": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("PRIVILEGED_TEST_STATE_INVALID")
    if not isinstance(value, dict) or not isinstance(value.get("groups"), dict):
        fail("PRIVILEGED_TEST_STATE_INVALID")
    return value


def _write_test_group_state(value: dict[str, Any]) -> None:
    assert TEST_ROOT is not None
    (TEST_ROOT / "identity-state.json").write_text(
        json.dumps(value, sort_keys=True), encoding="utf-8"
    )


def ensure_adb_group_membership() -> tuple[bool, bool]:
    """Return (group_created, ops_membership_added).

    The ADB group is granted to the existing ordinary control user recorded in
    local Fleet enrollment state, never inferred from the privileged SSH caller.
    """
    try:
        state = json.loads(local_state_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("PRIVILEGED_CONTROL_USER_UNAVAILABLE")
    control_user = state.get("ordinary_user") if isinstance(state, dict) else None
    if not isinstance(control_user, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", control_user):
        fail("PRIVILEGED_CONTROL_USER_UNAVAILABLE")
    if control_user in {"root", OPS_USER}:
        fail("PRIVILEGED_CONTROL_USER_INVALID")

    if TEST_MODE:
        state = _test_group_state()
        groups = state["groups"]
        created = ADB_GROUP not in groups
        members = groups.setdefault(ADB_GROUP, [])
        added = control_user not in members
        if added:
            members.append(control_user)
            members.sort()
        _write_test_group_state(state)
        return created, added

    try:
        user = pwd.getpwnam(control_user)
    except KeyError:
        fail("PRIVILEGED_CONTROL_USER_UNAVAILABLE")
    if user.pw_uid == 0:
        fail("PRIVILEGED_CONTROL_USER_INVALID")

    created = False
    try:
        group = grp.getgrnam(ADB_GROUP)
    except KeyError:
        run_fixed([GROUPADD, "--system", ADB_GROUP])
        created = True
        try:
            group = grp.getgrnam(ADB_GROUP)
        except KeyError:
            fail("PRIVILEGED_GROUP_POSTCONDITION_FAILED")

    already = user.pw_gid == group.gr_gid or control_user in group.gr_mem
    added = False
    if not already:
        run_fixed([USERMOD, "--append", "--groups", ADB_GROUP, control_user])
        added = True
        try:
            group = grp.getgrnam(ADB_GROUP)
        except KeyError:
            fail("PRIVILEGED_GROUP_POSTCONDITION_FAILED")
        if user.pw_gid != group.gr_gid and control_user not in group.gr_mem:
            fail("PRIVILEGED_GROUP_POSTCONDITION_FAILED")
    return created, added


def render_android_rules(vendor_ids: list[str]) -> bytes:
    lines = [RULE_MARKER, "# operation=android-udev-access", f"# group={ADB_GROUP}"]
    for vendor_id in vendor_ids:
        lines.append(
            'SUBSYSTEM=="usb", ATTR{idVendor}=="'
            + vendor_id
            + f'", MODE="0660", GROUP="{ADB_GROUP}"'
        )
    return ("\n".join(lines) + "\n").encode("ascii")


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def reconcile_rule_file(vendor_ids: list[str]) -> bool:
    path = rule_path()
    expected = render_android_rules(vendor_ids)
    expected_uid = os.geteuid() if TEST_MODE else 0
    if TEST_MODE:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    else:
        try:
            parent = path.parent.lstat()
        except OSError:
            fail("PRIVILEGED_UDEV_DIRECTORY_UNAVAILABLE")
        if (
            not stat.S_ISDIR(parent.st_mode)
            or stat.S_ISLNK(parent.st_mode)
            or parent.st_uid != 0
            or stat.S_IMODE(parent.st_mode) & 0o022
        ):
            fail("PRIVILEGED_UDEV_DIRECTORY_UNTRUSTED")

    if path.exists() or path.is_symlink():
        try:
            info = path.lstat()
            current = path.read_bytes()
        except OSError:
            fail("PRIVILEGED_RULE_INSPECTION_FAILED")
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != expected_uid
            or not current.startswith((RULE_MARKER + "\n").encode("ascii"))
        ):
            fail("PRIVILEGED_RULE_OWNERSHIP_CONFLICT")
        if current == expected and stat.S_IMODE(info.st_mode) == 0o644:
            return False

    tmp = path.parent / f".{RULE_NAME}.{os.getpid()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(tmp, flags, 0o600)
        try:
            os.write(fd, expected)
            os.fchmod(fd, 0o644)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        fail("PRIVILEGED_RULE_WRITE_FAILED")

    try:
        info = path.stat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != expected_uid
            or stat.S_IMODE(info.st_mode) != 0o644
            or path.read_bytes() != expected
        ):
            fail("PRIVILEGED_RULE_POSTCONDITION_FAILED")
    except OSError:
        fail("PRIVILEGED_RULE_POSTCONDITION_FAILED")
    return True


def reload_udev(vendor_ids: list[str]) -> None:
    run_fixed([UDEVADM, "control", "--reload-rules"])
    for vendor_id in vendor_ids:
        run_fixed(
            [
                UDEVADM,
                "trigger",
                "--subsystem-match=usb",
                f"--attr-match=idVendor={vendor_id}",
                "--action=change",
            ]
        )
    run_fixed([UDEVADM, "settle", "--timeout=10"])


def execute(request: dict[str, Any], ops_user: str) -> dict[str, Any]:
    operation = request["operation"]
    if operation == "root-probe":
        return {
            "ok": True,
            "schema": SCHEMA,
            "request_id": request["request_id"],
            "actor_ref": request["actor_ref"],
            "node_uid": request["node_uid"],
            "operation": operation,
            "execution_privilege": "root",
            "changed": False,
        }

    vendor_ids = request["vendor_ids"]
    created, added = ensure_adb_group_membership()
    changed_rule = reconcile_rule_file(vendor_ids)
    if created or changed_rule:
        reload_udev(vendor_ids)
    return {
        "ok": True,
        "schema": SCHEMA,
        "request_id": request["request_id"],
        "actor_ref": request["actor_ref"],
        "node_uid": request["node_uid"],
        "operation": operation,
        "vendor_ids": vendor_ids,
        "adb_group": ADB_GROUP,
        "changed": created or added or changed_rule,
        "group_created": created,
        "membership_added": added,
        "rule_changed": changed_rule,
        "new_login_required": added,
    }


def _v3_request(value: dict[str, Any]) -> tuple[dict[str, Any], str]:
    action = value.get("action")
    if action not in {"execute", "status"}:
        fail("PRIVILEGED_ACTION_INVALID")
    request = validate_request(value)
    # Unlike v2, v3 wire normalization is explicit and must already be canonical.
    if value.get("vendor_ids") != request["vendor_ids"]:
        fail("PRIVILEGED_VENDOR_SET_NOT_CANONICAL")
    generation = value.get("generation")
    profile = value.get("profile_generation")
    if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{64}", generation):
        fail("PRIVILEGED_GENERATION_INVALID")
    if not isinstance(profile, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", profile):
        fail("PRIVILEGED_PROFILE_GENERATION_INVALID")
    request.update(schema=SCHEMA_V3, generation=generation, profile_generation=profile)
    return request, action


def _v3_binding(request: dict[str, Any], state: str) -> dict[str, Any]:
    return {**request, "request_digest": request_digest(request), "state": state}


def _v3_receipt(request: dict[str, Any]) -> dict[str, Any] | None:
    path = _trusted_receipt_dir() / f"{request['request_id']}.json"
    if not path.exists() and not path.is_symlink():
        return None
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != (os.geteuid() if TEST_MODE else 0)
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_REQUEST_BYTES):
            fail("PRIVILEGED_RECEIPT_UNTRUSTED")
        value = json.loads(path.read_text(encoding="ascii"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("PRIVILEGED_RECEIPT_INVALID")
    if not isinstance(value, dict) or any(value.get(k) != v for k, v in request.items()):
        fail("PRIVILEGED_REQUEST_ID_CONFLICT")
    if value.get("request_digest") != request_digest(request):
        fail("PRIVILEGED_REQUEST_ID_CONFLICT")
    if value.get("state") not in {"PENDING", "UNKNOWN", "SUCCEEDED"}:
        fail("PRIVILEGED_RECEIPT_INVALID")
    return value


def _v3_generation_authority(request: dict[str, Any]) -> None:
    """Pins are root-owned deployment config, never model request authority."""
    path = local_state_path()
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != (os.geteuid() if TEST_MODE else 0)
            or stat.S_IMODE(info.st_mode) & 0o022 or info.st_size > MAX_REQUEST_BYTES):
            fail("PRIVILEGED_LOCAL_AUTHORITY_UNTRUSTED")
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("PRIVILEGED_LOCAL_AUTHORITY_UNAVAILABLE")
    if (not isinstance(state, dict) or state.get("schema") != "youling-fleet-privileged-operations-local/v2"
        or state.get("ops_user") != OPS_USER
        or state.get("generation") != request["generation"]
        or state.get("profile_generation") != request["profile_generation"]):
        fail("PRIVILEGED_GENERATION_MISMATCH")


def run_v3(value: dict[str, Any], ops_user: str) -> dict[str, Any]:
    request, action = _v3_request(value)
    # Status uses atomic receipt publication, needs no admission lock or state write.
    # Old generation status remains readable after an explicitly authorized rotation.
    if action == "status":
        return _v3_receipt(request) or _v3_binding(request, "NOT_FOUND")
    path = lock_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with open(path, "a+b") as lock:
        os.chmod(path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        previous = _v3_receipt(request)
        if previous is not None:
            if previous["state"] == "SUCCEEDED":
                previous = {**previous, "result": {**previous["result"], "duplicate": True}}
            return previous
        _v3_generation_authority(request)
        receipt_path = _trusted_receipt_dir() / f"{request['request_id']}.json"
        _write_receipt(receipt_path, _v3_binding(request, "PENDING"))
        audit = {key: request[key] for key in ("request_id", "actor_ref", "node_uid", "operation")}
        # Audit failure leaves PENDING; a later retry never executes it blindly.
        audit_event(**audit, ops_user=ops_user, phase="begin", result="pending")
        try:
            result = execute(request, ops_user)
        except Exception as error:
            code = error.code if isinstance(error, PrivilegedOperationError) else "PRIVILEGED_INTERNAL_ERROR"
            receipt = {**_v3_binding(request, "UNKNOWN"), "error": code}
            _write_receipt(receipt_path, receipt)
            audit_event(**audit, ops_user=ops_user, phase="end", result=code)
            return receipt
        result.update({key: request[key] for key in ("schema", "generation", "profile_generation")})
        result["duplicate"] = False
        receipt = {**_v3_binding(request, "SUCCEEDED"), "result": result}
        _write_receipt(receipt_path, receipt)
        audit_event(**audit, ops_user=ops_user, phase="end", result="ok", changed=result["changed"])
        return receipt


def run() -> dict[str, Any]:
    require_runtime()
    ops_user = dedicated_caller_identity()
    value = read_request()
    if value["schema"] == SCHEMA_V3:
        return run_v3(value, ops_user)
    request = validate_request(value)
    path = lock_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with open(path, "a+b") as lock:
        os.chmod(path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)

        replay = existing_receipt(request)
        if replay is not None:
            return replay

        write_receipt(request, state="PENDING")
        audit_event(
            request_id=request["request_id"],
            actor_ref=request["actor_ref"],
            node_uid=request["node_uid"],
            operation=request["operation"],
            ops_user=ops_user,
            phase="begin",
            result="pending",
        )
        try:
            result = execute(request, ops_user)
        except PrivilegedOperationError as error:
            # A typed operation can fail after a partial privileged mutation.
            # Persist UNKNOWN and require external postcondition reconciliation;
            # never make a same-ID retry silently re-execute the operation.
            try:
                write_receipt(request, state="UNKNOWN", error=error.code)
            finally:
                audit_event(
                    request_id=request["request_id"],
                    actor_ref=request["actor_ref"],
                    node_uid=request["node_uid"],
                    operation=request["operation"],
                    ops_user=ops_user,
                    phase="end",
                    result=error.code,
                    changed=None,
                )
            raise

        result["duplicate"] = False
        write_receipt(request, state="SUCCEEDED", result=result)
        audit_event(
            request_id=request["request_id"],
            actor_ref=request["actor_ref"],
            node_uid=request["node_uid"],
            operation=request["operation"],
            ops_user=ops_user,
            phase="end",
            result="ok",
            changed=bool(result.get("changed")),
        )
        return result


def main() -> int:
    try:
        result = run()
    except PrivilegedOperationError as error:
        print(json.dumps({"ok": False, "error": error.code}, separators=(",", ":")))
        return 2
    except Exception:
        print(json.dumps({"ok": False, "error": "PRIVILEGED_INTERNAL_ERROR"}, separators=(",", ":")))
        return 1
    print(json.dumps(result, separators=(",", ":"), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
