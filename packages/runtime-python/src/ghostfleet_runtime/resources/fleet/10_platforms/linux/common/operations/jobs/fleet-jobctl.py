#!/usr/bin/env python3
"""Fleet #129 rootless, node-local systemd job receipts. No listening daemon."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import time
import uuid

PROTOCOL = "fleet-job/v1"
NODE_RE = re.compile(r"node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
ACTOR_RE = re.compile(r"[0-9a-f]{64}")
ID_RE = re.compile(r"oj1-([0-9]{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})")
HANDLE_RE = re.compile(r"fj1-[0-9a-f]{64}")
SLOT_RE = re.compile(r"0|[1-9][0-9]{0,19}")
MAX_STORAGE = 70 * 1024 * 1024
MAX_ACTIVE = 4
MAX_OUTPUT = 4 * 1024 * 1024
MAX_META = 64 * 1024
MAX_REQUEST = 16 * 1024
MAX_READ = 32 * 1024
MAX_RUNTIME = 4 * 3600
RETENTION = 24 * 3600
SUBMIT_WINDOW = 300
RPC_SECONDS = 10
MEMORY_BYTES = 512 * 1024 * 1024
TASKS_MAX = 64
TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"}


class JobError(Exception):
    pass


def fail(code):
    raise JobError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def runtime_uid():
    if sys.platform != "linux" or not hasattr(os, "geteuid"):
        fail("LINUX_REQUIRED")
    uid = os.geteuid()
    if uid == 0 or os.getuid() != uid:
        fail("NORMAL_USER_REQUIRED")
    return uid


def remaining(deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        fail("RPC_DEADLINE")
    return left


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail("STATE_DIRECTORY_INVALID")
    if hasattr(os, "geteuid") and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
        fail("STATE_DIRECTORY_PERMISSIONS")


def open_receipt(path):
    """Read one immutable receipt generation without preventing replacement.

    POSIX readers keep the old inode after rename. The Windows CRT defaults
    omit FILE_SHARE_DELETE, so a concurrent reader otherwise rejects the
    writer's os.replace even though the writers hold their correct slot lock.
    """
    if sys.platform != "win32":
        return path.open("rb")
    import ctypes
    from ctypes import wintypes
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = (wintypes.HANDLE,)
    close.restype = wintypes.BOOL
    # GENERIC_READ; SHARE_READ | SHARE_WRITE | SHARE_DELETE; OPEN_EXISTING.
    handle = create(str(path), 0x80000000, 0x7, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY | os.O_NOINHERIT)
    except BaseException:
        close(handle)
        raise
    try:
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def load(path):
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_META:
            fail("STATE_FILE_INVALID")
        with open_receipt(path) as stream:
            data = stream.read(MAX_META + 1)
        value = json.loads(data)
        if len(data) > MAX_META or not isinstance(value, dict):
            fail("STATE_FILE_INVALID")
        return value
    except (OSError, ValueError):
        fail("STATE_FILE_INVALID")


def atomic(path, value):
    data = canonical(value)
    if len(data) > MAX_META:
        fail("STATE_FILE_TOO_LARGE")
    tmp = path.with_suffix(".tmp")
    # One writer per file: RPC metadata uses its slot lock; runner has an
    # exclusive launch claim. A fixed tmp name bounds crash debris.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    if sys.platform == "win32" and path.exists():
        # MoveFileExW (os.replace) still refuses replacement of an open target
        # on Windows. ReplaceFileW supports the shared-delete reader above.
        # Slot/admission ownership guarantees a single writer of this receipt.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        replace = kernel.ReplaceFileW
        replace.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                            wintypes.DWORD, wintypes.LPVOID, wintypes.LPVOID)
        replace.restype = wintypes.BOOL
        if not replace(str(path), str(tmp), None, 0, None, None):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.replace(tmp, path)
    if sys.platform == "linux":
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


@contextmanager
def locked(path, deadline):
    """Bounded non-blocking advisory lock, including Windows unit fixtures."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    acquired = False
    try:
        if os.fstat(fd).st_size == 0:
            os.write(fd, b"0")
        until = min(deadline, time.monotonic() + 1)
        while True:
            try:
                if sys.platform == "win32":
                    import msvcrt
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError:
                if time.monotonic() >= until:
                    fail("JOB_BUSY")
                time.sleep(min(0.01, remaining(until)))
        yield
    finally:
        if acquired:
            if sys.platform == "win32":
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def boot_id():
    try:
        value = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        if str(uuid.UUID(value)) != value:
            raise ValueError
        return value
    except (OSError, ValueError):
        fail("BOOT_ID_UNAVAILABLE")


