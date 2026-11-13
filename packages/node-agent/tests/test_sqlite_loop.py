"""Real loop/client/observer/executor with SQLite; no second daemon or fake SQL.

Tests use the existing local HTTP fixture. No production identity, node, service
or provider is involved. Network delivery is intentionally at-least-once.
"""
import io
import threading
import uuid
from types import SimpleNamespace

import pytest

from agent_test_support import AgentSandbox, TEST_TOKEN, make_task
from ghostfleet_agent.config import load_config
from ghostfleet_agent.logging import Logger, clear_secrets
from ghostfleet_agent.protocol import (
    OUTCOME_NETWORK_ERROR, OUTCOME_OK, OUTCOME_REJECTED, make_result, digest_of,
)
from ghostfleet_agent.repository import TaskRepository, RepositoryError
from ghostfleet_agent.sqlite_loop import build_loop


@pytest.fixture
def candidate(tmp_path, control_plane):
    sandbox = AgentSandbox(tmp_path / 'agent')
    config = load_config(str(sandbox.write_config(control_plane.url)))
    log = io.StringIO()
    loop = build_loop(config, TEST_TOKEN, sandbox.node_uid, logger=Logger(log))
    loop._sleep = lambda seconds: None
    loop._jitter = lambda ratio: 0.0
    try:
        yield sandbox, config, loop, log
    finally:
        loop.repository.close()
        clear_secrets()


def pending(loop, task_id='task-durable-1'):
    loop.repository.begin(task_id, 'agent.self.test')
    value = make_result(task_id=task_id, node_uid=loop.node_uid,
                        operation='agent.self.test', status='SUCCEEDED', data={'ok': True})
    loop.repository.complete(value)
    return value


def test_factory_uses_one_task_database(candidate):
    sandbox, _, loop, _ = candidate
    assert (sandbox.state_dir / 'tasks.db').is_file()
    for name in ('ledger.json', 'outbox.json', 'tombstones.json', 'tasks', 'archive'):
        assert not (sandbox.state_dir / name).exists()
    assert loop.repository.db.execute('PRAGMA synchronous').fetchone()[0] == 3


def test_actual_http_readonly_work_then_ack(candidate, control_plane):
    sandbox, _, loop, _ = candidate
    task = make_task(node_uid=sandbox.node_uid, task_id='task-work-1', operation='agent.self.test')
    control_plane.poll_tasks = [task]
    assert loop.iteration() == 'ok'
    sent = control_plane.requests_to('/result')
    assert len(sent) == 1
    body = sent[0]['body']
    assert body['result']['status'] == 'SUCCEEDED'
    assert body['result_digest'] == digest_of(body['result'])
    row = loop.repository.get(task['task_id'])
    assert row['delivery_state'] == 'ACKED' and row['body'] is None
    # Repeated poll envelope cannot execute or produce another terminal result.
    assert loop.iteration() == 'ok'
    assert len(control_plane.requests_to('/result')) == 1
    assert loop.state.tasks_executed == 1


def test_duplicate_id_with_other_operation_never_executes(candidate, control_plane):
    sandbox, _, loop, log = candidate
    control_plane.poll_tasks = [make_task(node_uid=sandbox.node_uid, task_id='task-collision', operation='agent.self.test')]
    loop.iteration()
    control_plane.poll_tasks = [make_task(node_uid=sandbox.node_uid, task_id='task-collision', operation='node.observe')]
    loop.iteration()
    assert loop.state.tasks_executed == 1
    assert len(control_plane.requests_to('/result')) == 1
    assert 'task_identity_conflict' in log.getvalue()


def test_unknown_operation_is_refused_and_idempotent(candidate, control_plane):
    sandbox, _, loop, _ = candidate
    control_plane.poll_tasks = [make_task(node_uid=sandbox.node_uid, task_id='task-forbidden', operation='arbitrary.shell')]
    loop.iteration(); loop.iteration()
    row = loop.repository.get('task-forbidden')
    assert row['execution_state'] == 'REFUSED'
    assert row['delivery_state'] == 'ACKED'
    assert len(control_plane.requests_to('/result')) == 1


