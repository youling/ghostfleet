#!/usr/bin/python3 -I
"""Approved administrator commands. No network, issuer secret, shell, or daemon.

The existing dedicated ops SSH/sudo entry owns ingress. This module owns V4
signature checks, an on-disk one-use fence and an optional systemd executor.
Imports do not execute commands. Missing production dependencies fail closed.
"""
from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from typing import Any

WIRE_SCHEMA = "youling-fleet-privileged-operations/v4"
LEASE_SCHEMA = "ghostfleet-approved-admin-lease/v1"
CONFIG_SCHEMA = "ghostfleet-approved-admin-config/v1"
RECEIPT_SCHEMA = "ghostfleet-approved-admin-receipt/v1"
DOMAIN = b"ghostfleet-approved-admin-command/v1\0"
DEFAULT_CONFIG = Path("/etc/youling-fleet/privileged-operations/admin-command.json")
OPS_USER = "ghostfleet-ops"
MAX_WIRE = 32768
MAX_LEASE = 16384
MAX_RECORD = 131072
HEX = re.compile(r"^[0-9a-f]{64}$")
REF = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$")
NODE = re.compile(r"^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ISSUER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
TERMINAL = {"SUCCEEDED", "FAILED", "EXPIRED", "REVOKED"}
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
ENV_DENY = re.compile(r"^(?:PATH|HOME|USER|LOGNAME|SHELL|ENV|BASH_ENV|SHELLOPTS|CDPATH|IFS|TMPDIR|LD_.*|DYLD_.*|PYTHON.*|SUDO_.*|SYSTEMD_.*|GCONV_PATH|LOCPATH)$")


class AdminError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def fail(code: str) -> None:
    raise AdminError(code)


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            fail("ADMIN_DUPLICATE_JSON_KEY")
        value[key] = item
    return value


def json_object(data: bytes, limit: int = MAX_RECORD) -> dict[str, Any]:
    if not data or len(data) > limit:
        fail("ADMIN_JSON_SIZE")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _: fail("ADMIN_JSON_CONSTANT"))
    except (ValueError, UnicodeDecodeError, RecursionError):
        fail("ADMIN_JSON_INVALID")
    if not isinstance(value, dict):
        fail("ADMIN_JSON_OBJECT_REQUIRED")
    return value


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64(value: Any, maximum: int, exact: int | None = None) -> bytes:
    if not isinstance(value, str) or len(value) > maximum * 2:
        fail("ADMIN_BASE64_INVALID")
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        fail("ADMIN_BASE64_INVALID")
    if len(raw) > maximum or (exact is not None and len(raw) != exact):
        fail("ADMIN_BASE64_SIZE")
    if base64.b64encode(raw).decode("ascii") != value:
        fail("ADMIN_BASE64_NONCANONICAL")
    return raw


