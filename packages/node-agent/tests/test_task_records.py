"""任务记录存储的故障注入测试（路线 C 阶段一：store 层）。

覆盖合同要求的注入点 1-4、7、10、11：

1. tmp 写入前失败 → 原文件字节不变、内存索引不变。
2. 写 tmp / fsync(file) 失败 → 原文件不变、目录无 .tmp-* 残留。
3. os.replace 失败 → 原文件不变。
4. rename 成功 + dir fsync 失败 → TaskStoreUncertainError（磁盘=新内容，内存=旧值）；
   重启后 load 读到新内容，栅栏会被补成恰好一条 UNKNOWN 待投递。
7. 容量：pending/records 达上限时未知 task 的 begin 返回 CAPACITY 且零写盘，
   已有记录一条都不删，已知 task 重投照旧回答。
10. 迁移：旧三文件 → 记录一一对应，legacy/ 字节不变，第二次 load 不重复导入。
11. 坏文件名 / 文件名哈希不符 / 未知 schema / 旧账本终态缺摘要 → fail closed。

注入点 5、6、8、9 需要 loop 集成（ACK 与重启重发），属于阶段二。
"""

import hashlib
import io
import json
import os

import pytest

from ghostfleet_agent import records as store_module
from ghostfleet_agent import state as state_module
from ghostfleet_agent.logging import Logger
from ghostfleet_agent.protocol import (
    AGENT_EXECUTION_UNKNOWN,
    RESULT_SUCCEEDED,
    RESULT_UNKNOWN,
    digest_of,
    make_result,
)
from ghostfleet_agent.records import (
    BEGIN_CAPACITY,
    BEGIN_DONE,
    BEGIN_FENCED,
    BEGIN_NEW,
    CAPACITY_PENDING,
    CAPACITY_RECORD,
    DELIVERY_ACKED,
    DELIVERY_DROPPED,
    DELIVERY_NONE,
    DELIVERY_PENDING,
    LEGACY_LEDGER_FILENAME,
    LEGACY_LEDGER_SCHEMA,
    LEGACY_MANIFEST_SCHEMA,
    LEGACY_OUTBOX_FILENAME,
    LEGACY_OUTBOX_SCHEMA,
    LEGACY_TOMBSTONES_FILENAME,
    LEGACY_TOMBSTONE_SCHEMA,
    MAY_HAVE_EXECUTED,
    TASK_RECORD_SCHEMA,
    TASKS_DIRNAME,
    TaskRecordStore,
    TaskStoreCorruptError,
    TaskStoreUncertainError,
    TaskStoreWriteError,
    record_filename,
)
from ghostfleet_agent.records import (
    DELIVERY_QUARANTINED,
    QUARANTINE_NODE_UID_CHANGED,
    RECORD_FIELDS,
    build_record,
)

NODE_UID = "node-agent-0001"


def _logger() -> Logger:
    return Logger(io.StringIO())


def _open_store(directory) -> TaskRecordStore:
    store = TaskRecordStore(str(directory), node_uid=NODE_UID, logger=_logger())
    store.load()
    return store


def _task_result(task_id: str, operation: str, status=RESULT_SUCCEEDED, *, data=None, code=None):
    return make_result(task_id=task_id, node_uid=NODE_UID, operation=operation, status=status, data=data, code=code)


def _successful_result(task_id: str, operation: str):
    return _task_result(task_id, operation, data={"value": task_id})


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def _snapshot(root) -> dict:
    """整棵状态目录的 {路径: sha256}，用来证明"一次交易只碰一个文件"。"""
    snapshot: dict = {}
    for dirpath, _dirnames, filenames in os.walk(str(root)):
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            snapshot[path] = hashlib.sha256(_read_bytes(path)).hexdigest()
    return snapshot


def _changed_paths(before: dict, after: dict) -> set:
    return {path for path in after if before.get(path) != after[path]}