def test_network_failure_preserves_original_body(candidate):
    _, _, loop, _ = candidate
    pending(loop)
    original = loop.repository.get('task-durable-1')['result_body']
    report = loop.outbox.flush(lambda item, timeout_s=None: SimpleNamespace(kind=OUTCOME_NETWORK_ERROR, code='NETWORK'))
    assert report.remaining == 1
    assert loop.repository.get('task-durable-1')['result_body'] == original
    assert loop.repository.get('task-durable-1')['delivery_attempts'] == 1


def test_remote_acceptance_lost_response_same_digest_resends_then_ack(candidate):
    _, _, loop, _ = candidate
    pending(loop)
    accepted = {}
    calls = []
    def server(item, timeout_s=None):
        task = item['task_id']; sha = item['body']['result_digest']; calls.append(sha)
        if task not in accepted:
            accepted[task] = sha
            return SimpleNamespace(kind=OUTCOME_NETWORK_ERROR, code='RESPONSE_LOST')
        assert accepted[task] == sha
        return SimpleNamespace(kind=OUTCOME_OK, code=None)
    assert loop.outbox.flush(server).remaining == 1
    assert loop.outbox.flush(server).remaining == 0
    assert len(calls) == 2 and calls[0] == calls[1]
    assert loop.repository.get('task-durable-1')['delivery_state'] == 'ACKED'


def test_permanent_rejection_quarantines_original_bytes(candidate):
    _, _, loop, _ = candidate
    pending(loop); original = loop.repository.get('task-durable-1')
    report = loop.outbox.flush(lambda item, timeout_s=None: SimpleNamespace(kind=OUTCOME_REJECTED, code='TASK_RESULT_CONFLICT'))
    assert report.remaining == 0 and report.rejected == ['task-durable-1']
    row = loop.repository.get('task-durable-1')
    assert row['delivery_state'] == 'QUARANTINED'
    assert row['result_body'] == original['result_body']
    assert row['result_digest'] == original['result_digest']


def test_restart_reconciles_fence_without_reexecution(candidate, control_plane):
    sandbox, config, loop, _ = candidate
    loop.repository.begin('task-crash', 'agent.self.test')
    loop.repository.close()
    restarted = build_loop(config, TEST_TOKEN, sandbox.node_uid)
    try:
        assert restarted.reconcile() == 1
        assert restarted.repository.get('task-crash')['execution_state'] == 'UNKNOWN'
        restarted.iteration()
        assert len(control_plane.requests_to('/result')) == 1
        assert control_plane.requests_to('/result')[0]['body']['result']['status'] == 'UNKNOWN'
        assert restarted.state.tasks_executed == 0
    finally:
        restarted.repository.close()


def test_full_pending_queue_keeps_heartbeat_but_skips_poll(candidate, control_plane):
    _, _, loop, _ = candidate
    loop.repository.max_pending = 1
    pending(loop)
    loop._send_outbox_item = lambda item, timeout_s=None: SimpleNamespace(kind=OUTCOME_NETWORK_ERROR, code='NETWORK')
    assert loop.iteration() == 'retry'
    assert len(control_plane.requests_to('/heartbeat')) == 1
    assert control_plane.requests_to('/tasks/poll') == []
    assert loop.outbox.depth() == 1


def test_stop_before_flush_leaves_body_and_sends_nothing(candidate):
    _, _, loop, _ = candidate
    pending(loop)
    stopped = threading.Event(); stopped.set(); calls = []
    report = loop.outbox.flush(lambda *a, **kw: calls.append(a), stop_event=stopped)
    assert report.stopped and report.remaining == 1 and not calls


