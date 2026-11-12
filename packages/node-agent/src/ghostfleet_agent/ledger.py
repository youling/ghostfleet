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
from .tasks import MAY_MUTATE, OPERATION_SPECS, READ_ONLY

LEDGER_SCHEMA = "ghostfleet-node-agent-ledger/v0"
TOMBSTONE_SCHEMA = "ghostfleet-node-agent-tombstones/v0"
TOMBSTONES_FILENAME = "tombstones.json"
MAX_LEDGER_BYTES = 1024 * 1024
MAX_LEDGER_ENTRIES = 512
# 被驱逐任务的有界墓碑：task_id → 终态/摘要。没有它，一个已 UNKNOWN 且已对账的
# 任务在驱逐后会被 begin() 当成 NEW 重新执行——"不重跑"必须优先于"有界"。
MAX_TOMBSTONES = 4096

FENCED = "MAY_HAVE_EXECUTED"
STATE_SUCCEEDED = "SUCCEEDED"
STATE_REFUSED = "REFUSED"
STATE_FAILED = "FAILED"
STATE_UNKNOWN = "UNKNOWN"
RESULT_DROPPED = "RESULT_DROPPED"
# FAILED 与 REFUSED 都是"已给出结论、可安全驱逐"的终态；UNKNOWN 只有在对账完成后
# 才可驱逐，MAY_HAVE_EXECUTED 永不驱逐。
TERMINAL_STATES = frozenset({STATE_SUCCEEDED, STATE_REFUSED, STATE_FAILED, STATE_UNKNOWN})
RESULT_STATES = frozenset({STATE_SUCCEEDED, STATE_REFUSED, STATE_FAILED, STATE_UNKNOWN})

BEGIN_NEW = "NEW"
BEGIN_FENCED = "ALREADY_FENCED"
BEGIN_DONE = "ALREADY_DONE"
# inspect() 对"只剩墓碑"的 task_id 返回这个哨兵值（不是条目状态）。
TOMBSTONE_STATE = "TOMBSTONE"


class LedgerCorruptError(StoreError):
    code = "LEDGER_CORRUPT"


class LedgerWriteError(StoreError):
    code = "LEDGER_WRITE_FAILED"


def _now() -> str:
    from .protocol import format_timestamp, now_utc

    return format_timestamp(now_utc())


