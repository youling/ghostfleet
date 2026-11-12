"""每个 task 一份权威记录：单文件原子提交（ADR §7 的数据面）。

旧存储把同一个 task 的事实拆在 ledger.json / outbox.json / tombstones.json 三个文件
里，于是每一次"写账本 + 撤回或重建 outbox body"都是跨文件双写，中间任何一点崩溃都会
留下"账本说 A、body 说 B"的状态，只能靠循环自愈——而自愈本身就是新的 bug 来源。

这里改成：一个 task 的全部事实（栅栏/终态/要发送的 body/投递状态）写在
tasks/<sha256(task_id)>.json 一个文件里，用一次 rename 原子提交。于是"执行终态 +
body + 摘要 + 投递状态"要么全都在、要么全都不在，没有第三种状态。唯一允许的"补事实"
是启动时把 MAY_HAVE_EXECUTED 一次性写成 UNKNOWN（ADR §7 明确允许，且只发生一次）；
此后任何 result_digest 都不再改写，ACK 之后连投递状态都只读。

不变量（load 与每一次写前自检，违反即 fail closed）：

1. 终态（SUCCEEDED/REFUSED/FAILED/UNKNOWN）⟺ result_digest 非 null；
   MAY_HAVE_EXECUTED ⟹ result_body 与 result_digest 都是 null。
2. delivery_state=PENDING ⟹ 有 body、digest 与 body.result 相符，且 body 里的
   task_id / operation / status 与记录逐字一致。
3. 补事实路径唯一：MAY_HAVE_EXECUTED → 一次写同时落 UNKNOWN + body + digest + PENDING。
4. delivery_state=ACKED ⟹ body 为 null、digest 保留、acked_at 非 null（这就是墓碑，
   不再有独立的 tombstone 文件）。
5. delivery_state=DROPPED ⟹ 只允许两类来源：迁移来的旧 dropped 事实（body 可为 null）、
   node_uid 变更导致的永不发送（body 可保留、digest 保留）。
6. 同一 task_id 只允许一个 digest 离开节点：已提交 digest 之后任何摘要变化都是
   TaskStoreConflictError；ACK 之后记录不可再写。
"""

from __future__ import annotations

import copy
import hashlib
import os
import re
from typing import Any

from .logging import get_logger
from .protocol import (
    AGENT_EXECUTION_UNKNOWN,
    RESULT_FAILED,
    RESULT_REFUSED,
    RESULT_STATUSES,
    RESULT_SUCCEEDED,
    RESULT_UNKNOWN,
    ProtocolError,
    canonical_json,
    digest_of,
    make_result,
)
from .state import (
    MAX_DOCUMENT_BYTES,
    STATE_FILE_MODE,
    StateCommitUncertain,
    StateWriteError,
    StoreError,
    atomic_write_json,
    atomic_write_json_checked,
    ensure_state_dir,
    load_json_document,
)

TASK_RECORD_SCHEMA = "ghostfleet-node-task-record/v1"
LEGACY_MANIFEST_SCHEMA = "ghostfleet-node-task-store-legacy/v1"

TASKS_DIRNAME = "tasks"
LEGACY_DIRNAME = "legacy"
IMPORTED_FILENAME = "IMPORTED"
TASKS_DIR_MODE = 0o700
RECORD_FILE_MODE = STATE_FILE_MODE
# 记录数上限包含 ACKED 墓碑：墓碑是"这个 task 已经结束"的唯一证据，驱逐它就会重跑。
MAX_TASK_RECORDS = 4096
# 待投递 body 上限：满了只暂停领取新任务，绝不驱逐任何已存在的记录。
MAX_PENDING_DELIVERIES = 64
MAX_RECORD_BYTES = MAX_DOCUMENT_BYTES

MAY_HAVE_EXECUTED = "MAY_HAVE_EXECUTED"
EXECUTION_SUCCEEDED = RESULT_SUCCEEDED
EXECUTION_REFUSED = RESULT_REFUSED
EXECUTION_FAILED = RESULT_FAILED
EXECUTION_UNKNOWN = RESULT_UNKNOWN
TERMINAL_EXECUTION_STATES = RESULT_STATUSES
EXECUTION_STATES = frozenset({MAY_HAVE_EXECUTED}) | RESULT_STATUSES

DELIVERY_NONE = "NONE"
DELIVERY_PENDING = "PENDING"
DELIVERY_ACKED = "ACKED"
DELIVERY_DROPPED = "DROPPED"
# 隔离：node_uid 变更后，已执行任务的证据既不能发（收件方会当外来节点拒绝），
# 也不能删（那是把真实执行事实变成不可追溯的丢弃）。body 与摘要原样留在同一个文件里，
# 只是永不发送、永不删除、不计入 MAX_PENDING_DELIVERIES。
DELIVERY_QUARANTINED = "QUARANTINED"
DELIVERY_STATES = frozenset({DELIVERY_NONE, DELIVERY_PENDING, DELIVERY_ACKED, DELIVERY_DROPPED, DELIVERY_QUARANTINED})
QUARANTINE_NODE_UID_CHANGED = "node_uid_changed"

BEGIN_NEW = "NEW"
BEGIN_FENCED = "ALREADY_FENCED"
BEGIN_DONE = "ALREADY_DONE"
BEGIN_CAPACITY = "CAPACITY"

CAPACITY_RECORD = "record_capacity"
CAPACITY_PENDING = "pending_capacity"

