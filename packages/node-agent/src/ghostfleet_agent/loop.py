"""常驻工作循环：observe → drift → heartbeat → poll → 栅栏执行 → flush → 喂狗。

ADR §6/§7/§8 的编排层：
- 每轮最多 2 个 heartbeat 任务 + 4 个 poll 任务；
- 每个任务先写 ledger 栅栏（MAY_HAVE_EXECUTED）再执行，结果入 outbox；
- 失败按 1→2→4…300 s 指数退避，控制面不可达时不退出、不丢已执行事实；
- SIGTERM/SIGINT 由 CLI 设置 stop_event：停止取新任务 → ≤10 s flush → 写 last_stop
  → 发送 STOPPING=1 → 退出 0；watchdog 每轮喂一次。
"""
from __future__ import annotations

import random
import time
from types import SimpleNamespace

from .logging import get_logger
from .observe import HEALTH_DEGRADED, compute_drift
from .outbox import CONFLICT, DUPLICATE, TOO_LARGE
from .protocol import (
    AGENT_EXECUTION_UNKNOWN,
    AGENT_LEDGER_EXHAUSTED,
    AGENT_INTERNAL_ERROR,
    OUTCOME_AUTH_FATAL,
    OUTCOME_INVALID_RESPONSE,
    OUTCOME_NETWORK_ERROR,
    OUTCOME_NONCE_REPLAY,
    OUTCOME_OK,
    OUTCOME_RATE_LIMITED,
    OUTCOME_REJECTED,
    OUTCOME_SERVER_ERROR,
    OUTCOME_TRANSPORT_REFUSED,
    RESULT_STATUSES,
    RESULT_UNKNOWN,
    TASK_ID_RE,
    ProtocolError,
    digest_of,
    make_result,
)
from .tasks import MAX_TASKS_PER_POLL, TaskExecutor, validate_envelope, TaskRefused
from . import protocol as protocol_mod

BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 300.0
RETRY_AFTER_CAP_S = 3600.0
SHUTDOWN_FLUSH_BUDGET_S = 30.0
SHUTDOWN_FLUSH_ATTEMPTS = 30
MIN_SLEEP_CHUNK_S = 0.2
MAX_SLEEP_CHUNK_S = 30.0  # WatchdogSec=60：任何睡眠都必须切成 ≤30 s 的块并每块喂狗


class AuthFatalError(Exception):
    """控制面明确拒绝该节点凭据：停止上报（ADR §9 吊销语义）。"""

    def __init__(self, code: str | None) -> None:
        self.code = code or protocol_mod.NODE_AUTH_INVALID
        super().__init__(self.code)


