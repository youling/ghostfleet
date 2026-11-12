"""常驻工作循环：observe → drift → heartbeat → poll → 栅栏执行 → flush → 喂狗。

ADR §6/§7/§8 的编排层：
- 每轮最多 2 个 heartbeat 任务 + 4 个 poll 任务；
- 每个任务先写 ledger 栅栏（MAY_HAVE_EXECUTED）再执行，结果入 outbox；
- 失败按 1→2→4…300 s 指数退避，控制面不可达时不退出、不丢已执行事实；
- SIGTERM/SIGINT 由 CLI 设置 stop_event：先停常驻喂狗线程 → 停止取新任务 →
  ≤SHUTDOWN_FLUSH_BUDGET_S（8 s）有界 flush（每条 send 前查 deadline，单请求超时
  钳到剩余预算）→ 写 last_stop → 发送 STOPPING=1 → 退出 0；
- watchdog 由常驻 daemon 线程按 WatchdogSec/3 喂，离线退避/长阻塞时也不会饿死。
"""
from __future__ import annotations

import random
import threading
import time
from types import SimpleNamespace

from .client import MIN_INTERVAL_S
from .ledger import LedgerWriteError
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
from .tasks import MAX_TASKS_PER_POLL, SUPPORTED_OPERATIONS, TaskExecutor, validate_envelope, TaskRefused
from . import protocol as protocol_mod

BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 300.0
RETRY_AFTER_CAP_S = 3600.0
# unit 的 TimeoutStopSec（ADR §8）；停机预算的三段之和必须留在它里面：
#   1 s（睡眠打断片）+ request_timeout_s 默认 10 s（在途 HTTP 不可中途 abort）+ 8 s（flush）
#   + 2 s 余量（STOPPING 通知、last_stop 落盘、进程退出）= 21 s ≤ 30 s。
TIMEOUT_STOP_SEC = 30.0
SHUTDOWN_RESERVE_S = 2.0
# ADR §8：SIGTERM 后 flush 有界。总停机预算按 TimeoutStopSec 的 ≤1/3 取 8 s。
SHUTDOWN_FLUSH_BUDGET_S = 8.0
SHUTDOWN_FLUSH_ATTEMPTS = 30
# SIGTERM 睡眠可打断性：每片 ≤1 s 检查一次 stop_event，保证任意睡眠点被唤醒。
STOP_SLICE_S = 1.0
MIN_SLEEP_CHUNK_S = 0.2
MAX_SLEEP_CHUNK_S = 30.0  # WatchdogSec=60：任何睡眠都必须切成 ≤30 s 的块并每块喂狗
# 常驻喂狗线程周期 = WatchdogSec/3（ADR §8 的 60 s）。线程不依赖主线程推进，
# 因此离线退避（1/2/4/8/16/32 s）或长网络阻塞时也不会饿死 watchdog。
WATCHDOG_INTERVAL_S = 20.0
WATCHDOG_JOIN_TIMEOUT_S = 2.0


class AuthFatalError(Exception):
    """控制面明确拒绝该节点凭据：停止上报（ADR §9 吊销语义）。"""

    def __init__(self, code: str | None) -> None:
        self.code = code or protocol_mod.NODE_AUTH_INVALID
        super().__init__(self.code)