# 旧布局（迁移唯一消费者）。格式已经冻结，副本留在这里：阶段二删掉旧模块也不会
# 影响"读得懂上一次升级前的盘上数据"这件事。
LEGACY_LEDGER_FILENAME = "ledger.json"
LEGACY_OUTBOX_FILENAME = "outbox.json"
LEGACY_TOMBSTONES_FILENAME = "tombstones.json"
LEGACY_LEDGER_SCHEMA = "ghostfleet-node-agent-ledger/v0"
LEGACY_OUTBOX_SCHEMA = "ghostfleet-node-agent-outbox/v0"
LEGACY_TOMBSTONE_SCHEMA = "ghostfleet-node-agent-tombstones/v0"
LEGACY_FENCED_STATE = MAY_HAVE_EXECUTED

_RECORD_NAME_RE = re.compile(r"[0-9a-f]{64}\.json")


class TaskStoreError(StoreError):
    code = "TASK_STORE_ERROR"


class TaskStoreCorruptError(TaskStoreError):
    code = "TASK_STORE_CORRUPT"


class TaskStoreWriteError(TaskStoreError):
    code = "TASK_STORE_WRITE_FAILED"


class TaskStoreUncertainError(TaskStoreError):
    """rename 已发生、目录 fsync 失败：磁盘可能是新内容。

    loop 唯一允许的反应是 FATAL（退出非 0，让 supervisor 重启后从磁盘重新读真值）。
    绝不允许继续用旧的内存索引——那就是"伪提交"。
    """

    code = "TASK_STORE_COMMIT_UNCERTAIN"


class TaskStoreConflictError(TaskStoreError):
    code = "TASK_STORE_CONFLICT"


def _now() -> str:
    from .protocol import format_timestamp, now_utc

    return format_timestamp(now_utc())


def record_filename(task_id: str) -> str:
    """记录文件名 = sha256(task_id) 的小写十六进制 + .json。"""
    return hashlib.sha256(task_id.encode("utf-8")).hexdigest() + ".json"


# v1 记录的完整字段集合。归档相关字段（archived_at / archive_reason 等）刻意不在其中：
# 它们只出现在归档行，由 task-33 引入；load 遇到未知字段是忽略并记日志，不是报错。
RECORD_FIELDS = (
    "schema",
    "task_id",
    "operation",
    "attempt",
    "execution_state",
    "reconciled",
    "started_at",
    "completed_at",
    "result_body",
    "result_digest",
    "delivery_state",
    "delivery_attempts",
    "last_error_code",
    "queued_at",
    "acked_at",
    "dropped_at",
    "quarantined_at",
    "quarantine_reason",
    "original_node_uid",
)


def build_record(
    *,
    task_id: str,
    operation: str,
    attempt: int,
    started_at: str | None,
    execution_state: str = MAY_HAVE_EXECUTED,
    reconciled: bool = False,
    completed_at: str | None = None,
    result_body: dict | None = None,
    result_digest: str | None = None,
    delivery_state: str = DELIVERY_NONE,
    delivery_attempts: int = 0,
    last_error_code: str | None = None,
    queued_at: str | None = None,
    acked_at: str | None = None,
    dropped_at: str | None = None,
    quarantined_at: str | None = None,
    quarantine_reason: str | None = None,
    original_node_uid: str | None = None,
) -> dict:
    """构造一条记录（字段齐全、顺序固定，便于 diff 与人工读取）。"""
    return {
        "schema": TASK_RECORD_SCHEMA,
        "task_id": task_id,
        "operation": operation,
        "attempt": attempt,
        "execution_state": execution_state,
        "reconciled": reconciled,
        "started_at": started_at,
        "completed_at": completed_at,
        "result_body": result_body,
        "result_digest": result_digest,
        "delivery_state": delivery_state,
        "delivery_attempts": delivery_attempts,
        "last_error_code": last_error_code,
        "queued_at": queued_at,
        "acked_at": acked_at,
        "dropped_at": dropped_at,
        "quarantined_at": quarantined_at,
        "quarantine_reason": quarantine_reason,
        "original_node_uid": original_node_uid,
    }


def _corrupt(detail: str, path: str) -> None:
    raise TaskStoreCorruptError(detail, path=path)


def _optional_text(record: dict, field: str, *, path: str) -> None:
    value = record.get(field)
    if value is not None and not isinstance(value, str):
        _corrupt(f"task record field {field} must be a string or null", path)


def _validate_body(body: dict, *, task_id: str, operation: str, state: str, digest: str, path: str) -> None:
    """不变量 2：PENDING 的 body 必须能被独立重算并逐字对上记录。"""
    if not isinstance(body, dict):
        _corrupt("task record result_body must be an object", path)
    body_task_id = body.get("task_id")
    if body_task_id != task_id:
        _corrupt("task record result_body task_id does not match the record", path)
    body_operation = body.get("operation")
    if not isinstance(body_operation, str) or body_operation != operation:
        _corrupt("task record result_body operation does not match the record", path)
    result = body.get("result")
    if not isinstance(result, dict):
        _corrupt("task record result_body has no result object", path)
    if result.get("task_id") != task_id:
        _corrupt("task record result_body result task_id does not match the record", path)
    if result.get("operation") != operation:
        _corrupt("task record result_body result operation does not match the record", path)
    if result.get("status") != state:
        _corrupt("task record result_body result status does not match the execution state", path)
    try:
        computed = digest_of(result)
    except ProtocolError:
        _corrupt("task record result_body result is not canonical JSON", path)
        return
    if body.get("result_digest") != digest:
        _corrupt("task record result_body digest does not match the record", path)
    if computed != digest:
        _corrupt("task record result_digest does not match the result body", path)


