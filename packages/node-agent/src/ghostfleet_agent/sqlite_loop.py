"""Thin SQLite adapter for the existing network/lifecycle orchestration.

不复制网络、systemd、信号或任务实现。两个 view 只查询同一 TaskRepository；
它们不写 ledger/outbox 文件。结果终态与正文只由 complete() 同事务保存。
"""
from __future__ import annotations

import time
from types import SimpleNamespace

from .loop import AgentLoop, SHUTDOWN_FLUSH_BUDGET_S
from .outbox import FlushReport, MIN_SEND_WINDOW_S
from .protocol import (
    AGENT_EXECUTION_UNKNOWN, AGENT_INTERNAL_ERROR, OUTCOME_AUTH_FATAL,
    OUTCOME_OK, OUTCOME_RATE_LIMITED, OUTCOME_REJECTED,
    ProtocolError, RESULT_UNKNOWN, TASK_ID_RE, make_result,
)
from .repository import TaskRepository, RepositoryError, Conflict, Capacity, FENCED


class _LedgerView:
    """Only the two read projections needed by existing iteration()."""
    def __init__(self, repository):
        self.repository = repository

    def is_exhausted(self):
        return self.repository.capacity_used() >= self.repository.max_pending

    @property
    def entries(self):
        return [row[0] for row in self.repository.db.execute('SELECT task_id FROM tasks')]


class _OutboxView:
    def __init__(self, repository):
        self.repository = repository

    def depth(self):
        return self.repository.db.execute(
            "SELECT count(*) FROM tasks WHERE node_uid=? AND delivery_state='PENDING'",
            (self.repository.node_uid,),
        ).fetchone()[0]

    def flush(self, send, *, stop_event=None, deadline=None, clock=time.monotonic):
        """No transaction is held over HTTP. Only explicit acceptance removes body."""
        report = FlushReport()
        for row in self.repository.pending():
            if stop_event is not None and stop_event.is_set():
                report.stopped = True
                break
            remaining = None if deadline is None else deadline - clock()
            if remaining is not None and remaining < MIN_SEND_WINDOW_S:
                report.deadline_hit = True
                break
            # Persist attempt before network; storage errors stop the loop.
            self.repository.record_attempt(row['task_id'])
            if stop_event is not None and stop_event.is_set():
                report.stopped = True
                break
            remaining = None if deadline is None else deadline - clock()
            if remaining is not None and remaining < MIN_SEND_WINDOW_S:
                report.deadline_hit = True
                break
            outcome = send({'task_id': row['task_id'], 'body': row['body'],
                            'digest': row['result_digest']}, timeout_s=remaining)
            if outcome.kind == OUTCOME_OK:
                self.repository.ack(row['task_id'], row['result_digest'])
                report.sent.append(row['task_id'])
            elif outcome.kind == OUTCOME_REJECTED:
                self.repository.quarantine(row['task_id'], str(outcome.code or 'upstream_rejected')[:256])
                report.rejected.append(row['task_id'])
            else:
                report.stop_outcome = outcome.kind
                report.stop_code = outcome.code
                report.fatal = outcome.kind == OUTCOME_AUTH_FATAL
                retry_after = getattr(outcome, 'retry_after_s', None)
                if outcome.kind == OUTCOME_RATE_LIMITED and isinstance(retry_after, (int, float)):
                    report.retry_after_s = max(0.0, min(float(retry_after), 3600.0))
                break
        report.remaining = self.depth()
        return report


class SqliteAgentLoop(AgentLoop):
    """Reuse the reviewed observer/client/systemd loop, replacing persistence only.

    Legacy AgentLoop remains available for historical tests during this staged
    change. The production factory selects only this class after integration;
    there is no runtime backend switch and no dual-write path.
    """

    def __init__(self, *, repository: TaskRepository, **kwargs):
        self.repository = repository
        super().__init__(ledger=_LedgerView(repository), outbox=_OutboxView(repository), **kwargs)

    def _replay_outbox_dropped(self):
        # There is no automatic overflow drop in the SQLite repository.
        return 0

    def reconcile(self):
        quarantined = self.repository.quarantine_foreign()
        if quarantined:
            self.logger.warning('foreign_identity_quarantined', count=quarantined)
        return self.repository.recover(lambda row: make_result(
            task_id=row['task_id'], node_uid=row['node_uid'], operation=row['operation'],
            status=RESULT_UNKNOWN, code=AGENT_EXECUTION_UNKNOWN,
        ))

    def _process_task(self, envelope):
        if not isinstance(envelope, dict):
            self.logger.warning('task_envelope_dropped', reason='not-an-object')
            return
        task_id = envelope.get('task_id')
        if not isinstance(task_id, str) or not TASK_ID_RE.fullmatch(task_id):
            self.logger.warning('task_envelope_dropped', reason='task_id-not-protocol-safe')
            return
        operation = envelope.get('operation')
        operation = operation if isinstance(operation, str) and operation else 'unknown'
        attempt = envelope.get('attempt')
        attempt = attempt if type(attempt) is int and attempt > 0 else 1
        try:
            outcome = self.repository.begin(task_id, operation, attempt)
        except Capacity:
            self.logger.warning('task_backpressure', task_id=task_id)
            return
        except Conflict:
            self.logger.error('task_identity_conflict', task_id=task_id)
            return
        if outcome != 'NEW':
            if outcome == 'ALREADY_FENCED':
                self.reconcile()
            self.logger.info('task_duplicate_skipped', task_id=task_id, state=outcome)
            return
        self._emit('task_start', {'task_id': task_id, 'operation': operation})
        result = self.executor.handle(envelope)
        self.repository.complete(result)
        self.state_store.record_task_executed()
        self._emit('task_result', {'task_id': task_id, 'operation': operation,
                                  'status': result['status'], 'code': result.get('code')})

    def _send_outbox_item(self, item, timeout_s=None):
        # pending() validated body/digest/identity against one atomic row already.
        try:
            response = self.client.send_result_body(
                lambda nonce: self._envelope(nonce, item['body']), item['task_id'],
                retry_hook=self._retry_hook, timeout_s=timeout_s,
            )
        except ProtocolError as error:
            return SimpleNamespace(kind=OUTCOME_REJECTED, code=error.code)
        return SimpleNamespace(kind=response.kind, code=response.code,
                               retry_after_s=getattr(response, 'retry_after_s', None))

    def _storage_fatal(self, error):
        # Never flush a poisoned store; only supervisor restart may reopen truth.
        self._stop_watchdog()
        self.notifier.stopping()
        self.logger.error('task_storage_fatal', code=error.code)
        return 5

    def run_forever(self, **kwargs):
        try:
            return super().run_forever(**kwargs)
        except RepositoryError as error:
            return self._storage_fatal(error)
        finally:
            self.repository.close()

    def run_once(self):
        try:
            return super().run_once()
        except RepositoryError as error:
            return self._storage_fatal(error)
        finally:
            self.repository.close()