def _temp_files(directory) -> list:
    return [name for name in os.listdir(str(directory)) if name.startswith(".tmp-")]


def _body_for(record: dict) -> dict:
    return record["result_body"]


def _write_json_0600(path: str, document) -> bytes:
    payload = (json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
    os.chmod(path, 0o600)
    return payload


def _write_record_raw(store: TaskRecordStore, task_id: str, record: dict, *, name: str = "") -> str:
    path = os.path.join(store.tasks_dir, name or record_filename(task_id))
    _write_json_0600(path, record)
    return path


# --------------------------------------------------------------- 基本不变量


def test_begin_writes_exactly_one_record_file(tmp_path):
    store = _open_store(tmp_path)
    before = _snapshot(tmp_path)

    assert store.begin("task-1", "node.observe") == BEGIN_NEW

    after = _snapshot(tmp_path)
    record_path = store.record_path("task-1")
    assert _changed_paths(before, after) == {record_path}
    assert os.path.dirname(record_path) == os.path.join(str(tmp_path), TASKS_DIRNAME)
    assert oct(os.stat(record_path).st_mode & 0o777) == "0o600"
    assert oct(os.stat(os.path.join(str(tmp_path), TASKS_DIRNAME)).st_mode & 0o777) == "0o700"

    record = json.loads(_read_bytes(record_path).decode("utf-8"))
    assert record["schema"] == TASK_RECORD_SCHEMA
    assert record["task_id"] == "task-1"
    assert record["operation"] == "node.observe"
    assert record["execution_state"] == MAY_HAVE_EXECUTED
    assert record["delivery_state"] == DELIVERY_NONE
    assert record["result_body"] is None
    assert record["result_digest"] is None
    # 记录文件 = canonical JSON + 行尾换行
    assert _read_bytes(record_path).endswith(b"\n")


def test_ack_keeps_the_digest_and_drops_the_body_in_one_write(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    result = _successful_result("task-1", "node.observe")
    record = store.complete("task-1", RESULT_SUCCEEDED, result=result)
    assert record["delivery_state"] == DELIVERY_PENDING
    assert record["delivery_attempts"] == 0
    assert record["result_digest"] == digest_of(result)
    assert _body_for(record)["result"] == result

    before = _snapshot(tmp_path)
    acked = store.ack("task-1")
    assert _changed_paths(before, _snapshot(tmp_path)) == {store.record_path("task-1")}
    assert acked["delivery_state"] == DELIVERY_ACKED
    assert acked["result_body"] is None
    assert acked["result_digest"] == digest_of(result)
    assert acked["acked_at"]


def test_list_pending_orders_by_queue_time_then_task_id(tmp_path):
    store = _open_store(tmp_path)
    for task_id in ("task-b", "task-a", "task-c"):
        store.begin(task_id, "node.observe")
        store.complete(task_id, RESULT_SUCCEEDED, result=_successful_result(task_id, "node.observe"))
    record_path = store.record_path("task-c")
    document = json.loads(_read_bytes(record_path).decode("utf-8"))
    document["queued_at"] = "2026-01-01T00:00:00Z"
    _write_json_0600(record_path, document)
    reloaded = _open_store(tmp_path)
    pending = reloaded.list_pending()
    assert pending[0]["task_id"] == "task-c"
    assert [entry["task_id"] for entry in pending[1:]] == sorted(entry["task_id"] for entry in pending[1:])


# ------------------------------------------------- 注入 1：临时文件创建失败


def test_temp_file_failure_leaves_the_record_untouched(tmp_path, monkeypatch):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    record_path = store.record_path("task-1")
    before = _read_bytes(record_path)

    def boom(*args, **kwargs):
        raise OSError(5, "Input/output error")

    monkeypatch.setattr(state_module.tempfile, "mkstemp", boom)
    with pytest.raises(TaskStoreWriteError):
        store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))

    assert _read_bytes(record_path) == before
    assert store.get("task-1")["execution_state"] == MAY_HAVE_EXECUTED
    assert store.pending_count() == 0
    assert _temp_files(store.tasks_dir) == []
    assert _open_store(tmp_path).get("task-1")["execution_state"] == MAY_HAVE_EXECUTED