def validate_record(record: dict, *, path: str = "") -> None:
    """记录自检：load 时和每次写盘前都要过一遍。"""
    if not isinstance(record, dict):
        _corrupt("task record must be an object", path)
    if record.get("schema") != TASK_RECORD_SCHEMA:
        _corrupt("task record schema mismatch", path)
    task_id = record.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        _corrupt("task record task_id must be a non-empty string", path)
    operation = record.get("operation")
    if not isinstance(operation, str) or not operation:
        _corrupt("task record operation must be a non-empty string", path)
    attempt = record.get("attempt")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        _corrupt("task record attempt must be an integer >= 1", path)
    state = record.get("execution_state")
    if state not in EXECUTION_STATES:
        _corrupt("task record execution_state is not a known state", path)
    if not isinstance(record.get("reconciled"), bool):
        _corrupt("task record reconciled must be a boolean", path)
    for field in (
        "started_at",
        "completed_at",
        "result_digest",
        "last_error_code",
        "queued_at",
        "acked_at",
        "dropped_at",
        "quarantined_at",
        "quarantine_reason",
        "original_node_uid",
    ):
        _optional_text(record, field, path=path)
    body = record.get("result_body")
    if body is not None and not isinstance(body, dict):
        _corrupt("task record result_body must be an object or null", path)
    digest = record.get("result_digest")
    delivery = record.get("delivery_state")
    if delivery not in DELIVERY_STATES:
        _corrupt("task record delivery_state is not a known state", path)
    attempts = record.get("delivery_attempts")
    if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
        _corrupt("task record delivery_attempts must be an integer >= 0", path)

    terminal = state in TERMINAL_EXECUTION_STATES
    if terminal and not isinstance(digest, str):
        _corrupt("terminal task record must carry a result_digest", path)
    if not terminal and digest is not None:
        _corrupt("MAY_HAVE_EXECUTED task record must not carry a result_digest", path)
    if not terminal and body is not None:
        _corrupt("MAY_HAVE_EXECUTED task record must not carry a result_body", path)

    if delivery == DELIVERY_NONE:
        if body is not None or digest is not None:
            _corrupt("task record with no delivery must not carry a result body", path)
        if terminal:
            _corrupt("terminal task record must have a delivery state", path)
        if record.get("queued_at") or record.get("acked_at") or record.get("dropped_at"):
            _corrupt("task record with no delivery must not carry delivery timestamps", path)
    elif delivery == DELIVERY_PENDING:
        if body is None or not isinstance(digest, str):
            _corrupt("pending delivery must carry a result body and digest", path)
        _validate_body(body, task_id=task_id, operation=operation, state=state, digest=digest, path=path)
        if not record.get("queued_at"):
            _corrupt("pending delivery must record queued_at", path)
        if record.get("acked_at") or record.get("dropped_at"):
            _corrupt("pending delivery must not carry acked_at or dropped_at", path)
    elif delivery == DELIVERY_ACKED:
        if body is not None:
            _corrupt("acked task record must not keep the result body", path)
        if not isinstance(digest, str):
            _corrupt("acked task record must keep the result digest", path)
        if not record.get("acked_at"):
            _corrupt("acked task record must record acked_at", path)
        if record.get("dropped_at"):
            _corrupt("acked task record must not record dropped_at", path)
    elif delivery == DELIVERY_QUARANTINED:
        # 不变量 5b：隔离是"状态"不是"移动"。已执行任务的证据必须原样留在同一文件里，
        # 摘要仍由 body.result 重算得出；只额外要求隔离时间、原因与旧 node_uid。
        if body is None or not isinstance(digest, str):
            _corrupt("quarantined task record must keep its result body and digest", path)
        _validate_body(body, task_id=task_id, operation=operation, state=state, digest=digest, path=path)
        if not record.get("quarantined_at"):
            _corrupt("quarantined task record must record quarantined_at", path)
        reason = record.get("quarantine_reason")
        if not isinstance(reason, str) or not reason:
            _corrupt("quarantined task record must record quarantine_reason", path)
        original = record.get("original_node_uid")
        if not isinstance(original, str) or not original:
            _corrupt("quarantined task record must record original_node_uid", path)
        if record.get("acked_at") or record.get("dropped_at"):
            _corrupt("quarantined task record must not carry acked_at or dropped_at", path)
    else:  # DELIVERY_DROPPED
        if not record.get("dropped_at"):
            _corrupt("dropped task record must record dropped_at", path)
        if record.get("acked_at"):
            _corrupt("dropped task record must not record acked_at", path)
        if body is not None and isinstance(digest, str):
            # node_uid 变更的"永不发送"允许保留 body：结构与摘要仍必须自洽，
            # 但不比对 node_uid（正是它变了才丢）。
            _validate_body(body, task_id=task_id, operation=operation, state=state, digest=digest, path=path)


def _require_text(value: Any, *, what: str, path: str) -> str:
    if not isinstance(value, str) or not value:
        raise TaskStoreWriteError(f"{what} must be a non-empty string", path=path)
    return value