def test_actual_result_body_from_prior_node_never_sent(candidate, control_plane):
    sandbox, config, loop, _ = candidate
    pending(loop); old = loop.repository.get('task-durable-1'); loop.repository.close()
    restarted = build_loop(config, TEST_TOKEN, 'node-' + str(uuid.UUID(int=1, version=4)))
    try:
        assert restarted.reconcile() == 0
        row = restarted.repository.get('task-durable-1')
        assert row['delivery_state'] == 'QUARANTINED'
        assert row['node_uid'] == sandbox.node_uid and row['result_body'] == old['result_body']
        assert restarted.repository.pending() == []
    finally:
        restarted.repository.close()
    assert control_plane.requests_to('/result') == []


def test_commit_failure_stops_before_any_result_send(candidate, control_plane):
    sandbox, _, loop, _ = candidate
    control_plane.poll_tasks = [make_task(node_uid=sandbox.node_uid, task_id='task-storage-failure', operation='agent.self.test')]
    count = {'commits': 0}
    def fault(point):
        if point == 'before_commit':
            count['commits'] += 1
            if count['commits'] == 2: raise OSError('synthetic result commit failure')
    loop.repository._fault = fault
    stopping = []
    loop.notifier.stopping = lambda: stopping.append(True)
    assert loop.run_once() == 5
    assert stopping == [True]
    assert control_plane.requests_to('/result') == []
    reopened = TaskRepository(sandbox.state_dir / 'tasks.db', sandbox.node_uid)
    try:
        assert reopened.get('task-storage-failure')['execution_state'] == 'MAY_HAVE_EXECUTED'
        assert reopened.get('task-storage-failure')['body'] is None
    finally:
        reopened.close()


@pytest.mark.parametrize("operation", [[], {}, None, 7])
def test_malformed_operation_is_refused_without_execution(candidate, operation):
    sandbox, _, loop, _ = candidate
    task=make_task(node_uid=sandbox.node_uid, task_id="task-malformed", operation="node.observe")
    task["operation"]=operation
    calls=[]
    real=loop.executor.handle
    loop.executor.handle=lambda envelope: calls.append(envelope) or real(envelope)
    loop._process_task(task)
    row=loop.repository.get("task-malformed")
    assert row["execution_state"] == "REFUSED"
    assert row["delivery_state"] == "PENDING"
    before=row["result_digest"]
    loop._process_task(task)
    assert len(calls) == 1
    assert loop.repository.get("task-malformed")["result_digest"] == before


def test_pending_result_precedes_heartbeat_and_poll(candidate, control_plane):
    _, _, loop, _ = candidate
    pending(loop)
    loop.iteration()
    assert control_plane.records[0]["path"].endswith("/result")
    assert any(r["path"].endswith("/heartbeat") for r in control_plane.records)


def test_existing_committed_body_survives_restart_without_unknown(candidate, control_plane):
    sandbox, config, loop, _ = candidate
    pending(loop); original=loop.repository.get("task-durable-1")["result_body"]
    loop.repository.close()
    restarted=build_loop(config, TEST_TOKEN, sandbox.node_uid)
    try:
        assert restarted.reconcile() == 0
        assert restarted.repository.get("task-durable-1")["result_body"] == original
        restarted.iteration()
        assert control_plane.requests_to("/result")[0]["body"]["result"]["status"] == "SUCCEEDED"
    finally: restarted.repository.close()


def test_fenced_task_redelivery_with_changed_operation_cannot_rewrite_identity(candidate):
    sandbox, _, loop, _ = candidate
    loop.repository.begin("task-fenced", "node.observe")
    loop._process_task(make_task(node_uid=sandbox.node_uid, task_id="task-fenced", operation="agent.self.test"))
    row=loop.repository.get("task-fenced")
    assert row["operation"] == "node.observe" and row["execution_state"] == "MAY_HAVE_EXECUTED"
    loop.reconcile()
    row=loop.repository.get("task-fenced")
    assert row["execution_state"] == "UNKNOWN"
    assert row["body"]["operation"] == "node.observe"
    assert loop.state.tasks_executed == 0