class Systemd:
    def __init__(self, uid):
        self.uid = uid

    def call(self, argv, deadline):
        try:
            return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, timeout=min(8, remaining(deadline)),
                                  check=False, env={**os.environ, "SYSTEMD_PAGER": "", "LC_ALL": "C"})
        except (OSError, subprocess.TimeoutExpired):
            fail("SYSTEMD_OUTCOME_UNKNOWN")

    def submit(self, root, slot, meta, deadline):
        # Only fixed helper arguments cross systemd's environment expansion.
        # Requested argv is read from the private spec file by the runner.
        argv = ["/usr/bin/systemd-run", "--user", "--quiet", "--service-type=exec",
                "--remain-after-exit", f"--unit={meta['unit']}", f"--description={meta['marker']}",
                "--property=ExitType=cgroup", "--property=KillMode=control-group",
                "--property=Restart=no", "--property=SendSIGKILL=yes", "--property=TimeoutStopSec=5s",
                f"--property=RuntimeMaxSec={meta['runtime_seconds']}s",
                f"--property=MemoryMax={MEMORY_BYTES}", "--property=MemorySwapMax=0",
                f"--property=TasksMax={TASKS_MAX}", "--property=CPUQuota=100%",
                "--property=NoNewPrivileges=yes", "--property=StandardOutput=null",
                "--property=StandardError=null", "--", sys.executable,
                str(Path(__file__).resolve()), "run", str(root), str(slot), meta["generation"]]
        if self.call(argv, deadline).returncode:
            fail("SYSTEMD_SUBMIT_UNKNOWN")

    def inspect(self, meta, deadline):
        fields = "Id,LoadState,ActiveState,SubState,Description,ControlGroup,MainPID,ControlPID,ExitType,KillMode"
        result = self.call(["/usr/bin/systemctl", "--user", "show", "--no-pager", f"--property={fields}", "--", meta["unit"]], deadline)
        if len(result.stdout) > 16384:
            fail("SYSTEMD_STATUS_INVALID")
        values = dict(line.split("=", 1) for line in result.stdout.decode("utf-8", "strict").splitlines() if "=" in line)
        if values.get("LoadState") == "not-found":
            return None
        if result.returncode or values.get("Id") != meta["unit"] or values.get("Description") != meta["marker"]:
            fail("JOB_UNIT_FOREIGN_OR_UNAVAILABLE")
        if values.get("ExitType") != "cgroup" or values.get("KillMode") != "control-group":
            fail("JOB_UNIT_PROPERTIES_CHANGED")
        return values

    def stop(self, meta, deadline):
        if self.call(["/usr/bin/systemctl", "--user", "stop", "--", meta["unit"]], deadline).returncode:
            fail("SYSTEMD_STOP_UNKNOWN")

    def retire(self, meta, deadline):
        if self.inspect(meta, deadline) is not None:
            self.stop(meta, deadline)
            # Failed transient units may remain pinned until their failure is
            # reset. Address only the previously verified exact owned unit.
            self.call(["/usr/bin/systemctl", "--user", "reset-failed", "--", meta["unit"]], deadline)
            if self.inspect(meta, deadline) is not None:
                fail("SYSTEMD_RETIRE_UNKNOWN")

    def empty(self, path, unit):
        """Kernel cgroup proof; access/mount/proc failures are never emptiness."""
        if not isinstance(path, str) or not path.startswith("/") or ".." in path.split("/"):
            return None
        if f"/user-{self.uid}.slice/" not in path or not path.endswith("/" + unit):
            return None
        base = Path("/sys/fs/cgroup")
        try:
            # A missing/unmounted cgroup hierarchy cannot prove deletion.
            (base / "cgroup.controllers").read_text()
            group = base / path.lstrip("/")
            try:
                events = dict(line.split() for line in (group / "cgroup.events").read_text().splitlines())
            except FileNotFoundError:
                try:
                    group.stat()
                except FileNotFoundError:
                    return True  # A cgroup can only be removed when empty.
                return None  # Group exists but required kernel evidence is absent.
            return {"0": True, "1": False}.get(events.get("populated"))
        except (OSError, ValueError):
            return None


