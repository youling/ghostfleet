"""端到端：本地假控制面 + 真实 urllib 传输，断言线上形态与幂等语义。

覆盖合同要求：请求头（Bearer / node-uid / agent-version）与请求体字段
（schema / node_uid / nonce / sent_at / boot_id / seq）；回放一条任务让 agent
执行并回传结果；同 task_id 同摘要的重复回传是幂等形态，异摘要才是冲突。
"""
from __future__ import annotations

import io
import json
import threading
import time
from types import SimpleNamespace

import pytest

from agent_test_support import TEST_AGENT_VERSION, TEST_TOKEN, AgentSandbox, make_task
from ghostfleet_agent import protocol
from ghostfleet_agent.client import TransportResponse
from ghostfleet_agent.cli import build_loop, load_node_uid, load_token
from ghostfleet_agent.config import DEFAULT_REQUEST_TIMEOUT_S, load_config
from ghostfleet_agent.ledger import MAX_LEDGER_ENTRIES, RESULT_DROPPED, LedgerWriteError
from ghostfleet_agent.loop import (
    MAX_SLEEP_CHUNK_S,
    SHUTDOWN_FLUSH_BUDGET_S,
    SHUTDOWN_RESERVE_S,
    STOP_SLICE_S,
    TIMEOUT_STOP_SEC,
    WATCHDOG_INTERVAL_S,
    WatchdogThread,
)
from ghostfleet_agent.logging import Logger, clear_secrets
from ghostfleet_agent.outbox import Outbox
from ghostfleet_agent.protocol import (
    AGENT_EXECUTION_INTERRUPTED,
    AGENT_EXECUTION_UNKNOWN,
    AGENT_NETWORK_ERROR,
    NODE_BOOT_ID_CAPACITY_REACHED,
    NODE_NONCE_REPLAY,
    NODE_RATE_LIMITED,
    OUTCOME_NETWORK_ERROR,
    OUTCOME_OK,
    AGENT_LEDGER_EXHAUSTED,
    TASK_OPERATION_MISMATCH,
    TASK_RESULT_SCHEMA_UNSUPPORTED,
    RESULT_FAILED,
    RESULT_REFUSED,
    RESULT_STATUSES,
    RESULT_SUCCEEDED,
    RESULT_UNKNOWN,
    SCHEMA_AGENT,
    SCHEMA_TASK,
    TASK_RESULT_CONFLICT,
    digest_of,
    make_result,
)
from ghostfleet_agent.state import StateStore


@pytest.fixture(autouse=True)
def _clean_secrets():
    clear_secrets()
    yield
    clear_secrets()


@pytest.fixture()
def sandbox(tmp_path):
    return AgentSandbox(tmp_path / "agent")


def build_agent(sandbox, control_plane, *, allowed_units=()):
    """走 cli.build_loop，确保测试覆盖真实装配路径。"""
    config_path = sandbox.write_config(control_plane.url, allowed_units=list(allowed_units))
    config = load_config(str(config_path))
    token = load_token(str(sandbox.token_path))
    node_uid = load_node_uid(str(sandbox.node_meta_path))
    logger_stream = io.StringIO()
    loop = build_loop(config, token, node_uid, logger=Logger(logger_stream))
    loop._sleep = lambda seconds: None
    loop._jitter = lambda ratio: 0.0
    return loop, logger_stream


def idle_responder(plane):
    """按 plane 当前队列作答的空闲响应器（回放任务时仍然生效）。"""

    def responder(record):
        path = record["path"]
        if path.endswith("/heartbeat"):
            return 200, {"interval_s": 15.0, "tasks": list(plane.heartbeat_tasks)}
        if path.endswith("/tasks/poll"):
            return 200, {"tasks": list(plane.poll_tasks)}
        return 200, {"status": "accepted"}

    return responder


