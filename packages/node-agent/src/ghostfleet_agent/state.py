"""耐用状态文件与原子写原语。

ADR §7：全部状态写盘统一 tmp + os.replace + fsync 文件与目录，避免半写。
state.json 记录 boot_id、seq、上次成功时间、退避计数、工作计数与上次上报观测
摘要（用于跨重启的 drift 比对）；文件权限 0600，目录 0700。

boot_id 语义（工头追加合同 A）：每次进程启动用新的随机 UUID，写入 state.json
持久化轮换；同一 boot_id 内 seq 严格递增，启动时从 0 重新计数。这样控制面可以
拒绝旧 boot_id 重放与 seq 回退，而不依赖内核 boot_id（容器/主机重启语义不同）。

失败语义：读损坏 → StateCorruptError（调用方非零退出，绝不静默重建）；
写失败 → StateWriteError（代理不吞，交给上层决定退出码）。
"""
from __future__ import annotations

import os
import re
import stat
import tempfile
import uuid

from .logging import get_logger
from .protocol import ProtocolError, decode_json, format_timestamp, now_utc

STATE_SCHEMA = "ghostfleet-node-agent-state/v0"
MAX_STATE_BYTES = 128 * 1024
MAX_DOCUMENT_BYTES = 256 * 1024

BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id"
BOOT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
UNKNOWN_BOOT_ID = "boot-unknown"
MAX_COUNTER = 2**31 - 1


def new_boot_id() -> str:
    """进程启动周期标识：每次启动都是新的随机 UUID（合同 A）。"""
    return str(uuid.uuid4())

STATE_DIR_MODE = 0o700
STATE_FILE_MODE = 0o600


class StoreError(Exception):
    """耐用存储错误基类；`code` 是稳定错误码。"""

    code = "AGENT_STATE_ERROR"

    def __init__(self, detail: str = "", *, path: str = "") -> None:
        self.detail = detail
        self.path = path
        super().__init__(detail or self.code)


class StateCorruptError(StoreError):
    code = "STATE_CORRUPT"


class StateWriteError(StoreError):
    code = "STATE_WRITE_FAILED"


class StateReadError(StoreError):
    code = "STATE_READ_FAILED"


def ensure_state_dir(path: str, *, logger=None) -> str:
    """创建并校验状态目录：必须是真实目录（非符号链接），权限 0700。"""
    log = logger or get_logger()
    directory = os.path.abspath(path)
    try:
        os.makedirs(directory, mode=STATE_DIR_MODE, exist_ok=True)
    except OSError as error:
        raise StateWriteError(f"cannot create state directory: {error.strerror}", path=directory) from None
    try:
        info = os.lstat(directory)
    except OSError as error:
        raise StateWriteError(f"cannot stat state directory: {error.strerror}", path=directory) from None
    if not stat.S_ISDIR(info.st_mode):
        raise StateWriteError("state directory is not a directory", path=directory)
    if stat.S_ISLNK(info.st_mode):
        raise StateWriteError("state directory must not be a symlink", path=directory)
    actual = stat.S_IMODE(info.st_mode)
    if actual & 0o077:
        log.warning("state_dir_permissions_loose", path=directory, mode=oct(actual))
    return directory


def _fsync_directory(directory: str) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _unlink_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        return


def atomic_write_bytes(path: str, payload: bytes, *, logger=None) -> None:
    """tmp + fsync + os.replace + fsync(dir)；任何失败都清理临时文件不留半写。"""
    log = logger or get_logger()
    directory = os.path.dirname(os.path.abspath(path)) or "."
    temp_path = ""
    descriptor = -1
    try:
        descriptor, temp_path = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=directory)
        os.fchmod(descriptor, STATE_FILE_MODE)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        temp_path = ""
        _fsync_directory(directory)
    except OSError as error:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temp_path:
            _unlink_quietly(temp_path)
        log.error("state_write_failed", path=path, reason=getattr(error, "strerror", None) or "write failed")
        raise StateWriteError(f"atomic write failed: {error.strerror or 'write failed'}", path=path) from None
    except Exception:  # noqa: BLE001 - 任何异常都不允许留下临时文件
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temp_path:
            _unlink_quietly(temp_path)
        raise


def atomic_write_json(path: str, document, *, logger=None) -> None:
    from .protocol import canonical_json

    try:
        text = canonical_json(document)
    except ProtocolError:
        raise StateWriteError("document is not canonical JSON serialisable", path=path) from None
    atomic_write_bytes(path, (text + "\n").encode("utf-8"), logger=logger)