class WatchdogThread:
    """常驻喂狗线程：周期发 WATCHDOG=1，保证主线程阻塞/离线退避时不被 systemd 杀。

    systemd 的 NotifyAccess=main 校验的是 SCM_CREDENTIALS 的 TGID；从线程发送时
    TGID 仍是主进程 PID，因此合法（实测 tgid 411 / tid 412 时收方看到 pid=411）。
    线程内任何异常都只记一次 warning 并退出线程，绝不影响主循环。
    """

    def __init__(self, notifier, *, interval_s: float = WATCHDOG_INTERVAL_S, logger=None, waiter=None) -> None:
        self._notifier = notifier
        self._interval_s = float(interval_s)
        self._logger = logger or get_logger()
        self._stop = threading.Event()
        self._thread = None
        self._warned = False
        # waiter(seconds) -> bool（True 表示收到停止信号）；默认等待 stop event。
        self._waiter = waiter

    @property
    def interval_s(self) -> float:
        return self._interval_s

    @property
    def thread(self):
        return self._thread

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="ghostfleet-watchdog", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is None:
            return
        if thread.is_alive():
            thread.join(WATCHDOG_JOIN_TIMEOUT_S)

    def _run(self) -> None:
        while not self._stop.is_set():
            wait = self._stop.wait if self._waiter is None else self._waiter
            try:
                if wait(self._interval_s):
                    return
            except Exception:
                self._warn_once()
                return
            if self._stop.is_set():
                return
            try:
                self._notifier.watchdog()
            except Exception:
                self._warn_once()
                return

    def _warn_once(self) -> None:
        if self._warned:
            return
        self._warned = True
        try:
            self._logger.warning("watchdog_thread_failed", interval_s=self._interval_s)
        except Exception:
            return


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
        watchdog_interval_s: float = WATCHDOG_INTERVAL_S,
        watchdog_waiter=None,
        stop_waiter=None,
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
        # 本地周期也不低于客户端 30 s 速率底线（ADR §5.1-7 的预算按 30 s 算）。
        self._interval_s = max(float(config.interval_s), MIN_INTERVAL_S)
        self._outcome_ok = OUTCOME_OK
        self._retry_after_s = 0.0
        self._watchdog_interval_s = float(watchdog_interval_s)
        self._watchdog_waiter = watchdog_waiter
        self._watchdog = None
        # stop_event 与等待函数都可在构造期注入，便于用假时钟断言"信号→退出"时延。
        self._stop_event = None
        self._stop_waiter = stop_waiter or (lambda event, timeout: event.wait(timeout))

    # -- 事件日志（合同 E：固定字段，绝不写 nonce/params/token） -------------
    def _emit(self, event: str, detail=None) -> None:
        try:
            seq = int(self.state.seq)
        except (AttributeError, TypeError, ValueError):
            seq = 0
        self.logger.event(event, seq, detail)

    def _stopping(self) -> bool:
        """SIGTERM/SIGINT 已置位：绝不再发起新的 heartbeat/poll/result send。"""
        event = self._stop_event
        return event is not None and event.is_set()

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
    def _apply_outbox_drops(self) -> list[str]:
        """先把丢弃事实记进 ledger，再清空 outbox 的待记账清单。

        顺序不可颠倒：若先 drain 后 mark，drain 落盘后崩溃会让 RESULT_DROPPED
        事实永久丢失（outbox 已空、ledger 无记录）。反过来崩溃最多重放一次：
        mark_result_dropped 幂等，pending_dropped 仍在下次启动重放。
        """
        dropped = list(self.outbox.pending_dropped())
        if not dropped:
            return []
        for task_id in dropped:
            self.ledger.mark_result_dropped(task_id)
            self.state_store.record_outbox_overflow(1)
        self.outbox.drain_dropped()
        return dropped

    def _replay_outbox_dropped(self) -> int:
        """把 outbox 里持久化的溢出丢弃清单重放成 ledger 的 RESULT_DROPPED 事实。

        丢弃清单与 items 同一次原子写落盘，因此"结果丢了但账本不知道"这个
        不一致窗口不存在；这里只负责在进程重启后补账。
        """
        dropped = self._apply_outbox_drops()
        if dropped:
            self.logger.warning("outbox_overflow_replayed", count=len(dropped))
        return len(dropped)

    def reconcile(self) -> int:
        """启动时对"已栅栏、未收敛"的 task 只补事实，不重跑（ADR §7 / D5）。"""
        self._replay_outbox_dropped()
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
        """执行一轮；返回 ok / retry / fatal / stopped。"""
        # SIGTERM 后绝不再发起任何新请求（含 startup flush 里的 result send）。
        if self._stopping():
            return "stopped"
        # F：上次进程遗留的未确认结果优先重发（同 task_id 同摘要幂等）。
        self._replay_outbox_dropped()
        if self.outbox.depth() > 0:
            startup_report = self.outbox.flush(
                self._send_outbox_item,
                stop_event=self._stop_event,
                deadline=self._monotonic() + SHUTDOWN_FLUSH_BUDGET_S,
            )
            if startup_report.fatal:
                raise AuthFatalError(startup_report.stop_code)
            if self._stopping():
                # 停机信号在重放途中到达：不再进入本轮任何控制面交互。
                return "stopped"
            if startup_report.retry_after_s:
                # 服务端对重放结果回了 429：本轮不再打任何请求，直接按权威时长退避。
                return self._fail_iteration(
                    "startup-flush",
                    protocol_mod.OUTCOME_RATE_LIMITED,
                    startup_report.stop_code,
                    startup_report.retry_after_s,
                )
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
        if self._stopping():
            return "stopped"
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
        # 心跳往返期间收到 SIGTERM：本轮到此为止，绝不发出 poll。
        if self._stopping():
            self.logger.info("iteration_stopped_before_poll")
            return "stopped"

        if exhausted:
            # 不 poll：宁可不取新任务，也不能因账本溢出丢掉"可能已执行"的事实。
            report = self.outbox.flush(
                self._send_outbox_item,
                stop_event=self._stop_event,
                deadline=self._monotonic() + SHUTDOWN_FLUSH_BUDGET_S,
            )
            if report.fatal:
                raise AuthFatalError(report.stop_code)
            self._note_flush_retry_after(report)
            if self._stopping():
                return "stopped"
            # 喂狗由常驻线程负责（P1-A）；主循环只保留 _sleep_with_jitter 的块间冗余喂狗。
            self.state_store.record_heartbeat(interval_s=self._interval_s, observation=snapshot, health=health)
            self._emit("poll", {"skipped": AGENT_LEDGER_EXHAUSTED, "tasks": 0, "health": health})
            return "retry" if report.remaining or self._retry_after_s > 0 else "ok"

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
        ledger_blocked = False
        try:
            for task in batch:
                # SIGTERM 后绝不再开始新任务：未开始的 task 不进 ledger（控制面可安全重投）。
                if self._stopping():
                    self.logger.info("task_batch_aborted", pending=len(batch))
                    break
                self._process_task(task)
        except LedgerWriteError as error:
            # 账本在批处理中途耗尽：绝不能让它抛到 CLI 变成 exit 5 脏退出（没有 shutdown /
            # STOPPING）。放弃本批剩余任务（未 fence 的可由控制面安全重投），本轮改报 DEGRADED。
            ledger_blocked = True
            self.logger.warning("ledger_write_failed_during_batch", detail=str(error))

        report = self.outbox.flush(
            self._send_outbox_item,
            stop_event=self._stop_event,
            deadline=self._monotonic() + SHUTDOWN_FLUSH_BUDGET_S,
        )
        if report.fatal:
            raise AuthFatalError(report.stop_code)
        self._note_flush_retry_after(report)
        if self._stopping():
            return "stopped"
        self.state_store.record_heartbeat(
            interval_s=self._interval_s,
            observation=snapshot,
            health=HEALTH_DEGRADED if ledger_blocked else health,
        )
        if ledger_blocked:
            self._emit("backoff", {"stage": "task-batch", "code": AGENT_LEDGER_EXHAUSTED})
            return "retry"
        if report.remaining or self._retry_after_s > 0:
            return "retry"
        return "ok"

    def _note_flush_retry_after(self, report) -> None:
        """结果回传的 429 Retry-After 是服务端权威时长，绝不清零或缩短。"""
        retry_after = getattr(report, "retry_after_s", None)
        if isinstance(retry_after, (int, float)) and not isinstance(retry_after, bool) and retry_after > 0:
            self._retry_after_s = max(self._retry_after_s, min(max(float(retry_after), 1.0), RETRY_AFTER_CAP_S))
            self.logger.warning("result_flush_rate_limited", retry_after_s=round(self._retry_after_s, 3))
            self._emit("backoff", {"stage": "result-flush", "retry_after_s": round(self._retry_after_s, 3)})
        elif not report.remaining:
            # 全部结果已被接受：服务端没有未完成的限速要求，恢复本地节奏。
            self._retry_after_s = 0.0

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
        if operation not in SUPPORTED_OPERATIONS:
            # P2d：未知/缺失 operation 必须在 fence 之前拒绝。
            # 栅栏的语义是"实现可能已经跑过"，而这类任务根本不会进入 dispatch；
            # 先 fence 会留下一条 MAY_MUTATE 等级、不可驱逐的条目，512 个未知
            # operation 就能永久耗尽账本并停掉一切 poll。
            self._emit("task_start", {"task_id": task_id, "operation": safe_operation})
            result = self.executor.handle(envelope)
            self._deliver_result(task_id, safe_operation, result)
            return
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
        self._deliver_result(task_id, safe_operation, result)

    def _deliver_result(self, task_id: str, operation: str, result: dict) -> None:
        """持久化一次执行结果：入队 → 重放溢出丢弃 → 补齐 ledger 终态 → 结构化事件。

        顺序是关键：结果先进 outbox（崩溃后仍未发出时下次启动优先重发），
        溢出/丢弃清单先记进 ledger（_apply_outbox_drops 先 mark 后 drain），
        最后才写终态并宣告 task_result。
        """
        status = result.get("status")
        digest = digest_of(result)
        add = self._enqueue_result(result)
        if add.status == TOO_LARGE:
            self.logger.error("result_too_large_for_outbox", task_id=task_id)
            self.ledger.mark_result_dropped(task_id)
        elif add.status == CONFLICT:
            self.logger.warning("result_digest_conflict_local", task_id=task_id)
        # 丢弃清单与 items 在同一次原子写里持久化；这里先记账后清空（P2a 崩溃窗）。
        for dropped in self._apply_outbox_drops():
            self.logger.warning("outbox_overflow", task_id=dropped)
        self.ledger.complete(
            task_id,
            status,
            result_digest=digest,
            code=result.get("code"),
            operation=operation,
        )
        self._emit("task_result", {"task_id": task_id, "operation": operation, "status": status, "code": result.get("code")})
        self.logger.info("task_processed", task_id=task_id, operation=operation, status=status)

    def _enqueue_result(self, result: dict):
        body = {
            "task_id": result.get("task_id"),
            "operation": result.get("operation"),
            "result": result,
            "result_digest": digest_of(result),
        }
        return self.outbox.add(body)

    def _send_outbox_item(self, item, timeout_s=None):
        body = item.get("body")
        if not isinstance(body, dict):
            return SimpleNamespace(kind=OUTCOME_REJECTED, code=AGENT_INTERNAL_ERROR)
        try:
            response = self.client.send_result_body(
                lambda nonce: self._envelope(nonce, body),
                str(item.get("task_id")),
                retry_hook=self._retry_hook,
                timeout_s=timeout_s,
            )
        except ProtocolError as error:
            return SimpleNamespace(kind=OUTCOME_REJECTED, code=error.code)
        return SimpleNamespace(
            kind=response.kind,
            code=response.code,
            retry_after_s=getattr(response, "retry_after_s", None),
        )

    # -- 睡眠 ---------------------------------------------------------------
    def _sleep_with_jitter(self, seconds: float, *, apply_jitter: bool = True, stop_event=None) -> bool:
        """睡眠；可被 stop_event 打断。返回 True 表示收到停止信号提前返回。

        不传 stop_event 时保持旧行为（一次性调用注入的 self._sleep），便于假时钟测试。
        传 stop_event 时按 ≤STOP_SLICE_S 的片等待，保证 SIGTERM 后 ≤1 s 脱离睡眠；
        这正是 TimeoutStopSec=30 下"任意时刻 SIGTERM → 进程 ≤5 s 退出"的关键。
        """
        # WatchdogSec=60：切成 ≤30 s 的块，每块前喂狗，保证长退避期间不被 systemd 杀掉。
        # 服务端 Retry-After 是权威时长，绝不乘抖动（否则会提前重试）。
        ratio = float(self.config.jitter_ratio)
        adjusted = max(0.0, seconds * (1.0 + float(self._jitter(ratio))) if apply_jitter else seconds)
        remaining = adjusted
        while remaining > 0:
            chunk = min(remaining, MAX_SLEEP_CHUNK_S)
            if stop_event is None:
                self._sleep(chunk)
            elif self._wait_chunk(chunk, stop_event):
                return True
            remaining -= chunk
            if remaining > 0 and stop_event is None:
                self.notifier.watchdog()
        return stop_event is not None and stop_event.is_set()

    def _wait_chunk(self, seconds: float, stop_event) -> bool:
        """按 ≤STOP_SLICE_S 切片等待；返回 True 表示看到停止信号。"""
        remaining = float(seconds)
        while remaining > 0:
            slice_s = min(remaining, STOP_SLICE_S)
            try:
                interrupted = bool(self._stop_waiter(stop_event, slice_s))
            except Exception:  # noqa: BLE001 - 任何等待失败都不能拖住停机
                interrupted = True
            if interrupted or stop_event.is_set():
                return True
            remaining -= slice_s
        return stop_event.is_set()

    def _sleep_interval(self, stop_event=None) -> bool:
        return self._sleep_with_jitter(self._interval_s, stop_event=stop_event)

    def _sleep_backoff(self, stop_event=None) -> bool:
        backoff = max(0.5, float(self.state.next_backoff_s or 1))
        return self._sleep_with_jitter(min(backoff, BACKOFF_CAP_S), stop_event=stop_event)

    def _retry_delay(self) -> float:
        """429 Retry-After 是服务端权威时长：不被本地 300 s 退避上限截断。"""
        if self._retry_after_s > 0:
            return min(max(float(self._retry_after_s), 1.0), RETRY_AFTER_CAP_S)
        backoff = max(0.5, float(self.state.next_backoff_s or 1))
        return min(backoff, BACKOFF_CAP_S)

    # -- 生命周期 -----------------------------------------------------------
    def _start_watchdog(self) -> None:
        """启动常驻喂狗线程（只在 run_forever 里；--once 不启动）。"""
        if self._watchdog is not None:
            return
        self._watchdog = WatchdogThread(
            self.notifier,
            interval_s=self._watchdog_interval_s,
            logger=self.logger,
            waiter=self._watchdog_waiter,
        )
        self._watchdog.start()

    def _stop_watchdog(self) -> None:
        watchdog = self._watchdog
        self._watchdog = None
        if watchdog is not None:
            watchdog.stop()

    def run_once(self) -> int:
        """--once：一轮后返回退出码（0 成功 / 4 凭据致命 / 5 可重试失败）。"""
        try:
            outcome = self.iteration()
        except AuthFatalError as error:
            self.logger.error("auth_fatal", code=error.code)
            return 4
        # stopped = 收到停机信号且未发起新请求：干净退出，不算失败。
        return 0 if outcome in ("ok", "stopped") else 5

    def bind_stop_event(self, stop_event) -> None:
        """把 SIGTERM 事件同时交给睡眠等待与任务执行器（协作式取消）。"""
        self._stop_event = stop_event
        try:
            self.executor.interrupt = stop_event
        except AttributeError:
            return

    def run_forever(self, *, stop_event=None, max_iterations: int | None = None) -> int:
        if stop_event is not None:
            self.bind_stop_event(stop_event)
        # CLI 在信号处理器装好后调用 bind_stop_event；测试可直接传事件。
        effective_stop = stop_event if stop_event is not None else self._stop_event
        self.notifier.ready()
        self._start_watchdog()
        iterations = 0
        stop_reason = "iteration_limit"
        try:
            while True:
                if effective_stop is not None and effective_stop.is_set():
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
                if outcome == "stopped":
                    # 停机信号已置位：本轮没有发起任何新请求，立即进入 shutdown。
                    stop_reason = "signal"
                    break
                interrupted = False
                if outcome == "ok":
                    interrupted = self._sleep_with_jitter(self._interval_s, stop_event=effective_stop)
                else:
                    # 只有本地指数退避才抖动；服务端 Retry-After 必须原样遵守。
                    interrupted = self._sleep_with_jitter(
                        self._retry_delay(), apply_jitter=self._retry_after_s <= 0, stop_event=effective_stop
                    )
                if interrupted:
                    stop_reason = "signal"
                    break
        finally:
            # 任何退出路径（含未预期异常）都先停线程，避免 STOPPING 之后还有 WATCHDOG。
            self._stop_watchdog()
        self.shutdown(reason=stop_reason)
        return 0

    def shutdown(self, *, reason: str) -> dict:
        """有界收尾：先停喂狗线程 → STOPPING=1 → ≤8 s 有界 flush → last_stop。

        先停线程再发 STOPPING=1 是合同 D 的顺序要求：STOPPING 之后不允许再有
        WATCHDOG。停机预算不是"常量相加"：整段收尾共用一个 deadline，每条 send
        之前都由 Outbox.flush 检查 deadline，单请求超时被钳到剩余预算，因此 64 条
        积压最坏也只消耗 8 s，而不是 64×request_timeout_s。
        返回收尾统计（pending/sent/rejected/elapsed_s），供 CLI 与测试断言。
        """
        self._stop_watchdog()
        self.notifier.stopping()
        self.state_store.mark_stopping()
        started = self._monotonic()
        deadline = started + SHUTDOWN_FLUSH_BUDGET_S
        sent = 0
        rejected = 0
        attempts = 0
        while self.outbox.depth() > 0 and attempts < SHUTDOWN_FLUSH_ATTEMPTS:
            attempts += 1
            if self._monotonic() >= deadline:
                break
            report = self.outbox.flush(
                self._send_outbox_item,
                deadline=deadline,
                clock=self._monotonic,
            )
            sent += len(report.sent)
            rejected += len(report.rejected)
            if report.fatal:
                self.logger.error("shutdown_flush_fatal", code=report.stop_code)
                break
            if report.progressed:
                continue
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                break
            self._sleep(min(1.0, max(0.05, remaining)))
        pending = self.outbox.depth()
        elapsed = max(0.0, self._monotonic() - started)
        if pending:
            self.logger.warning("shutdown_outbox_pending", pending=pending, reason=reason)
        self.state_store.record_stop()
        self.logger.info(
            "agent_stopped",
            reason=reason,
            outbox_depth=pending,
            sent=sent,
            rejected=rejected,
            elapsed_s=round(elapsed, 3),
        )
        return {"pending": pending, "sent": sent, "rejected": rejected, "elapsed_s": elapsed}