# -- 请求形态 ---------------------------------------------------------------
def test_heartbeat_carries_headers_and_envelope(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    assert loop.run_once() == 0

    records = control_plane.requests_to("/heartbeat")
    assert len(records) == 1
    record = records[0]
    assert record["path"] == f"/v0/nodes/{sandbox.node_uid}/heartbeat"
    headers = record["headers"]
    assert headers["authorization"] == f"Bearer {TEST_TOKEN}"
    assert headers["x-ghostfleet-node-uid"] == sandbox.node_uid
    assert headers["x-ghostfleet-agent-version"] == TEST_AGENT_VERSION
    assert headers["content-type"] == "application/json"

    body = record["body"]
    assert body["schema"] == SCHEMA_AGENT
    assert body["node_uid"] == sandbox.node_uid
    assert protocol.is_valid_nonce(body["nonce"])
    assert protocol.parse_timestamp(body["sent_at"])
    assert isinstance(body["boot_id"], str) and body["boot_id"]
    assert isinstance(body["seq"], int) and body["seq"] >= 1
    # 心跳额外字段（ADR §6）
    assert body["health"] in ("OK", "DEGRADED", "FAILING")
    assert isinstance(body["drift"], list)
    assert body["agent_version"] == TEST_AGENT_VERSION
    assert body["queue_depth"] == 0
    assert isinstance(body["observation"], dict)
    # 请求体有界
    assert len(record["raw"]) <= protocol.MAX_HEARTBEAT_BYTES


def test_poll_carries_envelope_and_is_node_scoped(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    assert loop.run_once() == 0

    records = control_plane.requests_to("/tasks/poll")
    assert len(records) == 1
    record = records[0]
    assert record["path"] == f"/v0/nodes/{sandbox.node_uid}/tasks/poll"
    assert record["headers"]["authorization"] == f"Bearer {TEST_TOKEN}"
    body = record["body"]
    for field in ("schema", "node_uid", "nonce", "sent_at", "boot_id", "seq"):
        assert field in body
    assert body["schema"] == SCHEMA_AGENT
    assert len(record["raw"]) <= protocol.MAX_POLL_BYTES
    # 序号单调递增：poll 在 heartbeat 之后
    assert body["seq"] > control_plane.requests_to("/heartbeat")[0]["body"]["seq"]


def test_requests_never_leak_the_token_into_logs(sandbox, control_plane):
    loop, logger_stream = build_agent(sandbox, control_plane)
    assert loop.run_once() == 0
    assert TEST_TOKEN not in logger_stream.getvalue()


# -- 任务执行与结果回传 -----------------------------------------------------
def test_replayed_task_is_executed_and_reported(sandbox, control_plane):
    control_plane.heartbeat_tasks = [make_task(node_uid=sandbox.node_uid)]
    loop, _ = build_agent(sandbox, control_plane)
    assert loop.run_once() == 0

    results = control_plane.results
    assert len(results) == 1
    body = results[0]
    for field in ("schema", "node_uid", "nonce", "sent_at", "boot_id", "seq"):
        assert field in body
    assert body["schema"] == SCHEMA_AGENT
    assert body["task_id"] == "task-0001"
    assert body["operation"] == "node.observe"
    result = body["result"]
    assert result["schema"] == SCHEMA_TASK
    assert result["task_id"] == "task-0001"
    assert result["node_uid"] == sandbox.node_uid
    assert result["status"] == RESULT_SUCCEEDED
    assert body["result_digest"] == digest_of(result)
    assert len(body["result_digest"]) == 64
    # 结果请求走 node 作用域端点
    result_record = control_plane.requests_to("/result")[0]
    assert result_record["path"] == f"/v0/nodes/{sandbox.node_uid}/tasks/task-0001/result"
    assert len(result_record["raw"]) <= protocol.MAX_RESULT_BYTES
    # outbox 已收敛
    assert loop.outbox.depth() == 0


def test_duplicate_task_delivery_is_not_executed_twice(sandbox, control_plane):
    task = make_task(node_uid=sandbox.node_uid)
    control_plane.heartbeat_tasks = [task]
    control_plane.poll_tasks = [dict(task)]
    loop, _ = build_agent(sandbox, control_plane)

    assert loop.run_once() == 0
    assert len(control_plane.results) == 1

    # 第二轮重复投递同一 task：已在 ledger 终态，绝不重跑、也不重复回传
    control_plane.poll_tasks = [dict(task)]
    assert loop.run_once() == 0
    assert len(control_plane.results) == 1
    assert loop.ledger.get("task-0001")["state"] == RESULT_SUCCEEDED


def test_same_task_same_digest_is_idempotent_same_task_other_digest_conflicts(sandbox, control_plane):
    state = {"seen": {}}

    def responder(record):
        path = record["path"]
        if path.endswith("/result"):
            body = record["body"] or {}
            control_plane.results.append(body)
            key = body.get("task_id")
            digest = body.get("result_digest")
            if key in state["seen"] and state["seen"][key] != digest:
                return 409, {"code": TASK_RESULT_CONFLICT}
            state["seen"][key] = digest
            return 200, {"status": "accepted", "task_id": key}
        return idle_responder(control_plane)(record)

    control_plane.respond = responder
    task = make_task(node_uid=sandbox.node_uid)
    control_plane.heartbeat_tasks = [task]
    loop, _ = build_agent(sandbox, control_plane)
    assert loop.run_once() == 0

    first = dict(control_plane.results[0])
    # 同 task_id + 同 digest 重放：控制面回 200 accepted（幂等）
    response = loop.client.send_result_body(
        lambda nonce: loop._envelope(nonce, {key: value for key, value in first.items() if key in ("task_id", "operation", "result", "result_digest")}),
        "task-0001",
    )
    assert response.status == 200
    assert len(control_plane.results) == 2
    assert control_plane.results[1]["result_digest"] == first["result_digest"]

    # 同 task_id 异 digest：控制面回 409，客户端归类为永久拒绝（不无限重试）
    altered = json.loads(json.dumps(first["result"]))
    # 固定成一个必然不同的时间戳（同一秒内取 now 可能生成相同 digest）。
    altered["observed_at"] = "2000-01-01T00:00:00Z"
    conflict = loop.client.send_result_body(
        lambda nonce: loop._envelope(
            nonce,
            {
                "task_id": "task-0001",
                "operation": "node.observe",
                "result": altered,
                "result_digest": digest_of(altered),
            },
        ),
        "task-0001",
    )
    assert conflict.status == 409
    assert conflict.code == TASK_RESULT_CONFLICT
    assert conflict.kind == "REJECTED"


# -- 崩溃恢复：只补事实，不重跑 --------------------------------------------
def test_reconcile_marks_unknown_without_rerunning(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    loop.ledger.begin("task-crash", "node.observe", 1)

    assert loop.reconcile() == 1
    entry = loop.ledger.get("task-crash")
    assert entry["state"] == RESULT_UNKNOWN
    assert loop.ledger.pending_reconcile() == []
    # 结果已进 outbox，等待下一轮 flush
    assert loop.outbox.has("task-crash")

    assert loop.run_once() == 0
    assert len(control_plane.results) == 1
    body = control_plane.results[0]
    assert body["task_id"] == "task-crash"
    assert body["result"]["status"] == RESULT_UNKNOWN
    assert body["result"]["code"] == AGENT_EXECUTION_UNKNOWN


def test_reconcile_uses_existing_outbox_result_instead_of_guessing(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    result = protocol.make_result(
        task_id="task-keep",
        node_uid=sandbox.node_uid,
        operation="node.observe",
        status=RESULT_SUCCEEDED,
        data={"status": "OK"},
    )
    body = {
        "task_id": "task-keep",
        "operation": "node.observe",
        "result": result,
        "result_digest": digest_of(result),
    }
    loop.ledger.begin("task-keep", "node.observe", 1)
    loop.outbox.add(body)

    assert loop.reconcile() == 1
    entry = loop.ledger.get("task-keep")
    assert entry["state"] == RESULT_SUCCEEDED
    assert entry["result_digest"] == digest_of(result)
    # 没有生造第二条 UNKNOWN 结果
    assert loop.outbox.depth() == 1

    assert loop.run_once() == 0
    assert [item["task_id"] for item in control_plane.results] == ["task-keep"]
    assert control_plane.results[0]["result_digest"] == digest_of(result)


# -- 生命周期 ---------------------------------------------------------------
def test_run_forever_sleeps_interval_and_exits_zero(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    sleeps = []
    loop._sleep = sleeps.append

    assert loop.run_forever(max_iterations=2) == 0
    assert len(control_plane.requests_to("/heartbeat")) == 2
    # 客户端/循环的周期下限是 30 s（ADR §5.1 速率预算），即使配置与心跳都写 15。
    assert sleeps and all(value == pytest.approx(30.0) for value in sleeps)
    document = json.loads(sandbox.state_paths()["state"].read_text(encoding="utf-8"))
    assert document["last_stop"]
    assert document["stopping"] is False  # record_stop 已清位


def test_run_forever_stops_on_stop_event(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)

    class SetStop:
        def is_set(self):
            return True

    assert loop.run_forever(stop_event=SetStop()) == 0
    assert control_plane.requests_to("/heartbeat") == []


def test_run_forever_exits_four_on_auth_fatal(sandbox, control_plane):
    control_plane.respond = lambda record: (401, {"code": "NODE_AUTH_INVALID"})
    loop, logger_stream = build_agent(sandbox, control_plane)
    assert loop.run_forever(max_iterations=3) == 4
    assert len(control_plane.requests_to("/heartbeat")) == 1
    assert "NODE_AUTH_INVALID" in logger_stream.getvalue()
    assert TEST_TOKEN not in logger_stream.getvalue()
    fatal_events = [record for record in _events(logger_stream) if record["event"] == "fatal"]
    assert fatal_events and fatal_events[0]["detail"]["code"] == "NODE_AUTH_INVALID"
# -- 合同 E：固定结构化事件与连续工作计数 -----------------------------------
def _events(stream):
    records = []
    for line in stream.getvalue().splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("event") in {"poll", "task_start", "task_result", "backoff", "fatal"}:
            records.append(record)
    return records


def test_structured_events_have_fixed_fields_and_no_secrets(sandbox, control_plane):
    control_plane.heartbeat_tasks = [make_task(node_uid=sandbox.node_uid)]
    loop, stream = build_agent(sandbox, control_plane)
    assert loop.run_once() == 0

    events = _events(stream)
    names = [record["event"] for record in events]
    assert "poll" in names
    assert "task_start" in names and "task_result" in names
    for record in events:
        assert {"ts", "event", "seq", "detail"} <= set(record)
        assert isinstance(record["seq"], int) and record["seq"] >= 0
    text = stream.getvalue()
    assert TEST_TOKEN not in text
    assert "nonce" not in text.lower()
    details = {record["event"]: record["detail"] for record in events}
    assert details["task_start"] == {
        "task_id": "task-0001",
        "operation": "node.observe",
    }
    assert details["task_result"]["status"] == RESULT_SUCCEEDED
    assert "params" not in json.dumps(events)

    document = json.loads(sandbox.state_paths()["state"].read_text(encoding="utf-8"))
    assert document["polls"] == 1
    assert document["tasks_executed"] == 1
    assert document["outbox_overflow"] == 0


def test_pending_outbox_is_flushed_before_new_work(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    result = protocol.make_result(
        task_id="task-pending",
        node_uid=sandbox.node_uid,
        operation="node.observe",
        status=RESULT_SUCCEEDED,
        data={"status": "OK"},
    )
    loop.outbox.add(
        {
            "task_id": "task-pending",
            "operation": "node.observe",
            "result": result,
            "result_digest": digest_of(result),
        }
    )
    loop.ledger.complete(
        "task-pending", RESULT_SUCCEEDED, result_digest=digest_of(result), operation="node.observe"
    )
    assert loop.run_once() == 0
    paths = [record["path"] for record in control_plane.records]
    assert paths[0].endswith("/tasks/task-pending/result")
    assert any(path.endswith("/heartbeat") for path in paths)


def test_startup_replays_persisted_outbox_drops_as_result_dropped(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    for index in range(66):
        result = protocol.make_result(
            task_id=f"task-{index:04d}",
            node_uid=sandbox.node_uid,
            operation="node.observe",
            status=RESULT_SUCCEEDED,
            data={"status": "OK"},
        )
        loop.outbox.add(
            {
                "task_id": f"task-{index:04d}",
                "operation": "node.observe",
                "result": result,
                "result_digest": digest_of(result),
            }
        )
    for item in loop.outbox.pending():
        loop.ledger.complete(
            item["task_id"],
            RESULT_SUCCEEDED,
            result_digest=item["body"]["result_digest"],
            operation="node.observe",
        )
    # 崩溃后重启：丢弃事实必须从 outbox.json 重放成 ledger 的 RESULT_DROPPED。
    assert loop.outbox.pending_dropped() == ["task-0000", "task-0001"]
    assert loop.run_once() == 0
    assert loop.outbox.pending_dropped() == []
    for task_id in ("task-0000", "task-0001"):
        assert loop.ledger.get(task_id)["result_state"] == "RESULT_DROPPED"
    document = json.loads(sandbox.state_paths()["state"].read_text(encoding="utf-8"))
    assert document["outbox_overflow"] == 2


def test_outbox_overflow_is_counted_and_dropped_oldest(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    for index in range(64):
        result = protocol.make_result(
            task_id=f"task-old-{index:03d}",
            node_uid=sandbox.node_uid,
            operation="node.observe",
            status=RESULT_SUCCEEDED,
            data={"status": "OK"},
        )
        loop.outbox.add(
            {
                "task_id": f"task-old-{index:03d}",
                "operation": "node.observe",
                "result": result,
                "result_digest": digest_of(result),
            }
        )
    # 直接派发一个任务：若走 iteration() 会先 flush 掉上面 64 条，构造不出溢出。
    loop._process_task(make_task(node_uid=sandbox.node_uid, task_id="task-new"))

    document = json.loads(sandbox.state_paths()["state"].read_text(encoding="utf-8"))
    assert document["outbox_overflow"] == 1
    assert loop.outbox.has("task-new")
    assert not loop.outbox.has("task-old-000")


# -- 合同 D：sd_notify 生命周期 --------------------------------------------
class RecordingNotifier:
    def __init__(self):
        self.calls = []

    def ready(self):
        self.calls.append("ready")
        return True

    def watchdog(self):
        self.calls.append("watchdog")
        return True

    def stopping(self):
        self.calls.append("stopping")
        return True

    def mainpid(self, pid=None):
        self.calls.append("mainpid")
        return True


def test_run_forever_sends_ready_first_and_stopping_last(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    notifier = RecordingNotifier()
    loop.notifier = notifier

    assert loop.run_forever(max_iterations=1) == 0
    assert notifier.calls[0] == "ready"
    assert notifier.calls[-1] == "stopping"


def test_shutdown_sends_stopping_before_flushing(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    notifier = RecordingNotifier()
    loop.notifier = notifier

    loop.shutdown(reason="test")
    assert notifier.calls[0] == "stopping"
    document = json.loads(sandbox.state_paths()["state"].read_text(encoding="utf-8"))
    assert document["last_stop"]


def test_long_sleeps_are_chunked_with_watchdog(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    notifier = RecordingNotifier()
    loop.notifier = notifier
    sleeps = []
    loop._sleep = sleeps.append

    loop._sleep_with_jitter(75.0)
    # WatchdogSec=60：75 s 必须切成 30+30+15，每块之间喂狗。
    assert sleeps == [pytest.approx(30.0), pytest.approx(30.0), pytest.approx(15.0)]
    assert notifier.calls == ["watchdog", "watchdog"]




# -- 429 Retry-After 权威 ---------------------------------------------------
def _enqueue_pending_result(loop, sandbox, task_id="task-rate-limited"):
    result = protocol.make_result(
        task_id=task_id,
        node_uid=sandbox.node_uid,
        operation="agent.self.test",
        status=RESULT_SUCCEEDED,
        data={"nonce": None},
    )
    loop.outbox.add(
        {
            "task_id": task_id,
            "operation": "agent.self.test",
            "result": result,
            "result_digest": digest_of(result),
        }
    )
    # 真实路径里 outbox 里的结果一定伴随已提交的 ledger 终态摘要（发送前闸门）。
    loop.ledger.complete(
        task_id,
        RESULT_SUCCEEDED,
        result_digest=digest_of(result),
        operation="agent.self.test",
    )
    return result


def test_result_429_retry_after_is_authoritative_and_not_jittered(sandbox, control_plane):
    """真实 429 响应（含 Retry-After: 900）驱动：不许手设内部状态。"""
    loop, _ = build_agent(sandbox, control_plane)
    _enqueue_pending_result(loop, sandbox)
    attempts = {"result": 0}

    def responder(record):
        path = record["path"]
        if path.endswith("/result"):
            attempts["result"] += 1
            if attempts["result"] == 1:
                return 429, {"code": NODE_RATE_LIMITED}
            return 200, {"status": "accepted"}
        if path.endswith("/heartbeat"):
            return 200, {"interval_s": 30.0, "tasks": []}
        if path.endswith("/tasks/poll"):
            return 200, {"tasks": []}
        return 200, {}

    control_plane.respond = responder
    control_plane.respond_headers = {"Retry-After": "900"}

    sleeps = []
    loop._sleep = sleeps.append
    # 抖动故意拉满：服务端权威时长绝不能乘抖动。
    loop._jitter = lambda ratio: 0.5

    assert loop.run_forever(max_iterations=2) == 0
    # 第一次 result POST 被 429：按 900 s（切块 30 s）等待，而不是本地 <=300 s 退避。
    assert sum(sleeps[:30]) == pytest.approx(900.0)
    assert sum(sleeps) > 300
    # 第二次投递真正发出，且没有在同一轮里连打。
    assert attempts["result"] == 2


def test_local_backoff_without_retry_after_is_capped_at_300(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    loop._retry_after_s = 0.0
    loop.state.next_backoff_s = 1000
    assert loop._retry_delay() == pytest.approx(300.0)


# -- 永久性错误：丢件而不是无限重投 -------------------------------------------
@pytest.mark.parametrize(
    "status, code",
    [
        (400, TASK_RESULT_SCHEMA_UNSUPPORTED),
        (409, TASK_OPERATION_MISMATCH),
    ],
)
def test_permanently_rejected_result_is_dropped_not_retried(sandbox, control_plane, status, code):
    loop, _ = build_agent(sandbox, control_plane)
    _enqueue_pending_result(loop, sandbox, task_id="task-permanent")
    control_plane.respond = lambda record: (
        (status, {"code": code}) if record["path"].endswith("/result") else (200, {"tasks": [], "interval_s": 30.0})
    )

    report = loop.outbox.flush(loop._send_outbox_item)
    # 真实 client._classify 路径（真实 urllib + 真实 HTTP 状态码）判定为顶不可接受。
    assert report.rejected == ["task-permanent"]
    assert report.remaining == 0
    assert loop.outbox.depth() == 0

    # 再 flush 一次不得产生新的 result POST：丢件即终局。
    before = len(control_plane.requests_to("/result"))
    loop.outbox.flush(loop._send_outbox_item)
    assert len(control_plane.requests_to("/result")) == before


def test_boot_capacity_409_is_fatal_and_stops_the_loop(sandbox, control_plane):
    control_plane.respond = lambda record: (409, {"code": NODE_BOOT_ID_CAPACITY_REACHED})
    loop, stream = build_agent(sandbox, control_plane)

    # 与 403 同路径：FATAL -> run_once 返 4，且只在第一轮打一次请求，不无限退避。
    assert loop.run_once() == 4
    assert len(control_plane.requests_to("/heartbeat")) == 1
    assert "fatal" in stream.getvalue()


# -- 账本耗尽：停止取任务，绝不驱逐栅栏 ---------------------------------------
def test_ledger_exhaustion_stops_polling_and_resumes_after_reconcile(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    loop.ledger.save = lambda: None  # 只为提速：栅栏仍在内存与迭代路径中
    for index in range(MAX_LEDGER_ENTRIES):
        loop.ledger.begin(f"task-fence-{index:04d}", "node.observe")
    assert loop.ledger.is_exhausted() is True

    assert loop.iteration() == "ok"
    heartbeats = control_plane.requests_to("/heartbeat")
    assert len(heartbeats) == 1
    body = heartbeats[0]["body"]
    assert body["health"] == "DEGRADED"
    assert body["health_reason"] == AGENT_LEDGER_EXHAUSTED
    # 关键：不 poll、不驱逐任何栅栏。
    assert control_plane.requests_to("/tasks/poll") == []
    assert len(loop.ledger.entries) == MAX_LEDGER_ENTRIES
    assert loop.ledger.get("task-fence-0000") is not None

    # 只有"可证明幂等的已收敛终态"能腾出空间：UNKNOWN 即使已对账也永不驱逐。
    loop.ledger.mark_unknown("task-fence-0000")
    loop.ledger.mark_reconciled("task-fence-0000")
    assert loop.ledger.is_exhausted() is True
    # 把一条栅栏收敛成只读 operation 的成功终态，才真正腾出可驱逐条目。
    loop.ledger.complete("task-fence-0001", RESULT_SUCCEEDED)
    assert loop.ledger.is_exhausted() is False
    assert loop.iteration() == "ok"
    assert len(control_plane.requests_to("/tasks/poll")) == 1
    assert "health_reason" not in control_plane.requests_to("/heartbeat")[1]["body"]


def test_shutdown_flushes_pending_results(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    result = protocol.make_result(
        task_id="task-pending",
        node_uid=sandbox.node_uid,
        operation="agent.self.test",
        status=RESULT_SUCCEEDED,
        data={"nonce": None},
    )
    loop.outbox.add(
        {
            "task_id": "task-pending",
            "operation": "agent.self.test",
            "result": result,
            "result_digest": digest_of(result),
        }
    )
    loop.ledger.complete(
        "task-pending", RESULT_SUCCEEDED, result_digest=digest_of(result), operation="agent.self.test"
    )
    loop.shutdown(reason="test")
    assert loop.outbox.depth() == 0
    assert [item["task_id"] for item in control_plane.results] == ["task-pending"]


# -- P1-A：常驻喂狗线程（离线/长阻塞时也不能饿死 watchdog） ------------------
class OfflineClient:
    """控制面不可达：每次请求都返回 NETWORK_ERROR，迫使循环走离线退避。"""

    def __init__(self):
        self.heartbeats = 0

    def heartbeat(self, body_builder, **_kwargs):
        self.heartbeats += 1
        return SimpleNamespace(
            kind=OUTCOME_NETWORK_ERROR, code=AGENT_NETWORK_ERROR, ok=False, retry_after_s=None
        )

    def poll(self, body_builder, **_kwargs):
        return SimpleNamespace(
            kind=OUTCOME_NETWORK_ERROR, code=AGENT_NETWORK_ERROR, ok=False, retry_after_s=None
        )

    def send_result_body(self, body_builder, task_id, **_kwargs):
        return SimpleNamespace(kind=OUTCOME_NETWORK_ERROR, code=AGENT_NETWORK_ERROR)


def test_watchdog_thread_beats_on_fake_time_axis():
    """假时间轴：周期恒为 WatchdogSec/3=20 s，相邻间隔 ≤ WatchdogSec/2=30 s。"""

    class Timeline:
        now = 0.0
        beats = []

    timeline = Timeline()

    class Notifier:
        def watchdog(self):
            timeline.beats.append(timeline.now)
            return True

    def waiter(seconds):
        timeline.now += seconds
        return len(timeline.beats) >= 5

    watchdog = WatchdogThread(Notifier(), interval_s=WATCHDOG_INTERVAL_S, waiter=waiter)
    watchdog._run()  # 同步执行：不启动真实线程、不真实睡眠

    assert len(timeline.beats) == 5
    gaps = [later - earlier for earlier, later in zip(timeline.beats, timeline.beats[1:])]
    assert max(gaps) <= 30.0  # WatchdogSec=60 的一半
    assert all(gap == pytest.approx(WATCHDOG_INTERVAL_S) for gap in gaps)


def test_offline_backoff_keeps_watchdog_beating(sandbox, control_plane):
    """离线连续 5 轮失败期间，喂狗线程仍按周期发 WATCHDOG（不会每 60 s 被重启）。"""
    loop, _ = build_agent(sandbox, control_plane)
    loop.client = OfflineClient()
    notifier = RecordingNotifier()
    loop.notifier = notifier
    loop._watchdog_interval_s = 0.005
    loop._sleep = lambda seconds: time.sleep(0.02)  # 让线程在真实时间里获得调度

    assert loop.run_forever(max_iterations=5) == 0
    assert loop.client.heartbeats == 5
    assert notifier.calls[0] == "ready"
    assert notifier.calls.count("watchdog") >= 5
    assert notifier.calls[-1] == "stopping"


def test_shutdown_joins_watchdog_before_stopping(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    notifier = RecordingNotifier()
    loop.notifier = notifier
    loop._watchdog_interval_s = 0.005
    loop._start_watchdog()
    thread = loop._watchdog.thread
    assert thread.is_alive()
    time.sleep(0.03)
    assert notifier.calls.count("watchdog") >= 1

    loop.shutdown(reason="test")
    assert loop._watchdog is None
    assert not thread.is_alive()  # 先 join 线程，再发 STOPPING
    assert notifier.calls[-1] == "stopping"
    assert "watchdog" not in notifier.calls[notifier.calls.index("stopping"):]


class ExplodingNotifier(RecordingNotifier):
    def watchdog(self):
        self.calls.append("watchdog")
        raise RuntimeError("sd_notify broken")


def test_watchdog_thread_exception_does_not_kill_the_loop(sandbox, control_plane):
    loop, logger_stream = build_agent(sandbox, control_plane)
    loop.client = OfflineClient()
    loop.notifier = ExplodingNotifier()
    loop._watchdog_interval_s = 0.001
    loop._sleep = lambda seconds: time.sleep(0.02)

    assert loop.run_forever(max_iterations=3) == 0
    assert loop.client.heartbeats == 3
    assert loop._watchdog is None
    trace = logger_stream.getvalue()
    assert "watchdog_thread_failed" in trace
    assert trace.count("watchdog_thread_failed") == 1  # 线程内异常只 warning 一次


def test_run_once_never_starts_the_watchdog_thread(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    notifier = RecordingNotifier()
    loop.notifier = notifier

    assert loop.run_once() == 0
    assert loop._watchdog is None
    assert "watchdog" not in notifier.calls


def test_stop_budget_is_a_runtime_deadline_not_a_constant_sum(sandbox, control_plane):
    """停机预算是运行时逐条检查的 deadline，不是"常量相加"。

    旧版这条测试只做算术（1+10+8+2<=30）就"证明"了停机 ≤30 s，但真机上
    flush 可以连打 64 条、每条最多 10 s（PROBE2 实测 12.84 s > 8 s 预算）。
    这里用假单调时钟 + 每条 send 0.2 s 驱动真实的 shutdown() 路径，断言：
      · 整个收尾耗时被 8 s 预算（+一次 send 的粒度）截住；
      · 每条 send 拿到的 timeout_s 是"剩余预算"且单调递减；
      · 没来得及发出的条目仍然可见（pending > 0）。
    """
    loop, _ = build_agent(sandbox, control_plane)
    for index in range(64):
        _enqueue_pending_result(loop, sandbox, task_id=f"task-slow-{index:04d}")

    clock = {"now": 1000.0}
    loop._monotonic = lambda: clock["now"]
    timeouts = []

    def slow_send(item, timeout_s=None):
        timeouts.append(timeout_s)
        clock["now"] += 0.2  # 每条 result POST 0.2 s
        return SimpleNamespace(kind=OUTCOME_OK, code=None)

    loop._send_outbox_item = slow_send
    stats = loop.shutdown(reason="test")

    # 64 × 0.2 = 12.8 s 的无预算行为被截断到 8 s 量级。
    assert stats["elapsed_s"] <= SHUTDOWN_FLUSH_BUDGET_S + 0.2
    assert stats["elapsed_s"] >= SHUTDOWN_FLUSH_BUDGET_S - 1.0
    assert len(timeouts) == stats["sent"]
    assert 25 <= stats["sent"] <= 40
    assert stats["pending"] == 64 - stats["sent"]
    assert stats["pending"] > 0  # 未发条数可见
    # 单请求超时被钳到剩余预算，且严格递减（绝不出现 10 s > 剩余预算）。
    assert all(value is not None and value <= SHUTDOWN_FLUSH_BUDGET_S for value in timeouts)
    assert all(later <= earlier + 1e-9 for earlier, later in zip(timeouts, timeouts[1:]))
    # 睡眠块必须小于两个喂狗周期，否则主循环块间喂狗也救不了 WatchdogSec=60。
    assert MAX_SLEEP_CHUNK_S < 2 * WATCHDOG_INTERVAL_S
    # 逐段上界 + 余量下限：只断言"总和 ≤ 30"是不敏感的哨兵——把 STOP_SLICE_S 改成 9.0
    # 仍然能加出 ≤30，却已经违反"每 ≤1 s 检查一次 stop_event"。因此每一段单独钉住。
    assert STOP_SLICE_S <= 1.0
    assert DEFAULT_REQUEST_TIMEOUT_S <= 10.0
    assert SHUTDOWN_FLUSH_BUDGET_S <= 8.0
    assert SHUTDOWN_RESERVE_S >= 2.0
    worst = STOP_SLICE_S + DEFAULT_REQUEST_TIMEOUT_S + SHUTDOWN_FLUSH_BUDGET_S + SHUTDOWN_RESERVE_S
    assert worst <= TIMEOUT_STOP_SEC
    # 余量下限：任何一段被改大都要么触发上面的分支断言，要么至少留下 ≥SHUTDOWN_RESERVE_S。
    assert TIMEOUT_STOP_SEC - worst >= SHUTDOWN_RESERVE_S


# -- P1：停止后不得再发起任何新请求（真机 PROBE1 的 loop 级复现） -------------
def test_stop_during_heartbeat_never_starts_a_poll(sandbox, control_plane):
    """心跳在途时收到 SIGTERM：绝不再发 poll（真机上曾多打一条 poll）。"""
    loop, _ = build_agent(sandbox, control_plane)
    stop_event = threading.Event()
    loop.bind_stop_event(stop_event)

    def responder(record):
        if record["path"].endswith("/heartbeat"):
            stop_event.set()  # 模拟 signal 恰好落在心跳在途期间
            return 200, {"interval_s": 15.0, "tasks": []}
        return 200, {"tasks": []}

    control_plane.respond = responder
    assert loop.iteration() == "stopped"
    assert len(control_plane.requests_to("/heartbeat")) == 1
    assert control_plane.requests_to("/tasks/poll") == []


def test_stopped_iteration_makes_no_request_at_all(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    stop_event = threading.Event()
    stop_event.set()
    loop.bind_stop_event(stop_event)
    for index in range(3):
        _enqueue_pending_result(loop, sandbox, task_id=f"task-pending-{index}")

    assert loop.iteration() == "stopped"
    # 含 startup flush 的 result send：signal 之后一条都不能发。
    assert control_plane.records == []
    assert loop.outbox.depth() == 3


def test_stop_during_result_send_stops_further_delivery(sandbox, control_plane):
    """结果回传在途时收到 SIGTERM：已发出的那条允许完成，后续绝不再发。"""
    loop, _ = build_agent(sandbox, control_plane)
    stop_event = threading.Event()
    loop.bind_stop_event(stop_event)
    _enqueue_pending_result(loop, sandbox, task_id="task-first")
    _enqueue_pending_result(loop, sandbox, task_id="task-second")

    def responder(record):
        if record["path"].endswith("/result"):
            stop_event.set()
            return 200, {"status": "accepted"}
        return 200, {"interval_s": 15.0, "tasks": []}

    control_plane.respond = responder
    assert loop.iteration() == "stopped"
    assert [record["path"].rsplit("/", 2)[-2] for record in control_plane.requests_to("/result")] == ["task-first"]
    assert loop.outbox.depth() == 1
    assert loop.outbox.has("task-second")


# -- P2a：丢弃事实必须"先记账后清空"，崩溃不留窗口 --------------------------
def test_outbox_drops_are_marked_before_being_drained(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    overflowed = []
    for index in range(66):  # 64 上限 + 2 个被挤掉
        result = _enqueue_pending_result(loop, sandbox, task_id=f"task-drop-{index:04d}")
        overflowed.extend(loop.outbox.pending_dropped())
    assert loop.outbox.pending_dropped() == ["task-drop-0000", "task-drop-0001"]

    def crash_before_drain():
        raise RuntimeError("simulated crash between mark and drain")

    loop.outbox.drain_dropped = crash_before_drain
    with pytest.raises(RuntimeError):
        loop._apply_outbox_drops()
    # 崩溃前 mark 已经落盘：账本知道这两个结果被丢弃。
    for task_id in ("task-drop-0000", "task-drop-0001"):
        entry = loop.ledger.get(task_id) or {}
        assert entry.get("result_state") == RESULT_DROPPED
    # drain 未执行 → 事实仍在 outbox 文件里，重启后可以重放（不会丢）。
    reloaded = Outbox(str(sandbox.state_paths()["outbox"]))
    reloaded.load()
    assert reloaded.pending_dropped() == ["task-drop-0000", "task-drop-0001"]

    del loop.outbox.drain_dropped
    assert loop._replay_outbox_dropped() == 2
    reloaded = Outbox(str(sandbox.state_paths()["outbox"]))
    reloaded.load()
    assert reloaded.pending_dropped() == []
    # 幂等：再次重放不再产生新事实、也不再记录溢出计数。
    assert loop._replay_outbox_dropped() == 0


# -- P1：SIGTERM 必须打断睡眠（任意时刻 ≤5 s 退出，退出码 0） -----------------
class FakeClockWaiter:
    """把 _stop_waiter 变成假时钟：累计请求秒数，到点置事件并报告已中断。

    不真实睡眠，因此"信号→退出"时延是可断言的确定值。
    """

    def __init__(self, stop_event, interrupt_after):
        self.stop_event = stop_event
        self.interrupt_after = float(interrupt_after)
        self.now = 0.0
        self.signal_at = None

    def __call__(self, event, timeout):
        self.now += float(timeout)
        if self.signal_at is None and self.now >= self.interrupt_after:
            self.signal_at = self.now
            event.set()
        return event.is_set()


def test_sigterm_during_backoff_exits_within_five_seconds(sandbox, control_plane):
    control_plane.respond = lambda record: (503, {"code": "AGENT_SERVER_ERROR"})
    loop, _ = build_agent(sandbox, control_plane)
    loop.state_store.state.consecutive_failures = 5  # 下一轮失败 → 32 s 退避
    loop.state_store.save()
    stop_event = threading.Event()
    clock = FakeClockWaiter(stop_event, interrupt_after=32.0)
    loop._stop_waiter = clock

    # 关键：32 s 退避期间收到 SIGTERM，必须在 ≤5 s 内脱离睡眠并以 0 退出。
    assert loop.run_forever(stop_event=stop_event) == 0
    assert clock.signal_at is not None
    assert clock.now >= 32.0
    assert clock.now - clock.signal_at <= 5.0


def test_sigterm_during_idle_interval_exits_within_five_seconds(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    control_plane.heartbeat_interval_s = 30.0
    loop, _ = build_agent(sandbox, control_plane)
    stop_event = threading.Event()
    clock = FakeClockWaiter(stop_event, interrupt_after=30.0)
    loop._stop_waiter = clock
    notifier = RecordingNotifier()
    loop.notifier = notifier

    assert loop.run_forever(stop_event=stop_event) == 0
    assert clock.signal_at is not None
    assert clock.now - clock.signal_at <= 5.0
    assert notifier.calls[0] == "ready"
    assert notifier.calls[-1] == "stopping"  # STOPPING 在退出前发出，之后不再有 WATCHDOG


def test_sigterm_during_task_reports_interrupted_failed_and_exits_zero(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    control_plane.heartbeat_tasks = [
        make_task(
            node_uid=sandbox.node_uid,
            task_id="task-inflight",
            operation="agent.self.test",
            params={"nonce": protocol.new_nonce()},
        )
    ]
    loop, _ = build_agent(sandbox, control_plane)
    stop_event = threading.Event()
    loop._stop_waiter = FakeClockWaiter(stop_event, interrupt_after=0.0)
    real_handle = loop.executor.handle

    def handle(envelope):
        stop_event.set()  # 模拟 SIGTERM 落在任务执行中
        return real_handle(envelope)

    loop.executor.handle = handle

    assert loop.run_forever(stop_event=stop_event) == 0
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    result = posts[0]["body"]["result"]
    # 只读任务被中断：FAILED（无副作用、可重投），绝不冒充 REFUSED。
    assert result["status"] == RESULT_FAILED
    assert result["code"] == AGENT_EXECUTION_INTERRUPTED
    assert loop.outbox.depth() == 0


def test_stop_event_is_checked_before_starting_remaining_batch(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    control_plane.poll_tasks = [
        make_task(node_uid=sandbox.node_uid, task_id="task-aaaa"),
        make_task(node_uid=sandbox.node_uid, task_id="task-bbbb"),
    ]
    loop, _ = build_agent(sandbox, control_plane)
    stop_event = threading.Event()
    loop.bind_stop_event(stop_event)
    processed = []
    real_process = loop._process_task

    def wrapped(envelope):
        processed.append(envelope.get("task_id"))
        stop_event.set()  # 第一个任务执行期间收到 SIGTERM
        return real_process(envelope)

    loop._process_task = wrapped
    loop.iteration()
    # 第二个任务绝不能被"开始"：没有栅栏，控制面可以安全重投。
    assert processed == ["task-aaaa"]
    assert loop.ledger.get("task-bbbb") is None


def test_sleep_with_jitter_returns_immediately_when_stop_event_is_set(sandbox, control_plane):
    loop, _ = build_agent(sandbox, control_plane)
    stop_event = threading.Event()
    stop_event.set()
    started = time.monotonic()
    assert loop._sleep_with_jitter(300.0, stop_event=stop_event) is True
    assert time.monotonic() - started < 0.5


# -- P2c：批处理中途账本写失败不得把进程打成 exit 5 --------------------------
def test_ledger_write_error_during_batch_degrades_instead_of_crashing(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    control_plane.poll_tasks = [
        make_task(node_uid=sandbox.node_uid, task_id=f"task-mid-{index}") for index in range(4)
    ]
    loop, stream = build_agent(sandbox, control_plane)
    real_begin = loop.ledger.begin
    calls = {"count": 0}

    def begin_then_exhaust(task_id, operation, attempt=1):
        calls["count"] += 1
        if calls["count"] > 1:
            raise LedgerWriteError("ledger capacity exhausted (AGENT_LEDGER_EXHAUSTED)", path=loop.ledger.path)
        return real_begin(task_id, operation, attempt)

    loop.ledger.begin = begin_then_exhaust
    # 旧实现会让 LedgerWriteError 一路抛到 CLI（exit 5，没有 STOPPING/last_stop）。
    assert loop.iteration() == "retry"
    assert loop.state.last_health == "DEGRADED"
    backoff = [record for record in _events(stream) if record["event"] == "backoff"]
    assert backoff and backoff[-1]["detail"]["code"] == AGENT_LEDGER_EXHAUSTED
    # 本批剩余任务一个都没有被 fence：控制面可以安全重投。
    for index in range(1, 4):
        assert loop.ledger.get(f"task-mid-{index}") is None
    # 迭代没有崩：下一轮照常心跳（账本恢复后即恢复 poll）。
    before = len(control_plane.requests_to("/heartbeat"))
    loop.ledger.begin = real_begin
    loop.iteration()
    assert len(control_plane.requests_to("/heartbeat")) == before + 1


# -- P2d：未知 operation 必须在 fence 之前拒绝（否则永久耗尽账本） -------------
def test_unknown_operations_do_not_exhaust_the_ledger(sandbox, control_plane):
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    loop.ledger.save = lambda: None
    for index in range(MAX_LEDGER_ENTRIES + 8):
        loop._process_task(
            make_task(node_uid=sandbox.node_uid, task_id=f"task-unknown-{index:04d}", operation="fleet.do.everything")
        )

    # 旧实现先写 MAY_HAVE_EXECUTED 栅栏再校验 → 每条都是 MAY_MUTATE 等级、不可驱逐，
    # 512 条未知 operation 就能让 is_exhausted() 永久为真、poll 永远停摆。
    assert loop.ledger.is_exhausted() is False
    assert len(loop.ledger.entries) <= MAX_LEDGER_ENTRIES
    assert loop.ledger.begin("task-after-unknown", "node.observe") == "NEW"


# -- P2-1b：非字符串 operation 不许把常驻进程打成 exit 5 ----------------------
@pytest.mark.parametrize("operation", [[], {}, ["node.observe"], None, 7])
def test_non_string_operation_is_refused_before_any_fence(sandbox, control_plane, operation):
    """JSON list/dict 不能进 frozenset 成员判断（TypeError 会穿透 run_forever → exit 5）。"""
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    begun = []
    real_begin = loop.ledger.begin
    loop.ledger.begin = lambda *args, **kwargs: begun.append(args) or real_begin(*args, **kwargs)
    envelope = make_task(node_uid=sandbox.node_uid, task_id="task-non-string-op")
    envelope["operation"] = operation

    loop._process_task(envelope)  # 不得抛 TypeError

    # 没有栅栏：实现从未被调用，控制面可以安全重投（REFUSED 语义）。
    assert begun == []
    entry = loop.ledger.get("task-non-string-op")
    assert entry["state"] == RESULT_REFUSED
    assert entry.get("reconciled") is True
    assert loop.outbox.has("task-non-string-op")


# -- P1-1：账本终态提交失败 → 这条结果永远不发送（一个 task 只能有一个摘要） ---
def test_uncommitted_result_is_never_sent_and_restart_reports_unknown(sandbox, control_plane):
    """rev-core 探针：complete() 失败后 shutdown 仍把真实摘要发出去，重启又补发 UNKNOWN
    → 同一 task 两个摘要、控制面只能 TASK_RESULT_CONFLICT。这里断言结果被撤回、
    零次 POST，重启后恰好一条 UNKNOWN。"""
    control_plane.respond = idle_responder(control_plane)
    control_plane.heartbeat_tasks = [make_task(node_uid=sandbox.node_uid, task_id="task-digest-race")]
    loop, stream = build_agent(sandbox, control_plane)

    def failing_complete(*_args, **_kwargs):
        raise LedgerWriteError("ledger write failed", path=loop.ledger.path)

    loop.ledger.complete = failing_complete
    # 终态提交失败 → 本轮降级（不崩溃），且刚入队的结果必须已被撤回。
    assert loop.iteration() == "retry"
    assert loop.outbox.depth() == 0
    assert loop.outbox.has("task-digest-race") is False
    assert control_plane.requests_to("/result") == []
    assert "result_retracted_before_send" in stream.getvalue()

    # 旧实现在这里会把真实摘要发出去（rev-core 的 digest 6cf0a718）。
    stats = loop.shutdown(reason="test")
    assert stats["sent"] == 0
    assert control_plane.requests_to("/result") == []

    # 重启：reconcile 只补 UNKNOWN 这一个事实，且只发这一个摘要。
    control_plane.heartbeat_tasks = []
    restarted, _ = build_agent(sandbox, control_plane)
    assert restarted.reconcile() == 1
    assert restarted.run_once() == 0
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    body = posts[0]["body"]
    assert body["result"]["status"] == RESULT_UNKNOWN
    assert body["result_digest"] == restarted.ledger.get("task-digest-race")["result_digest"]


# -- P1-2：停机 flush 里 409 重试绝不翻倍预算 ---------------------------------
@pytest.mark.parametrize(
    "cost, expected_calls, expected_retry_timeout",
    [(2.8, 1, None), (1.5, 2, 1.5)],
)
def test_shutdown_flush_never_doubles_the_retry_budget(
    sandbox, control_plane, monkeypatch, cost, expected_calls, expected_retry_timeout
):
    """flush 预算 3 s：第一次 409 花 2.8 s → 剩余 0.2 s < MIN_SEND_WINDOW_S，不重试；
    花 1.5 s → 重试只拿剩余 1.5 s（旧实现会再拿一整份 3 s，最坏 2× 预算）。"""
    monkeypatch.setattr("ghostfleet_agent.loop.SHUTDOWN_FLUSH_BUDGET_S", 3.0)
    loop, _ = build_agent(sandbox, control_plane)
    _enqueue_pending_result(loop, sandbox, task_id="task-retry-budget")
    clock = {"now": 1000.0}
    loop._monotonic = lambda: clock["now"]
    loop.client._monotonic = lambda: clock["now"]

    class SlowConflictTransport:
        def __init__(self):
            self.calls = []

        def post(self, url, *, headers, body, timeout_s):
            self.calls.append(timeout_s)
            clock["now"] += cost
            return TransportResponse(409, json.dumps({"code": NODE_NONCE_REPLAY}).encode())

    transport = SlowConflictTransport()
    loop.client.transport = transport
    stats = loop.shutdown(reason="test")

    assert len(transport.calls) == expected_calls
    assert stats["pending"] == 1
    assert stats["elapsed_s"] <= 3.0 + 0.5
    if expected_retry_timeout is not None:
        assert transport.calls[1] == pytest.approx(expected_retry_timeout)


# -- 发送闸的边界：已收敛并被驱逐的终态（只剩墓碑）仍要照常发送 --------------
def test_evicted_terminal_result_is_still_sendable_via_its_tombstone(sandbox, control_plane):
    """驱逐只留墓碑的已收敛只读终态，其待发结果不能被闸门误撤回。

    闸门只认"现存条目"时，账本一压满就会把合法待发的 result 撤掉：控制面永远收不到
    该 result，而墓碑又只让 begin() 返回 DONE、不会补发 → 该 task 的结果永久丢失。
    """
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    loop.ledger.save = lambda: None
    loop.ledger.save_tombstones = lambda: None
    result = _enqueue_pending_result(loop, sandbox, task_id="task-tombstoned-result")
    digest = digest_of(result)

    # 512 条在途栅栏不可驱逐；第 513 条触发 _prune，能驱逐的只有上面那条已收敛终态。
    for index in range(MAX_LEDGER_ENTRIES):
        loop.ledger.begin(f"task-busy-{index:04d}", "node.observe")
    loop.ledger.complete("task-prune-trigger", RESULT_SUCCEEDED, result_digest="0" * 64, operation="node.observe")
    assert loop.ledger.get("task-tombstoned-result") is None
    assert loop.ledger.tombstones["task-tombstoned-result"]["result_digest"] == digest

    stats = loop.shutdown(reason="test")
    assert stats["sent"] == 1
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    assert posts[0]["body"]["result_digest"] == digest


# -- P1：pre-dispatch 拒绝路径绝不能覆盖/推翻已有的 task 事实 -------------------
def test_known_terminal_task_is_not_refused_again(sandbox, control_plane):
    """同一 task_id 已 SUCCEEDED，再来一次未知 operation：不许写第二个摘要。

    旧实现在 pre-dispatch 分支直接 complete() 覆盖成 REFUSED + 新摘要，控制面会先
    收到 SUCCEEDED、再收到 REFUSED（两个摘要 → TASK_RESULT_CONFLICT）。
    """
    control_plane.respond = idle_responder(control_plane)
    loop, stream = build_agent(sandbox, control_plane)
    task_id = "task-already-succeeded"
    loop._process_task(make_task(node_uid=sandbox.node_uid, task_id=task_id))
    entry = loop.ledger.get(task_id)
    assert entry["state"] == RESULT_SUCCEEDED
    committed = entry["result_digest"]

    loop._process_task(
        make_task(node_uid=sandbox.node_uid, task_id=task_id, operation="fleet.do.everything")
    )
    entry = loop.ledger.get(task_id)
    assert entry["state"] == RESULT_SUCCEEDED
    assert entry["result_digest"] == committed
    assert "task_duplicate_skipped" in stream.getvalue()

    loop.shutdown(reason="test")
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    assert posts[0]["body"]["result"]["status"] == RESULT_SUCCEEDED
    assert posts[0]["body"]["result_digest"] == committed


def test_known_in_flight_task_is_reconciled_not_refused(sandbox, control_plane):
    """begin() 之后又来一次未知 operation：按既有语义对账成 UNKNOWN。

    旧实现会写成 REFUSED，并让发送闸把已排队的 UNKNOWN 撤回 → 可能已执行的任务
    变成"REFUSED 且零结果"。
    """
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    task_id = "task-may-have-executed"
    loop.ledger.begin(task_id, "node.observe")

    loop._process_task(
        make_task(node_uid=sandbox.node_uid, task_id=task_id, operation="fleet.do.everything")
    )
    entry = loop.ledger.get(task_id)
    assert entry["state"] == RESULT_UNKNOWN
    assert entry["reconciled"] is True
    committed = entry["result_digest"]
    assert loop.outbox.has(task_id) is True

    stats = loop.shutdown(reason="test")
    assert stats["sent"] == 1
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    assert posts[0]["body"]["result"]["status"] == RESULT_UNKNOWN
    assert posts[0]["body"]["result_digest"] == committed
    # operation 必须来自账本（begin 时的 node.observe），不能是新 envelope 的 fleet.do.everything：
    # 控制面按 ADR:109 校验 result.operation == 任务 operation，用新 operation 会被 409
    # TASK_OPERATION_MISMATCH 永久丢弃，而账本已是终态、重投会被 inspect() 跳过。
    assert posts[0]["body"]["operation"] == "node.observe"
    assert posts[0]["body"]["result"]["operation"] == "node.observe"
    assert RESULT_REFUSED not in {post["body"]["result"]["status"] for post in posts}


def test_reconciled_unknown_uses_the_operation_recorded_at_fence_time(sandbox, control_plane):
    """合法但不同的 operation 重投：UNKNOWN 仍绑定账本里 begin() 记录的 operation。"""
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    task_id = "task-op-mismatch"
    assert loop.ledger.begin(task_id, "node.observe") == "NEW"

    loop._process_task(
        make_task(node_uid=sandbox.node_uid, task_id=task_id, operation="capability.inspect")
    )
    entry = loop.ledger.get(task_id)
    assert entry["state"] == RESULT_UNKNOWN
    assert entry["operation"] == "node.observe"
    assert entry["reconciled"] is True
    committed = entry["result_digest"]
    body = loop.outbox.get(task_id)["body"]
    assert body["operation"] == "node.observe"
    assert body["result"]["operation"] == "node.observe"
    assert body["result_digest"] == committed

    stats = loop.shutdown(reason="test")
    assert stats["sent"] == 1
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    assert posts[0]["body"]["operation"] == "node.observe"
    assert posts[0]["body"]["result"]["operation"] == "node.observe"
    assert posts[0]["body"]["result"]["status"] == RESULT_UNKNOWN


def test_queued_result_with_a_foreign_operation_is_rebuilt_not_sent(sandbox, control_plane):
    """队列里的 body operation 与账本不一致：撤回重建 UNKNOWN，绝不原样发送。"""
    control_plane.respond = idle_responder(control_plane)
    loop, stream = build_agent(sandbox, control_plane)
    task_id = "task-foreign-queued-op"
    loop.ledger.begin(task_id, "node.observe")
    foreign = make_result(
        task_id=task_id,
        node_uid=sandbox.node_uid,
        operation="capability.inspect",
        status=RESULT_SUCCEEDED,
    )
    loop._enqueue_result(foreign)
    assert loop.outbox.has(task_id) is True

    # 重投同一个 node.observe：begin() 返回 ALREADY_FENCED → 对账必须按账本 operation 重建。
    loop._process_task(make_task(node_uid=sandbox.node_uid, task_id=task_id))
    entry = loop.ledger.get(task_id)
    assert entry["state"] == RESULT_UNKNOWN
    assert entry["operation"] == "node.observe"
    assert entry["reconciled"] is True
    body = loop.outbox.get(task_id)["body"]
    assert body["operation"] == "node.observe"
    assert body["result"]["operation"] == "node.observe"
    assert body["result"]["status"] == RESULT_UNKNOWN
    assert body["result_digest"] == entry["result_digest"]

    stats = loop.shutdown(reason="test")
    assert stats["sent"] == 1
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    assert posts[0]["body"]["operation"] == "node.observe"
    assert posts[0]["body"]["result"]["operation"] == "node.observe"
    assert "queued_result_not_sendable" in stream.getvalue()


def test_tombstoned_task_is_skipped_not_refused(sandbox, control_plane):
    """只剩墓碑（已收敛、已驱逐）的 task_id 再来未知 operation：跳过，不发送。"""
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    loop.ledger.save = lambda: None
    loop.ledger.save_tombstones = lambda: None
    task_id = "task-tombstone-only"
    loop.ledger.begin(task_id, "node.observe")
    loop.ledger.complete(task_id, RESULT_SUCCEEDED, result_digest="a" * 64, operation="node.observe")
    for index in range(MAX_LEDGER_ENTRIES):
        loop.ledger.begin(f"task-busy-{index:04d}", "node.observe")
    loop.ledger.complete("task-prune-trigger", RESULT_SUCCEEDED, result_digest="0" * 64, operation="node.observe")
    assert loop.ledger.get(task_id) is None
    assert loop.ledger.tombstones[task_id]["result_digest"] == "a" * 64

    loop._process_task(
        make_task(node_uid=sandbox.node_uid, task_id=task_id, operation="fleet.do.everything")
    )
    assert loop.outbox.has(task_id) is False
    assert loop.ledger.tombstones[task_id]["result_digest"] == "a" * 64
    stats = loop.shutdown(reason="test")
    assert stats["sent"] == 0
    assert control_plane.requests_to("/result") == []


def test_first_unknown_operation_is_still_refused(sandbox, control_plane):
    """从未见过的 task_id + 未知 operation：仍然按口径拒绝一次（建终态条目）。"""
    control_plane.respond = idle_responder(control_plane)
    loop, _ = build_agent(sandbox, control_plane)
    task_id = "task-fresh-unknown-op"
    loop._process_task(
        make_task(node_uid=sandbox.node_uid, task_id=task_id, operation="fleet.do.everything")
    )
    entry = loop.ledger.get(task_id)
    assert entry["state"] == RESULT_REFUSED
    assert entry["reconciled"] is True
    assert loop.outbox.has(task_id) is True

    stats = loop.shutdown(reason="test")
    assert stats["sent"] == 1
    posts = control_plane.requests_to("/result")
    assert len(posts) == 1
    assert posts[0]["body"]["result"]["status"] == RESULT_REFUSED
    assert posts[0]["body"]["result_digest"] == entry["result_digest"]
