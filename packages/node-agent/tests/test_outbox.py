"""outbox.json：幂等、冲突、上限 64、溢出保留最新并报 dropped。"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from ghostfleet_agent import outbox as outbox_module
from ghostfleet_agent.outbox import (
    ADDED,
    CONFLICT,
    DUPLICATE,
    MAX_OUTBOX_ITEMS,
    MAX_RESULT_BYTES,
    TOO_LARGE,
    Outbox,
    OutboxCorruptError,
)
from ghostfleet_agent.protocol import OUTCOME_AUTH_FATAL, OUTCOME_OK, OUTCOME_REJECTED, OUTCOME_SERVER_ERROR


def _body(task_id: str, *, status: str = "SUCCEEDED") -> dict:
    return {
        "task_id": task_id,
        "operation": "node.observe",
        "result": {"task_id": task_id, "status": status, "data": {}},
        "result_digest": "d" * 64,
    }


def _outbox(tmp_path) -> Outbox:
    box = Outbox(str(tmp_path / "outbox.json"))
    box.load()
    return box


def test_add_and_persist(tmp_path):
    box = _outbox(tmp_path)
    result = box.add(_body("task-0001"))
    assert result.status == ADDED
    assert box.depth() == 1
    assert box.has("task-0001")
    reloaded = _outbox(tmp_path)
    assert reloaded.depth() == 1
    assert reloaded.get("task-0001")["body"]["task_id"] == "task-0001"


def test_duplicate_same_digest_is_idempotent(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    result = box.add(_body("task-0001"))
    assert result.status == DUPLICATE
    assert box.depth() == 1


def test_conflict_different_digest_keeps_first(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001", status="SUCCEEDED"))
    result = box.add(_body("task-0001", status="REFUSED"))
    assert result.status == CONFLICT
    assert box.get("task-0001")["body"]["result"]["status"] == "SUCCEEDED"


def test_too_large_is_rejected(tmp_path):
    box = _outbox(tmp_path)
    huge = _body("task-0001")
    huge["result"]["data"] = {"blob": "x" * (MAX_RESULT_BYTES + 10)}
    assert box.add(huge).status == TOO_LARGE
    assert box.depth() == 0


def test_overflow_keeps_newest_and_reports_dropped(tmp_path):
    box = _outbox(tmp_path)
    dropped = []
    for index in range(MAX_OUTBOX_ITEMS + 3):
        result = box.add(_body(f"task-{index:04d}"))
        dropped.extend(result.dropped)
    assert box.depth() == MAX_OUTBOX_ITEMS
    assert dropped == ["task-0000", "task-0001", "task-0002"]
    assert not box.has("task-0000")
    assert box.has(f"task-{MAX_OUTBOX_ITEMS + 2:04d}")


def test_overflow_drops_survive_reload_until_replayed(tmp_path):
    box = _outbox(tmp_path)
    for index in range(MAX_OUTBOX_ITEMS + 2):
        box.add(_body(f"task-{index:04d}"))
    # 丢弃事实与 items 同一次原子写持久化：进程崩溃后仍能补记 RESULT_DROPPED。
    reloaded = _outbox(tmp_path)
    assert reloaded.pending_dropped() == ["task-0000", "task-0001"]
    assert reloaded.drain_dropped() == ["task-0000", "task-0001"]
    assert _outbox(tmp_path).pending_dropped() == []
    assert reloaded.depth() == MAX_OUTBOX_ITEMS


def test_flush_removes_acknowledged_items_in_order(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    box.add(_body("task-0002"))
    seen = []

    def send(item):
        seen.append(item["task_id"])
        return SimpleNamespace(kind=OUTCOME_OK, code=None)

    report = box.flush(send)
    assert seen == ["task-0001", "task-0002"]
    assert report.sent == ["task-0001", "task-0002"]
    assert report.remaining == 0
    assert box.depth() == 0
    assert report.progressed is True


def test_flush_rejected_is_permanent_but_logged(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    report = box.flush(lambda item: SimpleNamespace(kind=OUTCOME_REJECTED, code="TASK_RESULT_CONFLICT"))
    assert report.rejected == ["task-0001"]
    assert box.depth() == 0


def test_flush_retryable_stops_and_keeps_item(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    box.add(_body("task-0002"))
    report = box.flush(lambda item: SimpleNamespace(kind=OUTCOME_SERVER_ERROR, code="HTTP_500"))
    assert report.stop_outcome == OUTCOME_SERVER_ERROR
    assert report.remaining == 2
    assert box.get("task-0001")["attempts"] == 1
    assert box.get("task-0002")["attempts"] == 0


def test_flush_auth_fatal_marks_fatal(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    report = box.flush(lambda item: SimpleNamespace(kind=OUTCOME_AUTH_FATAL, code="NODE_AUTH_INVALID"))
    assert report.fatal is True
    assert report.stop_code == "NODE_AUTH_INVALID"
    assert box.depth() == 1


def test_remove(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    assert box.remove("task-0001") is True
    assert box.remove("task-0001") is False
    assert box.depth() == 0


@pytest.mark.parametrize(
    "text",
    [
        "{",
        '{"schema": "ghostfleet-node-agent-outbox/v0", "items": {}}',
        '{"schema": "ghostfleet-node-agent-outbox/v0", "items": [{"task_id": "x"}]}',
        '{"schema": "wrong", "items": []}',
        '{"schema": "ghostfleet-node-agent-outbox/v0", "items": ' + json.dumps([_body("t")] * (MAX_OUTBOX_ITEMS + 1)) + "}",
    ],
)
def test_corrupt_outbox_fails_closed(tmp_path, text):
    (tmp_path / "outbox.json").write_text(text, encoding="utf-8")
    with pytest.raises(OutboxCorruptError):
        Outbox(str(tmp_path / "outbox.json")).load()


def test_add_requires_task_id(tmp_path):
    box = _outbox(tmp_path)
    with pytest.raises(outbox_module.OutboxWriteError):
        box.add({"result": {}})
