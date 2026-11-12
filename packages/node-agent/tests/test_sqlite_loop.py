"""Real loop/client/observer/executor with SQLite; no second daemon or fake SQL.

Tests use the existing local HTTP fixture. No production identity, node, service
or provider is involved. Network delivery is intentionally at-least-once.
"""
import io
import threading
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
    restarted = build_loop(config, TEST_TOKEN, 'node-11111111-1111-4111-8111-111111111111')
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