# ------------------------------------------- 注入 2：写 tmp / fsync(file) 失败


def test_fsync_failure_before_rename_leaves_the_record_untouched(tmp_path, monkeypatch):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    record_path = store.record_path("task-1")
    before = _read_bytes(record_path)

    def boom(descriptor):
        raise OSError(5, "Input/output error")

    monkeypatch.setattr(state_module.os, "fsync", boom)
    with pytest.raises(TaskStoreWriteError):
        store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))

    assert _read_bytes(record_path) == before
    assert store.get("task-1")["delivery_state"] == DELIVERY_NONE
    assert _temp_files(store.tasks_dir) == []


# ------------------------------------------------------- 注入 3：rename 失败


def test_replace_failure_leaves_the_record_untouched(tmp_path, monkeypatch):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    record_path = store.record_path("task-1")
    before = _read_bytes(record_path)

    def boom(source, target):
        raise OSError(13, "Permission denied")

    monkeypatch.setattr(state_module.os, "replace", boom)
    with pytest.raises(TaskStoreWriteError):
        store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))

    assert _read_bytes(record_path) == before
    assert store.get("task-1")["execution_state"] == MAY_HAVE_EXECUTED
    assert _temp_files(store.tasks_dir) == []


# --------------------------------------- 注入 4：rename 之后目录 fsync 失败


def test_directory_fsync_failure_is_an_uncertain_commit(tmp_path, monkeypatch):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")

    def boom(directory):
        raise state_module.StateWriteError("directory fsync failed", path=directory)

    monkeypatch.setattr(state_module, "_fsync_directory", boom)
    with pytest.raises(TaskStoreUncertainError):
        store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))

    # 磁盘上是新内容（rename 已经发生）。
    on_disk = json.loads(_read_bytes(store.record_path("task-1")).decode("utf-8"))
    assert on_disk["execution_state"] == RESULT_SUCCEEDED
    assert on_disk["delivery_state"] == DELIVERY_PENDING
    # 内存里仍是旧值：调用方必须走 FATAL，绝不能拿着旧索引继续跑。
    assert store.get("task-1")["execution_state"] == MAY_HAVE_EXECUTED

    monkeypatch.undo()
    reloaded = _open_store(tmp_path)
    assert reloaded.list_fenced() == []
    assert [record["task_id"] for record in reloaded.list_pending()] == ["task-1"]
    assert reloaded.get("task-1")["result_digest"] == digest_of(_successful_result("task-1", "node.observe"))


def test_restart_after_a_fence_synthesises_exactly_one_unknown(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "capability.inspect")

    restarted = _open_store(tmp_path)
    assert restarted.list_fenced() == ["task-1"]
    updated = restarted.mark_unknown("task-1")
    assert updated["execution_state"] == RESULT_UNKNOWN
    assert updated["reconciled"] is True
    assert updated["delivery_state"] == DELIVERY_PENDING
    assert updated["result_body"]["result"]["operation"] == "capability.inspect"
    assert updated["result_body"]["result"]["code"] == AGENT_EXECUTION_UNKNOWN
    assert updated["result_digest"] == digest_of(updated["result_body"]["result"])
    assert restarted.list_fenced() == []

    # 第二次补事实是空操作：一条记录只允许一个摘要离开节点。
    again = restarted.mark_unknown("task-1")
    assert again["result_digest"] == updated["result_digest"]
    assert [record["task_id"] for record in _open_store(tmp_path).list_pending()] == ["task-1"]


# --------------------------------------------------------------- 注入 7：容量