class AgentLoop:
    """可注入时间/睡眠/抖动的循环，便于确定性测试。"""

    def __init__(
        self,
        *,
        config,
        node_uid: str,
        token: str,
        state_store,
        ledger,
        outbox,
        observer,
        executor: TaskExecutor,
        client,
        notifier,
        logger=None,
        sleep=None,
        monotonic=None,
        jitter=None,
        clock=None,
    ) -> None:
        self.config = config
        self.node_uid = node_uid
        self._token = token
        self.state_store = state_store
        self.ledger = ledger
        self.outbox = outbox
        self.observer = observer
        self.executor = executor
        self.client = client
        self.notifier = notifier
        self.logger = logger or get_logger()
        self._sleep = sleep or time.sleep
        self._monotonic = monotonic or time.monotonic
        self._jitter = jitter or (lambda ratio: random.uniform(-ratio, ratio))
        self._clock = clock
        self._interval_s = float(config.interval_s)
        self._outcome_ok = OUTCOME_OK
        self._retry_after_s = 0.0

    # -- 事件日志（合同 E：固定字段，绝不写 nonce/params/token） -------------
    def _emit(self, event: str, detail=None) -> None:
        try:
            seq = int(self.state.seq)
        except (AttributeError, TypeError, ValueError):
            seq = 0
        self.logger.event(event, seq, detail)

    def _retry_hook(self, kind: str) -> None:
        """409 分派：NODE_BOOT_REPLAY 换新 boot_id+seq；nonce/seq 由信封自然换新。"""
        if kind == "BOOT_REPLAY":
            self.state_store.rotate_boot_id()

    # -- 状态 ---------------------------------------------------------------
    @property
    def state(self):
        return self.state_store.state

    def _next_seq(self) -> int:
        return self.state_store.next_seq()

    def _envelope(self, nonce: str, extra: dict) -> dict:
        from .client import build_envelope

        return build_envelope(
            node_uid=self.node_uid,
            boot_id=self.state.boot_id,
            seq=self._next_seq(),
            nonce=nonce,
            extra=extra,
        )

    # -- 启动对账 -----------------------------------------------------------
    def reconcile(self) -> int:
        """启动时对"已栅栏、未收敛"的 task 只补事实，不重跑（ADR §7 / D5）。"""
        task_ids = self.ledger.pending_reconcile()
        for task_id in task_ids:
            entry = self.ledger.get(task_id) or {}
            self._reconcile_task(task_id, entry.get("operation"))
        if task_ids:
            self.logger.info("startup_reconcile", tasks=len(task_ids))
        return len(task_ids)

    def _reconcile_task(self, task_id: str, operation) -> None:
        existing = self.outbox.get(task_id)
        if existing is not None:
            body = existing.get("body") if isinstance(existing.get("body"), dict) else {}
            result = body.get("result") if isinstance(body.get("result"), dict) else None
            status = result.get("status") if isinstance(result, dict) else None
            digest = body.get("result_digest")
            if status in RESULT_STATUSES and isinstance(digest, str):
                # 结果已在 outbox：以事实为准补齐 ledger 终态，绝不重跑。
                self.ledger.complete(task_id, status, result_digest=digest)
            else:
                self.ledger.mark_unknown(task_id)
            self.ledger.mark_reconciled(task_id)
            return
        safe_operation = operation if isinstance(operation, str) and operation else "unknown"
        result = make_result(
            task_id=task_id,
            node_uid=self.node_uid,
            operation=safe_operation,
            status=RESULT_UNKNOWN,
            code=AGENT_EXECUTION_UNKNOWN,
        )
        self._enqueue_result(result)
        self.ledger.mark_unknown(task_id, result_digest=digest_of(result))
        self.ledger.mark_reconciled(task_id)
        self.logger.warning("task_result_unknown_after_crash", task_id=task_id)

    # -- 单轮 ---------------------------------------------------------------
    def iteration(self) -> str:
        """执行一轮；返回 ok / retry / fatal。"""
        # F：上次进程遗留的未确认结果优先重发（同 task_id 同摘要幂等）。
        if self.outbox.depth() > 0:
            startup_report = self.outbox.flush(self._send_outbox_item)
            if startup_report.fatal:
                raise AuthFatalError(startup_report.stop_code)
        snapshot = self.observer.snapshot()
        drift = compute_drift(self.state.last_observation, snapshot)
        health = self.observer.health(
            snapshot=snapshot,
            outbox_depth=self.outbox.depth(),
            failures=int(self.state.consecutive_failures),
        )
        # 账本到上限且没有可驱逐的已对账终态：停止取新任务，但心跳/观测继续，
        # 让控制面看到 DEGRADED/AGENT_LEDGER_EXHAUSTED 而不是"节点失联"。
        exhausted = self.ledger.is_exhausted()
        if exhausted:
            health = HEALTH_DEGRADED
            self.logger.warning("ledger_exhausted", entries=len(self.ledger.entries))
        heartbeat_extra = {
            "health": health,
            "drift": drift,
            "agent_version": self.config.agent_version,
            "capability_digest": snapshot.get("capability_digest"),
            "queue_depth": self.outbox.depth(),
            "observation": snapshot,
        }
        if exhausted:
            heartbeat_extra["health_reason"] = AGENT_LEDGER_EXHAUSTED
        heartbeat = self.client.heartbeat(
            lambda nonce: self._envelope(nonce, heartbeat_extra),
            interval_bounds=self.config.interval_bounds,
            retry_hook=self._retry_hook,
        )
        if heartbeat.kind == OUTCOME_AUTH_FATAL:
            self._fatal(heartbeat.code)
        if not heartbeat.ok:
            return self._fail_iteration("heartbeat", heartbeat.kind, heartbeat.code, heartbeat.retry_after_s)
        if heartbeat.interval_s is not None:
            self._interval_s = heartbeat.interval_s

        if exhausted:
            # 不 poll：宁可不取新任务，也不能因账本溢出丢掉"可能已执行"的事实。
            report = self.outbox.flush(self._send_outbox_item)
            if report.fatal:
                raise AuthFatalError(report.stop_code)
            self._retry_after_s = 0.0
            self.notifier.watchdog()
            self.state_store.record_heartbeat(interval_s=self._interval_s, observation=snapshot, health=health)
            self._emit("poll", {"skipped": AGENT_LEDGER_EXHAUSTED, "tasks": 0, "health": health})
            return "retry" if report.remaining else "ok"

        poll = self.client.poll(lambda nonce: self._envelope(nonce, {}), retry_hook=self._retry_hook)
        if poll.kind == OUTCOME_AUTH_FATAL:
            self._fatal(poll.code)
        if not poll.ok:
            return self._fail_iteration("poll", poll.kind, poll.code, poll.retry_after_s)
        self.state_store.record_poll()
        self._emit("poll", {"tasks": len(heartbeat.tasks) + len(poll.tasks), "health": health})

        batch: list[dict] = []
        seen: set[str] = set()
        for task in list(heartbeat.tasks) + list(poll.tasks):
            task_id = task.get("task_id") if isinstance(task, dict) else None
            key = task_id if isinstance(task_id, str) else repr(sorted(task.keys())) if isinstance(task, dict) else "?"
            if key in seen:
                continue
            seen.add(key)
            batch.append(task)
        if len(batch) > MAX_TASKS_PER_POLL + 2:
            self.logger.warning("task_batch_truncated", received=len(batch))
            batch = batch[: MAX_TASKS_PER_POLL + 2]
        for task in batch:
            self._process_task(task)

        report = self.outbox.flush(self._send_outbox_item)
        if report.fatal:
            raise AuthFatalError(report.stop_code)
        self._retry_after_s = 0.0
        self.notifier.watchdog()
        self.state_store.record_heartbeat(interval_s=self._interval_s, observation=snapshot, health=health)
        if report.remaining:
            return "retry"
        return "ok"

    def _fail_iteration(self, stage: str, kind: str | None, code: str | None, retry_after_s=None) -> str:
        failures = int(self.state.consecutive_failures) + 1
        backoff = self._backoff_for(failures)
        if kind == OUTCOME_RATE_LIMITED and isinstance(retry_after_s, (int, float)) and retry_after_s > 0:
            # ADR §5.1-7 / 合同 3：429 必须读 Retry-After 并遵守它，再叠加退避。
            self._retry_after_s = min(max(float(retry_after_s), 1.0), 3600.0)
        self.state_store.record_failure(round(backoff), health="FAILING")
        self.logger.warning(
            "iteration_failed",
            stage=stage,
            outcome=kind,
            code=code,
            backoff_s=round(backoff),
            retry_after_s=round(self._retry_after_s, 3),
        )
        self._emit(
            "backoff",
            {"stage": stage, "code": code, "backoff_s": round(backoff, 3), "retry_after_s": round(self._retry_after_s, 3)},
        )
        return "retry"

    def _fatal(self, code: str | None) -> None:
        self._emit("fatal", {"code": code})
        raise AuthFatalError(code)

    def _backoff_for(self, failures: int) -> float:
        exponent = min(max(failures - 1, 0), 9)
        base = min(BACKOFF_CAP_S, BACKOFF_BASE_S * (2 ** exponent))
        return max(0.5, base * (1.0 + float(self._jitter(self.config.jitter_ratio))))

    # -- 任务 ---------------------------------------------------------------
    def _process_task(self, envelope) -> None:
        if not isinstance(envelope, dict):
            self.logger.warning("task_envelope_dropped", reason="not-an-object")
            return
        task_id = envelope.get("task_id")
        if not isinstance(task_id, str) or not TASK_ID_RE.fullmatch(task_id):
            # 没有可安全标识的 task_id：无法栅栏也无法回传，只能拒绝（不进 ledger）。
            self.logger.warning("task_envelope_dropped", reason="task_id-not-protocol-safe")
            return
        operation = envelope.get("operation")
        safe_operation = operation if isinstance(operation, str) and operation else "unknown"
        attempt = envelope.get("attempt")
        safe_attempt = attempt if isinstance(attempt, int) and not isinstance(attempt, bool) else 1
        begin = self.ledger.begin(task_id, safe_operation, safe_attempt)
        if begin != "NEW":
            if begin == "ALREADY_FENCED":
                # 重复投递 + 上次崩在 execute 与 complete 之间：只补事实，不重跑。
                self._reconcile_task(task_id, safe_operation)
            self.logger.info("task_duplicate_skipped", task_id=task_id, state=begin)
            return
        self._emit("task_start", {"task_id": task_id, "operation": safe_operation})
        result = self.executor.handle(envelope)
        self.state_store.record_task_executed()
        status = result.get("status")
        digest = digest_of(result)
        add = self._enqueue_result(result)
        if add.status == TOO_LARGE:
            self.logger.error("result_too_large_for_outbox", task_id=task_id)
            self.ledger.mark_result_dropped(task_id)
        elif add.status == CONFLICT:
            self.logger.warning("result_digest_conflict_local", task_id=task_id)
        for dropped in add.dropped:
            self.ledger.mark_result_dropped(dropped)
            self.state_store.record_outbox_overflow(1)
            self.logger.warning("outbox_overflow", task_id=dropped)
        self.ledger.complete(task_id, status, result_digest=digest, code=result.get("code"))
        self._emit("task_result", {"task_id": task_id, "operation": safe_operation, "status": status, "code": result.get("code")})
        self.logger.info("task_processed", task_id=task_id, operation=safe_operation, status=status)

    def _enqueue_result(self, result: dict):
        body = {
            "task_id": result.get("task_id"),
            "operation": result.get("operation"),
            "result": result,
            "result_digest": digest_of(result),
        }
        return self.outbox.add(body)

    def _send_outbox_item(self, item):
        body = item.get("body")
        if not isinstance(body, dict):
            return SimpleNamespace(kind=OUTCOME_REJECTED, code=AGENT_INTERNAL_ERROR)
        try:
            response = self.client.send_result_body(
                lambda nonce: self._envelope(nonce, body),
                str(item.get("task_id")),
                retry_hook=self._retry_hook,
            )
        except ProtocolError as error:
            return SimpleNamespace(kind=OUTCOME_REJECTED, code=error.code)
        return SimpleNamespace(kind=response.kind, code=response.code)

    # -- 睡眠 ---------------------------------------------------------------
    def _sleep_with_jitter(self, seconds: float) -> None:
        # WatchdogSec=60：切成 ≤30 s 的块，每块前喂狗，保证长退避期间不被 systemd 杀掉。
        ratio = float(self.config.jitter_ratio)
        adjusted = max(0.0, seconds * (1.0 + float(self._jitter(ratio))))
        remaining = adjusted
        while remaining > 0:
            chunk = min(remaining, MAX_SLEEP_CHUNK_S)
            self._sleep(chunk)
            remaining -= chunk
            if remaining > 0:
                self.notifier.watchdog()

    def _sleep_interval(self, stop_event=None) -> None:
        self._sleep_with_jitter(self._interval_s)

    def _sleep_backoff(self, stop_event=None) -> None:
        backoff = max(0.5, float(self.state.next_backoff_s or 1))
        self._sleep_with_jitter(min(backoff, BACKOFF_CAP_S))

    def _retry_delay(self) -> float:
        """429 Retry-After 是服务端权威时长：不被本地 300 s 退避上限截断。"""
        if self._retry_after_s > 0:
            return min(max(float(self._retry_after_s), 1.0), RETRY_AFTER_CAP_S)
        backoff = max(0.5, float(self.state.next_backoff_s or 1))
        return min(backoff, BACKOFF_CAP_S)

    # -- 生命周期 -----------------------------------------------------------
    def run_once(self) -> int:
        """--once：一轮后返回退出码（0 成功 / 4 凭据致命 / 5 可重试失败）。"""
        try:
            outcome = self.iteration()
        except AuthFatalError as error:
            self.logger.error("auth_fatal", code=error.code)
            return 4
        return 0 if outcome == "ok" else 5

    def run_forever(self, *, stop_event=None, max_iterations: int | None = None) -> int:
        self.notifier.ready()
        iterations = 0
        stop_reason = "iteration_limit"
        while True:
            if stop_event is not None and stop_event.is_set():
                stop_reason = "signal"
                break
            if max_iterations is not None and iterations >= max_iterations:
                stop_reason = "iteration_limit"
                break
            iterations += 1
            try:
                outcome = self.iteration()
            except AuthFatalError as error:
                self.logger.error("auth_fatal", code=error.code)
                self.shutdown(reason="auth_fatal")
                return 4
            if outcome == "ok":
                self._sleep_with_jitter(self._interval_s)
            else:
                self._sleep_with_jitter(self._retry_delay())
        self.shutdown(reason=stop_reason)
        return 0

    def shutdown(self, *, reason: str) -> None:
        """有界收尾：STOPPING=1 → 停止取新任务 → ≤30 s flush → last_stop。

        先发 STOPPING=1 是合同 D 的明确要求：systemd 立刻知道进程正在优雅退出。
        """
        self.notifier.stopping()
        self.state_store.mark_stopping()
        deadline = self._monotonic() + SHUTDOWN_FLUSH_BUDGET_S
        attempts = 0
        while self.outbox.depth() > 0 and attempts < SHUTDOWN_FLUSH_ATTEMPTS:
            attempts += 1
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                break
            report = self.outbox.flush(self._send_outbox_item)
            if report.fatal:
                self.logger.error("shutdown_flush_fatal", code=report.stop_code)
                break
            if report.progressed:
                continue
            self._sleep(min(1.0, max(0.05, remaining)))
        pending = self.outbox.depth()
        if pending:
            self.logger.warning("shutdown_outbox_pending", pending=pending, reason=reason)
        self.state_store.record_stop()
        self.logger.info("agent_stopped", reason=reason, outbox_depth=pending)
