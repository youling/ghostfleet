"""任务派发栅栏 ledger：跨重启的 MAY_HAVE_EXECUTED 事实记录。

ADR §7 / D5：
- 执行任何任务前先落盘 `state=MAY_HAVE_EXECUTED` 并 fsync，然后才调用实现；
- 完成后写终态 `SUCCEEDED|REFUSED` 与 result_digest；
- 启动时对"已栅栏、无终态"的条目只补一条 UNKNOWN 结果（不重跑），再标 RECONCILED；
- outbox 溢出丢弃的 task_id 记 `result_state=RESULT_DROPPED`，不覆盖执行终态。

ledger 只回答"我们是否可能已经执行过 / 是否已经给出过结论"，不保存结果载荷本身
（载荷在 outbox 与 state 里，减少重复存储与泄漏面）。
"""
from __future__ import annotations

import os
import time

from .logging import get_logger
from .state import StoreError, atomic_write_json, load_json_document, ensure_state_dir

LEDGER_SCHEMA = "ghostfleet-node-agent-ledger/v0"
MAX_LEDGER_BYTES = 1024 * 1024
MAX_LEDGER_ENTRIES = 512

FENCED = "MAY_HAVE_EXECUTED"
STATE_SUCCEEDED = "SUCCEEDED"
STATE_REFUSED = "REFUSED"
STATE_UNKNOWN = "UNKNOWN"
RESULT_DROPPED = "RESULT_DROPPED"
TERMINAL_STATES = frozenset({STATE_SUCCEEDED, STATE_REFUSED, STATE_UNKNOWN})
RESULT_STATES = frozenset({STATE_SUCCEEDED, STATE_REFUSED, STATE_UNKNOWN})

BEGIN_NEW = "NEW"
BEGIN_FENCED = "ALREADY_FENCED"
BEGIN_DONE = "ALREADY_DONE"


class LedgerCorruptError(StoreError):
    code = "LEDGER_CORRUPT"


class LedgerWriteError(StoreError):
    code = "LEDGER_WRITE_FAILED"


def _now() -> str:
    from .protocol import format_timestamp, now_utc

    return format_timestamp(now_utc())