def load_json_document(
    path: str,
    *,
    schema: str,
    corrupt_error,
    max_bytes: int = MAX_DOCUMENT_BYTES,
    logger=None,
    require_mode: bool = True,
):
    """读取并校验一个 schema 标记的 JSON 对象；文件不存在返回 None。

    损坏（非法 JSON、schema 不符、类型不符、超大、不可读）一律抛 corrupt_error，
    绝不返回部分内容，也绝不自动重建——调用方必须显式处理（通常非零退出）。
    """
    log = logger or get_logger()
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise corrupt_error(f"cannot stat state file: {error.strerror}", path=path) from None
    if stat.S_ISLNK(info.st_mode):
        raise corrupt_error("state file must not be a symlink", path=path)
    if not stat.S_ISREG(info.st_mode):
        raise corrupt_error("state file is not a regular file", path=path)
    if require_mode and stat.S_IMODE(info.st_mode) & 0o077:
        log.warning("state_file_permissions_loose", path=path, mode=oct(stat.S_IMODE(info.st_mode)))
    try:
        with open(path, "rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError as error:
        raise corrupt_error(f"state file is not readable: {error.strerror}", path=path) from None
    if len(raw) > max_bytes:
        raise corrupt_error("state file exceeds size limit", path=path)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise corrupt_error("state file is not UTF-8", path=path) from None
    try:
        document = decode_json(text)
    except ProtocolError as error:
        raise corrupt_error(f"state file is not valid JSON ({error.detail})", path=path) from None
    if not isinstance(document, dict):
        raise corrupt_error("state file root must be an object", path=path)
    if document.get("schema") != schema:
        raise corrupt_error("state file schema mismatch", path=path)
    return document


def read_boot_id(path: str = BOOT_ID_PATH) -> str:
    """读取内核 boot_id；不可用时返回稳定占位值（仍满足信封字段非空）。"""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(128)
    except OSError:
        return UNKNOWN_BOOT_ID
    try:
        text = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        return UNKNOWN_BOOT_ID
    if not text or not BOOT_ID_RE.fullmatch(text):
        return UNKNOWN_BOOT_ID
    return text


class AgentState:
    """state.json 的内存投影；字段全部有界，未知字段不落盘。"""

    __slots__ = (
        "boot_id",
        "seq",
        "last_start",
        "last_stop",
        "last_heartbeat_at",
        "last_success_at",
        "stopping",
        "consecutive_failures",
        "next_backoff_s",
        "server_interval_s",
        "last_observation",
        "last_health",
        "polls",
        "tasks_executed",
        "outbox_overflow",
    )

    def __init__(self) -> None:
        self.boot_id = UNKNOWN_BOOT_ID
        self.seq = 0
        self.last_start = None
        self.last_stop = None
        self.last_heartbeat_at = None
        self.last_success_at = None
        self.stopping = False
        self.consecutive_failures = 0
        self.next_backoff_s = 0
        self.server_interval_s = None
        self.last_observation = None
        self.last_health = None
        self.polls = 0
        self.tasks_executed = 0
        self.outbox_overflow = 0

    def to_document(self) -> dict:
        return {
            "schema": STATE_SCHEMA,
            "boot_id": self.boot_id,
            "seq": int(self.seq),
            "last_start": self.last_start,
            "last_stop": self.last_stop,
            "last_heartbeat_at": self.last_heartbeat_at,
            "last_success_at": self.last_success_at,
            "stopping": bool(self.stopping),
            "consecutive_failures": int(self.consecutive_failures),
            "next_backoff_s": int(self.next_backoff_s),
            "server_interval_s": self.server_interval_s,
            "last_observation": self.last_observation,
            "last_health": self.last_health,
            "polls": int(self.polls),
            "tasks_executed": int(self.tasks_executed),
            "outbox_overflow": int(self.outbox_overflow),
        }

    @classmethod
    def from_document(cls, document: dict) -> "AgentState":
        state = cls()
        boot_id = document.get("boot_id")
        state.boot_id = boot_id if isinstance(boot_id, str) and BOOT_ID_RE.fullmatch(boot_id.replace("-", "")) else UNKNOWN_BOOT_ID
        seq = document.get("seq")
        state.seq = seq if isinstance(seq, int) and not isinstance(seq, bool) and 0 <= seq < 2**53 else 0
        for name in ("last_start", "last_stop", "last_heartbeat_at", "last_success_at", "last_health"):
            value = document.get(name)
            if isinstance(value, str) and len(value) <= 64:
                setattr(state, name, value)
        state.stopping = document.get("stopping") is True
        failures = document.get("consecutive_failures")
        state.consecutive_failures = failures if isinstance(failures, int) and 0 <= failures < 1000 else 0
        backoff = document.get("next_backoff_s")
        state.next_backoff_s = backoff if isinstance(backoff, int) and 0 <= backoff <= 3600 else 0
        interval = document.get("server_interval_s")
        if isinstance(interval, (int, float)) and not isinstance(interval, bool) and 1 <= float(interval) <= 3600:
            state.server_interval_s = float(interval)
        observation = document.get("last_observation")
        if isinstance(observation, dict) and len(observation) <= 32:
            state.last_observation = observation
        for name in ("polls", "tasks_executed", "outbox_overflow"):
            value = document.get(name)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_COUNTER:
                setattr(state, name, value)
        return state


class StateStore:
    """state.json 访问器；每次变更立即持久化，避免"内存有、磁盘无"。"""

    def __init__(self, path: str, *, logger=None, boot_id_path: str | None = None) -> None:
        self.path = os.path.abspath(path)
        self.directory = os.path.dirname(self.path) or "."
        self.logger = logger or get_logger()
        # 兼容旧参数：boot_id 已改为每进程随机 UUID（合同 A），不再读内核 boot_id。
        self._boot_id_path = boot_id_path
        self._state = AgentState()
        self._loaded = False

    @property
    def state(self) -> AgentState:
        return self._state

    def load(self) -> AgentState:
        """载入 state.json 并轮换启动周期；损坏抛 StateCorruptError。

        合同 A：每次进程启动都是新的 boot_id（随机 UUID），seq 从 0 重新计数；
        工作计数（polls/tasks_executed/outbox_overflow）与 last_stop 等事实跨重启保留。
        """
        ensure_state_dir(self.directory, logger=self.logger)
        document = load_json_document(
            self.path,
            schema=STATE_SCHEMA,
            corrupt_error=StateCorruptError,
            max_bytes=MAX_STATE_BYTES,
            logger=self.logger,
        )
        previous_boot = document.get("boot_id") if isinstance(document, dict) else None
        state = AgentState() if document is None else AgentState.from_document(document)
        state.boot_id = new_boot_id()
        state.seq = 0
        state.stopping = False
        state.consecutive_failures = 0
        state.next_backoff_s = 0
        state.last_start = format_timestamp(now_utc())
        self._state = state
        self._loaded = True
        self.save()
        if document is None:
            self.logger.info("state_initialised", path=self.path, boot_id=state.boot_id)
        else:
            self.logger.info(
                "state_boot_rotated",
                path=self.path,
                boot_id=state.boot_id,
                previous_boot_id=previous_boot if isinstance(previous_boot, str) else None,
            )
        return state

    def save(self) -> None:
        atomic_write_json(self.path, self._state.to_document(), logger=self.logger)

    def next_seq(self, *, persist: bool = True) -> int:
        """返回并递增本次启动内的 seq；默认先持久化再返回（合同 A：不得回退）。"""
        self._state.seq += 1
        if persist:
            self.save()
        return self._state.seq

    def rotate_boot_id(self) -> str:
        """控制面回 409 NODE_BOOT_REPLAY 时换新 boot_id，seq 归零。"""
        self._state.boot_id = new_boot_id()
        self._state.seq = 0
        self.save()
        self.logger.warning("boot_id_rotated", boot_id=self._state.boot_id)
        return self._state.boot_id

    def record_poll(self) -> None:
        """累计已轮询次数（跨重启保留，status --json 可读）。"""
        self._state.polls = min(MAX_COUNTER, self._state.polls + 1)
        self.save()

    def record_task_executed(self) -> None:
        self._state.tasks_executed = min(MAX_COUNTER, self._state.tasks_executed + 1)
        self.save()

    def record_outbox_overflow(self, dropped: int) -> None:
        if dropped <= 0:
            return
        self._state.outbox_overflow = min(MAX_COUNTER, self._state.outbox_overflow + int(dropped))
        self.save()

    def record_heartbeat(self, *, interval_s=None, observation=None, health=None) -> None:
        stamp = format_timestamp(now_utc())
        self._state.last_heartbeat_at = stamp
        self._state.last_success_at = stamp
        self._state.consecutive_failures = 0
        self._state.next_backoff_s = 0
        if interval_s is not None:
            self._state.server_interval_s = float(interval_s)
        if observation is not None:
            self._state.last_observation = observation
        if health is not None:
            self._state.last_health = health
        self.save()

    def record_failure(self, backoff_s: int, *, health: str | None = None) -> None:
        self._state.consecutive_failures += 1
        self._state.next_backoff_s = int(backoff_s)
        if health is not None:
            self._state.last_health = health
        self.save()

    def mark_stopping(self) -> None:
        self._state.stopping = True
        self.save()

    def record_stop(self) -> None:
        self._state.last_stop = format_timestamp(now_utc())
        self._state.stopping = False
        self.save()