def test_pending_capacity_pauses_intake_without_deleting_anything(tmp_path, monkeypatch):
    monkeypatch.setattr(store_module, "MAX_PENDING_DELIVERIES", 1)
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))
    assert store.capacity_reason() == CAPACITY_PENDING

    before = _snapshot(tmp_path)
    assert store.begin("task-2", "node.observe") == BEGIN_CAPACITY
    assert _snapshot(tmp_path) == before
    assert store.inspect("task-2") is None
    # 已知 task 重投仍然照旧回答，且不加写。
    assert store.begin("task-1", "node.observe") == BEGIN_DONE
    assert _snapshot(tmp_path) == before


def test_record_capacity_answers_known_tasks_without_writing(tmp_path, monkeypatch):
    monkeypatch.setattr(store_module, "MAX_TASK_RECORDS", 2)
    store = _open_store(tmp_path)
    assert store.begin("task-1", "node.observe") == BEGIN_NEW
    assert store.begin("task-2", "node.observe") == BEGIN_NEW
    assert store.capacity_reason() == CAPACITY_RECORD

    before = _snapshot(tmp_path)
    assert store.begin("task-3", "node.observe") == BEGIN_CAPACITY
    assert _snapshot(tmp_path) == before
    assert store.begin("task-1", "node.observe") == BEGIN_FENCED
    assert store.record_count() == 2


# --------------------------------------------------------------- 注入 10：迁移


def _legacy_fixture(tmp_path) -> dict:
    done_result = _successful_result("task-done", "node.observe")
    foreign_result = _successful_result("task-foreign", "capability.inspect")
    tomb_result = _task_result("task-tomb", "node.observe", RESULT_UNKNOWN, code=AGENT_EXECUTION_UNKNOWN)
    dropped_result = _successful_result("task-migrated-dropped", "node.observe")
    ledger_document = {
        "schema": LEGACY_LEDGER_SCHEMA,
        "entries": {
            "task-done": {
                "state": RESULT_SUCCEEDED,
                "operation": "node.observe",
                "attempt": 1,
                "started_at": "2026-01-01T00:00:00Z",
                "finished_at": "2026-01-01T00:00:01Z",
                "reconciled": True,
                "result_digest": digest_of(done_result),
            },
            "task-fenced": {
                "state": MAY_HAVE_EXECUTED,
                "operation": "capability.inspect",
                "attempt": 2,
                "started_at": "2026-01-01T00:00:02Z",
                "reconciled": False,
            },
            "task-foreign": {
                "state": RESULT_SUCCEEDED,
                "operation": "node.observe",
                "attempt": 1,
                "started_at": "2026-01-01T00:00:03Z",
                "finished_at": "2026-01-01T00:00:04Z",
                "reconciled": True,
                "result_digest": digest_of(foreign_result),
            },
            "task-migrated-dropped": {
                "state": RESULT_SUCCEEDED,
                "operation": "node.observe",
                "attempt": 1,
                "started_at": "2026-01-01T00:00:05Z",
                "finished_at": "2026-01-01T00:00:06Z",
                "reconciled": True,
                "result_digest": digest_of(dropped_result),
            },
        },
    }
    outbox_document = {
        "schema": LEGACY_OUTBOX_SCHEMA,
        "items": [
            {
                "task_id": "task-done",
                "digest": digest_of(done_result),
                "body": {
                    "task_id": "task-done",
                    "operation": "node.observe",
                    "result": done_result,
                    "result_digest": digest_of(done_result),
                },
                "queued_at": "2026-01-01T00:00:01Z",
                "attempts": 3,
                "last_error_code": "NETWORK_ERROR",
            },
            {
                "task_id": "task-foreign",
                "digest": digest_of(foreign_result),
                "body": {
                    "task_id": "task-foreign",
                    "operation": "capability.inspect",
                    "result": foreign_result,
                    "result_digest": digest_of(foreign_result),
                },
                "queued_at": "2026-01-01T00:00:04Z",
                "attempts": 0,
                "last_error_code": None,
            },
            {
                "task_id": "task-fenced",
                "digest": digest_of(_successful_result("task-fenced", "capability.inspect")),
                "body": {
                    "task_id": "task-fenced",
                    "operation": "capability.inspect",
                    "result": _successful_result("task-fenced", "capability.inspect"),
                    "result_digest": digest_of(_successful_result("task-fenced", "capability.inspect")),
                },
                "queued_at": "2026-01-01T00:00:02Z",
                "attempts": 1,
                "last_error_code": None,
            },
        ],
        "dropped": ["task-migrated-dropped", "task-without-fact"],
    }
    tombstone_document = {
        "schema": LEGACY_TOMBSTONE_SCHEMA,
        "entries": {
            "task-tomb": {
                "state": RESULT_UNKNOWN,
                "operation": "node.observe",
                "result_digest": digest_of(tomb_result),
                "evicted_at": "2026-01-01T00:01:00Z",
            }
        },
    }
    payloads = {
        LEGACY_LEDGER_FILENAME: _write_json_0600(os.path.join(str(tmp_path), LEGACY_LEDGER_FILENAME), ledger_document),
        LEGACY_OUTBOX_FILENAME: _write_json_0600(os.path.join(str(tmp_path), LEGACY_OUTBOX_FILENAME), outbox_document),
        LEGACY_TOMBSTONES_FILENAME: _write_json_0600(
            os.path.join(str(tmp_path), LEGACY_TOMBSTONES_FILENAME), tombstone_document
        ),
    }
    return {
        "payloads": payloads,
        "done_digest": digest_of(done_result),
        "tomb_digest": digest_of(tomb_result),
    }


