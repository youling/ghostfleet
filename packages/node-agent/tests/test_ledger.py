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
    LedgerWriteError,
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
        ledger.complete("task-0001", "CRASHED")


def test_failed_is_a_valid_terminal_state(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-0001", "node.observe")
    ledger.complete("task-0001", "FAILED", code="AGENT_EXECUTION_FAILED")
    entry = ledger.get("task-0001")
    assert entry["state"] == "FAILED"
    assert entry["code"] == "AGENT_EXECUTION_FAILED"
    assert entry["reconciled"] is True
    assert ledger.pending_reconcile() == []


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


def test_fences_are_never_evicted_and_exhaustion_blocks_new_work(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.save = lambda: None  # 只为提速：仍在内存里累积 512 个栅栏
    ledger.save_tombstones = lambda: None
    for index in range(MAX_LEDGER_ENTRIES):
        ledger.begin(f"task-{index:05d}", "node.observe")
    assert len(ledger.entries) == MAX_LEDGER_ENTRIES
    assert ledger.is_exhausted() is True
    # 无可驱逐条目时 fail closed：拒绝新任务，栅栏一个都不许丢。
    with pytest.raises(LedgerWriteError):
        ledger.begin("task-overflow", "node.observe")
    assert len(ledger.entries) == MAX_LEDGER_ENTRIES
    assert ledger.get("task-00000") is not None
    # 把一条栅栏收敛成只读 operation 的成功终态：它变成可驱逐，但还没被驱逐。
    ledger.complete("task-00001", "SUCCEEDED")
    assert ledger.get("task-00001") is not None
    assert ledger.is_exhausted() is False
    # 再进一个新任务并收敛：prune 只驱逐刚对账的那条，其他栅栏一个不动。
    ledger.begin("task-new", "node.observe")
    ledger.complete("task-new", "SUCCEEDED")
    assert len(ledger.entries) == MAX_LEDGER_ENTRIES
    assert ledger.get("task-00001") is None
    assert ledger.get("task-new") is not None
    assert ledger.get("task-00000") is not None
    # 被驱逐的任务留下墓碑：begin 视作已完成，绝不再执行一次。
    assert "task-00001" in ledger.tombstones
    assert ledger.begin("task-00001", "node.observe") == BEGIN_DONE
    assert len(ledger.entries) == MAX_LEDGER_ENTRIES
    # 栅栏facts原样保留（不因驱逐或重投而丢）。
    assert ledger.begin("task-00000", "node.observe") == BEGIN_FENCED


def test_reconciled_terminals_are_evictable_so_exhaustion_clears(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.save = lambda: None
    ledger._prune = lambda: None
    for index in range(MAX_LEDGER_ENTRIES):
        task_id = f"task-{index:05d}"
        ledger.begin(task_id, "node.observe")
        ledger.complete(task_id, "SUCCEEDED")
    assert len(ledger.entries) == MAX_LEDGER_ENTRIES
    assert ledger.is_exhausted() is False


def test_failed_evictable_but_unknown_and_fenced_are_not(tmp_path):
    failed = _ledger(tmp_path / "failed")
    failed.save = lambda: None
    failed._prune = lambda: None  # 只观察可驱逐性，不在这里压缩
    for index in range(MAX_LEDGER_ENTRIES):
        task_id = f"task-failed-{index:05d}"
        failed.begin(task_id, "node.observe")
        failed.complete(task_id, "FAILED")
    assert len(failed.entries) == MAX_LEDGER_ENTRIES
    assert failed.is_exhausted() is False  # FAILED 是可驱逐的已对账终态

    uncertain = _ledger(tmp_path / "uncertain")
    uncertain.save = lambda: None
    uncertain._prune = lambda: None
    for index in range(MAX_LEDGER_ENTRIES):
        task_id = f"task-unknown-{index:05d}"
        uncertain.begin(task_id, "node.observe")
        uncertain.mark_unknown(task_id)
    assert uncertain.is_exhausted() is True  # 待对账 UNKNOWN 与栅栏一样不可驱逐
    # UNKNOWN 永远不可驱逐（副作用不可判定），对账只是补事实。
    uncertain.mark_reconciled("task-unknown-00000")
    assert uncertain.is_exhausted() is True
    with pytest.raises(LedgerWriteError):
        uncertain.begin("task-overflow", "node.observe")


def test_absent_dropped_results_are_evictable_and_keep_a_tombstone(tmp_path):
    """P2b：absent task_id 的 RESULT_DROPPED 不能永久耗尽账本（真机 512 次即停摆）。

    旧实现把 absent-id 丢弃建成 UNKNOWN（永不驱逐），512 个不存在 task 的丢弃事实
    就能让 is_exhausted() 永久为真、begin() 抛错、poll 永远停摆。现在丢弃事实先判定
    可驱逐，但驱逐必须留墓碑：begin() 绝不能把"结果已丢"的任务当 NEW 重跑。
    """
    ledger = _ledger(tmp_path)
    ledger.save = lambda: None
    ledger.save_tombstones = lambda: None
    for index in range(MAX_LEDGER_ENTRIES + 8):
        ledger.mark_result_dropped(f"task-absent-{index:05d}")

    assert ledger.is_exhausted() is False
    assert len(ledger.entries) <= MAX_LEDGER_ENTRIES
    evicted = [task_id for task_id in ledger.tombstones if task_id.startswith("task-absent-")]
    assert evicted, "驱逐 RESULT_DROPPED 必须留墓碑"
    # 墓碑让被驱逐的丢弃任务视作已收敛：绝不重投、绝不重跑。
    assert ledger.begin(evicted[0], "node.observe") == BEGIN_DONE
    # 账本恢复接收新任务（poll 恢复）。
    assert ledger.begin("task-fresh", "node.observe") == BEGIN_NEW
    ledger.complete("task-fresh", "SUCCEEDED")

    # 真实落盘 + 重启：丢弃事实仍可表达（墓碑跨重启保留）。
    del ledger.save
    del ledger.save_tombstones
    ledger._prune()
    ledger.save()
    ledger.save_tombstones()
    reloaded = _ledger(tmp_path)
    assert reloaded.is_exhausted() is False
    assert reloaded.begin(evicted[0], "node.observe") == BEGIN_DONE


def test_tombstone_capacity_is_fail_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger_module, "MAX_TOMBSTONES", 2)
    ledger = _ledger(tmp_path)
    ledger.save = lambda: None
    ledger._tombstones = {
        "task-old-1": {"state": "SUCCEEDED"},
        "task-old-2": {"state": "SUCCEEDED"},
    }
    assert ledger.is_exhausted() is True
    with pytest.raises(LedgerWriteError):
        ledger.begin("task-fresh", "node.observe")

    # 容量恢复后，墓碑命中的任务视作已完成，绝不重跑。
    monkeypatch.setattr(ledger_module, "MAX_TOMBSTONES", 8)
    assert ledger.begin("task-old-1", "node.observe") == BEGIN_DONE


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
    target = tmp_path / "ledger.json"
    target.write_text(text, encoding="utf-8")
    target.chmod(0o600)  # 先过文件信任闸，才轮到内容校验
    with pytest.raises(LedgerCorruptError):
        Ledger(str(tmp_path / "ledger.json")).load()


def test_ledger_roundtrip(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.begin("task-0001", "agent.self.test")
    ledger.complete("task-0001", "SUCCEEDED")
    reloaded = _ledger(tmp_path)
    assert reloaded.is_executed("task-0001") is True
    assert reloaded.get("task-0001")["operation"] == "agent.self.test"
