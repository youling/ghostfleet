"""state.json：原子写、损坏 fail-closed、启动周期与 seq 语义。"""
from __future__ import annotations

import json
import os
import stat

import pytest

from ghostfleet_agent import state as state_module
from ghostfleet_agent.state import (
    BOOT_ID_PATH,
    UNKNOWN_BOOT_ID,
    AgentState,
    StateCorruptError,
    StateStore,
    StateWriteError,
    StoreError,
    atomic_write_bytes,
    atomic_write_json,
    ensure_state_dir,
    read_boot_id,
)

BOOT_UUID = "11111111-2222-3333-4444-555555555555"


def _store(tmp_path, *, boot_id=None) -> StateStore:
    # boot_id 现在由进程启动时生成并持久化轮换（合同 A），旧 boot_id_path 仅为兼容保留。
    boot_path = tmp_path / "boot_id"
    boot_path.write_text((boot_id if boot_id is not None else BOOT_UUID) + "\n", encoding="utf-8")
    return StateStore(str(tmp_path / "state" / "state.json"), boot_id_path=str(boot_path))


def test_state_initialisation_is_atomic_and_private(tmp_path):
    store = _store(tmp_path)
    state = store.load()
    path = tmp_path / "state" / "state.json"
    assert path.exists()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert state_module.BOOT_ID_RE.fullmatch(state.boot_id)
    assert state.boot_id != BOOT_UUID
    assert state.seq == 0
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["schema"] == state_module.STATE_SCHEMA
    assert sorted(os.listdir(path.parent)) == ["state.json"]


def test_sequencing_and_persistence(tmp_path):
    store = _store(tmp_path)
    store.load()
    assert store.next_seq() == 1
    assert store.next_seq() == 2
    store.record_heartbeat(interval_s=30, observation={"a": 1}, health="OK")
    reloaded = _store(tmp_path).load()
    assert reloaded.last_health == "OK"
    assert reloaded.server_interval_s == 30.0
    assert reloaded.last_observation == {"a": 1}
    assert reloaded.last_heartbeat_at is not None


def test_failure_and_stop_bookkeeping(tmp_path):
    store = _store(tmp_path)
    store.load()
    store.record_failure(4, health="FAILING")
    assert store.state.consecutive_failures == 1
    assert store.state.next_backoff_s == 4
    store.mark_stopping()
    assert store.state.stopping is True
    store.record_stop()
    assert store.state.stopping is False
    assert store.state.last_stop is not None


def test_new_boot_resets_seq_and_stopping(tmp_path):
    store = _store(tmp_path)
    first = store.load()
    store.next_seq()
    store.next_seq()
    store.record_poll()
    store.record_task_executed()
    store.record_outbox_overflow(2)
    store.mark_stopping()
    store.save()

    other_boot = _store(tmp_path).load()
    assert other_boot.boot_id != first.boot_id
    assert state_module.BOOT_ID_RE.fullmatch(other_boot.boot_id)
    assert other_boot.seq == 0
    assert other_boot.stopping is False
    assert other_boot.consecutive_failures == 0
    # 连续工作计数跨重启保留（合同 E/F）。
    assert other_boot.polls == 1
    assert other_boot.tasks_executed == 1
    assert other_boot.outbox_overflow == 2


@pytest.mark.parametrize(
    "text",
    [
        "{",
        "[]",
        '{"schema": "wrong"}',
        "[]",
    ],
)
def test_corrupt_state_is_rejected(tmp_path, text):
    directory = tmp_path / "state"
    directory.mkdir(mode=0o700)
    target = directory / "state.json"
    target.write_text(text, encoding="utf-8")
    os.chmod(target, 0o600)  # 先过信任闸，才轮到内容校验
    with pytest.raises(StateCorruptError):
        _store(tmp_path).load()


def test_oversize_state_is_rejected(tmp_path):
    directory = tmp_path / "state"
    directory.mkdir(mode=0o700)
    target = directory / "state.json"
    target.write_text(" " * (state_module.MAX_STATE_BYTES + 1), encoding="utf-8")
    os.chmod(target, 0o600)
    with pytest.raises(StateCorruptError):
        _store(tmp_path).load()


def test_atomic_write_failure_leaves_no_half_file(tmp_path, monkeypatch):
    target = tmp_path / "payload.json"
    atomic_write_json(target, {"a": 1})
    original = target.read_bytes()

    def _boom(source, destination):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(state_module.os, "replace", _boom)
    with pytest.raises(StateWriteError):
        atomic_write_json(target, {"a": 2})
    assert target.read_bytes() == original
    assert sorted(os.listdir(tmp_path)) == ["payload.json"]