def test_migration_maps_legacy_facts_onto_records(tmp_path):
    fixture = _legacy_fixture(tmp_path)

    store = _open_store(tmp_path)

    done = store.get("task-done")
    assert done["execution_state"] == RESULT_SUCCEEDED
    assert done["delivery_state"] == DELIVERY_PENDING
    assert done["delivery_attempts"] == 3
    assert done["last_error_code"] == "NETWORK_ERROR"
    assert done["result_digest"] == fixture["done_digest"]
    assert done["result_body"]["operation"] == "node.observe"
    assert done["result_body"]["result"]["operation"] == "node.observe"

    fence = store.get("task-fenced")
    assert fence["execution_state"] == MAY_HAVE_EXECUTED
    assert fence["delivery_state"] == DELIVERY_NONE
    assert fence["result_body"] is None
    assert fence["attempt"] == 2

    foreign = store.get("task-foreign")
    assert foreign["execution_state"] == RESULT_SUCCEEDED
    assert foreign["delivery_state"] == DELIVERY_DROPPED
    assert foreign["last_error_code"] == "MIGRATION_BODY_UNVERIFIABLE"

    tomb = store.get("task-tomb")
    assert tomb["execution_state"] == RESULT_UNKNOWN
    assert tomb["delivery_state"] == DELIVERY_ACKED
    assert tomb["result_body"] is None
    assert tomb["result_digest"] == fixture["tomb_digest"]

    dropped = store.get("task-migrated-dropped")
    assert dropped["execution_state"] == RESULT_SUCCEEDED
    assert dropped["delivery_state"] == DELIVERY_DROPPED
    assert dropped["dropped_at"]

    # 旧文件被原样搬进 legacy/，字节与迁移前完全一致。
    assert os.path.exists(os.path.join(str(tmp_path), LEGACY_LEDGER_FILENAME)) is False
    for name, payload in fixture["payloads"].items():
        assert _read_bytes(os.path.join(str(tmp_path), "legacy", name)) == payload
        assert hashlib.sha256(payload).hexdigest() != ""
    manifest = json.loads(_read_bytes(os.path.join(str(tmp_path), "legacy", "IMPORTED")).decode("utf-8"))
    assert manifest["schema"] == LEGACY_MANIFEST_SCHEMA
    assert {entry["name"] for entry in manifest["files"]} == set(fixture["payloads"])
    assert manifest["records"] == 5
    assert any(warning["kind"] == "orphan-body-discarded" for warning in manifest["warnings"])
    assert any(warning["kind"] == "queued-body-unverifiable" for warning in manifest["warnings"])
    assert any(warning["kind"] == "dropped-entry-without-fact" for warning in manifest["warnings"])