def string(value: Any, limit: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > limit or "\0" in value:
        fail("ADMIN_STRING_INVALID")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError:
        fail("ADMIN_STRING_INVALID")
    return value


def exact_keys(value: Any, keys: set[str], code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(code)
    return value


class TrustedFiles:
    """Production trusts uid 0 from /. Tests may inject a separate fixture root.

    There is no environment or wire switch for fixture ownership/root.
    Root-owned symlinks are allowed only for OS executable paths, after both
    original and resolved paths have been checked. Authority/state reject them.
    """
    def __init__(self, owner_uid: int = 0, anchor: Path = Path("/")):
        self.owner_uid = owner_uid
        self.anchor = anchor.absolute()

    def path(self, path: Path | str, kind: str = "file",
             private: bool = False, executable: bool = False) -> Path:
        p = Path(path)
        if not p.is_absolute() or ".." in p.parts or "." in p.parts:
            fail("ADMIN_PATH_INVALID")
        try:
            relative = p.relative_to(self.anchor)
        except ValueError:
            fail("ADMIN_PATH_OUTSIDE_TRUST_ROOT")
        current = self.anchor
        candidates = [current]
        for part in relative.parts:
            current = current / part
            candidates.append(current)
        link = False
        for item in candidates:
            try:
                info = item.lstat()
            except OSError:
                fail("ADMIN_PATH_UNAVAILABLE")
            if info.st_uid != self.owner_uid:
                fail("ADMIN_PATH_OWNER")
            if stat.S_ISLNK(info.st_mode):
                if not executable:
                    fail("ADMIN_PATH_SYMLINK")
                link = True
                continue
            if stat.S_IMODE(info.st_mode) & 0o022:
                fail("ADMIN_PATH_WRITABLE")
            if item != p and not stat.S_ISDIR(info.st_mode):
                fail("ADMIN_PARENT_NOT_DIRECTORY")
        if link:
            try:
                resolved = p.resolve(strict=True)
            except (OSError, RuntimeError):
                fail("ADMIN_PATH_SYMLINK")
            self.path(resolved, kind=kind, private=private, executable=False)
        try:
            info = p.stat()
        except OSError:
            fail("ADMIN_PATH_UNAVAILABLE")
        if kind == "file" and not stat.S_ISREG(info.st_mode):
            fail("ADMIN_FILE_REQUIRED")
        if kind == "dir" and not stat.S_ISDIR(info.st_mode):
            fail("ADMIN_DIRECTORY_REQUIRED")
        if private and stat.S_IMODE(info.st_mode) & 0o077:
            fail("ADMIN_PATH_NOT_PRIVATE")
        if executable and not stat.S_IMODE(info.st_mode) & 0o111:
            fail("ADMIN_EXECUTABLE_REQUIRED")
        return p

    def read(self, path: Path, limit: int = MAX_RECORD, private: bool = False) -> bytes:
        self.path(path, private=private)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if info.st_uid != self.owner_uid or not stat.S_ISREG(info.st_mode):
                    fail("ADMIN_FILE_CHANGED")
                if stat.S_IMODE(info.st_mode) & (0o077 if private else 0o022):
                    fail("ADMIN_FILE_CHANGED")
                raw = stream.read(limit + 1)
        except OSError:
            fail("ADMIN_READ_FAILED")
        if len(raw) > limit:
            fail("ADMIN_FILE_SIZE")
        return raw

    def executable_digest(self, path: Path) -> str:
        self.path(path, executable=True)
        # A root-owned system symlink is acceptable; the resolved inode and
        # every directory on both paths were checked above.
        resolved = path.resolve(strict=True)
        self.path(resolved)
        try:
            fd = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if info.st_uid != self.owner_uid or stat.S_IMODE(info.st_mode) & 0o022:
                    fail("ADMIN_EXECUTABLE_CHANGED")
                sha = hashlib.sha256()
                count = 0
                while chunk := stream.read(1024 * 1024):
                    count += len(chunk)
                    if count > 256 * 1024 * 1024:
                        fail("ADMIN_EXECUTABLE_SIZE")
                    sha.update(chunk)
                return sha.hexdigest()
        except OSError:
            fail("ADMIN_EXECUTABLE_UNAVAILABLE")

    def mkdir(self, path: Path) -> None:
        self.path(path.parent, kind="dir")
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        self.path(path, kind="dir", private=True)
        # The new directory entry must be durable before a receipt inside it
        # can serve as a crash-safe one-use fence. Repeat on FileExists too:
        # a prior mkdir may have succeeded while its parent fsync failed.
        try:
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            fail("ADMIN_DIRECTORY_SYNC_FAILED")

    def write(self, path: Path, value: dict[str, Any]) -> None:
        self.path(path.parent, kind="dir", private=True)
        if path.exists() or path.is_symlink():
            self.path(path, private=True)
        tmp = path.parent / (path.name + "." + os.urandom(12).hex() + ".tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        raw = canonical(value) + b"\n"
        if len(raw) > MAX_RECORD:
            fail("ADMIN_RECORD_SIZE")
        try:
            fd = os.open(tmp, flags, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            fail("ADMIN_STATE_WRITE_FAILED")
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass


@contextlib.contextmanager
def authority_locked(config_path: Path, fs: TrustedFiles):
    """One lifecycle lock shared by config CAS and final command admission.

    Lock order is always authority -> lease. Never hold either lock while
    waiting for an approved process to finish or for OS cancellation.
    """
    fs.path(config_path.parent, kind="dir")
    path = config_path.parent / "admin-command-authority.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        info = os.fstat(fd)
        if (info.st_uid != fs.owner_uid or not stat.S_ISREG(info.st_mode)
                or stat.S_IMODE(info.st_mode) != 0o600):
            fail("ADMIN_AUTHORITY_LOCK_UNTRUSTED")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


CONFIG_KEYS = {
    "schema", "node_uid", "subject_ref", "audience_ref", "generation",
    "profile_generation", "issuer_keys", "state_dir", "python_executable",
    "helper_path", "node_report_path", "control_state_path",
    "max_ttl_seconds", "max_runtime_seconds",
}


def load_config(path: Path, fs: TrustedFiles, *, require_state: bool = True,
                raw: bytes | None = None) -> dict[str, Any]:
    cfg = json_object(fs.read(path, private=True) if raw is None else raw)
    exact_keys(cfg, CONFIG_KEYS, "ADMIN_CONFIG_FIELDS")
    if cfg["schema"] != CONFIG_SCHEMA or not NODE.fullmatch(str(cfg["node_uid"])):
        fail("ADMIN_CONFIG_SCHEMA")
    if not HEX.fullmatch(str(cfg["subject_ref"])) or not HEX.fullmatch(str(cfg["generation"])):
        fail("ADMIN_CONFIG_BINDING")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(cfg["profile_generation"])):
        fail("ADMIN_CONFIG_BINDING")
    if cfg["audience_ref"] != "ghostfleet-approved-admin-command/v1":
        fail("ADMIN_CONFIG_AUDIENCE")
    for key in ("max_ttl_seconds", "max_runtime_seconds"):
        if type(cfg[key]) is not int or not 1 <= cfg[key] <= 900:
            fail("ADMIN_CONFIG_BOUNDS")
    if (not isinstance(cfg["issuer_keys"], dict) or not 1 <= len(cfg["issuer_keys"]) <= 16):
        fail("ADMIN_CONFIG_ISSUERS")
    for issuer, public in cfg["issuer_keys"].items():
        if not ISSUER.fullmatch(issuer):
            fail("ADMIN_CONFIG_ISSUER")
        b64(public, 32, 32)
    for key in ("state_dir", "python_executable", "helper_path", "node_report_path", "control_state_path"):
        string(cfg[key])
        if not Path(cfg[key]).is_absolute():
            fail("ADMIN_CONFIG_PATH")
    # Both existing canonical identities remain authority. A request cannot
    # manufacture a node or substitute a new generation.
    report = json_object(fs.read(Path(cfg["node_report_path"])))
    state = json_object(fs.read(Path(cfg["control_state_path"])))
    if report.get("node_uid") != cfg["node_uid"]:
        fail("ADMIN_LOCAL_NODE_MISMATCH")
    if (state.get("schema") != "youling-fleet-privileged-operations-local/v2"
            or state.get("ops_user") != OPS_USER
            or state.get("generation") != cfg["generation"]
            or state.get("profile_generation") != cfg["profile_generation"]):
        fail("ADMIN_LOCAL_GENERATION_MISMATCH")
    if require_state:
        fs.path(Path(cfg["state_dir"]), kind="dir", private=True)
    else:
        fs.path(Path(cfg["state_dir"]).parent, kind="dir")
    return cfg


LEASE_KEYS = {
    "schema", "lease_id", "request_id", "operation_id", "operation", "issuer_id",
    "node_uid", "subject_ref", "audience_ref", "generation", "profile_generation",
    "work_ref", "purpose", "approval_ref", "rollback_ref",
    "issued_at", "not_before", "expires_at", "max_uses", "max_runtime_seconds",
    "command",
}
WIRE_KEYS = {"schema", "action", "node_uid", "actor_ref", "lease_b64", "signature_b64"}


def verify_request(wire: Any, cfg: dict[str, Any], fs: TrustedFiles, *,
                   now: float, check_time: bool = True,
                   check_command_files: bool = True) -> tuple[dict[str, Any], bytes]:
    exact_keys(wire, WIRE_KEYS, "ADMIN_WIRE_FIELDS")
    if wire["schema"] != WIRE_SCHEMA or wire["action"] not in {"execute", "status", "cancel"}:
        fail("ADMIN_WIRE_SCHEMA")
    if wire["node_uid"] != cfg["node_uid"] or wire["actor_ref"] != cfg["subject_ref"]:
        fail("ADMIN_AUTHENTICATED_ACTOR_OR_NODE_MISMATCH")
    raw = b64(wire["lease_b64"], MAX_LEASE)
    signature = b64(wire["signature_b64"], 64, 64)
    lease = json_object(raw, MAX_LEASE)
    exact_keys(lease, LEASE_KEYS, "ADMIN_LEASE_FIELDS")
    if lease["schema"] != LEASE_SCHEMA or lease["operation"] != "admin.command":
        fail("ADMIN_LEASE_SCHEMA")
    issuer = lease["issuer_id"]
    if not isinstance(issuer, str) or issuer not in cfg["issuer_keys"]:
        fail("ADMIN_ISSUER_UNTRUSTED")
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.exceptions import InvalidSignature
    except ImportError:
        fail("ADMIN_SIGNATURE_BACKEND_UNAVAILABLE")
    try:
        Ed25519PublicKey.from_public_bytes(b64(cfg["issuer_keys"][issuer], 32, 32)).verify(signature, DOMAIN + raw)
    except (InvalidSignature, ValueError):
        fail("ADMIN_SIGNATURE_INVALID")
    for key in ("node_uid", "subject_ref", "audience_ref"):
        if lease[key] != cfg[key]:
            fail("ADMIN_LEASE_BINDING_MISMATCH")
    if check_time and (lease["generation"] != cfg["generation"]
                       or lease["profile_generation"] != cfg["profile_generation"]):
        fail("ADMIN_GENERATION_STALE")
    if (not HEX.fullmatch(str(lease["generation"]))
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(lease["profile_generation"]))):
        fail("ADMIN_GENERATION_INVALID")
    for key in ("lease_id", "request_id", "operation_id", "approval_ref"):
        if not isinstance(lease[key], str) or not REF.fullmatch(lease[key]):
            fail("ADMIN_REFERENCE_INVALID")
    for key in ("work_ref", "purpose", "rollback_ref"):
        string(lease[key], 1024)
    for key in ("issued_at", "not_before", "expires_at", "max_uses", "max_runtime_seconds"):
        if type(lease[key]) is not int:
            fail("ADMIN_LEASE_INTEGER")
    if (lease["max_uses"] != 1
            or not lease["issued_at"] <= lease["not_before"] < lease["expires_at"]
            or lease["expires_at"] - lease["issued_at"] > cfg["max_ttl_seconds"]
            or not 1 <= lease["max_runtime_seconds"] <= cfg["max_runtime_seconds"]):
        fail("ADMIN_LEASE_BOUNDS")
    if check_time and not lease["not_before"] <= now < lease["expires_at"]:
        fail("ADMIN_LEASE_EXPIRED_OR_NOT_YET_VALID")
    allowed_cmd_keys = {"argv", "cwd", "env", "executable_sha256", "output"}
    has_limit = isinstance(lease["command"], dict) and "output_limit_bytes" in lease["command"]
    if has_limit:
        allowed_cmd_keys = {"argv", "cwd", "env", "executable_sha256", "output", "output_limit_bytes"}
    command = exact_keys(lease["command"], allowed_cmd_keys, "ADMIN_COMMAND_FIELDS")
    argv = command["argv"]
    if not isinstance(argv, list) or not 1 <= len(argv) <= 64:
        fail("ADMIN_ARGV_INVALID")
    for arg in argv:
        string(arg)
    if sum(len(arg.encode("utf-8")) for arg in argv) > 8192 or not Path(argv[0]).is_absolute():
        fail("ADMIN_ARGV_BOUNDS")
    string(command["cwd"])
    if not Path(command["cwd"]).is_absolute() or not HEX.fullmatch(str(command["executable_sha256"])):
        fail("ADMIN_COMMAND_PATH_OR_DIGEST")
    if command["output"] not in {"discard", "bounded"}:
        fail("ADMIN_OUTPUT_POLICY")
    if has_limit:
        limit = command["output_limit_bytes"]
        if type(limit) is not int or not 1024 <= limit <= 32768:
            fail("ADMIN_OUTPUT_LIMIT_BOUNDS")
    env = command["env"]
    if not isinstance(env, dict) or len(env) > 16:
        fail("ADMIN_ENV_INVALID")
    for key, value in env.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", key) or ENV_DENY.fullmatch(key):
            fail("ADMIN_ENV_FORBIDDEN")
        string(value, 1024)
    if check_command_files:
        fs.path(Path(command["cwd"]), kind="dir")
        if fs.executable_digest(Path(argv[0])) != command["executable_sha256"]:
            fail("ADMIN_EXECUTABLE_DIGEST_MISMATCH")
    return lease, raw


class Ledger:
    def __init__(self, root: Path, fs: TrustedFiles):
        self.root = fs.path(root, kind="dir", private=True)
        self.fs = fs
        self.fs.mkdir(root / "locks")
        self.fs.mkdir(root / "leases")

    @staticmethod
    def key(lease_id: str) -> str:
        return digest(lease_id.encode("utf-8"))

    @contextlib.contextmanager
    def locked(self, key: str):
        if not HEX.fullmatch(key):
            fail("ADMIN_LEDGER_KEY")
        path = self.root / "locks" / (key + ".lock")
        self.fs.path(path.parent, kind="dir", private=True)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            info = os.fstat(fd)
            if (info.st_uid != self.fs.owner_uid or not stat.S_ISREG(info.st_mode)
                    or stat.S_IMODE(info.st_mode) != 0o600):
                fail("ADMIN_LOCK_UNTRUSTED")
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def read(self, key: str) -> dict[str, Any] | None:
        path = self.root / "leases" / (key + ".json")
        if not path.exists() and not path.is_symlink():
            return None
        record = json_object(self.fs.read(path, private=True))
        if record.get("schema") != "ghostfleet-admin-ledger/v1" or record.get("lease_key") != key:
            fail("ADMIN_LEDGER_CORRUPT")
        return record

    def write(self, key: str, record: dict[str, Any]) -> None:
        self.fs.write(self.root / "leases" / (key + ".json"), record)


def public_receipt(lease: dict[str, Any], raw: bytes, record: dict[str, Any] | None,
                   duplicate: bool = False) -> dict[str, Any]:
    state = record["state"] if record else "NOT_FOUND"
    cmd_output = lease["command"].get("output", "discard")
    receipt_output = "bounded" if cmd_output == "bounded" else "discarded"
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "lease_id": lease["lease_id"], "request_id": lease["request_id"],
        "operation_id": lease["operation_id"], "node_uid": lease["node_uid"],
        "actor_ref": lease["subject_ref"], "lease_digest": digest(raw),
        "command_digest": digest(canonical(lease["command"])),
        "state": state, "duplicate": duplicate, "retry_safe": False,
        "reconcile_required": state in {"RESERVED", "STARTED", "UNKNOWN"},
        "exit_code": record.get("exit_code") if record else None,
        "execution_privilege": "root" if record and record.get("started") else None,
        "output": receipt_output,
        "persistent_effects_rolled_back": False,
        "code": record.get("code") if record else None,
    }
    if receipt_output == "bounded" and record:
        for field in ("stdout_bytes", "stderr_bytes", "output_bytes", "truncated", "output_sha256"):
            if field in record:
                receipt[field] = record[field]
    return receipt


class SystemdBackend:
    """Short RPCs; the command and deadline survive the SSH helper process."""
    SYSTEMCTL = "/usr/bin/systemctl"
    SYSTEMD_RUN = "/usr/bin/systemd-run"
    INGRESS_PYTHON = "/usr/bin/python3"
    SIGNATURE_IMPORT = ("import cryptography; "
                        "from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey; "
                        "assert cryptography.__version__ == '50.0.2'")
    CGROUP_BASE = Path("/sys/fs/cgroup/system.slice")

    def __init__(self, cfg: dict[str, Any], config_path: Path, fs: TrustedFiles):
        self.cfg, self.config_path, self.fs = cfg, config_path, fs

    def _run(self, argv: list[str], timeout: float = 8) -> str:
        try:
            result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, env=SAFE_ENV, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            fail("ADMIN_SYSTEMD_OUTCOME_UNKNOWN")
        if result.returncode != 0 or len(result.stdout) > 32768:
            fail("ADMIN_SYSTEMD_REJECTED")
        return result.stdout.decode("utf-8", "strict")

    def preflight(self) -> None:
        if os.geteuid() != 0:
            fail("ADMIN_ROOT_REQUIRED")
        try:
            if Path("/proc/1/comm").read_text().strip() != "systemd":
                fail("ADMIN_SYSTEMD_REQUIRED")
            self.fs.path(Path("/run/systemd/system"), kind="dir")
            if not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
                fail("ADMIN_CGROUP_V2_REQUIRED")
            if os.statvfs("/sys/fs/cgroup").f_flag & os.ST_RDONLY:
                fail("ADMIN_CGROUP_READONLY")
        except OSError:
            fail("ADMIN_SYSTEMD_REQUIRED")
        for path in (self.SYSTEMCTL, self.SYSTEMD_RUN, self.cfg["python_executable"]):
            self.fs.path(Path(path), executable=True)
        self.fs.path(Path(self.cfg["helper_path"]))
        self.fs.path(self.config_path, private=True)
        version = self._run([self.SYSTEMCTL, "--version"]).splitlines()[0]
        match = re.match(r"systemd (\d+)", version)
        if not match or int(match[1]) < 250:
            fail("ADMIN_SYSTEMD_VERSION")
        self._run([self.SYSTEMCTL, "show", "--property=Version", "--no-pager"])
        # Validate the same root-managed interpreter used by the transient unit.
        self._run([self.cfg["python_executable"], "-I", "-c", self.SIGNATURE_IMPORT])

    def ingress_preflight(self) -> None:
        # fleet_privctl's installed shebang is fixed to this interpreter. A
        # configured child venv cannot supply imports to the SSH ingress.
        self.fs.path(Path(self.INGRESS_PYTHON), executable=True)
        self._run([self.INGRESS_PYTHON, "-I", "-c", self.SIGNATURE_IMPORT])

    @staticmethod
    def unit(key: str) -> str:
        if not HEX.fullmatch(key):
            fail("ADMIN_UNIT_KEY")
        return "ghostfleet-admin-" + key + ".service"

    @staticmethod
    def timer(key: str) -> str:
        return "ghostfleet-admin-deadline-" + key

    def start(self, key: str, deadline: int, max_runtime_seconds: int) -> None:
        unit, timer = self.unit(key), self.timer(key)
        runtime_ms = min(max_runtime_seconds * 1000, int((deadline - time.time()) * 1000))
        if runtime_ms <= 0:
            fail("ADMIN_DEADLINE_BEFORE_DISPATCH")
        # Absolute deadline is installed before command dispatch. A late child
        # independently checks this same deadline, so firing before start does
        # not create a window for execution after expiry.
        self._run([
            self.SYSTEMD_RUN, "--quiet", "--unit=" + timer,
            "--on-calendar=@" + str(deadline),
            "--timer-property=AccuracySec=1us", "--timer-property=RandomizedDelaySec=0",
            "--property=User=root", "--property=Group=root",
            "--property=StandardOutput=null", "--property=StandardError=null",
            "--", self.SYSTEMCTL, "kill", "--kill-who=all", "--signal=KILL", unit,
        ])
        self._run([
            self.SYSTEMD_RUN, "--quiet", "--unit=" + unit, "--service-type=exec",
            "--property=User=root", "--property=Group=root",
            "--property=ExitType=cgroup", "--property=RemainAfterExit=yes",
            "--property=Slice=system.slice",
            "--property=KillMode=control-group", "--property=TimeoutStopSec=2s",
            "--property=SendSIGKILL=yes", "--property=Restart=no",
            "--property=RuntimeMaxSec=" + str(runtime_ms) + "ms",
            "--property=StandardOutput=null", "--property=StandardError=null",
            "--property=UMask=0077", "--property=WorkingDirectory=/",
            "--", self.cfg["python_executable"], "-I", self.cfg["helper_path"],
            "--child", str(self.config_path), key,
        ])

    def observe(self, key: str) -> dict[str, str]:
        raw = self._run([self.SYSTEMCTL, "show", self.unit(key),
                         "--property=LoadState,ActiveState,SubState,Result,MainPID",
                         "--no-pager"])
        fields = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        if fields.get("LoadState") == "not-found":
            return {"state": "UNKNOWN"}
        if fields.get("ActiveState") == "failed":
            return {"state": "UNKNOWN"}
        return {"state": "STARTED"}

    def _cgroup_empty(self, key: str) -> bool:
        # The start request fixes Slice=system.slice. A missing/failed main PID
        # says nothing about detached descendants; kernel cgroup facts do.
        try:
            self.fs.path(self.CGROUP_BASE, kind="dir")
            group = self.CGROUP_BASE / self.unit(key)
            if not group.exists() and not group.is_symlink():
                return True
            self.fs.path(group, kind="dir")
            events = dict(line.split() for line in (group / "cgroup.events").read_text().splitlines())
            if events.get("populated") != "0":
                return False
            count = 0
            for directory, subdirs, files in os.walk(group, followlinks=False):
                count += 1
                if count > 1024:
                    return False
                for subdir in subdirs:
                    self.fs.path(Path(directory) / subdir, kind="dir")
                if "cgroup.procs" not in files or (Path(directory) / "cgroup.procs").read_text().strip():
                    return False
            return True
        except (OSError, ValueError, AdminError):
            return False

    def stop(self, key: str) -> bool:
        unit = self.unit(key)
        # Stop (not merely kill the original PID) covers detached descendants.
        try:
            self._run([self.SYSTEMCTL, "stop", unit], timeout=8)
            raw = self._run([self.SYSTEMCTL, "show", unit,
                             "--property=LoadState,ActiveState,MainPID,ControlGroup", "--no-pager"])
            fields = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
            expected = "/system.slice/" + unit
            group_matches = fields.get("ControlGroup", "") in {"", expected}
            stopped = (fields.get("LoadState") == "not-found"
                       or (fields.get("ActiveState") in {"inactive", "failed"}
                           and fields.get("MainPID", "0") == "0"))
            confirmed = group_matches and stopped and self._cgroup_empty(key)
        except AdminError:
            return False
        if confirmed:
            # A failed deadline timer is harmless after confirmed stop; cleanup
            # failure must not erase the operation's durable record.
            try:
                self._run([self.SYSTEMCTL, "stop", self.timer(key) + ".timer"])
            except AdminError:
                pass
        return confirmed


class Executor:
    def __init__(self, config_path: Path, fs: TrustedFiles | None = None,
                 backend: Any = None, clock: Any = time.time):
        self.fs = fs or TrustedFiles()
        self.config_path = config_path
        self._injected_backend = backend
        self.clock = clock
        with authority_locked(self.config_path, self.fs):
            self._reload()

    def _reload(self) -> None:
        # A long-lived controller object is never a cache of authority. Re-read
        # under the same lock used by installer apply/rollback and child start.
        self.cfg = load_config(self.config_path, self.fs)
        self.ledger = Ledger(Path(self.cfg["state_dir"]), self.fs)
        self.backend = self._injected_backend or SystemdBackend(self.cfg, self.config_path, self.fs)

    def handle(self, wire: dict[str, Any]) -> dict[str, Any]:
        stop_plan = None
        with authority_locked(self.config_path, self.fs):
            self._reload()
            action = wire.get("action") if isinstance(wire, dict) else None
            lease, raw = verify_request(wire, self.cfg, self.fs, now=self.clock(),
                                        check_time=action == "execute",
                                        check_command_files=action == "execute")
            key = self.ledger.key(lease["lease_id"])
            if action == "execute":
                self.backend.preflight()
            with self.ledger.locked(key):
                record = self.ledger.read(key)
                if record and record.get("lease_digest") != digest(raw):
                    fail("ADMIN_LEASE_ID_CONFLICT")
                if action == "status":
                    if record and record["state"] not in TERMINAL:
                        if self.clock() >= record["deadline"] or time.monotonic() >= record["monotonic_deadline"]:
                            # Publish an admission barrier before releasing the
                            # locks for OS stop; installer must see unresolved.
                            record.update(state="UNKNOWN", revoked=True, code="ADMIN_DEADLINE_REACHED")
                            self.ledger.write(key, record)
                            stop_plan = (self.backend, "EXPIRED", "ADMIN_DEADLINE_REACHED")
                        else:
                            observed = self.backend.observe(key)
                            if observed["state"] == "UNKNOWN":
                                record.update(state="UNKNOWN", code="ADMIN_RECONCILE_REQUIRED")
                            self.ledger.write(key, record)
                    if stop_plan is None:
                        return public_receipt(lease, raw, record)
                elif action == "cancel":
                    if record and record["state"] in TERMINAL:
                        return public_receipt(lease, raw, record, duplicate=True)
                    if record is None:
                        record = self._record(key, wire, lease, raw)
                        record.update(state="REVOKED", revoked=True, code="ADMIN_REVOKED_BEFORE_DISPATCH")
                        self.ledger.write(key, record)
                        return public_receipt(lease, raw, record)
                    record.update(state="UNKNOWN", revoked=True, code="ADMIN_REVOCATION_REQUESTED")
                    self.ledger.write(key, record)
                    stop_plan = (self.backend, "REVOKED", "ADMIN_REVOKED")
                elif record is not None:
                    return public_receipt(lease, raw, record, duplicate=True)
                else:
                    record = self._record(key, wire, lease, raw)
                    self.ledger.write(key, record)
                    if self.clock() >= record["deadline"] or time.monotonic() >= record["monotonic_deadline"]:
                        record.update(state="EXPIRED", code="ADMIN_DEADLINE_BEFORE_DISPATCH")
                    else:
                        try:
                            self.backend.start(key, record["deadline"], lease["max_runtime_seconds"])
                            record.update(state="STARTED", started=True)
                        except Exception:
                            record.update(state="UNKNOWN", code="ADMIN_DISPATCH_OUTCOME_UNKNOWN")
                    self.ledger.write(key, record)
                    return public_receipt(lease, raw, record)
        # OS stop can wait for process exit. Admission is already revoked and
        # durable UNKNOWN prevents configuration changes during this interval.
        backend, terminal, code = stop_plan
        try:
            stopped = backend.stop(key)
        except Exception:
            stopped = False
        with authority_locked(self.config_path, self.fs):
            self._reload()
            with self.ledger.locked(key):
                current = self.ledger.read(key)
                if not current or current.get("lease_digest") != digest(raw):
                    fail("ADMIN_RECONCILE_RECORD_CHANGED")
                if current["state"] not in TERMINAL:
                    current.update(state=terminal if stopped else "UNKNOWN", code=code if stopped else "ADMIN_CANCEL_OUTCOME_UNKNOWN")
                    self.ledger.write(key, current)
                return public_receipt(lease, raw, current)

    def get_output(self, wire: dict[str, Any]) -> dict[str, str] | None:
        try:
            lease, _ = verify_request(wire, self.cfg, self.fs, now=self.clock(),
                                      check_time=False, check_command_files=False)
            key = self.ledger.key(lease["lease_id"])
            with self.ledger.locked(key):
                record = self.ledger.read(key)
                if record and "stdout" in record and "stderr" in record:
                    return {"stdout": record["stdout"], "stderr": record["stderr"]}
        except Exception:
            pass
        return None

    def _record(self, key: str, wire: dict[str, Any], lease: dict[str, Any], raw: bytes) -> dict[str, Any]:
        return {
            "schema": "ghostfleet-admin-ledger/v1", "lease_key": key,
            "lease_digest": digest(raw), "state": "RESERVED", "consumed": True,
            "wire": wire, "started": False, "revoked": False, "exit_code": None,
            "deadline": min(lease["expires_at"], int(self.clock()) + lease["max_runtime_seconds"]),
            "monotonic_deadline": time.monotonic() + max(0, min(
                lease["expires_at"] - self.clock(), lease["max_runtime_seconds"])),
        }


def handle_request(wire: dict[str, Any], ops_user: str) -> dict[str, Any]:
    if os.geteuid() != 0 or ops_user != OPS_USER:
        return {"ok": False, "error": "ADMIN_DEDICATED_OPS_REQUIRED"}
    try:
        executor = Executor(DEFAULT_CONFIG)
        receipt = executor.handle(wire)
        result: dict[str, Any] = {"ok": True, "receipt": receipt}
        if receipt.get("output") == "bounded":
            output_data = executor.get_output(wire)
            if output_data is not None:
                result["output"] = output_data
        return result
    except AdminError as error:
        return {"ok": False, "error": error.code}
    except Exception:
        return {"ok": False, "error": "ADMIN_INTERNAL_ERROR"}


def _other_unit_processes(key: str) -> bool:
    prefix = "0::"
    groups = [line[len(prefix):] for line in Path("/proc/self/cgroup").read_text().splitlines()
              if line.startswith(prefix)]
    expected = SystemdBackend.unit(key)
    if len(groups) != 1 or not groups[0].endswith("/" + expected) or ".." in groups[0].split("/"):
        fail("ADMIN_CHILD_CGROUP_MISMATCH")
    root = Path("/sys/fs/cgroup") / groups[0].lstrip("/")
    visited = 0
    for directory, _, files in os.walk(root):
        visited += 1
        if visited > 1024:
            fail("ADMIN_CGROUP_TREE_LIMIT")
        if "cgroup.procs" in files:
            for pid in (Path(directory) / "cgroup.procs").read_text().split():
                if int(pid) != os.getpid():
                    return True
    return False


def _capture_bounded_output(process: subprocess.Popen, limit_bytes: int,
                            deadline_monotonic: float) -> tuple[int, bytes, bytes, bool]:
    import select
    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []
    total_bytes = 0
    truncated = False

    for stream in (process.stdout, process.stderr):
        if stream:
            os.set_blocking(stream.fileno(), False)

    active_readers = {}
    if process.stdout:
        active_readers[process.stdout.fileno()] = ("stdout", process.stdout)
    if process.stderr:
        active_readers[process.stderr.fileno()] = ("stderr", process.stderr)

    while active_readers:
        remaining_time = deadline_monotonic - time.monotonic()
        if remaining_time <= 0:
            raise subprocess.TimeoutExpired(cmd=process.args, timeout=0)
        readable, _, _ = select.select(list(active_readers.keys()), [], [], min(max(0.001, remaining_time), 0.1))
        if not readable:
            if process.poll() is not None:
                break
            continue
        for fd in readable:
            channel, stream = active_readers[fd]
            try:
                chunk = os.read(fd, 4096)
            except (BlockingIOError, OSError):
                chunk = b""
            if not chunk:
                del active_readers[fd]
                continue
            if total_bytes < limit_bytes:
                space = limit_bytes - total_bytes
                if len(chunk) <= space:
                    (out_chunks if channel == "stdout" else err_chunks).append(chunk)
                    total_bytes += len(chunk)
                else:
                    (out_chunks if channel == "stdout" else err_chunks).append(chunk[:space])
                    total_bytes += space
                    truncated = True
            else:
                truncated = True

    for fd, (channel, stream) in list(active_readers.items()):
        try:
            while True:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                if total_bytes < limit_bytes:
                    space = limit_bytes - total_bytes
                    if len(chunk) <= space:
                        (out_chunks if channel == "stdout" else err_chunks).append(chunk)
                        total_bytes += len(chunk)
                    else:
                        (out_chunks if channel == "stdout" else err_chunks).append(chunk[:space])
                        total_bytes += space
                        truncated = True
                else:
                    truncated = True
        except (BlockingIOError, OSError):
            pass

    for stream in (process.stdout, process.stderr):
        if stream:
            try:
                stream.close()
            except OSError:
                pass

    remaining_time = deadline_monotonic - time.monotonic()
    if remaining_time <= 0 and process.poll() is None:
        raise subprocess.TimeoutExpired(cmd=process.args, timeout=0)
    exit_code = process.wait(timeout=max(0.001, remaining_time))
    return exit_code, b"".join(out_chunks), b"".join(err_chunks), truncated


def child(config_path: Path, key: str) -> int:
    """Only systemd calls this root-only wrapper; caller-controlled CLI is absent."""
    if os.geteuid() != 0 or not HEX.fullmatch(key):
        return 77
    fs = TrustedFiles()
    with authority_locked(config_path, fs):
        cfg = load_config(config_path, fs)
        ledger = Ledger(Path(cfg["state_dir"]), fs)
        with ledger.locked(key):
            record = ledger.read(key)
            if not record or record["state"] not in {"RESERVED", "STARTED"} or record.get("revoked"):
                return 77
            lease, raw = verify_request(record["wire"], cfg, fs, now=time.time())
            if (digest(raw) != record["lease_digest"] or time.time() >= record["deadline"]
                    or time.monotonic() >= record["monotonic_deadline"]):
                return 77
            if ledger.key(lease["lease_id"]) != key:
                return 77
            command = lease["command"]
            output_mode = command.get("output", "discard")
            output_limit = command.get("output_limit_bytes", 32768)
            # Cancellation and command start share the same admission lock. A
            # cancellation that commits first prevents even a new child process.
            _other_unit_processes(key)
            if time.time() >= record["deadline"] or time.monotonic() >= record["monotonic_deadline"]:
                return 77
            # The approved argv never appears in systemd's command line or receipt.
            if output_mode == "bounded":
                process = subprocess.Popen(
                    command["argv"], cwd=command["cwd"], env={**SAFE_ENV, **command["env"]},
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    close_fds=True,
                )
            else:
                process = subprocess.Popen(
                    command["argv"], cwd=command["cwd"], env={**SAFE_ENV, **command["env"]},
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    close_fds=True,
                )
            record.update(state="STARTED", started=True)
            ledger.write(key, record)
    try:
        if output_mode == "bounded":
            exit_code, out_raw, err_raw, truncated = _capture_bounded_output(
                process, output_limit, record["monotonic_deadline"]
            )
        else:
            exit_code = process.wait(timeout=max(0.001, record["monotonic_deadline"] - time.monotonic()))
            out_raw, err_raw, truncated = b"", b"", False
    except subprocess.TimeoutExpired:
        # This process is in the unit being stopped. Publish uncertainty before
        # requesting cgroup stop; an external status call confirms emptiness.
        with authority_locked(config_path, fs):
            with ledger.locked(key):
                current = ledger.read(key)
                if current and current["state"] not in TERMINAL:
                    current.update(state="UNKNOWN", code="ADMIN_RUNTIME_EXPIRED")
                    ledger.write(key, current)
        SystemdBackend(cfg, config_path, fs).stop(key)
        return 78
    # A daemonized/setsid child remains in the unit cgroup. Do not report
    # completion while descendants continue running.
    while _other_unit_processes(key):
        if time.time() >= record["deadline"] or time.monotonic() >= record["monotonic_deadline"]:
            SystemdBackend(cfg, config_path, fs).stop(key)
            return 78  # Independent systemd deadline still kills the full unit.
        time.sleep(0.05)
    with authority_locked(config_path, fs):
        with ledger.locked(key):
            current = ledger.read(key)
            if current and not current.get("revoked") and current["state"] not in TERMINAL:
                update_fields: dict[str, Any] = {
                    "state": "SUCCEEDED" if exit_code == 0 else "FAILED",
                    "started": True, "exit_code": exit_code, "code": None,
                }
                if output_mode == "bounded":
                    out_text = out_raw.decode("utf-8", errors="replace")
                    err_text = err_raw.decode("utf-8", errors="replace")
                    out_b = len(out_text.encode("utf-8"))
                    err_b = len(err_text.encode("utf-8"))
                    tot_b = out_b + err_b
                    if tot_b > output_limit:
                        truncated = True
                        if out_b >= output_limit:
                            out_text = out_text.encode("utf-8")[:output_limit].decode("utf-8", errors="ignore")
                            err_text = ""
                        else:
                            rem = output_limit - out_b
                            err_text = err_text.encode("utf-8")[:rem].decode("utf-8", errors="ignore")
                        out_b = len(out_text.encode("utf-8"))
                        err_b = len(err_text.encode("utf-8"))
                        tot_b = out_b + err_b
                    digest_val = digest((out_text + err_text).encode("utf-8"))
                    update_fields.update({
                        "stdout": out_text,
                        "stderr": err_text,
                        "stdout_bytes": out_b,
                        "stderr_bytes": err_b,
                        "output_bytes": tot_b,
                        "truncated": truncated,
                        "output_sha256": digest_val,
                    })
                current.update(update_fields)
                ledger.write(key, current)
    return 0


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--child":
            raise SystemExit(child(Path(sys.argv[2]), sys.argv[3]))
        raise SystemExit(64)
    except AdminError:
        # No command, payload, exception details or stdout/stderr are exposed.
        raise SystemExit(77)