def test_atomic_write_failure_without_previous_file(tmp_path, monkeypatch):
    target = tmp_path / "fresh.json"
    monkeypatch.setattr(state_module.os, "replace", lambda *_a: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(StateWriteError):
        atomic_write_bytes(target, b"{}")
    assert sorted(os.listdir(tmp_path)) == []


def test_atomic_write_fsyncs_file_before_rename_and_directory_after(tmp_path, monkeypatch):
    events = []
    real_fsync = os.fsync
    real_replace = os.replace

    def _fsync(descriptor):
        events.append("fsync")
        return real_fsync(descriptor)

    def _replace(source, destination):
        events.append("replace")
        return real_replace(source, destination)

    monkeypatch.setattr(state_module.os, "fsync", _fsync)
    monkeypatch.setattr(state_module.os, "replace", _replace)
    atomic_write_json(tmp_path / "payload.json", {"a": 1})
    # 文件 fsync → rename → 目录 fsync：崩溃时不会出现半写文件。
    assert events == ["fsync", "replace", "fsync"]


def test_directory_fsync_failure_is_propagated(tmp_path, monkeypatch):
    target = tmp_path / "payload.json"
    atomic_write_json(target, {"a": 1})
    calls = {"count": 0}
    real_fsync = os.fsync

    def _fsync(descriptor):
        calls["count"] += 1
        if calls["count"] == 2:  # 第二次是目录 fsync
            raise OSError("simulated directory fsync failure")
        return real_fsync(descriptor)

    monkeypatch.setattr(state_module.os, "fsync", _fsync)
    with pytest.raises(StateWriteError):
        atomic_write_json(target, {"a": 2})


def test_state_file_with_loose_mode_is_rejected(tmp_path):
    store = _store(tmp_path)
    store.load()
    target = tmp_path / "state" / "state.json"
    os.chmod(target, 0o644)
    with pytest.raises(StateCorruptError):
        _store(tmp_path).load()


def test_state_file_with_foreign_owner_is_rejected(tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.load()
    target = str(tmp_path / "state" / "state.json")
    real_lstat = os.lstat

    def _lstat(path, *args, **kwargs):
        info = real_lstat(path, *args, **kwargs)
        if os.fspath(path) == target:
            return os.stat_result(
                (info.st_mode, info.st_ino, info.st_dev, info.st_nlink, os.geteuid() + 1, info.st_gid,
                 info.st_size, info.st_atime, info.st_mtime, info.st_ctime)
            )
        return info

    monkeypatch.setattr(state_module.os, "lstat", _lstat)
    with pytest.raises(StateCorruptError):
        _store(tmp_path).load()


def test_state_dir_is_created_private_and_symlink_rejected(tmp_path):
    directory = tmp_path / "state"
    ensure_state_dir(str(directory))
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    target = tmp_path / "real"
    target.mkdir()
    link = tmp_path / "link"
    link.symlink_to(target, target_is_directory=True)
    with pytest.raises(StoreError):
        ensure_state_dir(str(link))


class _WarningRecorder:
    def __init__(self):
        self.events = []

    def warning(self, event, **fields):
        self.events.append((event, fields))


def test_state_dir_loose_permission_warns_once_then_fails_closed(tmp_path):
    state_module._LOOSE_PERMISSION_WARNINGS.clear()
    directory = tmp_path / "state-loose"
    directory.mkdir()
    os.chmod(directory, 0o755)
    recorder = _WarningRecorder()

    # 0o755 → 先记一次告警（同 path+mode 每进程一次），随后每次调用都 fail closed。
    with pytest.raises(StateWriteError):
        ensure_state_dir(str(directory), logger=recorder)
    with pytest.raises(StateWriteError):
        ensure_state_dir(str(directory), logger=recorder)
    events = [event for event in recorder.events if event[0] == "state_dir_permissions_loose"]
    assert len(events) == 1
    fields = events[0][1]
    assert fields["path"] == str(directory)
    assert fields["mode"] == oct(0o755)
    assert fields["writable_by_group"] is False
    assert fields["writable_by_other"] is False

    # group/other 有写位：换 mode 后必须再告警一次，同样 fail closed。
    os.chmod(directory, 0o775)
    with pytest.raises(StateWriteError):
        ensure_state_dir(str(directory), logger=recorder)
    events = [event for event in recorder.events if event[0] == "state_dir_permissions_loose"]
    assert len(events) == 2
    assert events[1][1]["mode"] == oct(0o775)
    assert events[1][1]["writable_by_group"] is True

    # 0700 是正确配置：不告警、不失败。
    private = tmp_path / "state-private"
    ensure_state_dir(str(private), logger=recorder)
    assert len([e for e in recorder.events if e[0] == "state_dir_permissions_loose"]) == 2


def test_read_boot_id_is_bounded(tmp_path):
    if not os.path.exists(BOOT_ID_PATH):
        pytest.skip("/proc is not available")
    value = read_boot_id()
    assert value == UNKNOWN_BOOT_ID or len(value) >= 8
    bad = tmp_path / "boot"
    bad.write_text("not-a-uuid\n", encoding="utf-8")
    assert read_boot_id(str(bad)) == UNKNOWN_BOOT_ID


def test_agent_state_from_document_tolerates_out_of_range_scalars():
    state = AgentState.from_document({"schema": state_module.STATE_SCHEMA, "seq": -1, "boot_id": 5, "next_backoff_s": 99999})
    assert state.seq == 0
    assert state.boot_id == UNKNOWN_BOOT_ID
    assert state.next_backoff_s == 0


def test_agent_state_from_document_ignores_unknown_fields():
    state = AgentState.from_document({"schema": state_module.STATE_SCHEMA, "seq": 3, "extra": "x"})
    assert state.seq == 3