class TaskRecordStore:
    """权威 task 记录存储：一个 task 一个文件，一次 rename 一个提交。"""

    def __init__(
        self,
        directory: str,
        *,
        node_uid: str | None = None,
        logger=None,
        ledger_path: str | None = None,
        outbox_path: str | None = None,
        tombstone_path: str | None = None,
    ) -> None:
        self.directory = os.path.abspath(directory)
        self.tasks_dir = os.path.join(self.directory, TASKS_DIRNAME)
        self.legacy_dir = os.path.join(self.directory, LEGACY_DIRNAME)
        self.imported_path = os.path.join(self.legacy_dir, IMPORTED_FILENAME)
        self.node_uid = node_uid
        self.logger = logger or get_logger()
        self._ledger_path = os.path.abspath(ledger_path or os.path.join(self.directory, LEGACY_LEDGER_FILENAME))
        self._outbox_path = os.path.abspath(outbox_path or os.path.join(self.directory, LEGACY_OUTBOX_FILENAME))
        self._tombstone_path = os.path.abspath(tombstone_path or os.path.join(self.directory, LEGACY_TOMBSTONES_FILENAME))
        self._records: dict[str, dict] = {}

    # ------------------------------------------------------------------ 读取

    def load(self) -> list[dict]:
        """载入记录并（必要时）迁移旧布局；任何不确定都 fail closed。"""
        try:
            ensure_state_dir(self.directory, logger=self.logger)
        except StateWriteError as error:
            raise TaskStoreWriteError(error.detail, path=self.directory) from None
        self._ensure_tasks_dir()
        self._records = {}
        self._load_records()
        self._migrate_legacy()
        return self.records()

    def records(self) -> list[dict]:
        return [copy.deepcopy(record) for record in sorted(self._records.values(), key=lambda r: r["task_id"])]

    def get(self, task_id: str) -> dict | None:
        record = self._records.get(task_id)
        return None if record is None else copy.deepcopy(record)

    def inspect(self, task_id: str) -> str | None:
        """只读：返回执行状态（含终态与栅栏），完全没有事实时返回 None。"""
        record = self._records.get(task_id)
        if record is None:
            return None
        return record.get("execution_state")

    def list_fenced(self) -> list[str]:
        """需要补 UNKNOWN 事实的栅栏（按 task_id 排序，顺序稳定）。"""
        return sorted(task_id for task_id, record in self._records.items() if record["execution_state"] == MAY_HAVE_EXECUTED)

    def list_pending(self) -> list[dict]:
        """待投递记录，按 (queued_at, task_id) 排序——重启后重发顺序与入队顺序一致。"""
        pending = [copy.deepcopy(record) for record in self._records.values() if record["delivery_state"] == DELIVERY_PENDING]
        pending.sort(key=lambda record: (record.get("queued_at") or "", record["task_id"]))
        return pending

    def pending_count(self) -> int:
        return sum(1 for record in self._records.values() if record["delivery_state"] == DELIVERY_PENDING)

    def list_quarantined(self) -> list[dict]:
        """隔离记录（永不发送、永不删除）：status 必须把它们列出来，绝不静默。"""
        quarantined = [
            copy.deepcopy(record) for record in self._records.values() if record["delivery_state"] == DELIVERY_QUARANTINED
        ]
        quarantined.sort(key=lambda record: (record.get("quarantined_at") or "", record["task_id"]))
        return quarantined

    def quarantined_count(self) -> int:
        return sum(1 for record in self._records.values() if record["delivery_state"] == DELIVERY_QUARANTINED)

    def record_count(self) -> int:
        return len(self._records)

    def capacity_reason(self) -> str | None:
        """满容量的原因；None 表示还能领取新任务。"""
        if len(self._records) >= MAX_TASK_RECORDS:
            return CAPACITY_RECORD
        if self.pending_count() >= MAX_PENDING_DELIVERIES:
            return CAPACITY_PENDING
        return None

    # ------------------------------------------------------------------ 写入

    def begin(self, task_id: str, operation: str, *, attempt: int = 1) -> str:
        """为派发栅栏写记录：NEW 表示可以执行，其余都是"不要再执行"。"""
        path = self.record_path(task_id)
        _require_text(task_id, what="task_id", path=path)
        _require_text(operation, what="operation", path=path)
        existing = self._records.get(task_id)
        if existing is not None:
            if existing["execution_state"] == MAY_HAVE_EXECUTED:
                return BEGIN_FENCED
            return BEGIN_DONE
        reason = self.capacity_reason()
        if reason is not None:
            self.logger.warning(
                "task_intake_paused",
                reason=reason,
                records=len(self._records),
                pending=self.pending_count(),
                limit_records=MAX_TASK_RECORDS,
                limit_pending=MAX_PENDING_DELIVERIES,
            )
            return BEGIN_CAPACITY
        safe_attempt = attempt if isinstance(attempt, int) and not isinstance(attempt, bool) and attempt >= 1 else 1
        record = build_record(
            task_id=task_id,
            operation=operation,
            attempt=safe_attempt,
            started_at=_now(),
            execution_state=MAY_HAVE_EXECUTED,
            reconciled=False,
            delivery_state=DELIVERY_NONE,
        )
        self._commit(path, record)
        return BEGIN_NEW

    def complete(self, task_id: str, status: str, *, result: dict) -> dict:
        """终态 + body + 摘要 + PENDING 一次写完（不接受"先写终态再补 body"）。"""
        path = self.record_path(task_id)
        record = self._require_record(task_id, path=path)
        if status not in TERMINAL_EXECUTION_STATES:
            raise TaskStoreWriteError("terminal status must be SUCCEEDED/REFUSED/FAILED/UNKNOWN", path=path)
        if not isinstance(result, dict):
            raise TaskStoreWriteError("result must be an object", path=path)
        if result.get("task_id") != task_id:
            raise TaskStoreWriteError("result task_id does not match the task record", path=path)
        if result.get("status") != status:
            raise TaskStoreWriteError("result status does not match the terminal status", path=path)
        try:
            digest = digest_of(result)
        except ProtocolError:
            raise TaskStoreWriteError("result is not canonical JSON", path=path) from None
        body = {"task_id": task_id, "operation": record["operation"], "result": result, "result_digest": digest}
        existing_digest = record.get("result_digest")
        if isinstance(existing_digest, str):
            if existing_digest != digest:
                raise TaskStoreConflictError("result digest already committed for this task", path=path)
            return copy.deepcopy(record)
        if record["delivery_state"] != DELIVERY_NONE:
            raise TaskStoreConflictError("task record already has a delivery state", path=path)
        now = _now()
        candidate = copy.deepcopy(record)
        candidate.update(
            {
                "execution_state": status,
                "reconciled": True,
                "completed_at": now,
                "result_body": body,
                "result_digest": digest,
                "delivery_state": DELIVERY_PENDING,
                "delivery_attempts": 0,
                "last_error_code": None,
                "queued_at": now,
                "acked_at": None,
                "dropped_at": None,
            }
        )
        self._commit(path, candidate)
        return copy.deepcopy(candidate)

    def mark_unknown(self, task_id: str) -> dict | None:
        """唯一允许的补事实路径：MAY_HAVE_EXECUTED → UNKNOWN（一次原子写）。"""
        path = self.record_path(task_id)
        record = self._records.get(task_id)
        if record is None:
            return None
        if record["execution_state"] != MAY_HAVE_EXECUTED:
            return copy.deepcopy(record)
        node_uid = self.node_uid
        if not isinstance(node_uid, str) or not node_uid:
            raise TaskStoreWriteError("node uid is required to synthesise an UNKNOWN result", path=path)
        try:
            result = make_result(
                task_id=task_id,
                node_uid=node_uid,
                operation=record["operation"],
                status=EXECUTION_UNKNOWN,
                code=AGENT_EXECUTION_UNKNOWN,
            )
            digest = digest_of(result)
        except ProtocolError as error:
            raise TaskStoreWriteError(f"cannot synthesise an UNKNOWN result: {error.detail}", path=path) from None
        now = _now()
        body = {"task_id": task_id, "operation": record["operation"], "result": result, "result_digest": digest}
        candidate = copy.deepcopy(record)
        candidate.update(
            {
                "execution_state": EXECUTION_UNKNOWN,
                "reconciled": True,
                "completed_at": now,
                "result_body": body,
                "result_digest": digest,
                "delivery_state": DELIVERY_PENDING,
                "delivery_attempts": 0,
                "last_error_code": None,
                "queued_at": now,
                "acked_at": None,
                "dropped_at": None,
            }
        )
        self._commit(path, candidate)
        return copy.deepcopy(candidate)

    def ack(self, task_id: str) -> dict:
        """控制面已接受这条结果：body 清空、摘要留作墓碑（一次原子写）。"""
        path = self.record_path(task_id)
        record = self._require_record(task_id, path=path)
        if record["delivery_state"] == DELIVERY_ACKED:
            return copy.deepcopy(record)
        if record["delivery_state"] != DELIVERY_PENDING:
            raise TaskStoreConflictError("only a pending delivery can be acked", path=path)
        candidate = copy.deepcopy(record)
        candidate.update({"delivery_state": DELIVERY_ACKED, "result_body": None, "acked_at": _now()})
        self._commit(path, candidate)
        return copy.deepcopy(candidate)

    def drop(self, task_id: str, *, code: str | None = None) -> dict:
        """永不发送：保留 body 与摘要（若已有），只把投递判死。"""
        path = self.record_path(task_id)
        record = self._require_record(task_id, path=path)
        if record["delivery_state"] == DELIVERY_DROPPED:
            return copy.deepcopy(record)
        if record["delivery_state"] != DELIVERY_PENDING:
            raise TaskStoreConflictError("only a pending delivery can be dropped", path=path)
        candidate = copy.deepcopy(record)
        candidate.update(
            {
                "delivery_state": DELIVERY_DROPPED,
                "dropped_at": _now(),
                "last_error_code": code or record.get("last_error_code"),
            }
        )
        self._commit(path, candidate)
        return copy.deepcopy(candidate)

    def record_delivery_failure(self, task_id: str, code: str) -> dict:
        """投递失败记账：只改 attempts / last_error_code，绝不改 body 或摘要。"""
        path = self.record_path(task_id)
        record = self._require_record(task_id, path=path)
        _require_text(code, what="delivery failure code", path=path)
        if record["delivery_state"] != DELIVERY_PENDING:
            raise TaskStoreConflictError("only a pending delivery can record a failure", path=path)
        candidate = copy.deepcopy(record)
        candidate.update(
            {
                "delivery_attempts": record["delivery_attempts"] + 1,
                "last_error_code": code,
            }
        )
        self._commit(path, candidate)
        return copy.deepcopy(candidate)

    # ------------------------------------------------------------------ 内部

    def record_path(self, task_id: str) -> str:
        return os.path.join(self.tasks_dir, record_filename(task_id if isinstance(task_id, str) else ""))

    def _require_record(self, task_id: str, *, path: str) -> dict:
        _require_text(task_id, what="task_id", path=path)
        record = self._records.get(task_id)
        if record is None:
            raise TaskStoreWriteError("task record is missing; begin() must fence the task first", path=path)
        return record

    def _ensure_tasks_dir(self) -> None:
        try:
            ensure_state_dir(self.tasks_dir, logger=self.logger)
        except StateWriteError as error:
            raise TaskStoreWriteError(error.detail, path=self.tasks_dir) from None

    def _load_records(self) -> None:
        try:
            names = sorted(os.listdir(self.tasks_dir))
        except OSError as error:
            raise TaskStoreWriteError(f"cannot list task records: {error.strerror or 'list failed'}", path=self.tasks_dir) from None
        for name in names:
            path = os.path.join(self.tasks_dir, name)
            if name.startswith(".tmp-"):
                self._remove_stale_temp(path)
                continue
            if not _RECORD_NAME_RE.fullmatch(name):
                _corrupt(f"unexpected file in the task record directory: {name}", path)
            record = load_json_document(
                path,
                schema=TASK_RECORD_SCHEMA,
                corrupt_error=TaskStoreCorruptError,
                max_bytes=MAX_RECORD_BYTES,
                logger=self.logger,
            )
            if record is None:
                continue
            task_id = record.get("task_id") if isinstance(record, dict) else None
            if not isinstance(task_id, str) or not task_id:
                _corrupt("task record task_id must be a non-empty string", path)
            if record_filename(task_id) != name:
                _corrupt("task record filename does not match sha256(task_id)", path)
            validate_record(record, path=path)
            unknown = sorted(set(record) - set(RECORD_FIELDS))
            if unknown:
                # 向前兼容：归档行才会出现的字段（archived_at / archive_reason ...）
                # 出现在记录文件里时是"忽略"，不是"损坏"——旧版本不能因为新字段就拒绝启动。
                self.logger.warning("task_record_unknown_fields_ignored", path=path, fields=unknown)
                record = {name: record[name] for name in RECORD_FIELDS if name in record}
            if task_id in self._records:
                _corrupt("duplicate task record for one task_id", path)
            self._records[task_id] = record

    def _remove_stale_temp(self, path: str) -> None:
        # 上一个进程被强杀时可能留下 .tmp-*；它不是事实，删掉即可（原子写的正确性不依赖它）。
        try:
            os.unlink(path)
        except OSError as error:
            self.logger.error("task_store_temp_remove_failed", path=path, reason=getattr(error, "strerror", None) or "unlink failed")
            return
        self.logger.warning("task_store_temp_removed", path=path)

    def _commit(self, path: str, candidate: dict) -> None:
        """唯一的落盘入口：先自检、再原子写、durable 之后才更新内存索引。"""
        validate_record(candidate, path=path)
        existing = self._records.get(candidate["task_id"])
        if existing is not None:
            if existing["delivery_state"] == DELIVERY_ACKED:
                raise TaskStoreConflictError("acked task record is immutable", path=path)
            if existing["operation"] != candidate["operation"]:
                raise TaskStoreConflictError("task record operation is fixed once written", path=path)
            existing_digest = existing.get("result_digest")
            if isinstance(existing_digest, str) and candidate.get("result_digest") != existing_digest:
                raise TaskStoreConflictError("result digest already committed for this task", path=path)
        try:
            size = len(canonical_json(candidate).encode("utf-8")) + 1
        except ProtocolError:
            raise TaskStoreWriteError("task record is not canonical JSON serialisable", path=path) from None
        if size > MAX_RECORD_BYTES:
            raise TaskStoreWriteError(f"task record is too large ({size} > {MAX_RECORD_BYTES} bytes)", path=path)
        try:
            atomic_write_json_checked(path, candidate, logger=self.logger)
        except StateWriteError as error:
            raise TaskStoreWriteError(error.detail, path=path) from None
        except StateCommitUncertain as error:
            raise TaskStoreUncertainError(error.detail, path=path) from None
        self._records[candidate["task_id"]] = candidate

    # --------------------------------------------------------------- 迁移

    def _migrate_legacy(self) -> None:
        sources = [
            (LEGACY_LEDGER_FILENAME, self._ledger_path, LEGACY_LEDGER_SCHEMA),
            (LEGACY_OUTBOX_FILENAME, self._outbox_path, LEGACY_OUTBOX_SCHEMA),
            (LEGACY_TOMBSTONES_FILENAME, self._tombstone_path, LEGACY_TOMBSTONE_SCHEMA),
        ]
        present = [(name, path, schema) for name, path, schema in sources if os.path.exists(path)]
        if not present:
            return
        if os.path.exists(self.imported_path):
            # 清单已存在：导入阶段早就完成了；只剩"移动旧文件"可能没做完。
            self._finish_legacy_move(present)
            return
        documents: dict[str, dict] = {}
        for name, path, schema in present:
            document = load_json_document(
                path,
                schema=schema,
                corrupt_error=TaskStoreCorruptError,
                logger=self.logger,
            )
            if document is None:
                raise TaskStoreCorruptError("legacy file disappeared during migration", path=path)
            documents[name] = document
        planned, legacy_ids, warnings, per_file = _plan_migration(
            ledger_document=documents.get(LEGACY_LEDGER_FILENAME),
            outbox_document=documents.get(LEGACY_OUTBOX_FILENAME),
            tombstone_document=documents.get(LEGACY_TOMBSTONES_FILENAME),
            now=_now(),
        )
        missing = [task_id for task_id in legacy_ids if task_id not in self._records and task_id not in planned]
        if missing:
            raise TaskStoreCorruptError(
                f"legacy facts did not produce task records for {len(missing)} task id(s): {sorted(missing)[:5]}",
                path=self.tasks_dir,
            )
        fresh = [task_id for task_id in planned if task_id not in self._records]
        if len(self._records) + len(fresh) > MAX_TASK_RECORDS:
            raise TaskStoreCorruptError(
                f"legacy migration would create {len(self._records) + len(fresh)} task records (limit {MAX_TASK_RECORDS})",
                path=self.tasks_dir,
            )
        self._ensure_legacy_dir()
        manifest = {
            "schema": LEGACY_MANIFEST_SCHEMA,
            "imported_at": _now(),
            "records": len(fresh),
            "files": [
                {
                    "name": name,
                    "sha256": _sha256_of(path),
                    "bytes": os.stat(path).st_size,
                    "imported_records": per_file.get(name, 0),
                }
                for name, path, _schema in present
            ],
            "warnings": warnings,
        }
        try:
            atomic_write_json(self.imported_path, manifest, logger=self.logger)
        except StateWriteError as error:
            raise TaskStoreWriteError(error.detail, path=self.imported_path) from None
        for task_id in fresh:
            self._commit(self.record_path(task_id), planned[task_id])
        for warning in warnings:
            self.logger.warning("task_store_migration_warning", **warning)
        self.logger.info(
            "state_layout_migrated",
            records=len(self._records),
            imported_ledger=per_file.get(LEGACY_LEDGER_FILENAME, 0),
            imported_outbox=per_file.get(LEGACY_OUTBOX_FILENAME, 0),
            imported_tombstones=per_file.get(LEGACY_TOMBSTONES_FILENAME, 0),
            imported_dropped=per_file.get("dropped", 0),
        )
        self._finish_legacy_move(present)

    def _ensure_legacy_dir(self) -> None:
        try:
            ensure_state_dir(self.legacy_dir, logger=self.logger)
        except StateWriteError as error:
            raise TaskStoreWriteError(error.detail, path=self.legacy_dir) from None

    def _finish_legacy_move(self, present: list[tuple[str, str, str]]) -> None:
        """把旧文件原样移进 legacy/：不删除、不改字节，迁移后仍可人工审计。"""
        self._ensure_legacy_dir()
        for name, path, _schema in present:
            target = os.path.join(self.legacy_dir, name)
            if os.path.exists(target):
                self.logger.warning("task_store_legacy_duplicate", source=path, target=target)
                continue
            try:
                os.replace(path, target)
            except OSError as error:
                raise TaskStoreWriteError(
                    f"cannot move legacy file into {LEGACY_DIRNAME}/: {error.strerror or 'replace failed'}",
                    path=path,
                ) from None
            self.logger.info("task_store_legacy_moved", name=name, target=target)