class Jobs:
    def __init__(self, root, node_uid, backend, boot, now=time.time):
        if not NODE_RE.fullmatch(node_uid):
            fail("LOCAL_NODE_ID_INVALID")
        self.root, self.node, self.backend, self.boot, self.now = Path(root), node_uid, backend, boot, now
        private_dir(self.root)

    def path(self, slot, name):
        return self.root / str(slot) / name

    def records(self):
        for directory in self.root.iterdir():
            if not SLOT_RE.fullmatch(directory.name):
                continue
            private_dir(directory)
            slot = int(directory.name)
            path = self.path(slot, "meta.json")
            if path.exists():
                meta = load(path)
                if meta.get("protocol") != PROTOCOL or not HANDLE_RE.fullmatch(meta.get("handle", "")):
                    fail("JOB_METADATA_INVALID")
                generation = meta.get("generation")
                if meta.get("node_uid") != self.node:
                    fail("STATE_NODE_BINDING_MISMATCH")
                if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{32}", generation):
                    fail("JOB_METADATA_INVALID")
                if meta.get("unit") != f"fleet-job-{generation}.service" or meta.get("marker") != f"fleet-job-v1:{meta['handle']}:{generation}":
                    fail("JOB_METADATA_INVALID")
                yield slot, meta

    def storage_charge(self, records):
        # Reserve every possible JSON/temp file, and the full output allowance
        # until kernel-backed terminal proof says the writer has stopped.
        total = 0
        for slot, meta in records:
            output = self.path(slot, "output.bin")
            size = output.stat().st_size if output.exists() else 0
            if size > MAX_OUTPUT:
                fail("OUTPUT_BOUND_VIOLATED")
            total += 6 * MAX_META + (size if meta.get("terminal") in TERMINAL else MAX_OUTPUT)
        return total

    def locate(self, handle):
        if not isinstance(handle, str) or not HANDLE_RE.fullmatch(handle):
            fail("JOB_HANDLE_INVALID")
        for slot, meta in self.records():
            if meta["handle"] == handle:
                return slot, meta
        fail("JOB_NOT_FOUND")

    def bind(self, meta, actor, handle):
        if meta.get("handle") != handle or meta.get("node_uid") != self.node or meta.get("actor_ref") != actor:
            fail("JOB_BINDING_MISMATCH")

    def snapshot(self, slot, meta, deadline):
        state, reason, code = "UNKNOWN", "reconcile_required", None
        run = load(self.path(slot, "run.json")) if self.path(slot, "run.json").exists() else {}
        if run and run.get("generation") != meta["generation"]:
            fail("JOB_GENERATION_MISMATCH")
        if meta["boot_id"] != self.boot:
            state = meta.get("terminal") if meta.get("terminal") in TERMINAL else "INTERRUPTED"
            reason = "retained_terminal_receipt" if state != "INTERRUPTED" else "node_rebooted_no_replay"
            if state in {"SUCCEEDED", "FAILED"}:
                code = run.get("exit_code")
        else:
            unit = self.backend.inspect(meta, deadline)
            cgroup = unit.get("ControlGroup") if unit else None
            cgroup = cgroup or run.get("cgroup") or meta.get("cgroup")
            empty = self.backend.empty(cgroup, meta["unit"]) if cgroup else None
            if unit and unit.get("ActiveState") in {"active", "activating", "deactivating"} and unit.get("SubState") != "exited" and empty is not True:
                state, reason = "RUNNING", "os_unit_active"
            elif empty is True:
                if meta.get("cancel_requested"):
                    state, reason = "CANCELLED", "owned_cgroup_empty"
                elif run.get("finished") is True and type(run.get("exit_code")) is int:
                    code = run["exit_code"]
                    state, reason = ("SUCCEEDED" if code == 0 else "FAILED"), "command_exited_cgroup_empty"
                elif run:
                    state, reason = "INTERRUPTED", "owned_cgroup_empty_exit_receipt_missing"
            if cgroup and cgroup != meta.get("cgroup"):
                meta["cgroup"] = cgroup
        if state in TERMINAL:
            meta["terminal"] = state
        atomic(self.path(slot, "meta.json"), meta)
        output = self.path(slot, "output.bin")
        size = output.stat().st_size if output.exists() else 0
        if size > MAX_OUTPUT:
            fail("OUTPUT_BOUND_VIOLATED")
        return {"handle": meta["handle"], "generation": meta["generation"], "operation_id": meta["operation_id"],
                "spec_digest": meta["spec_digest"], "state": state, "reason": reason, "exit_code": code,
                "retry_submit": False, "reconcile_required": state in {"UNKNOWN", "INTERRUPTED"}, "output_bytes": size,
                "output_capped": size >= MAX_OUTPUT or self.path(slot, "capped").exists(), "expires_at": meta["expires_at"],
                "retention_until": meta["retention_until"]}

    def start(self, request, deadline):
        operation = request.get("operation_id")
        match = ID_RE.fullmatch(operation) if isinstance(operation, str) else None
        if not match:
            fail("OPERATION_ID_INVALID")
        actor = request["actor_ref"]
        argv = request.get("argv")
        if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or any(not isinstance(v, str) or not v or "\0" in v or len(v.encode()) > 4096 for v in argv):
            fail("ARGV_INVALID")
        if not argv[0].startswith("/") or sum(len(v.encode("utf-8")) for v in argv) > 8192:
            fail("ARGV_INVALID")
        duration = request.get("runtime_seconds", 3600)
        if type(duration) is not int or not 1 <= duration <= MAX_RUNTIME:
            fail("RUNTIME_INVALID")
        spec = {"argv": argv, "runtime_seconds": duration}
        spec_hash = digest(spec)
        if request.get("spec_digest") != spec_hash:
            fail("SPEC_DIGEST_MISMATCH")
        handle = "fj1-" + digest([self.node, actor, operation])
        # Reclaim expired terminal receipts without depending on the GC timer.
        # This never evicts a live/UNKNOWN job or an unexpired replay receipt.
        if not any(meta["handle"] == handle for _, meta in self.records()):
            try:
                self.gc(deadline, terminal_only=True)
            except JobError:
                # Maintenance is best effort; admission still validates every
                # receipt and charges unreclaimed storage before dispatch.
                remaining(deadline)
        fresh = False
        # This admission lock guards receipt reservation ONLY, never OS I/O.
        with locked(self.root / "admission.lock", deadline):
            records = list(self.records())
            found = next(((s, m) for s, m in records if m["handle"] == handle), None)
            if found:
                slot, meta = found
            else:
                age = self.now() - int(match[1]) / 1000
                if not -30 <= age <= SUBMIT_WINDOW:
                    fail("SUBMISSION_WINDOW_EXPIRED")
                if sum(m.get("terminal") not in TERMINAL for _, m in records) >= MAX_ACTIVE:
                    fail("ACTIVE_JOB_LIMIT")
                if self.storage_charge(records) + MAX_OUTPUT + 6 * MAX_META > MAX_STORAGE:
                    fail("STORAGE_BYTE_LIMIT")
                occupied = {s for s, _ in records}
                slot = 0
                while slot in occupied:
                    slot += 1
                private_dir(self.root / str(slot))
                generation = uuid.uuid4().hex
                meta = {"protocol": PROTOCOL, "node_uid": self.node, "actor_ref": actor, "operation_id": operation,
                        "handle": handle, "generation": generation, "spec_digest": spec_hash, "boot_id": self.boot,
                        "created_at": self.now(), "runtime_seconds": duration, "expires_at": self.now() + duration,
                        "retention_until": self.now() + duration + RETENTION, "submission": "RESERVED",
                        "unit": f"fleet-job-{generation}.service", "marker": f"fleet-job-v1:{handle}:{generation}"}
                atomic(self.path(slot, "spec.json"), spec)
                atomic(self.path(slot, "meta.json"), meta)
                fresh = True
        with locked(self.path(slot, "rpc.lock"), deadline):
            meta = load(self.path(slot, "meta.json"))
            self.bind(meta, actor, handle)
            if meta["spec_digest"] != spec_hash:
                fail("IDEMPOTENCY_CONFLICT")
            if fresh:
                # Persist BEFORE dispatch; a crash at this boundary is UNKNOWN,
                # not permission for this or any future caller to resubmit.
                meta["submission"] = "ATTEMPTED"
                atomic(self.path(slot, "meta.json"), meta)
                try:
                    self.backend.submit(self.root, slot, meta, deadline)
                except JobError:
                    return {"handle": handle, "generation": meta["generation"], "operation_id": operation,
                            "spec_digest": spec_hash, "state": "UNKNOWN", "reason": "submission_uncertain",
                            "retry_submit": False, "reconcile_required": True, "duplicate": False}
            result = self.snapshot(slot, meta, deadline)
            return {**result, "duplicate": not fresh}

    def access(self, request, deadline):
        slot, original = self.locate(request.get("handle"))
        with locked(self.path(slot, "rpc.lock"), deadline):
            meta = load(self.path(slot, "meta.json"))
            self.bind(meta, request["actor_ref"], request["handle"])
            if request.get("generation") != meta["generation"] or original["generation"] != meta["generation"]:
                fail("JOB_GENERATION_MISMATCH")
            action = request["action"]
            if action == "cancel":
                if request.get("confirm") is not True:
                    fail("CANCEL_CONFIRM_REQUIRED")
                before = self.snapshot(slot, meta, deadline)
                if before["state"] in TERMINAL:
                    return before
                if meta["boot_id"] == self.boot:
                    unit = self.backend.inspect(meta, deadline)
                    if unit is not None:
                        meta["cgroup"] = unit.get("ControlGroup") or meta.get("cgroup")
                        meta["cancel_requested"] = True
                        atomic(self.path(slot, "meta.json"), meta)
                        try:
                            self.backend.stop(meta, deadline)
                        except JobError:
                            return {"handle": meta["handle"], "generation": meta["generation"],
                                    "operation_id": meta["operation_id"], "spec_digest": meta["spec_digest"],
                                    "state": "UNKNOWN", "reason": "cancel_uncertain", "retry_submit": False,
                                    "reconcile_required": True}
            result = self.snapshot(slot, meta, deadline)
            if action == "read":
                cursor = request.get("cursor", 0)
                count = request.get("max_bytes", MAX_READ)
                if type(cursor) is not int or not 0 <= cursor <= result["output_bytes"] or type(count) is not int or not 1 <= count <= MAX_READ:
                    fail("CURSOR_INVALID")
                path = self.path(slot, "output.bin")
                if path.exists():
                    with path.open("rb") as stream:
                        stream.seek(cursor)
                        # The runner may append after snapshot(); keep this
                        # receipt and its cursor within the observed prefix.
                        data = stream.read(min(count, result["output_bytes"] - cursor))
                else:
                    data = b""
                result.update(output_base64=base64.b64encode(data).decode(), cursor=cursor, next_cursor=cursor + len(data),
                              more_available=cursor + len(data) < result["output_bytes"], gap=False)
            return result

    def gc(self, deadline, terminal_only=False):
        removed = 0
        # Numeric receipt directories only; unknown/foreign jobs are retained.
        for slot, initial in list(self.records()):
            remaining(deadline)
            if self.now() < initial["retention_until"]:
                continue
            if terminal_only and initial.get("terminal") not in TERMINAL:
                continue
            with locked(self.path(slot, "rpc.lock"), deadline):
                if not self.path(slot, "meta.json").exists():
                    continue
                meta = load(self.path(slot, "meta.json"))
                if meta["generation"] != initial["generation"]:
                    continue
                if not meta.get("gc_retired"):
                    result = self.snapshot(slot, meta, deadline)
                    if result["state"] not in TERMINAL:
                        continue
                    if meta["boot_id"] == self.boot:
                        self.backend.retire(meta, deadline)
                    # Persist retirement before deleting any receipt file, so
                    # interrupted GC resumes without inventing missing evidence.
                    meta["gc_retired"] = True
                    atomic(self.path(slot, "meta.json"), meta)
                with locked(self.root / "admission.lock", deadline):
                    for name in ("spec.json", "spec.tmp", "run.json", "run.tmp", "output.bin", "capped", "launch.claim", "meta.tmp"):
                        self.path(slot, name).unlink(missing_ok=True)
                    self.path(slot, "meta.json").unlink()
                    removed += 1
            if terminal_only and removed:
                break  # At most one retirement on a start RPC; timer GC drains the rest.
        return {"purged": removed, "slot_limit": None, "max_storage_bytes": MAX_STORAGE,
                "max_active": MAX_ACTIVE, "max_output_bytes": MAX_OUTPUT}

    def rpc(self, request, deadline):
        if not isinstance(request, dict) or request.get("protocol") != PROTOCOL:
            fail("PROTOCOL_INVALID")
        if request.get("node_uid") != self.node:
            fail("NODE_BINDING_MISMATCH")
        if not isinstance(request.get("actor_ref"), str) or not ACTOR_RE.fullmatch(request["actor_ref"]):
            fail("TRUSTED_ACTOR_REQUIRED")
        common = {"protocol", "node_uid", "actor_ref", "action"}
        fields = {"start": {"operation_id", "argv", "runtime_seconds", "spec_digest"},
                  "status": {"handle", "generation"}, "cancel": {"handle", "generation", "confirm"},
                  "read": {"handle", "generation", "cursor", "max_bytes"}}
        action = request.get("action")
        if action not in fields or set(request) - common - fields[action]:
            fail("REQUEST_FIELDS_INVALID")
        result = self.start(request, deadline) if action == "start" else self.access(request, deadline)
        return {"protocol": PROTOCOL, "ok": True, "action": action, **result}


