"""有界结果队列：按 task_id 幂等回传，溢出保留最新并记 RESULT_DROPPED。

ADR §7：outbox 上限 64 条；溢出保留最新 64 条，被丢弃条目的 task_id 记入 ledger
的 RESULT_DROPPED（事实记录，不是静默丢弃）。flush 严格按入队顺序发送，遇到
不可重试的鉴权失败立即停止并把 fatal 交给循环处理。
"""
from __future__ import annotations

import os

from .logging import get_logger
from .protocol import (
    MAX_RESULT_BYTES,
    OUTCOME_AUTH_FATAL,
    OUTCOME_INVALID_RESPONSE,
    OUTCOME_NETWORK_ERROR,
    OUTCOME_NONCE_REPLAY,
    OUTCOME_OK,
    OUTCOME_RATE_LIMITED,
    OUTCOME_REJECTED,
    OUTCOME_SERVER_ERROR,
    OUTCOME_TRANSPORT_REFUSED,
    canonical_bytes,
    digest_of,
)
from .state import StoreError, atomic_write_json, ensure_state_dir, load_json_document

OUTBOX_SCHEMA = "ghostfleet-node-agent-outbox/v0"
MAX_OUTBOX_ITEMS = 64
MAX_OUTBOX_BYTES = 8 * 1024 * 1024

ADDED = "ADDED"
DUPLICATE = "DUPLICATE"
CONFLICT = "CONFLICT"
TOO_LARGE = "TOO_LARGE"

RETRYABLE_OUTCOMES = frozenset(
    {
        OUTCOME_NONCE_REPLAY,
        OUTCOME_RATE_LIMITED,
        OUTCOME_SERVER_ERROR,
        OUTCOME_NETWORK_ERROR,
        OUTCOME_TRANSPORT_REFUSED,
        OUTCOME_INVALID_RESPONSE,
    }
)


class OutboxCorruptError(StoreError):
    code = "OUTBOX_CORRUPT"


class OutboxWriteError(StoreError):
    code = "OUTBOX_WRITE_FAILED"


class OutboxAddResult:
    """一次入队的结果：状态、当前队列长度、本次因溢出被丢弃的 task_id。"""

    __slots__ = ("status", "dropped", "size")

    def __init__(self, status: str, dropped=None, size: int = 0) -> None:
        self.status = status
        self.dropped = list(dropped or [])
        self.size = size

    def __repr__(self) -> str:  # pragma: no cover - 仅调试
        return f"OutboxAddResult(status={self.status!r}, dropped={self.dropped!r}, size={self.size})"


class FlushReport:
    """一次 flush 的结果分类（供循环决定退避与是否致命）。"""

    __slots__ = ("sent", "rejected", "remaining", "fatal", "stop_outcome", "stop_code")

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.rejected: list[str] = []
        self.remaining = 0
        self.fatal = False
        self.stop_outcome: str | None = None
        self.stop_code: str | None = None

    @property
    def progressed(self) -> bool:
        return bool(self.sent or self.rejected)

    def __repr__(self) -> str:  # pragma: no cover - 仅调试
        return (
            f"FlushReport(sent={len(self.sent)}, rejected={len(self.rejected)}, "
            f"remaining={self.remaining}, fatal={self.fatal}, stop={self.stop_outcome})"
        )