def _sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _legacy_entries(document: dict | None, what: str) -> dict:
    if document is None:
        return {}
    entries = document.get("entries")
    if not isinstance(entries, dict):
        raise TaskStoreCorruptError(f"legacy {what} file has no entries object")
    return {task_id: entry for task_id, entry in entries.items() if isinstance(entry, dict)}


def _legacy_outbox(document: dict | None) -> tuple[list[dict], list[str]]:
    if document is None:
        return [], []
    items = document.get("items")
    dropped = document.get("dropped")
    if not isinstance(items, list):
        raise TaskStoreCorruptError("legacy outbox file has no items list")
    if dropped is None:
        dropped = []
    if not isinstance(dropped, list):
        raise TaskStoreCorruptError("legacy outbox dropped list is not a list")
    clean_items = [item for item in items if isinstance(item, dict)]
    clean_dropped = [task_id for task_id in dropped if isinstance(task_id, str) and task_id]
    return clean_items, clean_dropped


def _body_problems(body: Any, *, task_id: str, operation: str, state: str, digest: str) -> list[str]:
    """迁移时判断旧 body 能否原样挂到记录上（等价于不变量 2，附问题码便于日志）。"""
    if not isinstance(body, dict):
        return ["result-not-object"]
    problems: list[str] = []
    if body.get("task_id") != task_id:
        problems.append("body-task-id-mismatch")
    if body.get("operation") != operation:
        problems.append("body-operation-mismatch")
    result = body.get("result")
    if not isinstance(result, dict):
        problems.append("result-not-object")
        return problems
    if result.get("task_id") != task_id:
        problems.append("result-task-id-mismatch")
    if result.get("operation") != operation:
        problems.append("result-operation-mismatch")
    if result.get("status") != state:
        problems.append("result-status-mismatch")
    try:
        computed = digest_of(result)
    except ProtocolError:
        problems.append("result-not-canonical")
        return problems
    if computed != digest:
        problems.append("result-digest-mismatch")
    if body.get("result_digest") != digest:
        problems.append("body-digest-mismatch")
    return problems