def capture(argv, directory):
    """Bounded combined byte output; excess is drained, never spooled."""
    output_fd = os.open(directory / "output.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(output_fd, "wb", buffering=0) as output:
        try:
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, cwd=Path.home(), env={"PATH": "/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "C.UTF-8"})
        except OSError:
            return 126
        written, capped = 0, False
        try:
            while True:
                chunk = os.read(child.stdout.fileno(), 8192)
                if not chunk:
                    break
                keep = chunk[:max(0, MAX_OUTPUT - written)]
                output.write(keep)
                written += len(keep)
                if len(keep) != len(chunk) and not capped:
                    (directory / "capped").touch(mode=0o600)
                    capped = True
            code = child.wait()
            os.fsync(output.fileno())
            return code
        finally:
            child.stdout.close()


def verify_resources(group):
    try:
        for name, maximum in (("memory.max", MEMORY_BYTES), ("pids.max", TASKS_MAX)):
            value = (group / name).read_text().strip()
            if not value.isdigit() or not 0 < int(value) <= maximum:
                fail("RESOURCE_LIMIT_UNVERIFIED")
        quota, period = (group / "cpu.max").read_text().split()
        if not quota.isdigit() or not period.isdigit() or not 0 < int(quota) <= int(period):
            fail("RESOURCE_LIMIT_UNVERIFIED")
        if (group / "memory.swap.max").read_text().strip() != "0":
            fail("RESOURCE_LIMIT_UNVERIFIED")
    except (OSError, ValueError):
        fail("RESOURCE_LIMIT_UNVERIFIED")


def runner(root, slot, generation):
    uid = runtime_uid()
    if not SLOT_RE.fullmatch(slot) or not re.fullmatch(r"[0-9a-f]{32}", generation):
        fail("RUNNER_ARGUMENT_INVALID")
    directory = Path(root) / slot
    private_dir(directory)
    meta = load(directory / "meta.json")
    if meta.get("generation") != generation or meta.get("boot_id") != boot_id() or meta.get("submission") != "ATTEMPTED":
        fail("RUNNER_BINDING_MISMATCH")
    # Verify the actual service cgroup and enforceable resource limits before
    # spawning requested argv. A configured property alone is not proof.
    lines = Path("/proc/self/cgroup").read_text().splitlines()
    cgroup = next((line[3:] for line in lines if line.startswith("0::")), "")
    if f"/user-{uid}.slice/" not in cgroup or not cgroup.endswith("/" + meta["unit"]):
        fail("RUNNER_CGROUP_MISMATCH")
    group = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
    spec = load(directory / "spec.json")
    if digest(spec) != meta["spec_digest"]:
        fail("RUNNER_SPEC_MISMATCH")
    fd = os.open(directory / "launch.claim", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    run = {"generation": generation, "cgroup": cgroup, "finished": False, "exit_code": None}
    atomic(directory / "run.json", run)
    try:
        verify_resources(group)
    except JobError:
        # Preserve a bounded pre-launch failure receipt; requested argv has
        # not been spawned, but a new invocation still requires a new key.
        run.update(finished=True, exit_code=126, error="RESOURCE_LIMIT_UNVERIFIED")
        atomic(directory / "run.json", run)
        return 126
    os.umask(0o077)
    code = capture(spec["argv"], directory)
    run.update(finished=True, exit_code=code)
    atomic(directory / "run.json", run)
    return 0 if code == 0 else 1


def read_request(fd, deadline):
    data = bytearray()
    while True:
        ready, _, _ = select.select([fd], [], [], min(2, remaining(deadline)))
        if not ready:
            fail("RPC_INPUT_TIMEOUT")
        chunk = os.read(fd, min(8192, MAX_REQUEST + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_REQUEST:
            fail("RPC_INPUT_TOO_LARGE")
    try:
        return json.loads(data)
    except (ValueError, UnicodeDecodeError):
        fail("RPC_INPUT_INVALID")


def main():
    deadline = time.monotonic() + RPC_SECONDS
    try:
        uid = runtime_uid()  # No env/test/root bypass exists in the executable.
        if len(sys.argv) == 5 and sys.argv[1] == "run":
            return runner(*sys.argv[2:])
        encoded = len(sys.argv) == 6 and sys.argv[1] == "rpc" and sys.argv[4] == "--request-base64"
        if (len(sys.argv) != 4 and not encoded) or sys.argv[1] not in {"rpc", "gc"}:
            fail("USAGE_RPC_OR_GC_STATE_ROOT_NODE_UID")
        root = Path(sys.argv[2]).expanduser().absolute()
        if not root.is_absolute() or any(c in str(root) for c in "$%\n\r"):
            fail("STATE_PATH_INVALID")
        # NODE_UID is installed/passed by the trusted node adapter, never taken
        # from the untrusted operation payload as local identity authority.
        jobs = Jobs(root, sys.argv[3], Systemd(uid), boot_id())
        if encoded:
            if len(sys.argv[5]) > (MAX_REQUEST + 2) // 3 * 4:
                fail("RPC_INPUT_TOO_LARGE")
            try:
                raw = base64.b64decode(sys.argv[5], validate=True)
                if len(raw) > MAX_REQUEST:
                    fail("RPC_INPUT_TOO_LARGE")
                request = json.loads(raw)
            except ValueError:
                fail("RPC_INPUT_INVALID")
        elif sys.argv[1] == "rpc":
            request = read_request(sys.stdin.fileno(), deadline)
        result = jobs.rpc(request, deadline) if sys.argv[1] == "rpc" else jobs.gc(deadline)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except JobError as error:
        print(json.dumps({"ok": False, "error": str(error), "retry_submit": False}))
        return 2
    except Exception:
        print(json.dumps({"ok": False, "error": "JOB_INTERNAL_UNKNOWN", "retry_submit": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
