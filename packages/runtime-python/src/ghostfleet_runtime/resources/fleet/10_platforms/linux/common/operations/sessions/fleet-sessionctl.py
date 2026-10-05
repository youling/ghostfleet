#!/usr/bin/env python3
"""Fleet Control V2 Interactive Session V1 rootless node-local helper.

Short RPCs own metadata and reconciliation. tmux owns PTY/process lifetime.
No listener or resident Fleet daemon is created by this helper.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import select
import shlex
import signal
import stat
import subprocess
import sys
import time
import uuid

PROTOCOL = "fleet-session/v2"
NODE_RE = re.compile(r"node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
ACTOR_RE = re.compile(r"[0-9a-f]{64}")
OPERATION_RE = re.compile(r"os1-([0-9]{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})")
HANDLE_RE = re.compile(r"fs2-[0-9a-f]{64}")
GENERATION_RE = re.compile(r"[0-9a-f]{32}")
SESSION_ID_RE = re.compile(r"\$[0-9]+")
PANE_ID_RE = re.compile(r"%[0-9]+")
SLOT_RE = re.compile(r"0|[1-9][0-9]{0,19}")
MAX_STORAGE = 128 * 1024 * 1024
MAX_ACTIVE = 4
MAX_ACTIVE_PER_ACTOR = 2
MAX_META = 64 * 1024
MAX_REQUEST = 32 * 1024
MAX_INPUT = 16 * 1024
MAX_READ = 32 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
MAX_RUNTIME = 4 * 3600
IDLE_TTL = 30 * 60
RETENTION = 24 * 3600
SUBMIT_WINDOW = 300
RPC_SECONDS = 10
TMUX_SECONDS = 6
LAUNCH_WAIT_SECONDS = 8
MEMORY_BYTES = 1024 * 1024 * 1024
PROCESS_LIMIT = 128
HISTORY_LINES = 2000
TERMINAL = {"EXITED", "CLOSED"}
CONTROL_KEYS = {
    "ENTER": "Enter",
    "TAB": "Tab",
    "ESCAPE": "Escape",
    "BACKSPACE": "BSpace",
    "CTRL_C": "C-c",
    "CTRL_D": "C-d",
    "CTRL_Z": "C-z",
    "UP": "Up",
    "DOWN": "Down",
    "LEFT": "Left",
    "RIGHT": "Right",
}


class SessionError(Exception):
    pass


def fail(code: str):
    raise SessionError(code)


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        fail("RPC_DEADLINE")
    return left


def runtime_uid() -> int:
    if sys.platform != "linux" or not hasattr(os, "geteuid"):
        fail("LINUX_REQUIRED")
    uid = os.geteuid()
    if uid == 0 or os.getuid() != uid:
        fail("NORMAL_USER_REQUIRED")
    return uid


def private_dir(path: Path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail("STATE_DIRECTORY_INVALID")
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        fail("STATE_DIRECTORY_PERMISSIONS")


def load(path: Path) -> dict:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > MAX_META:
            fail("STATE_FILE_INVALID")
        with path.open("rb") as stream:
            data = stream.read(MAX_META + 1)
        value = json.loads(data)
        if len(data) > MAX_META or not isinstance(value, dict):
            fail("STATE_FILE_INVALID")
        return value
    except (OSError, ValueError, UnicodeDecodeError):
        fail("STATE_FILE_INVALID")


def atomic(path: Path, value: dict):
    data = canonical(value)
    if len(data) > MAX_META:
        fail("STATE_FILE_TOO_LARGE")
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


@contextmanager
def locked(path: Path, deadline: float):
    import fcntl
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    acquired = False
    try:
        until = min(deadline, time.monotonic() + 1)
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError:
                if time.monotonic() >= until:
                    fail("SESSION_BUSY")
                time.sleep(min(0.01, remaining(until)))
        yield
    finally:
        if acquired:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def bounded_request(fd: int, deadline: float) -> dict:
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
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        fail("RPC_INPUT_INVALID")
    if not isinstance(value, dict):
        fail("RPC_INPUT_INVALID")
    return value


def safe_root(value: str) -> Path:
    root = Path(value).expanduser().absolute()
    text = str(root)
    if not root.is_absolute() or any(c in text for c in "$%\n\r\0"):
        fail("STATE_PATH_INVALID")
    private_dir(root)
    return root


def tmux_socket(root: Path) -> str:
    return "fleet-s2-" + hashlib.sha256(str(root).encode()).hexdigest()[:12]


class Tmux:
    def __init__(self, root: Path):
        self.root = root
        self.socket = tmux_socket(root)
        self.binary = "/usr/bin/tmux"
        if not Path(self.binary).is_file():
            fail("TMUX_UNAVAILABLE")

    def call(self, args: list[str], deadline: float, *, input_bytes: bytes | None = None, check: bool = True):
        try:
            result = subprocess.run(
                [self.binary, "-L", self.socket, "-f", "/dev/null", *args],
                input=input_bytes,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=min(TMUX_SECONDS, remaining(deadline)),
                check=False,
                env={**os.environ, "LC_ALL": "C"},
            )
        except (OSError, subprocess.TimeoutExpired):
            fail("TMUX_OUTCOME_UNKNOWN")
        if check and result.returncode != 0:
            fail("TMUX_OUTCOME_UNKNOWN")
        return result

    def session_by_name(self, name: str, deadline: float) -> str | None:
        result = self.call(["list-sessions", "-F", "#{session_name}|#{session_id}"], deadline, check=False)
        if result.returncode != 0:
            return None
        for line in result.stdout.decode("utf-8", "replace").splitlines():
            current, sep, session_id = line.partition("|")
            if sep and current == name and SESSION_ID_RE.fullmatch(session_id):
                return session_id
        return None

    def has_id(self, session_id: str, deadline: float) -> bool:
        if not SESSION_ID_RE.fullmatch(session_id):
            return False
        return self.call(["has-session", "-t", session_id], deadline, check=False).returncode == 0

    def option(self, session_id: str, key: str, deadline: float) -> str:
        result = self.call(["show-options", "-qv", "-t", session_id, key], deadline, check=False)
        return result.stdout.decode("utf-8", "replace").strip() if result.returncode == 0 else ""

    def environment(self, session_id: str, key: str, deadline: float) -> str:
        result = self.call(["show-environment", "-t", session_id, key], deadline, check=False)
        if result.returncode != 0:
            return ""
        line = result.stdout.decode("utf-8", "replace").strip()
        prefix = key + "="
        return line[len(prefix):] if line.startswith(prefix) else ""

    def markers(self, meta: dict) -> dict[str, str]:
        values = {
            "YOULING_FLEET_SCHEMA": "v2",
            "YOULING_FLEET_HANDLE": meta.get("handle"),
            "YOULING_FLEET_NODE": meta.get("node_uid"),
            "YOULING_FLEET_ACTOR": meta.get("actor_ref"),
            "YOULING_FLEET_GENERATION": meta.get("generation"),
        }
        if not all(isinstance(value, str) for value in values.values()):
            fail("SESSION_METADATA_INVALID")
        return values

    def marker_owned(self, session_id: str, meta: dict, deadline: float) -> bool:
        return all(self.environment(session_id, key, deadline) == value for key, value in self.markers(meta).items())

    def recover(self, meta: dict, deadline: float) -> bool:
        name = meta.get("tmux_name")
        if not isinstance(name, str):
            fail("SESSION_METADATA_INVALID")
        session_id = self.session_by_name(name, deadline)
        if session_id is None:
            return False
        if not self.marker_owned(session_id, meta, deadline):
            fail("SESSION_FOREIGN_OR_CORRUPT")
        panes = self.call(["list-panes", "-t", session_id, "-F", "#{pane_id}"], deadline).stdout.decode("utf-8", "replace").splitlines()
        panes = [pane.strip() for pane in panes if pane.strip()]
        if len(panes) != 1 or not PANE_ID_RE.fullmatch(panes[0]):
            fail("SESSION_FOREIGN_OR_CORRUPT")
        meta["tmux_session_id"] = session_id
        meta["pane_id"] = panes[0]
        return True

    def owned(self, meta: dict, deadline: float) -> bool:
        session_id = meta.get("tmux_session_id")
        name = meta.get("tmux_name")
        if not isinstance(session_id, str) or not isinstance(name, str) or not self.has_id(session_id, deadline):
            return False
        return self.session_by_name(name, deadline) == session_id and self.marker_owned(session_id, meta, deadline)

    def configure(self, helper: Path, root: Path, slot: int, meta: dict, deadline: float):
        if not self.owned(meta, deadline):
            fail("SESSION_FOREIGN_OR_CORRUPT")
        session_id = meta["tmux_session_id"]
        pane_id = meta["pane_id"]
        for key, value in (
            ("@youling-fleet-schema", "v2"),
            ("@youling-fleet-handle", meta["handle"]),
            ("@youling-fleet-node", meta["node_uid"]),
            ("@youling-fleet-actor", meta["actor_ref"]),
            ("@youling-fleet-generation", meta["generation"]),
        ):
            self.call(["set-option", "-t", session_id, key, value], deadline)
        self.call(["set-option", "-w", "-t", pane_id, "remain-on-exit", "on"], deadline)
        self.call(["set-option", "-w", "-t", pane_id, "history-limit", str(HISTORY_LINES)], deadline)
        # Recovered creation may configure a replacement pipe for the same
        # session generation. Its predecessor cannot seal the new writer.
        meta["spool_token"] = uuid.uuid4().hex
        atomic(root / str(slot) / "meta.json", meta)
        command = " ".join(
            shlex.quote(v)
            for v in [sys.executable, "-I", str(helper), "spool", str(root), str(slot), meta["generation"], meta["spool_token"]]
        )
        self.call(["pipe-pane", "-O", "-t", pane_id, command], deadline)
        if not self.owned(meta, deadline):
            fail("SESSION_CREATE_UNKNOWN")

    def create(self, helper: Path, root: Path, slot: int, meta: dict, deadline: float):
        name = meta["tmux_name"]
        marker_args: list[str] = []
        for key, value in self.markers(meta).items():
            marker_args.extend(["-e", key + "=" + value])
        result = self.call(
            [
                "new-session", "-d", "-P", "-F", "#{session_id}|#{pane_id}",
                "-s", name, "-x", str(meta["cols"]), "-y", str(meta["rows"]),
                *marker_args,
                sys.executable, str(helper), "run", str(root), str(slot), meta["generation"],
            ],
            deadline,
            check=False,
        )
        if result.returncode != 0:
            fail("TMUX_CREATE_UNKNOWN")
        fields = result.stdout.decode("utf-8", "replace").strip().split("|", 1)
        if len(fields) != 2 or not SESSION_ID_RE.fullmatch(fields[0]) or not PANE_ID_RE.fullmatch(fields[1]):
            fail("TMUX_CREATE_UNKNOWN")
        meta["tmux_session_id"], meta["pane_id"] = fields
        if not self.owned(meta, deadline):
            fail("TMUX_CREATE_UNKNOWN")
        self.configure(helper, root, slot, meta, deadline)

    def status(self, meta: dict, deadline: float) -> tuple[str, int | None, str | None, str]:
        if meta.get("state") == "CLOSED":
            return "CLOSED", meta.get("exit_code"), meta.get("exit_signal"), "closed"
        session_id = meta.get("tmux_session_id")
        pane_id = meta.get("pane_id")
        name = meta.get("tmux_name")
        if not all(isinstance(v, str) for v in (session_id, pane_id, name)):
            return "UNKNOWN", None, None, "create_incomplete"
        if not self.has_id(session_id, deadline):
            collision = self.session_by_name(name, deadline)
            if collision is not None and collision != session_id:
                return "UNKNOWN", None, None, "foreign_name_collision"
            return "UNKNOWN", None, None, "tmux_session_missing"
        if not self.owned(meta, deadline):
            fail("SESSION_FOREIGN_OR_CORRUPT")
        result = self.call(
            ["display-message", "-p", "-t", pane_id, "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"],
            deadline,
            check=False,
        )
        if result.returncode != 0:
            return "UNKNOWN", None, None, "pane_missing"
        fields = result.stdout.decode("utf-8", "replace").strip().split("|", 2)
        if len(fields) != 3:
            return "UNKNOWN", None, None, "pane_status_invalid"
        dead, status, signal = fields
        if dead == "0":
            return "RUNNING", None, None, "pane_running"
        if dead == "1":
            try:
                code = int(status) if status else None
            except ValueError:
                code = None
            return "EXITED", code, signal or None, "pane_exited"
        return "UNKNOWN", None, None, "pane_status_unknown"

    def kill_owned(self, meta: dict, deadline: float):
        session_id = meta.get("tmux_session_id")
        if not isinstance(session_id, str) or not self.has_id(session_id, deadline):
            if not self.recover(meta, deadline):
                return
            session_id = meta["tmux_session_id"]
        if not self.owned(meta, deadline):
            fail("SESSION_FOREIGN_OR_CORRUPT")
        self.call(["kill-session", "-t", session_id], deadline)

    def literal_input(self, meta: dict, seq: int, text: str, keys: list[str], deadline: float):
        if not self.owned(meta, deadline):
            fail("SESSION_FOREIGN_OR_CORRUPT")
        pane = meta["pane_id"]
        if text:
            buffer_name = f"fsv2_{meta['generation']}_{seq}"
            self.call(["load-buffer", "-b", buffer_name, "-"], deadline, input_bytes=text.encode("utf-8"))
            self.call(["paste-buffer", "-d", "-r", "-b", buffer_name, "-t", pane], deadline)
        for key in keys:
            self.call(["send-keys", "-t", pane, CONTROL_KEYS[key]], deadline)


class Sessions:
    def __init__(self, root: Path, node_uid: str, now=time.time):
        if not NODE_RE.fullmatch(node_uid):
            fail("LOCAL_NODE_ID_INVALID")
        self.root = root
        self.node = node_uid
        self.now = now
        self.tmux = Tmux(root)
        self.helper = Path(__file__).resolve()
        private_dir(self.root)

    def path(self, slot: int, name: str) -> Path:
        return self.root / str(slot) / name

    def records(self):
        for directory in self.root.iterdir():
            if not SLOT_RE.fullmatch(directory.name):
                continue
            private_dir(directory)
            slot = int(directory.name)
            path = self.path(slot, "meta.json")
            if not path.exists():
                continue
            meta = load(path)
            if meta.get("protocol") != PROTOCOL or not HANDLE_RE.fullmatch(meta.get("handle", "")):
                fail("SESSION_METADATA_INVALID")
            generation = meta.get("generation")
            if meta.get("node_uid") != self.node or not isinstance(generation, str) or not GENERATION_RE.fullmatch(generation):
                fail("SESSION_METADATA_INVALID")
            if meta.get("tmux_name") != f"fleet-s2-{generation}":
                fail("SESSION_METADATA_INVALID")
            yield slot, meta

    def storage_charge(self, records):
        total = 0
        for slot, meta in records:
            # A dead pane can still have a pipe writer draining its output.
            # Only the matching durable spool receipt releases that reserve.
            sealed_path = self.path(slot, "spool.json")
            sealed = load(sealed_path) if sealed_path.exists() else {}
            size = self.output_size(slot)
            finished = (meta.get("state") in TERMINAL
                        and sealed.get("generation") == meta["generation"]
                        and isinstance(meta.get("spool_token"), str)
                        and sealed.get("spool_token") == meta["spool_token"]
                        and sealed.get("output_bytes") == size)
            total += 8 * MAX_META + (size if finished else MAX_OUTPUT)
        return total

    def locate(self, handle: str):
        if not isinstance(handle, str) or not HANDLE_RE.fullmatch(handle):
            fail("SESSION_HANDLE_INVALID")
        for slot, meta in self.records():
            if meta["handle"] == handle:
                return slot, meta
        fail("SESSION_NOT_FOUND")

    def bind(self, meta: dict, actor: str, handle: str, generation: str):
        if meta.get("handle") != handle or meta.get("node_uid") != self.node or meta.get("actor_ref") != actor:
            fail("SESSION_BINDING_MISMATCH")
        if meta.get("generation") != generation:
            fail("SESSION_GENERATION_MISMATCH")

    def output_size(self, slot: int) -> int:
        path = self.path(slot, "output.bin")
        size = path.stat().st_size if path.exists() else 0
        if size > MAX_OUTPUT:
            fail("OUTPUT_BOUND_VIOLATED")
        return size

    def snapshot(self, slot: int, meta: dict, deadline: float) -> dict:
        if not isinstance(meta.get("tmux_session_id"), str) or not isinstance(meta.get("pane_id"), str):
            if self.tmux.recover(meta, deadline):
                atomic(self.path(slot, "meta.json"), meta)
        state, code, exit_signal, reason = self.tmux.status(meta, deadline)
        if state == "EXITED" and meta.get("state") != "CLOSED":
            run_path = self.path(slot, "run.json")
            run = load(run_path) if run_path.exists() else {}
            if (
                run.get("generation") != meta.get("generation")
                or run.get("finished") is not True
                or not (run.get("exit_code") is None or type(run.get("exit_code")) is int)
                or not (run.get("exit_signal") is None or isinstance(run.get("exit_signal"), str))
            ):
                state, code, exit_signal, reason = "UNKNOWN", None, None, "exit_receipt_missing"
            else:
                code = run.get("exit_code")
                exit_signal = run.get("exit_signal")
                reason = "pane_exited_receipt"
                meta["state"] = "EXITED"
                meta["exit_code"] = code
                meta["exit_signal"] = exit_signal
                meta.setdefault("terminal_at", self.now())
                atomic(self.path(slot, "meta.json"), meta)
        elif state == "CLOSED":
            reason = meta.get("close_reason", reason)
        size = self.output_size(slot)
        pending = meta.get("pending_input") if isinstance(meta.get("pending_input"), dict) else None
        return {
            "handle": meta["handle"],
            "generation": meta["generation"],
            "operation_id": meta["operation_id"],
            "spec_digest": meta["spec_digest"],
            "state": state,
            "reason": reason,
            "exit_code": code,
            "exit_signal": exit_signal,
            "last_input_seq": meta.get("last_input_seq", 0),
            "pending_input_seq": pending.get("seq") if pending else None,
            "retry_mutation": False,
            "reconcile_required": state == "UNKNOWN" or pending is not None,
            "output_bytes": size,
            "output_capped": size >= MAX_OUTPUT or self.path(slot, "capped").exists(),
            "idle_expires_at": meta["last_activity_at"] + IDLE_TTL,
            "absolute_expires_at": meta["absolute_expires_at"],
            "retention_until": meta["retention_until"],
        }

    def should_expire(self, meta: dict) -> bool:
        return self.now() >= meta["absolute_expires_at"] or self.now() - meta["last_activity_at"] >= IDLE_TTL

    def expire(self, slot: int, meta: dict, deadline: float, reason: str):
        if meta.get("state") in TERMINAL:
            return
        self.tmux.kill_owned(meta, deadline)
        meta["state"] = "CLOSED"
        meta["close_reason"] = reason
        meta["terminal_at"] = self.now()
        meta["pending_input"] = None
        atomic(self.path(slot, "meta.json"), meta)

    def start(self, request: dict, deadline: float) -> dict:
        operation = request.get("operation_id")
        match = OPERATION_RE.fullmatch(operation) if isinstance(operation, str) else None
        if not match:
            fail("OPERATION_ID_INVALID")
        actor = request["actor_ref"]
        argv = request.get("argv")
        if not isinstance(argv, list) or not 1 <= len(argv) <= 64:
            fail("ARGV_INVALID")
        if any(not isinstance(v, str) or not v or "\0" in v or len(v.encode("utf-8")) > 4096 for v in argv):
            fail("ARGV_INVALID")
        if not argv[0].startswith("/") or sum(len(v.encode("utf-8")) for v in argv) > 8192:
            fail("ARGV_INVALID")
        cwd_profile = request.get("cwd_profile", "home")
        if cwd_profile != "home":
            fail("CWD_PROFILE_INVALID")
        rows, cols = request.get("rows", 24), request.get("cols", 100)
        if type(rows) is not int or type(cols) is not int or not 10 <= rows <= 200 or not 20 <= cols <= 400:
            fail("TERMINAL_SIZE_INVALID")
        runtime_seconds = request.get("runtime_seconds", 3600)
        if type(runtime_seconds) is not int or not 1 <= runtime_seconds <= MAX_RUNTIME:
            fail("RUNTIME_INVALID")
        spec = {"argv": argv, "cols": cols, "cwd_profile": cwd_profile, "rows": rows, "runtime_seconds": runtime_seconds}
        spec_hash = digest(spec)
        if request.get("spec_digest") != spec_hash:
            fail("SPEC_DIGEST_MISMATCH")
        handle = "fs2-" + digest([self.node, actor, operation])
        if not any(meta["handle"] == handle for _, meta in self.records()):
            try:
                self.gc(deadline, terminal_only=True)
            except SessionError:
                remaining(deadline)
        fresh = False
        with locked(self.root / "admission.lock", deadline):
            records = list(self.records())
            found = next(((s, m) for s, m in records if m["handle"] == handle), None)
            if found:
                slot, meta = found
            else:
                age = self.now() - int(match[1]) / 1000
                if not -30 <= age <= SUBMIT_WINDOW:
                    fail("SUBMISSION_WINDOW_EXPIRED")
                active = sum(existing.get("state") not in TERMINAL for _, existing in records)
                actor_active = sum(
                    existing.get("state") not in TERMINAL and existing.get("actor_ref") == actor
                    for _, existing in records
                )
                if active >= MAX_ACTIVE:
                    fail("ACTIVE_SESSION_LIMIT")
                if actor_active >= MAX_ACTIVE_PER_ACTOR:
                    fail("ACTOR_SESSION_LIMIT")
                if self.storage_charge(records) + MAX_OUTPUT + 8 * MAX_META > MAX_STORAGE:
                    fail("STORAGE_BYTE_LIMIT")
                occupied = {s for s, _ in records}
                slot = 0
                while slot in occupied:
                    slot += 1
                private_dir(self.root / str(slot))
                generation = uuid.uuid4().hex
                now = self.now()
                meta = {
                    "protocol": PROTOCOL,
                    "node_uid": self.node,
                    "actor_ref": actor,
                    "operation_id": operation,
                    "handle": handle,
                    "generation": generation,
                    "spec_digest": spec_hash,
                    "created_at": now,
                    "last_activity_at": now,
                    "runtime_seconds": runtime_seconds,
                    "absolute_expires_at": now + runtime_seconds,
                    "retention_until": now + runtime_seconds + RETENTION,
                    "submission": "RESERVED",
                    "state": "CREATING",
                    "tmux_name": f"fleet-s2-{generation}",
                    "rows": rows,
                    "cols": cols,
                    "last_input_seq": 0,
                    "last_input_digest": None,
                    "pending_input": None,
                }
                atomic(self.path(slot, "spec.json"), spec)
                atomic(self.path(slot, "meta.json"), meta)
                fresh = True
        with locked(self.path(slot, "rpc.lock"), deadline):
            meta = load(self.path(slot, "meta.json"))
            if meta.get("actor_ref") != actor or meta.get("handle") != handle:
                fail("SESSION_BINDING_MISMATCH")
            if meta.get("spec_digest") != spec_hash:
                fail("IDEMPOTENCY_CONFLICT")
            if fresh:
                meta["submission"] = "ATTEMPTED"
                atomic(self.path(slot, "meta.json"), meta)
            if meta.get("state") == "CREATING" and not self.path(slot, "go").exists():
                try:
                    if fresh:
                        self.tmux.create(self.helper, self.root, slot, meta, deadline)
                    else:
                        if not self.tmux.recover(meta, deadline):
                            result = self.snapshot(slot, meta, deadline)
                            return {**result, "state": "UNKNOWN", "reason": "create_uncertain", "reconcile_required": True, "duplicate": True}
                        atomic(self.path(slot, "meta.json"), meta)
                        pre_state, _, _, _ = self.tmux.status(meta, deadline)
                        if pre_state != "RUNNING":
                            result = self.snapshot(slot, meta, deadline)
                            return {**result, "state": "UNKNOWN", "reason": "create_uncertain", "reconcile_required": True, "duplicate": True}
                        self.tmux.configure(self.helper, self.root, slot, meta, deadline)
                    atomic(self.path(slot, "meta.json"), meta)
                    self.path(slot, "go").touch(mode=0o600, exist_ok=False)
                    meta["state"] = "ACTIVE"
                    atomic(self.path(slot, "meta.json"), meta)
                except SessionError:
                    result = self.snapshot(slot, meta, deadline)
                    return {**result, "state": "UNKNOWN", "reason": "create_uncertain", "reconcile_required": True, "duplicate": not fresh}
            elif meta.get("state") == "CREATING" and self.path(slot, "go").exists():
                try:
                    if self.tmux.recover(meta, deadline) or isinstance(meta.get("tmux_session_id"), str):
                        meta["state"] = "ACTIVE"
                        atomic(self.path(slot, "meta.json"), meta)
                except SessionError:
                    pass
            result = self.snapshot(slot, meta, deadline)
            return {**result, "duplicate": not fresh}

    def access(self, request: dict, deadline: float) -> dict:
        handle = request.get("handle")
        generation = request.get("generation")
        actor = request["actor_ref"]
        if not isinstance(generation, str) or not GENERATION_RE.fullmatch(generation):
            fail("SESSION_GENERATION_INVALID")
        slot, _ = self.locate(handle)
        with locked(self.path(slot, "rpc.lock"), deadline):
            meta = load(self.path(slot, "meta.json"))
            self.bind(meta, actor, handle, generation)
            action = request["action"]
            if meta.get("state") not in TERMINAL and self.should_expire(meta):
                try:
                    self.expire(slot, meta, deadline, "ttl_expired")
                except SessionError:
                    result = self.snapshot(slot, meta, deadline)
                    return {**result, "state": "UNKNOWN", "reason": "ttl_cleanup_uncertain", "reconcile_required": True}
                meta = load(self.path(slot, "meta.json"))
            if action in {"status", "read"}:
                meta["last_activity_at"] = self.now()
                atomic(self.path(slot, "meta.json"), meta)
            if action == "status":
                return self.snapshot(slot, meta, deadline)
            if action == "read":
                result = self.snapshot(slot, meta, deadline)
                cursor = request.get("cursor", 0)
                count = request.get("max_bytes", MAX_READ)
                if type(cursor) is not int or not 0 <= cursor <= result["output_bytes"] or type(count) is not int or not 1 <= count <= MAX_READ:
                    fail("CURSOR_INVALID")
                path = self.path(slot, "output.bin")
                data = b""
                if path.exists():
                    with path.open("rb") as stream:
                        stream.seek(cursor)
                        data = stream.read(min(count, result["output_bytes"] - cursor))
                result.update(
                    output_base64=base64.b64encode(data).decode("ascii"),
                    cursor=cursor,
                    next_cursor=cursor + len(data),
                    more_available=cursor + len(data) < result["output_bytes"],
                    gap=False,
                )
                return result
            if action == "input":
                if meta.get("state") in TERMINAL:
                    fail("SESSION_NOT_RUNNING")
                seq = request.get("input_seq")
                text = request.get("text", "")
                keys = request.get("control_keys", [])
                if type(seq) is not int or not 1 <= seq <= 2**31 - 1:
                    fail("INPUT_SEQ_INVALID")
                if not isinstance(text, str) or "\0" in text or len(text.encode("utf-8")) > MAX_INPUT:
                    fail("INPUT_INVALID")
                if not isinstance(keys, list) or len(keys) > 16 or any(k not in CONTROL_KEYS for k in keys):
                    fail("CONTROL_KEYS_INVALID")
                if not text and not keys:
                    fail("EMPTY_INPUT")
                state = self.snapshot(slot, meta, deadline)
                if state["state"] != "RUNNING":
                    return {**state, "reconcile_required": True, "input_seq": seq, "duplicate": False}
                input_hash = digest({"control_keys": keys, "text": text})
                last = meta.get("last_input_seq", 0)
                last_hash = meta.get("last_input_digest")
                pending = meta.get("pending_input") if isinstance(meta.get("pending_input"), dict) else None
                if seq == last:
                    if input_hash != last_hash:
                        fail("INPUT_SEQ_CONFLICT")
                    return {**state, "input_seq": seq, "duplicate": True}
                if seq < last:
                    fail("STALE_INPUT_SEQ")
                if pending is not None:
                    same = pending.get("seq") == seq and pending.get("digest") == input_hash
                    return {
                        **state,
                        "state": "UNKNOWN",
                        "reason": "input_outcome_unknown" if same else "input_blocked_by_unknown",
                        "reconcile_required": True,
                        "input_seq": seq,
                        "duplicate": False,
                    }
                if seq != last + 1:
                    fail("OUT_OF_ORDER_INPUT_SEQ")
                meta["pending_input"] = {"seq": seq, "digest": input_hash}
                atomic(self.path(slot, "meta.json"), meta)
                try:
                    self.tmux.literal_input(meta, seq, text, keys, deadline)
                except SessionError:
                    state = self.snapshot(slot, meta, deadline)
                    return {**state, "state": "UNKNOWN", "reason": "input_outcome_unknown", "reconcile_required": True, "input_seq": seq, "duplicate": False}
                meta["last_input_seq"] = seq
                meta["last_input_digest"] = input_hash
                meta["pending_input"] = None
                meta["last_activity_at"] = self.now()
                atomic(self.path(slot, "meta.json"), meta)
                state = self.snapshot(slot, meta, deadline)
                return {**state, "input_seq": seq, "duplicate": False}
            if action == "close":
                if request.get("confirm") is not True:
                    fail("CLOSE_CONFIRM_REQUIRED")
                if meta.get("state") == "CLOSED":
                    return {**self.snapshot(slot, meta, deadline), "duplicate": True}
                try:
                    self.tmux.kill_owned(meta, deadline)
                except SessionError:
                    state = self.snapshot(slot, meta, deadline)
                    return {**state, "state": "UNKNOWN", "reason": "close_outcome_unknown", "reconcile_required": True, "duplicate": False}
                meta["state"] = "CLOSED"
                meta["close_reason"] = "explicit_close"
                meta["terminal_at"] = self.now()
                meta["pending_input"] = None
                atomic(self.path(slot, "meta.json"), meta)
                return {**self.snapshot(slot, meta, deadline), "duplicate": False}
            fail("ACTION_INVALID")

    def rpc(self, request: dict, deadline: float) -> dict:
        if request.get("protocol") != PROTOCOL or request.get("node_uid") != self.node:
            fail("PROTOCOL_OR_NODE_BINDING_INVALID")
        actor = request.get("actor_ref")
        if not isinstance(actor, str) or not ACTOR_RE.fullmatch(actor):
            fail("TRUSTED_ACTOR_REQUIRED")
        action = request.get("action")
        common = {"protocol", "node_uid", "actor_ref", "action"}
        fields = {
            "create": {"operation_id", "argv", "cwd_profile", "rows", "cols", "runtime_seconds", "spec_digest"},
            "status": {"handle", "generation"},
            "read": {"handle", "generation", "cursor", "max_bytes"},
            "input": {"handle", "generation", "input_seq", "text", "control_keys"},
            "close": {"handle", "generation", "confirm"},
        }
        if action not in fields or set(request) - common - fields[action]:
            fail("REQUEST_FIELDS_INVALID")
        result = self.start(request, deadline) if action == "create" else self.access(request, deadline)
        return {"protocol": PROTOCOL, "ok": True, "action": action, **result}

    def gc(self, deadline: float, terminal_only=False) -> dict:
        closed = purged = retained_unknown = 0
        for slot, initial in list(self.records()):
            remaining(deadline)
            if terminal_only and (initial.get("state") not in TERMINAL or self.now() < initial["retention_until"]):
                continue
            with locked(self.path(slot, "rpc.lock"), deadline):
                if not self.path(slot, "meta.json").exists():
                    continue
                meta = load(self.path(slot, "meta.json"))
                if meta["generation"] != initial["generation"]:
                    continue
                if meta.get("state") not in TERMINAL and self.should_expire(meta):
                    try:
                        self.expire(slot, meta, deadline, "gc_ttl_expired")
                        closed += 1
                        meta = load(self.path(slot, "meta.json"))
                    except SessionError:
                        retained_unknown += 1
                        continue
                if meta.get("state") in TERMINAL and self.now() >= meta["retention_until"]:
                    try:
                        self.tmux.kill_owned(meta, deadline)
                    except SessionError:
                        retained_unknown += 1
                        continue
                    with locked(self.root / "admission.lock", deadline):
                        for name in (
                            "spec.json", "spec.json.tmp", "meta.tmp", "meta.json.tmp", "run.json", "run.json.tmp",
                            "spool.json", "spool.json.tmp", "output.bin", "capped", "go", "launch.claim"
                        ):
                            self.path(slot, name).unlink(missing_ok=True)
                        self.path(slot, "meta.json").unlink(missing_ok=True)
                        purged += 1
            if terminal_only and purged:
                break
        return {
            "closed": closed,
            "purged": purged,
            "retained_unknown": retained_unknown,
            "slot_limit": None,
            "max_active": MAX_ACTIVE,
            "max_active_per_actor": MAX_ACTIVE_PER_ACTOR,
            "max_storage_bytes": MAX_STORAGE,
            "max_output_bytes": MAX_OUTPUT,
        }


def set_child_limits():
    try:
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_NPROC, (PROCESS_LIMIT, PROCESS_LIMIT))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    except (ValueError, OSError):
        fail("RESOURCE_LIMIT_UNAVAILABLE")


def runner(root_value: str, slot_value: str, generation: str) -> int:
    runtime_uid()
    root = safe_root(root_value)
    if not SLOT_RE.fullmatch(slot_value) or not GENERATION_RE.fullmatch(generation):
        fail("RUNNER_ARGUMENT_INVALID")
    slot = int(slot_value)
    directory = root / str(slot)
    private_dir(directory)
    meta = load(directory / "meta.json")
    if meta.get("generation") != generation or meta.get("submission") != "ATTEMPTED":
        fail("RUNNER_BINDING_MISMATCH")
    spec = load(directory / "spec.json")
    if digest(spec) != meta.get("spec_digest"):
        fail("RUNNER_SPEC_MISMATCH")
    fd = os.open(directory / "launch.claim", os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(fd)
    deadline = time.monotonic() + LAUNCH_WAIT_SECONDS
    while not (directory / "go").exists():
        if time.monotonic() >= deadline:
            return 125
        time.sleep(0.02)
    set_child_limits()
    os.chdir(Path.home())
    os.umask(0o077)
    forwarded = (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP)
    for sig in forwarded:
        signal.signal(sig, signal.SIG_IGN)
    try:
        pid = os.fork()
    except OSError:
        os.write(2, b"FLEET_SESSION_FORK_FAILED\n")
        return 126
    if pid == 0:
        for sig in forwarded:
            signal.signal(sig, signal.SIG_DFL)
        try:
            os.execv(spec["argv"][0], spec["argv"])
        except OSError:
            os.write(2, b"FLEET_SESSION_EXEC_FAILED\n")
            os._exit(126)
    run = {"generation": generation, "child_pid": pid, "finished": False, "exit_code": None, "exit_signal": None}
    atomic(directory / "run.json", run)
    try:
        _, status = os.waitpid(pid, 0)
    except OSError:
        return 125
    result = os.waitstatus_to_exitcode(status)
    if result < 0:
        try:
            exit_signal = signal.Signals(-result).name
        except ValueError:
            exit_signal = "SIGNAL_" + str(-result)
        exit_code = None
    else:
        exit_signal = None
        exit_code = result
    run.update(finished=True, exit_code=exit_code, exit_signal=exit_signal)
    atomic(directory / "run.json", run)
    return exit_code if exit_code is not None and 0 <= exit_code <= 255 else 128


def spool(root_value: str, slot_value: str, generation: str, spool_token=None) -> int:
    runtime_uid()
    root = safe_root(root_value)
    if not SLOT_RE.fullmatch(slot_value) or not GENERATION_RE.fullmatch(generation):
        fail("SPOOL_ARGUMENT_INVALID")
    slot = int(slot_value)
    directory = root / str(slot)
    meta = load(directory / "meta.json")
    if meta.get("generation") != generation:
        fail("SPOOL_BINDING_MISMATCH")
    if spool_token is not None and (not GENERATION_RE.fullmatch(spool_token) or meta.get("spool_token") != spool_token):
        fail("SPOOL_BINDING_MISMATCH")
    output_path = directory / "output.bin"
    fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "ab", buffering=0) as output:
        current = output_path.stat().st_size
        while True:
            ready, _, _ = select.select([sys.stdin.fileno()], [], [], 0.25)
            if not ready:
                latest = load(directory / "meta.json")
                # tmux 3.6 keeps pipe-pane open for remain-on-exit panes.
                # snapshot() persists EXITED only after pane_dead and the
                # runner receipt agree. pane_dead means the PTY has closed
                # after tmux drained its pipe buffer. Drain our socket as well
                # before sealing; an idle running pane is never sufficient.
                if (latest.get("generation") == generation
                        and latest.get("spool_token") == spool_token
                        and latest.get("state") == "EXITED"
                        and not select.select([sys.stdin.fileno()], [], [], 0)[0]):
                    break
                continue
            chunk = os.read(sys.stdin.fileno(), 8192)
            if not chunk:
                break
            keep = chunk[: max(0, MAX_OUTPUT - current)]
            if keep:
                output.write(keep)
                current += len(keep)
            if len(keep) != len(chunk):
                (directory / "capped").touch(mode=0o600, exist_ok=True)
        output.flush()
        os.fsync(output.fileno())
    atomic(directory / "spool.json", {"generation": generation, "spool_token": spool_token, "output_bytes": current})
    return 0


def main() -> int:
    deadline = time.monotonic() + RPC_SECONDS
    try:
        runtime_uid()
        if len(sys.argv) == 5 and sys.argv[1] in {"run", "spool"}:
            return runner(*sys.argv[2:]) if sys.argv[1] == "run" else spool(*sys.argv[2:])
        if len(sys.argv) == 6 and sys.argv[1] == "spool":
            return spool(*sys.argv[2:])
        if len(sys.argv) != 4 or sys.argv[1] not in {"rpc", "gc"}:
            fail("USAGE_RPC_OR_GC_STATE_ROOT_NODE_UID")
        root = safe_root(sys.argv[2])
        node_uid = sys.argv[3]
        sessions = Sessions(root, node_uid)
        if sys.argv[1] == "rpc":
            request = bounded_request(sys.stdin.fileno(), deadline)
            result = sessions.rpc(request, deadline)
        else:
            result = sessions.gc(deadline)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except SessionError as error:
        print(json.dumps({"ok": False, "error": str(error), "retry_mutation": False}, separators=(",", ":")))
        return 2
    except Exception:
        print(json.dumps({"ok": False, "error": "SESSION_INTERNAL_UNKNOWN", "retry_mutation": False}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