def test_backpressure_reopens_when_pending_is_acknowledged(candidate, control_plane):
    sandbox, _, loop, _ = candidate
    loop.repository.max_pending=1
    pending(loop)
    original=loop._send_outbox_item
    loop._send_outbox_item=lambda *a,**k: SimpleNamespace(kind=OUTCOME_NETWORK_ERROR,code="NETWORK")
    loop.iteration()
    assert control_plane.requests_to("/tasks/poll") == []
    loop._send_outbox_item=original
    control_plane.poll_tasks=[make_task(node_uid=sandbox.node_uid, task_id="task-after-capacity", operation="agent.self.test")]
    loop.iteration()
    assert loop.repository.get("task-after-capacity")["delivery_state"] == "ACKED"


def test_ack_commit_failure_retains_result_for_idempotent_retransmission(candidate):
    _, _, loop, _ = candidate
    pending(loop); sha=loop.repository.get("task-durable-1")["result_digest"]
    accepted=[]
    def accepted_then_fail_local(item, timeout_s=None):
        accepted.append(item["body"]["result_digest"])
        loop.repository._fault=lambda point: (_ for _ in ()).throw(OSError("injected")) if point=="before_commit" else None
        return SimpleNamespace(kind=OUTCOME_OK,code=None)
    with pytest.raises(RepositoryError): loop.outbox.flush(accepted_then_fail_local)
    replacement=TaskRepository(loop.repository.path,loop.node_uid)
    try:
        row=replacement.get("task-durable-1")
        assert row["delivery_state"] == "PENDING" and row["result_digest"] == sha
        assert accepted == [sha]
        replacement.ack("task-durable-1",sha)
        assert replacement.get("task-durable-1")["body"] is None
    finally: replacement.close()


def test_quarantine_write_failure_never_discards_body(candidate):
    _, _, loop, _ = candidate
    pending(loop); body=loop.repository.get("task-durable-1")["result_body"]
    def reject_then_fail(item, timeout_s=None):
        loop.repository._fault=lambda point: (_ for _ in ()).throw(OSError("injected")) if point=="before_commit" else None
        return SimpleNamespace(kind=OUTCOME_REJECTED,code="TASK_RESULT_CONFLICT")
    with pytest.raises(RepositoryError): loop.outbox.flush(reject_then_fail)
    replacement=TaskRepository(loop.repository.path,loop.node_uid)
    try:
        row=replacement.get("task-durable-1")
        assert row["delivery_state"] == "PENDING" and row["result_body"] == body
    finally: replacement.close()


# Explicit delivery parity for the retired JSON queue; never drop old coverage silently.
def test_sqlite_auth_failure_keeps_all_bodies_and_stops_batch(candidate):
    from ghostfleet_agent.protocol import OUTCOME_AUTH_FATAL
    _, _, loop, _ = candidate
    pending(loop, "task-first"); pending(loop, "task-second")
    original = {r["task_id"]: r["result_body"] for r in loop.repository.pending()}
    calls = []
    def refuse(item, timeout_s=None):
        calls.append(item["task_id"])
        return SimpleNamespace(kind=OUTCOME_AUTH_FATAL, code="NODE_TOKEN_REVOKED")
    report = loop.outbox.flush(refuse)
    assert report.fatal and report.remaining == 2
    assert calls == ["task-first"]
    assert {r["task_id"]: r["result_body"] for r in loop.repository.pending()} == original


def test_sqlite_flush_acknowledges_in_stable_order(candidate):
    _, _, loop, _ = candidate
    pending(loop, "task-order-1"); pending(loop, "task-order-2")
    calls = []
    def accept(item, timeout_s=None):
        calls.append(item["task_id"])
        return SimpleNamespace(kind=OUTCOME_OK, code=None)
    report = loop.outbox.flush(accept)
    assert calls == ["task-order-1", "task-order-2"]
    assert report.sent == calls and report.remaining == 0
    assert all(loop.repository.get(task)["body"] is None for task in calls)


