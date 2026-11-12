"""ledger.json：执行前栅栏、崩溃恢复只产 UNKNOWN、损坏 fail-closed。"""
from __future__ import annotations

import json
import stat

import pytest

from ghostfleet_agent import ledger as ledger_module
from ghostfleet_agent.ledger import (
    BEGIN_DONE,
    BEGIN_FENCED,
    BEGIN_NEW,
    FENCED,
    MAX_LEDGER_ENTRIES,
    RESULT_DROPPED,
    Ledger,
    LedgerCorruptError,
)


def _ledger(tmp_path) -> Ledger:
    ledger = Ledger(str(tmp_path / "ledger.json"))
    ledger.load()
    return ledger


def test_begin_fences_before_returning(tmp_path):
    ledger = _ledger(tmp_path)
    assert ledger.begin("task-0001", "node.observe", 1) == BEGIN_NEW
    on_disk = json.loads((tmp_path / "ledger.json").read_text(encoding="utf-8"))
    assert on_disk["entries"]["task-0001"]["state"] == FENCED
    assert on_disk["entries"]["task-0001"]["operation"] == "node.observe"
    assert stat.S_IMODE((tmp_path / "ledger.json").stat().st_mode) == 0o600


def test_duplicate_begin_is_not_new(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-0001", "node.observe")
    assert ledger.begin("task-0001", "node.observe") == BEGIN_FENCED
    ledger.complete("task-0001", "SUCCEEDED", result_digest="a" * 64)
    assert ledger.begin("task-0001", "node.observe") == BEGIN_DONE


def test_pending_reconcile_only_reports_fenced(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-fenced", "node.observe")
    ledger.begin("task-done", "node.observe")
    ledger.complete("task-done", "SUCCEEDED")
    assert ledger.pending_reconcile() == ["task-fenced"]


def test_crash_recovery_records_unknown_not_new_execution(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-crash", "node.observe")
    reloaded = _ledger(tmp_path)
    pending = reloaded.pending_reconcile()
    assert pending == ["task-crash"]
    reloaded.mark_unknown("task-crash")
    reloaded.mark_reconciled("task-crash")
    reloaded.complete("task-crash", "UNKNOWN")
    again = _ledger(tmp_path)
    assert again.pending_reconcile() == []
    assert again.get("task-crash")["state"] == "UNKNOWN"


def test_complete_records_terminal_facts(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-0001", "node.observe", 2)
    ledger.complete("task-0001", "REFUSED", result_digest="b" * 64, code="TASK_EXPIRED")
    entry = ledger.get("task-0001")
    assert entry["state"] == "REFUSED"
    assert entry["code"] == "TASK_EXPIRED"
    assert entry["result_digest"] == "b" * 64
    assert entry["reconciled"] is True


def test_complete_rejects_unknown_terminal_status(tmp_path):
    ledger = _ledger(tmp_path)
    with pytest.raises(ledger_module.LedgerWriteError):
        ledger.complete("task-0001", "FAILED")


def test_result_dropped_is_recorded_without_overwriting_terminal_state(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-0001", "node.observe")
    ledger.complete("task-0001", "SUCCEEDED")
    ledger.mark_result_dropped("task-0001")
    entry = ledger.get("task-0001")
    assert entry["state"] == "SUCCEEDED"
    assert entry["result_state"] == RESULT_DROPPED


def test_prune_keeps_bounded_entries_even_with_dropped_results(tmp_path):
    ledger = _ledger(tmp_path)
    for index in range(MAX_LEDGER_ENTRIES + 10):
        task_id = f"task-{index:05d}"
        ledger.begin(task_id, "node.observe")
        ledger.complete(task_id, "SUCCEEDED")
        ledger.mark_result_dropped(task_id)
    assert len(ledger.entries) <= MAX_LEDGER_ENTRIES
    assert ledger.pending_reconcile() == []


@pytest.mark.parametrize(
    "text",
    [
        "{",
        "[]",
        '{"schema": "ghostfleet-node-agent-ledger/v0", "entries": []}',
        '{"schema": "ghostfleet-node-agent-ledger/v0", "entries": {"a": {"state": "BOGUS"}}}',
        '{"schema": "other", "entries": {}}',
    ],
)
def test_corrupt_ledger_fails_closed(tmp_path, text):
    (tmp_path / "ledger.json").write_text(text, encoding="utf-8")
    with pytest.raises(LedgerCorruptError):
        Ledger(str(tmp_path / "ledger.json")).load()


def test_ledger_roundtrip(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-0001", "agent.self.test")
    ledger.complete("task-0001", "SUCCEEDED")
    reloaded = _ledger(tmp_path)
    assert reloaded.is_executed("task-0001") is True
    assert reloaded.get("task-0001")["operation"] == "agent.self.test"