class Ledger:
    """ledger.json 访问器；所有变更立即以原子写持久化。"""

    def __init__(self, path: str, *, logger=None, tombstone_path: str | None = None) -> None:
        self.path = os.path.abspath(path)
        self.directory = os.path.dirname(self.path) or "."
        self.tombstone_path = (
            os.path.abspath(tombstone_path)
            if tombstone_path is not None
            else os.path.join(self.directory, TOMBSTONES_FILENAME)
        )
        self.logger = logger or get_logger()
        self._entries: dict[str, dict] = {}
        self._tombstones: dict[str, dict] = {}

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
        self._tombstones = self._load_tombstones()
        return self._entries

    def _load_tombstones(self) -> dict[str, dict]:
        document = load_json_document(
            self.tombstone_path,
            schema=TOMBSTONE_SCHEMA,
            corrupt_error=LedgerCorruptError,
            max_bytes=MAX_LEDGER_BYTES,
            logger=self.logger,
        )
        if document is None:
            return {}
        raw_entries = document.get("entries")
        if not isinstance(raw_entries, dict):
            raise LedgerCorruptError("tombstone entries must be an object", path=self.tombstone_path)
        tombstones: dict[str, dict] = {}
        for task_id, entry in raw_entries.items():
            if not isinstance(task_id, str) or not isinstance(entry, dict):
                raise LedgerCorruptError("tombstone entry has invalid shape", path=self.tombstone_path)
            if entry.get("state") not in TERMINAL_STATES:
                raise LedgerCorruptError("tombstone entry has non-terminal state", path=self.tombstone_path)
            tombstones[task_id] = dict(entry)
        if len(tombstones) > MAX_TOMBSTONES:
            raise LedgerCorruptError("tombstones exceed capacity", path=self.tombstone_path)
        return tombstones

    def save_tombstones(self) -> None:
        try:
            atomic_write_json(
                self.tombstone_path,
                {"schema": TOMBSTONE_SCHEMA, "entries": self._tombstones},
                logger=self.logger,
            )
        except StoreError as error:
            raise LedgerWriteError(error.detail, path=self.tombstone_path) from None

    @property
    def tombstones(self) -> dict[str, dict]:
        return self._tombstones

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

    def inspect(self, task_id: str) -> str | None:
        """只读查询该 task_id 的历史事实，绝不写任何文件。

        返回值：终态字符串（SUCCEEDED/REFUSED/FAILED/UNKNOWN）、FENCED（可能已执行、
        尚未收敛）、TOMBSTONE_STATE（曾被驱逐但已收敛）、None（从未见过）。

        调用方（pre-dispatch 拒绝路径）用它决定"能不能再写一条新结论"：账本只允许
        一个 task 一个终态摘要，覆盖会让控制面收到两个摘要（ADR §5.2/§7）。
        """
        entry = self._entries.get(task_id)
        if entry is not None:
            state = entry.get("state")
            return state if isinstance(state, str) else FENCED
        if task_id in self._tombstones:
            return TOMBSTONE_STATE
        return None

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
        if self.is_exhausted():
            # fail closed：账本/墓碑都满时不再接收新任务，宁可停摆也不重跑。
            raise LedgerWriteError("ledger capacity exhausted (AGENT_LEDGER_EXHAUSTED)", path=self.path)
        if task_id in self._tombstones:
            # 曾被驱逐但墓碑记着它已经收敛：绝不能再执行一次。
            self.logger.info("ledger_tombstone_replay", task_id=task_id, state=self._tombstones[task_id].get("state"))
            return BEGIN_DONE
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

    def complete(
        self,
        task_id: str,
        status: str,
        *,
        result_digest: str | None = None,
        code: str | None = None,
        operation: str | None = None,
    ) -> None:
        if status not in RESULT_STATES:
            raise LedgerWriteError("terminal status must be SUCCEEDED/REFUSED/FAILED/UNKNOWN", path=self.path)
        entry = self._entries.get(task_id)
        if entry is not None and entry.get("state") in TERMINAL_STATES:
            # 一个 task 只能有一个终态摘要（ADR §5.2/§7）：不同摘要是上层绕过了历史，
            # 这里 fail closed 而不是静默覆盖——覆盖就会让控制面看到两个摘要。
            if entry.get("result_digest") != result_digest:
                raise LedgerWriteError(
                    "terminal result digest already committed for this task",
                    path=self.path,
                )
        if entry is None:
            # pre-dispatch 拒绝（例如未知 operation）没有栅栏条目：按事实建最小条目，
            # 但保留真实 operation 名，便于审计为什么它没有进入实现函数。
            entry = {
                "state": FENCED,
                "operation": operation if isinstance(operation, str) and operation else "unknown",
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
        self._prune()
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
        self._prune()
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
    @staticmethod
    def _effect(entry: dict) -> str:
        """按 OPERATION_SPECS 判定效果等级；未知 operation 按 may_mutate 保守处理。"""
        operation = entry.get("operation")
        spec = OPERATION_SPECS.get(operation) if isinstance(operation, str) else None
        if spec is None:
            return MAY_MUTATE
        return spec.effect

    def _evictable(self, task_id: str) -> bool:
        """可驱逐 = 重投不会双执行，且事实可由墓碑表达。

        1) result_state == RESULT_DROPPED 先判定：结果已确定不可回传，驱逐不会
           造成"重投双执行"（墓碑仍让 begin() 返回 DONE），因此无论是否
           reconciled、无论 operation 效果等级都可驱逐。absent task_id 的丢弃
           事实（mark_result_dropped 建的最小条目）正靠这一条才不会被永久占满
           账本。唯一例外是仍处于 FENCED 的条目：可能已执行且尚未收敛，必须由
           启动对账补 UNKNOWN，绝不在这里驱逐。
        2) 其余只驱逐"可证明幂等的已收敛终态"：MAY_HAVE_EXECUTED 栅栏、UNKNOWN
           终态、任何 may_mutate operation 的终态永不驱逐。read_only 的已对账
           终态可驱逐，但必须留墓碑防止 begin() 当成 NEW 重执行。
        """
        entry = self._entries[task_id]
        state = entry.get("state")
        if entry.get("result_state") == RESULT_DROPPED:
            return state != FENCED
        if state not in TERMINAL_STATES:
            return False
        if state == STATE_UNKNOWN:
            return False
        if entry.get("reconciled") is not True:
            return False
        if state == STATE_REFUSED:
            # REFUSED 只允许在 dispatch 之前产生（"实现从未被调用"的承诺），因此它
            # 永远可以安全忘记，墓碑足以表达"已收敛"。这条保证未知 operation 之类
            # 的 pre-dispatch 拒绝不会因 _effect 保守返回 MAY_MUTATE 而永久占满账本。
            return True
        return self._effect(entry) == READ_ONLY

    def _prune(self) -> None:
        """有界保留：只驱逐可证明幂等的已收敛终态，并为每次驱逐留墓碑。

        驱逐顺序：RESULT_DROPPED 最先（结果本已不可回传），其次其他已对账终态。
        墓碑容量（4096）耗尽时不再驱逐，is_exhausted() 变真，由 loop 停止取新任务
        （health=DEGRADED / AGENT_LEDGER_EXHAUSTED）等待人工处理。
        """
        overflow = len(self._entries) - MAX_LEDGER_ENTRIES
        if overflow <= 0:
            return

        def _rank(task_id: str):
            entry = self._entries[task_id]
            if entry.get("result_state") == RESULT_DROPPED:
                return (0, entry.get("result_dropped_at") or entry.get("finished_at") or "")
            return (1, entry.get("finished_at") or "")

        candidates = sorted(
            (task_id for task_id in self._entries if self._evictable(task_id)),
            key=lambda task_id: (_rank(task_id), task_id),
        )
        evicted = 0
        tombstones_changed = False
        for task_id in candidates:
            if evicted >= overflow:
                break
            if len(self._tombstones) >= MAX_TOMBSTONES:
                self.logger.error(
                    "ledger_tombstone_exhausted",
                    entries=len(self._entries),
                    tombstones=len(self._tombstones),
                )
                break
            entry = self._entries.pop(task_id)
            self._tombstones[task_id] = {
                "state": entry.get("state"),
                "operation": entry.get("operation"),
                "result_digest": entry.get("result_digest"),
                "evicted_at": _now(),
            }
            tombstones_changed = True
            evicted += 1
            if entry.get("result_state") == RESULT_DROPPED:
                self.logger.warning("ledger_dropped_evicted", task_id=task_id)
            else:
                self.logger.warning("ledger_entry_evicted", task_id=task_id)
        if tombstones_changed:
            # 先写墓碑再写账本：崩溃只会留下"账本条目 + 墓碑"的重复，不会丢事实。
            self.save_tombstones()

    def is_exhausted(self) -> bool:
        """到达上限且没有可驱逐条目（或墓碑已满）：不能再安全接收新任务。"""
        if len(self._tombstones) >= MAX_TOMBSTONES:
            return True
        if len(self._entries) < MAX_LEDGER_ENTRIES:
            return False
        return not any(self._evictable(task_id) for task_id in self._entries)