class Ledger:
    """ledger.json 访问器；所有变更立即以原子写持久化。"""

    def __init__(self, path: str, *, logger=None) -> None:
        self.path = os.path.abspath(path)
        self.directory = os.path.dirname(self.path) or "."
        self.logger = logger or get_logger()
        self._entries: dict[str, dict] = {}

    # -- 载入 / 持久化 -------------------------------------------------------
    def load(self) -> dict[str, dict]:
        ensure_state_dir(self.directory, logger=self.logger)
        document = load_json_document(
            self.path,
            schema=LEDGER_SCHEMA,
            corrupt_error=LedgerCorruptError,
            max_bytes=MAX_LEDGER_BYTES,
            logger=self.logger,
        )
        if document is None:
            self._entries = {}
            self.save()
            return self._entries
        raw_entries = document.get("entries")
        if not isinstance(raw_entries, dict):
            raise LedgerCorruptError("ledger entries must be an object", path=self.path)
        entries: dict[str, dict] = {}
        for task_id, entry in raw_entries.items():
            if not isinstance(task_id, str) or not isinstance(entry, dict):
                raise LedgerCorruptError("ledger entry has invalid shape", path=self.path)
            state = entry.get("state")
            if state not in TERMINAL_STATES and state != FENCED:
                raise LedgerCorruptError("ledger entry has unknown state", path=self.path)
            entries[task_id] = dict(entry)
        self._entries = entries
        return self._entries

    def save(self) -> None:
        try:
            atomic_write_json(
                self.path,
                {"schema": LEDGER_SCHEMA, "entries": self._entries},
                logger=self.logger,
            )
        except StoreError as error:
            raise LedgerWriteError(error.detail, path=self.path) from None

    # -- 查询 ---------------------------------------------------------------
    @property
    def entries(self) -> dict[str, dict]:
        return self._entries

    def get(self, task_id: str) -> dict | None:
        entry = self._entries.get(task_id)
        return dict(entry) if entry is not None else None

    def is_executed(self, task_id: str) -> bool:
        """该 task_id 是否已经进入"可能已执行"状态（含终态）。"""
        return task_id in self._entries

    def pending_reconcile(self) -> list[str]:
        """已栅栏但既无终态也未对账的 task_id（启动恢复用）。"""
        return sorted(
            task_id
            for task_id, entry in self._entries.items()
            if entry.get("state") == FENCED and entry.get("reconciled") is not True
        )

    # -- 变更 ---------------------------------------------------------------
    def begin(self, task_id: str, operation: str, attempt: int = 1) -> str:
        """执行前栅栏；返回 NEW / ALREADY_FENCED / ALREADY_DONE。

        只有 NEW 允许调用实现函数。ALREADY_FENCED 表示上次已进入可能已执行区间
        但未收敛，调用方必须走 UNKNOWN 对账而不是重跑。
        """
        entry = self._entries.get(task_id)
        if entry is not None:
            if entry.get("state") == FENCED:
                return BEGIN_FENCED
            return BEGIN_DONE
        self._entries[task_id] = {
            "state": FENCED,
            "operation": operation,
            "attempt": int(attempt),
            "started_at": _now(),
            "reconciled": False,
        }
        self.save()
        return BEGIN_NEW

    def complete(self, task_id: str, status: str, *, result_digest: str | None = None, code: str | None = None) -> None:
        if status not in RESULT_STATES:
            raise LedgerWriteError("terminal status must be SUCCEEDED/REFUSED/UNKNOWN", path=self.path)
        entry = self._entries.get(task_id)
        if entry is None:
            entry = {
                "state": FENCED,
                "operation": "unknown",
                "attempt": 1,
                "started_at": _now(),
            }
            self._entries[task_id] = entry
        entry["state"] = status
        entry["finished_at"] = _now()
        entry["reconciled"] = True
        if result_digest is not None:
            entry["result_digest"] = result_digest
        if code is not None:
            entry["code"] = code
        self.save()

    def mark_unknown(self, task_id: str, *, result_digest: str | None = None) -> None:
        """崩溃恢复：只记录"结果未知"事实，不代表重跑。"""
        entry = self._entries.get(task_id)
        if entry is None:
            entry = {
                "state": FENCED,
                "operation": "unknown",
                "attempt": 1,
                "started_at": _now(),
            }
            self._entries[task_id] = entry
        entry["state"] = STATE_UNKNOWN
        entry["finished_at"] = _now()
        entry["reconciled"] = False
        if result_digest is not None:
            entry["result_digest"] = result_digest
        self.save()

    def mark_reconciled(self, task_id: str) -> None:
        entry = self._entries.get(task_id)
        if entry is None:
            return
        entry["reconciled"] = True
        entry["reconciled_at"] = _now()
        self.save()

    def mark_result_dropped(self, task_id: str) -> None:
        """outbox 溢出：结果已无法回传，作为事实记录在 ledger（不覆盖执行终态）。"""
        entry = self._entries.get(task_id)
        if entry is None:
            entry = {
                "state": STATE_UNKNOWN,
                "operation": "unknown",
                "attempt": 1,
                "started_at": _now(),
                "finished_at": _now(),
            }
            self._entries[task_id] = entry
        entry["result_state"] = RESULT_DROPPED
        entry["reconciled"] = False
        entry["result_dropped_at"] = _now()
        self._prune()
        self.save()

    # -- 保留上限 -----------------------------------------------------------
    def _prune(self) -> None:
        """有界保留：优先丢已对账终态，其次丢 RESULT_DROPPED，最后才丢栅栏。

        文件必须保持在 MAX_LEDGER_BYTES 以内，否则下次 load 会 fail closed 把 agent
        永久卡死；因此这里宁可 evict 并留下 warning，也不允许无界增长。丢弃顺序
        刻意把 FENCED（可能已执行）放到最后，尽量不牺牲"不重跑"保证。
        """
        overflow = len(self._entries) - MAX_LEDGER_ENTRIES
        if overflow <= 0:
            return

        def _rank(task_id: str):
            entry = self._entries[task_id]
            if (
                entry.get("state") in TERMINAL_STATES
                and entry.get("reconciled") is True
                and entry.get("result_state") != RESULT_DROPPED
            ):
                return (0, entry.get("finished_at") or "")
            if entry.get("result_state") == RESULT_DROPPED:
                return (1, entry.get("result_dropped_at") or entry.get("finished_at") or "")
            if entry.get("state") in TERMINAL_STATES:
                return (2, entry.get("finished_at") or "")
            return (3, entry.get("started_at") or "")

        ordered = sorted(self._entries, key=lambda task_id: (_rank(task_id), task_id))
        for task_id in ordered[:overflow]:
            entry = self._entries.pop(task_id)
            if entry.get("result_state") == RESULT_DROPPED:
                self.logger.warning("ledger_dropped_evicted", task_id=task_id)
            elif entry.get("state") not in TERMINAL_STATES:
                self.logger.warning("ledger_fence_evicted", task_id=task_id)
