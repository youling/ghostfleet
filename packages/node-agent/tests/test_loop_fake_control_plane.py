"""端到端：本地假控制面 + 真实 urllib 传输，断言线上形态与幂等语义。

覆盖合同要求：请求头（Bearer / node-uid / agent-version）与请求体字段
（schema / node_uid / nonce / sent_at / boot_id / seq）；回放一条任务让 agent
执行并回传结果；同 task_id 同摘要的重复回传是幂等形态，异摘要才是冲突。
"""
from __future__ import annotations

import io
import json
import time
from types import SimpleNamespace

import pytest

from agent_test_support import TEST_AGENT_VERSION, TEST_TOKEN, AgentSandbox, make_task
from ghostfleet_agent import protocol
from ghostfleet_agent.cli import build_loop, load_node_uid, load_token
from ghostfleet_agent.config import load_config
from ghostfleet_agent.ledger import MAX_LEDGER_ENTRIES
from ghostfleet_agent.loop import WATCHDOG_INTERVAL_S, WatchdogThread
from ghostfleet_agent.logging import Logger, clear_secrets
from ghostfleet_agent.outbox import Outbox
from ghostfleet_agent.protocol import (
    AGENT_EXECUTION_UNKNOWN,
    AGENT_NETWORK_ERROR,
    NODE_BOOT_ID_CAPACITY_REACHED,
    NODE_RATE_LIMITED,
    OUTCOME_NETWORK_ERROR,
    AGENT_LEDGER_EXHAUSTED,
    TASK_OPERATION_MISMATCH,
    TASK_RESULT_SCHEMA_UNSUPPORTED,
    RESULT_STATUSES,
    RESULT_SUCCEEDED,
    RESULT_UNKNOWN,
    SCHEMA_AGENT,
    SCHEMA_TASK,
    TASK_RESULT_CONFLICT,
    digest_of,
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
    assert loop.run_once() == 0
    paths = [record["path"] for record in control_plane.records]
    assert paths[0].endswith("/tasks/task-pending/result")
    assert any(path.endswith("/heartbeat") for path in paths)


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