def _plan_migration(
    *,
    ledger_document: dict | None,
    outbox_document: dict | None,
    tombstone_document: dict | None,
    now: str,
) -> tuple[dict[str, dict], set[str], list[dict], dict[str, int]]:
    """把旧三文件的事实映射成记录（纯函数：不写盘，便于单测）。

    绝不重建摘要、绝不改写 operation：只做"把已有事实搬到新布局"这一件事。
    """
    planned: dict[str, dict] = {}
    legacy_ids: set[str] = set()
    warnings: list[dict] = []
    per_file: dict[str, int] = {}

    def bump(name: str) -> None:
        per_file[name] = per_file.get(name, 0) + 1

    # 1) 账本：执行事实的唯一权威。
    for task_id, entry in _legacy_entries(ledger_document, "ledger").items():
        legacy_ids.add(task_id)
        bump(LEGACY_LEDGER_FILENAME)
        state = entry.get("state")
        if state == LEGACY_FENCED_STATE:
            execution = MAY_HAVE_EXECUTED
        elif isinstance(state, str) and state in TERMINAL_EXECUTION_STATES:
            execution = state
        else:
            raise TaskStoreCorruptError(f"legacy ledger entry has an unknown state: {state!r}")
        operation = entry.get("operation")
        if not isinstance(operation, str) or not operation:
            operation = "unknown"
            warnings.append({"kind": "ledger-operation-missing", "task_id": task_id})
        attempt = entry.get("attempt")
        if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
            attempt = 1
        digest = entry.get("result_digest")
        if execution != MAY_HAVE_EXECUTED and not isinstance(digest, str):
            raise TaskStoreCorruptError("legacy ledger entry is terminal but has no result digest")
        finished_at = entry.get("finished_at") if isinstance(entry.get("finished_at"), str) else None
        started_at = entry.get("started_at") if isinstance(entry.get("started_at"), str) else None
        if execution == MAY_HAVE_EXECUTED:
            planned[task_id] = build_record(
                task_id=task_id,
                operation=operation,
                attempt=attempt,
                started_at=started_at,
                execution_state=MAY_HAVE_EXECUTED,
                reconciled=entry.get("reconciled") is True,
                delivery_state=DELIVERY_NONE,
            )
        else:
            # 终态记录默认视为"投递已成事实"（旧布局里 body 只可能还在 outbox；若还在，
            # 下面第 3 步会把它接上并改成 PENDING）。
            planned[task_id] = build_record(
                task_id=task_id,
                operation=operation,
                attempt=attempt,
                started_at=started_at,
                execution_state=execution,
                reconciled=entry.get("reconciled") is True,
                completed_at=finished_at,
                result_digest=digest,
                delivery_state=DELIVERY_ACKED,
                acked_at=finished_at or now,
            )

    # 2) 墓碑：账本被驱逐后唯一剩下的终态事实。
    for task_id, entry in _legacy_entries(tombstone_document, "tombstones").items():
        legacy_ids.add(task_id)
        bump(LEGACY_TOMBSTONES_FILENAME)
        if task_id in planned:
            warnings.append({"kind": "tombstone-shadowed-by-ledger", "task_id": task_id})
            continue
        state = entry.get("state")
        digest = entry.get("result_digest")
        if not isinstance(state, str) or state not in TERMINAL_EXECUTION_STATES:
            raise TaskStoreCorruptError("legacy tombstone has an unknown state")
        if not isinstance(digest, str):
            raise TaskStoreCorruptError("legacy tombstone has no result digest")
        operation = entry.get("operation")
        if not isinstance(operation, str) or not operation:
            operation = "unknown"
            warnings.append({"kind": "tombstone-operation-missing", "task_id": task_id})
        planned[task_id] = build_record(
            task_id=task_id,
            operation=operation,
            attempt=1,
            started_at=None,
            execution_state=state,
            reconciled=True,
            completed_at=None,
            result_digest=digest,
            delivery_state=DELIVERY_ACKED,
            acked_at=now,
        )

    # 3) outbox：只接"能通过不变量 2"的 body；接不上的 body 绝不重建摘要。
    outbox_items, outbox_dropped = _legacy_outbox(outbox_document)
    for item in outbox_items:
        task_id = item.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise TaskStoreCorruptError("legacy outbox item has no task_id")
        legacy_ids.add(task_id)
        bump(LEGACY_OUTBOX_FILENAME)
        record = planned.get(task_id)
        if record is None:
            raise TaskStoreCorruptError(f"legacy outbox item has no ledger or tombstone fact: {task_id}")
        if record["execution_state"] == MAY_HAVE_EXECUTED:
            # 栅栏 + 孤儿 body：body 属于一次没有结论的执行。保留栅栏（启动时补一次
            # UNKNOWN 才是对控制面诚实的收尾），body 丢弃并留告警。
            warnings.append({"kind": "orphan-body-discarded", "task_id": task_id, "digest": item.get("digest")})
            continue
        problems = _body_problems(
            item.get("body"),
            task_id=task_id,
            operation=record["operation"],
            state=record["execution_state"],
            digest=record["result_digest"],
        )
        if problems:
            warnings.append({"kind": "queued-body-unverifiable", "task_id": task_id, "reasons": problems})
            record.update(
                {
                    "delivery_state": DELIVERY_DROPPED,
                    "acked_at": None,
                    "dropped_at": now,
                    "last_error_code": "MIGRATION_BODY_UNVERIFIABLE",
                }
            )
            continue
        attempts = item.get("attempts")
        if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
            attempts = 0
        last_error_code = item.get("last_error_code") if isinstance(item.get("last_error_code"), str) else None
        queued_at = item.get("queued_at") if isinstance(item.get("queued_at"), str) else None
        record.update(
            {
                "result_body": item.get("body"),
                "delivery_state": DELIVERY_PENDING,
                "delivery_attempts": attempts,
                "last_error_code": last_error_code,
                "queued_at": queued_at or now,
                "acked_at": None,
                "dropped_at": None,
            }
        )

    # 4) outbox 的 dropped 列表：只记"投递被丢"这个事实，不制造执行结论。
    for task_id in outbox_dropped:
        bump("dropped")
        record = planned.get(task_id)
        if record is None:
            warnings.append({"kind": "dropped-entry-without-fact", "task_id": task_id})
            continue
        legacy_ids.add(task_id)
        if record["execution_state"] == MAY_HAVE_EXECUTED:
            warnings.append({"kind": "dropped-entry-for-a-fence", "task_id": task_id})
            continue
        record.update(
            {
                "delivery_state": DELIVERY_DROPPED,
                "acked_at": None,
                "dropped_at": now,
                "last_error_code": record.get("last_error_code") or "MIGRATION_DROPPED",
            }
        )

    return planned, legacy_ids, warnings, per_file