def test_migration_runs_once_and_is_auditable(tmp_path):
    _legacy_fixture(tmp_path)
    store = _open_store(tmp_path)
    first = {record["task_id"]: record for record in store.records()}
    snapshot = _snapshot(tmp_path)

    reopened = _open_store(tmp_path)
    assert {record["task_id"]: record for record in reopened.records()} == first
    assert _snapshot(tmp_path) == snapshot
    assert os.path.exists(os.path.join(str(tmp_path), "legacy", "IMPORTED"))


def test_migration_keeps_the_legacy_bytes_when_a_file_cannot_be_moved(tmp_path, monkeypatch):
    fixture = _legacy_fixture(tmp_path)
    real_replace = state_module.os.replace

    def boom(source, target):
        # 只让"搬进 legacy/"这一步失败：记录提交仍然成功，证明失败的是移动而不是写入。
        if os.sep + "legacy" + os.sep in str(target):
            raise OSError(18, "Invalid cross-device link")
        return real_replace(source, target)

    monkeypatch.setattr(state_module.os, "replace", boom)
    with pytest.raises(TaskStoreWriteError):
        _open_store(tmp_path)
    for name, payload in fixture["payloads"].items():
        assert _read_bytes(os.path.join(str(tmp_path), name)) == payload


# ------------------------------------------------------------ 注入 11：fail closed