class Outbox:
    """outbox.json 访问器：单文件、有界、按顺序持久化。"""

    def __init__(self, path: str, *, logger=None) -> None:
        self.path = os.path.abspath(path)
        self.directory = os.path.dirname(self.path) or "."
        self.logger = logger or get_logger()
        self._items: list[dict] = []

    def load(self) -> list[dict]:
        ensure_state_dir(self.directory, logger=self.logger)
        document = load_json_document(
            self.path,
            schema=OUTBOX_SCHEMA,
            corrupt_error=OutboxCorruptError,
            max_bytes=MAX_OUTBOX_BYTES,
            logger=self.logger,
        )
        if document is None:
            self._items = []
            self.save()
            return []
        raw_items = document.get("items")
        if not isinstance(raw_items, list):
            raise OutboxCorruptError("outbox items must be a list", path=self.path)
        items: list[dict] = []
        for item in raw_items:
            if not isinstance(item, dict):
                raise OutboxCorruptError("outbox item must be an object", path=self.path)
            task_id = item.get("task_id")
            digest = item.get("digest")
            body = item.get("body")
            if not isinstance(task_id, str) or not isinstance(digest, str) or not isinstance(body, dict):
                raise OutboxCorruptError("outbox item has invalid shape", path=self.path)
            items.append(
                {
                    "task_id": task_id,
                    "digest": digest,
                    "body": body,
                    "queued_at": item.get("queued_at"),
                    "attempts": int(item.get("attempts", 0) or 0),
                    "last_error_code": item.get("last_error_code"),
                }
            )
        if len(items) > MAX_OUTBOX_ITEMS:
            raise OutboxCorruptError("outbox exceeds 64 items", path=self.path)
        self._items = items
        return self.pending()

    def save(self) -> None:
        try:
            atomic_write_json(
                self.path,
                {"schema": OUTBOX_SCHEMA, "items": self._items},
                logger=self.logger,
            )
        except StoreError as error:
            raise OutboxWriteError(error.detail, path=self.path) from None

    # -- 查询 ---------------------------------------------------------------
    @property
    def items(self) -> list[dict]:
        return self._items

    def pending(self) -> list[dict]:
        return [dict(item) for item in self._items]

    def depth(self) -> int:
        return len(self._items)

    def has(self, task_id: str) -> bool:
        return any(item["task_id"] == task_id for item in self._items)

    def get(self, task_id: str) -> dict | None:
        for item in self._items:
            if item["task_id"] == task_id:
                return dict(item)
        return None

    # -- 入队 ---------------------------------------------------------------
    def add(self, body: dict, *, queued_at: str | None = None) -> OutboxAddResult:
        """入队一条结果；body 必须含 task_id 与 result。

        幂等：同 task_id 同摘要视为重复（不重复占用队列）；同 task_id 不同摘要
        视为本地状态异常，保留先前的条目并返回 CONFLICT（绝不覆盖已确认的结果）。
        """
        task_id = body.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise OutboxWriteError("result body must carry task_id", path=self.path)
        try:
            encoded = canonical_bytes(body)
        except Exception as error:  # noqa: BLE001 - ProtocolError 已在 canonical 内
            raise OutboxWriteError(f"result body is not canonical JSON: {error}", path=self.path) from None
        if len(encoded) > MAX_RESULT_BYTES:
            return OutboxAddResult(TOO_LARGE, size=len(self._items))
        digest = digest_of(body)
        existing = self.get(task_id)
        if existing is not None:
            if existing["digest"] == digest:
                return OutboxAddResult(DUPLICATE, size=len(self._items))
            self.logger.warning("outbox_digest_conflict", task_id=task_id)
            return OutboxAddResult(CONFLICT, size=len(self._items))
        self._items.append(
            {
                "task_id": task_id,
                "digest": digest,
                "body": body,
                "queued_at": queued_at,
                "attempts": 0,
                "last_error_code": None,
            }
        )
        dropped: list[str] = []
        while len(self._items) > MAX_OUTBOX_ITEMS:
            oldest = self._items.pop(0)
            dropped.append(str(oldest["task_id"]))
            self.logger.warning("outbox_overflow_dropped", task_id=oldest["task_id"])
        self.save()
        return OutboxAddResult(ADDED, dropped=dropped, size=len(self._items))

    # -- 出队 ---------------------------------------------------------------
    def record_attempt(self, task_id: str, error_code: str | None = None) -> None:
        for item in self._items:
            if item["task_id"] == task_id:
                item["attempts"] = int(item.get("attempts", 0)) + 1
                item["last_error_code"] = error_code
                break

    def remove(self, task_id: str) -> bool:
        for index, item in enumerate(self._items):
            if item["task_id"] == task_id:
                del self._items[index]
                return True
        return False

    def flush(self, send) -> FlushReport:
        """按顺序回传；send(item) 返回带 kind/code 属性的分类结果。"""
        report = FlushReport()
        changed = False
        for item in list(self._items):
            outcome = send(item)
            kind = getattr(outcome, "kind", None)
            code = getattr(outcome, "code", None)
            if kind == OUTCOME_OK:
                self.remove(item["task_id"])
                report.sent.append(item["task_id"])
                changed = True
                continue
            if kind == OUTCOME_REJECTED:
                # 控制面明确拒绝（4xx 非重试类）：记为已处理，避免无限重试。
                self.remove(item["task_id"])
                report.rejected.append(item["task_id"])
                changed = True
                self.logger.warning("result_rejected_permanently", task_id=item["task_id"], code=code)
                continue
            self.record_attempt(item["task_id"], code)
            changed = True
            report.stop_outcome = kind
            report.stop_code = code
            if kind == OUTCOME_AUTH_FATAL:
                report.fatal = True
            break
        if changed:
            self.save()
        report.remaining = len(self._items)
        return report
