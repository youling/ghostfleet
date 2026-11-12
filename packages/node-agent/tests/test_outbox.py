"""outbox.json：幂等、冲突、上限 64、溢出保留最新并报 dropped。"""
from __future__ import annotations

import json
import threading
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


# -- 停机预算：逐条检查 stop/deadline，单请求超时钳到剩余预算 -----------------
def test_flush_stops_before_any_send_when_stop_event_is_set(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    box.add(_body("task-0002"))
    stop_event = threading.Event()
    stop_event.set()
    calls = []

    def send(item, timeout_s=None):
        calls.append(item["task_id"])
        return SimpleNamespace(kind=OUTCOME_OK, code=None)

    report = box.flush(send, stop_event=stop_event)
    assert calls == []  # 一条都不许发
    assert report.stopped is True
    assert report.deadline_hit is False
    assert report.remaining == 2


def test_flush_checks_stop_event_before_every_send(tmp_path):
    box = _outbox(tmp_path)
    box.add(_body("task-0001"))
    box.add(_body("task-0002"))
    stop_event = threading.Event()
    seen = []

    def send(item, timeout_s=None):
        seen.append(item["task_id"])
        stop_event.set()  # 第一条在途时收到 SIGTERM
        return SimpleNamespace(kind=OUTCOME_OK, code=None)

    report = box.flush(send, stop_event=stop_event)
    assert seen == ["task-0001"]
    assert report.sent == ["task-0001"]
    assert report.stopped is True
    assert report.remaining == 1
    assert box.has("task-0002")


def test_flush_honours_deadline_and_passes_remaining_budget_as_timeout(tmp_path):
    box = _outbox(tmp_path)
    for index in range(4):
        box.add(_body(f"task-{index:04d}"))
    clock = {"now": 100.0}
    budgets = []

    def send(item, timeout_s=None):
        budgets.append(timeout_s)
        clock["now"] += 0.2
        return SimpleNamespace(kind=OUTCOME_OK, code=None)

    report = box.flush(send, deadline=100.5, clock=lambda: clock["now"])
    # 起始剩余 0.5 s 能发第一条；发完只剩 0.3 s（< MIN_SEND_WINDOW_S）立刻停。
    assert budgets == [pytest.approx(0.5)]
    assert budgets[0] <= outbox_module.MIN_SEND_WINDOW_S + 1e-9
    assert report.deadline_hit is True
    assert report.remaining == 3


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