def test_sqlite_flush_budget_counts_commit_time(candidate):
    _, _, loop, _ = candidate
    pending(loop)
    now = [10.0]; calls = []
    actual = loop.repository.record_attempt
    def slow_commit(task_id):
        actual(task_id)
        now[0] += 0.8
    loop.repository.record_attempt = slow_commit
    report = loop.outbox.flush(lambda *a, **k: calls.append(a), deadline=11.0, clock=lambda: now[0])
    assert report.deadline_hit and calls == [] and report.remaining == 1
    assert loop.repository.get("task-durable-1")["body"] is not None


def test_sqlite_stop_after_first_send_preserves_second_result(candidate):
    _, _, loop, _ = candidate
    pending(loop, "task-stop-1"); pending(loop, "task-stop-2")
    stop = threading.Event(); calls = []
    def send(item, timeout_s=None):
        calls.append(item["task_id"]); stop.set()
        return SimpleNamespace(kind=OUTCOME_OK, code=None)
    report = loop.outbox.flush(send, stop_event=stop)
    assert calls == ["task-stop-1"] and report.stopped and report.remaining == 1
    assert loop.repository.get("task-stop-1")["delivery_state"] == "ACKED"
    assert loop.repository.get("task-stop-2")["body"] is not None


def test_sqlite_expired_deadline_does_not_start_delivery(candidate):
    _, _, loop, _ = candidate
    pending(loop); calls = []
    report = loop.outbox.flush(lambda *a, **k: calls.append(a), deadline=10.1, clock=lambda: 10.0)
    assert report.deadline_hit and report.remaining == 1 and calls == []
    assert loop.repository.get("task-durable-1")["delivery_attempts"] == 0


def test_sqlite_fence_write_failure_prevents_execution(candidate):
    sandbox, _, loop, _ = candidate
    calls = []
    loop.executor.handle = lambda task: calls.append(task)
    def fail(point):
        if point == "before_commit":
            raise OSError("synthetic fence I/O failure")
    loop.repository._fault = fail
    task = make_task(node_uid=sandbox.node_uid, task_id="task-never-executed", operation="agent.self.test")
    with pytest.raises(RepositoryError):
        loop._process_task(task)
    assert calls == []
    reopened = TaskRepository(loop.repository.path, sandbox.node_uid)
    try:
        assert reopened.get("task-never-executed") is None
    finally:
        reopened.close()


def test_sqlite_oversize_result_preserves_durable_fence(candidate):
    from ghostfleet_agent.repository import Conflict, MAX_BODY_BYTES
    _, _, loop, _ = candidate
    task = "task-oversized"
    loop.repository.begin(task, "agent.self.test")
    value = make_result(task_id=task, node_uid=loop.node_uid, operation="agent.self.test",
                        status="SUCCEEDED", data={"blob": "x" * (MAX_BODY_BYTES + 1)})
    with pytest.raises(Conflict):
        loop.repository.complete(value)
    row = loop.repository.get(task)
    assert row["execution_state"] == "MAY_HAVE_EXECUTED" and row["body"] is None
    assert row["delivery_state"] == "NONE"


@pytest.mark.parametrize("task_id", [None, [], {}, ""])
def test_sqlite_missing_task_identity_is_refused_without_write(candidate, task_id):
    from ghostfleet_agent.repository import Conflict
    _, _, loop, _ = candidate
    before = loop.repository.counts()
    with pytest.raises(Conflict):
        loop.repository.begin(task_id, "agent.self.test")
    assert loop.repository.counts() == before


@pytest.mark.parametrize("status", ["SUCCEEDED", "REFUSED", "FAILED", "UNKNOWN"])
def test_sqlite_all_terminal_outcomes_commit_body_and_pending(candidate, status):
    _, _, loop, _ = candidate
    task = "task-terminal-outcome"
    loop.repository.begin(task, "agent.self.test")
    value = make_result(task_id=task, node_uid=loop.node_uid, operation="agent.self.test", status=status)
    assert loop.repository.complete(value) == "PENDING"
    row = loop.repository.get(task)
    assert row["execution_state"] == status and row["delivery_state"] == "PENDING"
    assert row["body"]["result"] == value and row["result_digest"] == digest_of(value)