def test_unexpected_file_in_the_task_directory_fails_closed(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    _write_json_0600(os.path.join(store.tasks_dir, "notes.txt"), {"hello": "world"})
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_record_filename_that_does_not_match_the_hash_fails_closed(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    record = store.get("task-1")
    os.unlink(store.record_path("task-1"))
    _write_record_raw(store, "task-1", record, name=record_filename("task-2"))
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_unknown_record_schema_fails_closed(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    record = store.get("task-1")
    record["schema"] = "ghostfleet-node-task-record/v0"
    _write_record_raw(store, "task-1", record)
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_tampered_pending_body_fails_closed(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    record = store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))
    record["result_body"]["result"]["operation"] = "capability.inspect"
    _write_record_raw(store, "task-1", record)
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_may_have_executed_record_with_a_body_fails_closed(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    record = store.get("task-1")
    record["result_digest"] = "a" * 64
    _write_record_raw(store, "task-1", record)
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_stale_temp_file_is_removed_on_load(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    stale = os.path.join(store.tasks_dir, ".tmp-leftover.json")
    _write_json_0600(stale, {"partial": True})
    reopened = _open_store(tmp_path)
    assert reopened.record_count() == 1
    assert os.path.exists(stale) is False


def test_legacy_terminal_entry_without_a_digest_fails_closed(tmp_path):
    _write_json_0600(
        os.path.join(str(tmp_path), LEGACY_LEDGER_FILENAME),
        {
            "schema": LEGACY_LEDGER_SCHEMA,
            "entries": {
                "task-broken": {
                    "state": RESULT_SUCCEEDED,
                    "operation": "node.observe",
                    "attempt": 1,
                    "reconciled": True,
                    "result_digest": None,
                }
            },
        },
    )
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_capacity_limits_come_from_the_module(tmp_path):
    store = _open_store(tmp_path)
    assert store_module.MAX_TASK_RECORDS == 4096
    assert store_module.MAX_PENDING_DELIVERIES == 64
    assert store.record_count() == 0
    assert store.capacity_reason() is None


# ------------------------------- 隔离（QUARANTINED：状态不是移动，证据必须原样保留）


def _quarantined_candidate(record: dict) -> dict:
    candidate = json.loads(json.dumps(record))
    candidate.update(
        {
            "delivery_state": DELIVERY_QUARANTINED,
            "quarantined_at": "2026-02-02T00:00:00Z",
            "quarantine_reason": QUARANTINE_NODE_UID_CHANGED,
            "original_node_uid": "node-agent-old",
            "acked_at": None,
            "dropped_at": None,
        }
    )
    return candidate


def test_record_fields_constant_matches_build_record():
    record = build_record(task_id="task-1", operation="node.observe", attempt=1, started_at=None)
    assert set(record) == set(RECORD_FIELDS)
    assert len(RECORD_FIELDS) == len(record)
    # 归档字段只出现在归档行，v1 记录文件里刻意没有它们。
    assert "archived_at" not in record
    assert "archive_reason" not in record


def test_quarantined_record_keeps_its_body_and_digest(tmp_path, monkeypatch):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    done = store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))
    candidate = _quarantined_candidate(done)
    _write_record_raw(store, "task-1", candidate)

    monkeypatch.setattr(store_module, "MAX_PENDING_DELIVERIES", 1)
    reopened = _open_store(tmp_path)
    record = reopened.get("task-1")
    assert record["delivery_state"] == DELIVERY_QUARANTINED
    assert record["execution_state"] == RESULT_SUCCEEDED
    assert record["result_digest"] == done["result_digest"]
    assert record["result_body"] == done["result_body"]
    assert record["quarantine_reason"] == QUARANTINE_NODE_UID_CHANGED
    assert record["original_node_uid"] == "node-agent-old"
    assert record["quarantined_at"]
    # 隔离记录永不发送、不计入待投递容量，但仍然是记录（要能被 status 列出来）。
    assert reopened.list_pending() == []
    assert reopened.pending_count() == 0
    assert reopened.quarantined_count() == 1
    assert [entry["task_id"] for entry in reopened.list_quarantined()] == ["task-1"]
    assert reopened.capacity_reason() is None
    assert reopened.record_count() == 1
    # 已知 task 重投不再执行。
    assert reopened.begin("task-1", "node.observe") == BEGIN_DONE


def test_quarantined_record_without_its_body_fails_closed(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    done = store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))
    candidate = _quarantined_candidate(done)
    candidate["result_body"] = None
    _write_record_raw(store, "task-1", candidate)
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_quarantined_record_without_a_reason_fails_closed(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    done = store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))
    candidate = _quarantined_candidate(done)
    candidate["quarantine_reason"] = None
    _write_record_raw(store, "task-1", candidate)
    with pytest.raises(TaskStoreCorruptError):
        _open_store(tmp_path)


def test_archive_fields_are_ignored_instead_of_corrupting_the_record(tmp_path):
    store = _open_store(tmp_path)
    store.begin("task-1", "node.observe")
    done = store.complete("task-1", RESULT_SUCCEEDED, result=_successful_result("task-1", "node.observe"))
    document = json.loads(json.dumps(done))
    document["archived_at"] = "2026-03-03T00:00:00Z"
    document["archive_reason"] = "acknowledged"
    _write_record_raw(store, "task-1", document)

    stream = io.StringIO()
    reopened = TaskRecordStore(str(tmp_path), node_uid=NODE_UID, logger=Logger(stream))
    reopened.load()
    record = reopened.get("task-1")
    assert record["delivery_state"] == DELIVERY_PENDING
    assert record["result_digest"] == done["result_digest"]
    assert "archived_at" not in record
    assert "archive_reason" not in record
    assert "task_record_unknown_fields_ignored" in stream.getvalue()
    # 忽略不是拒绝：记录仍然可以正常推进（这里是 ACK）。
    acked = reopened.ack("task-1")
    assert acked["delivery_state"] == DELIVERY_ACKED
