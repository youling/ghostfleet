"""任务信封校验 + 只读 allowlist 分派（无 shell、无特权通路）。

ADR §5.3 / §7 的执行侧合同：
- 信封字段与 task_id/node_uid/时间窗全部 fail closed；
- operation 白名单之外一律 REFUSED + TASK_OPERATION_UNKNOWN（控制面另有
  TASK_OPERATION_FORBIDDEN，Agent 只是不认识）；
- params 递归禁用键 → TASK_PARAMS_FORBIDDEN；
- service.status.read 只允许配置里的 allowed_units 白名单，unit 名正则校验；
- 结果状态按"副作用是否可能已发生"分派（ADR §7）：
  校验拒绝（调用实现之前）→ REFUSED（保证无副作用，可安全重投）；
  只读 operation 的实现抛异常 → FAILED（只读保证无副作用，可安全重投）；
  声明为 may_mutate 的 operation 实现抛异常 → UNKNOWN（副作用不可判定，绝不重投）；
  以上异常都不允许穿透到循环。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from .logging import get_logger
from .observe import (
    DEFAULT_WANT,
    MAX_UNITS_OBSERVED,
    UNIT_RE,
    WANT_TOKENS,
    Observer,
)
from .protocol import (
    AGENT_EXECUTION_FAILED,
    AGENT_EXECUTION_INTERRUPTED,
    AGENT_EXECUTION_UNKNOWN,
    AGENT_UNIT_NOT_ALLOWED,
    MAX_PARAMS_DEPTH,
    NODE_UID_RE,
    RESULT_FAILED,
    RESULT_REFUSED,
    RESULT_SUCCEEDED,
    RESULT_UNKNOWN,
    SCHEMA_TASK,
    TASK_ENVELOPE_INVALID,
    TASK_EXPIRED,
    TASK_ID_RE,
    TASK_OPERATION_UNKNOWN,
    TASK_PARAMS_FORBIDDEN,
    TASK_SCOPE_MISMATCH,
    ProtocolError,
    check_params,
    format_timestamp,
    is_valid_nonce,
    make_result,
    now_utc,
    parse_timestamp,
)

OPERATION_OBSERVE = "node.observe"
OPERATION_SERVICE_STATUS = "service.status.read"
OPERATION_CAPABILITY_INSPECT = "capability.inspect"
OPERATION_SELF_TEST = "agent.self.test"

# 每个 operation 必须显式声明执行效果等级：不是隐含约定，而是分派表里的字段。
# - read_only：实现不可能改变节点状态，异常可报 FAILED 并允许控制面重投；
# - may_mutate：实现可能已产生副作用，异常必须报 UNKNOWN，控制面不得重投。
# v0 词汇（ADR §5.3）全部只读；将来新增可变更 operation 必须显式写 may_mutate。
READ_ONLY = "read_only"
MAY_MUTATE = "may_mutate"
EFFECTS = frozenset({READ_ONLY, MAY_MUTATE})


@dataclass(frozen=True)
class OperationSpec:
    """单个 operation 的显式声明：执行效果等级 + 处理函数名。"""

    operation: str
    effect: str
    handler: str


OPERATION_SPECS = {
    OPERATION_OBSERVE: OperationSpec(OPERATION_OBSERVE, READ_ONLY, "_observe"),
    OPERATION_SERVICE_STATUS: OperationSpec(OPERATION_SERVICE_STATUS, READ_ONLY, "_service_status"),
    OPERATION_CAPABILITY_INSPECT: OperationSpec(OPERATION_CAPABILITY_INSPECT, READ_ONLY, "_capability_inspect"),
    OPERATION_SELF_TEST: OperationSpec(OPERATION_SELF_TEST, READ_ONLY, "_self_test"),
}
SUPPORTED_OPERATIONS = frozenset(OPERATION_SPECS)

# 实现层异常的稳定错误码必须匹配该形态；否则退回通用码。
EXECUTION_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{3,63}$")

MAX_TASKS_PER_POLL = 4
MAX_TASKS_PER_HEARTBEAT = 2
MAX_UNITS_PER_TASK = 8
MAX_TASK_LIFETIME_S = 600
MAX_CLOCK_SKEW_S = 600
MIN_ATTEMPT = 1
MAX_ATTEMPT = 3


class TaskRefused(Exception):
    """任务未被接受；`code` 是稳定错误码，进入结果 payload 而不是异常栈。"""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


class TaskInterrupted(Exception):
    """SIGTERM 协作式取消：实现已被调用、但没有完成全部操作。

    read_only → FAILED（无副作用，可重投）；may_mutate → UNKNOWN（不可重投）。
    绝不使用 TaskRefused：REFUSED 的语义是"实现从未被调用"。
    """

    def __init__(self, detail: str = "") -> None:
        self.code = AGENT_EXECUTION_INTERRUPTED
        self.detail = detail
        super().__init__(f"{AGENT_EXECUTION_INTERRUPTED}: {detail}" if detail else AGENT_EXECUTION_INTERRUPTED)


class ValidatedTask:
    """已通过信封校验的任务；执行层只需要这些字段。"""

    __slots__ = ("task_id", "node_uid", "operation", "params", "attempt", "issued_at", "expires_at")

    def __init__(self, task_id, node_uid, operation, params, attempt, issued_at, expires_at) -> None:
        self.task_id = task_id
        self.node_uid = node_uid
        self.operation = operation
        self.params = params
        self.attempt = attempt
        self.issued_at = issued_at
        self.expires_at = expires_at

    def __repr__(self) -> str:  # pragma: no cover - 仅调试
        return f"ValidatedTask({self.task_id!r}, {self.operation!r}, attempt={self.attempt})"


def validate_envelope(
    envelope,
    *,
    node_uid: str,
    now: datetime | None = None,
    supported_operations=SUPPORTED_OPERATIONS,
    allowed_units=(),
) -> ValidatedTask:
    """校验任务信封与 operation 参数；任何不符抛 TaskRefused（稳定错误码）。

    白名单与参数校验全部发生在这里（调用实现之前），因此 REFUSED 始终等价于
    "实现函数从未被调用、保证零副作用"。实现内部如果仍抛 TaskRefused，调用方
    必须按 FAILED/UNKNOWN 处理（见 handle）。
    """
    if not isinstance(envelope, dict):
        raise TaskRefused(TASK_ENVELOPE_INVALID, "task envelope must be an object")
    # lease_expires_at 是 ADR §5.2 明列的服务端租约事实（服务端按 300 s 租约计算，
    # 就在 attempt 前面）。Agent 不用它做任何本地决策（过期只看 expires_at），但必须
    # 接受该字段，否则控制面的每个任务都会被判成 TASK_ENVELOPE_INVALID。
    extra = sorted(key for key in envelope if key not in {
        "schema", "task_id", "node_uid", "operation", "params", "issued_at", "expires_at", "attempt",
        "lease_expires_at",
    })
    if extra:
        raise TaskRefused(TASK_ENVELOPE_INVALID, f"unexpected envelope field {extra[0]}")
    if envelope.get("schema") != SCHEMA_TASK:
        raise TaskRefused(TASK_ENVELOPE_INVALID, "schema mismatch")
    task_id = envelope.get("task_id")
    if not isinstance(task_id, str) or not TASK_ID_RE.fullmatch(task_id):
        raise TaskRefused(TASK_ENVELOPE_INVALID, "task_id is not protocol-safe")
    envelope_node_uid = envelope.get("node_uid")
    if not isinstance(envelope_node_uid, str) or not NODE_UID_RE.fullmatch(envelope_node_uid):
        raise TaskRefused(TASK_ENVELOPE_INVALID, "node_uid is not a protocol node identity")
    if envelope_node_uid != node_uid:
        raise TaskRefused(TASK_SCOPE_MISMATCH, "task is addressed to a different node")
    operation = envelope.get("operation")
    if not isinstance(operation, str) or not operation:
        raise TaskRefused(TASK_ENVELOPE_INVALID, "operation is missing")
    params = envelope.get("params", {})
    try:
        check_params(params)
    except ProtocolError as error:
        raise TaskRefused(error.code, error.detail) from None
    attempt = envelope.get("attempt", 1)
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not MIN_ATTEMPT <= attempt <= MAX_ATTEMPT:
        raise TaskRefused(TASK_ENVELOPE_INVALID, "attempt must be 1..3")
    try:
        issued_at = parse_timestamp(envelope.get("issued_at"), code=TASK_ENVELOPE_INVALID)
        expires_at = parse_timestamp(envelope.get("expires_at"), code=TASK_ENVELOPE_INVALID)
        # 租约字段可选（兼容旧控制面/本地测试）；存在时只校验 RFC3339 UTC 形态，
        # 不参与过期判断——过期语义只由 expires_at 决定，避免本地时钟与租约口径打架。
        if "lease_expires_at" in envelope:
            lease_expires_at = envelope["lease_expires_at"]
            if not isinstance(lease_expires_at, str):
                raise ProtocolError(TASK_ENVELOPE_INVALID, "lease_expires_at must be an RFC3339 UTC string")
            parse_timestamp(lease_expires_at, code=TASK_ENVELOPE_INVALID)
    except ProtocolError as error:
        raise TaskRefused(error.code, error.detail) from None
    moment = now if now is not None else now_utc()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    lifetime = (expires_at - issued_at).total_seconds()
    if lifetime < 0 or lifetime > MAX_TASK_LIFETIME_S:
        raise TaskRefused(TASK_ENVELOPE_INVALID, "task lifetime must be within 600 s")
    if (issued_at - moment).total_seconds() > MAX_CLOCK_SKEW_S:
        raise TaskRefused(TASK_ENVELOPE_INVALID, "task issued_at is implausibly in the future")
    if expires_at <= moment:
        raise TaskRefused(TASK_EXPIRED, "task has expired")
    if operation not in supported_operations:
        raise TaskRefused(TASK_OPERATION_UNKNOWN, "operation is not in the v0 read-only vocabulary")
    _validate_operation_params(operation, params, allowed_units=allowed_units)
    return ValidatedTask(task_id, envelope_node_uid, operation, dict(params), int(attempt), issued_at, expires_at)


def _require_only_params(params: dict, allowed: set[str]) -> None:
    extra = sorted(key for key in params if key not in allowed)
    if extra:
        raise TaskRefused(TASK_PARAMS_FORBIDDEN, f"params field {extra[0]} is not allowed for this operation")


def _validate_operation_params(operation: str, params: dict, *, allowed_units=()) -> None:
    """按 operation 校验 params 语义（禁用键/取值/本地白名单），从不调用实现。"""
    if operation == OPERATION_OBSERVE:
        _require_only_params(params, {"want"})
        want = params.get("want")
        if want is None:
            return
        if not isinstance(want, list) or not want:
            raise TaskRefused(TASK_PARAMS_FORBIDDEN, "want must be a non-empty list")
        selected: list[str] = []
        for token in want:
            if not isinstance(token, str) or token not in WANT_TOKENS:
                raise TaskRefused(TASK_PARAMS_FORBIDDEN, "want contains an unsupported fact")
            if token in selected:
                raise TaskRefused(TASK_PARAMS_FORBIDDEN, "want contains duplicates")
            selected.append(token)
        return
    if operation == OPERATION_SERVICE_STATUS:
        _require_only_params(params, {"units"})
        units = params.get("units")
        if not isinstance(units, list) or not units:
            raise TaskRefused(TASK_PARAMS_FORBIDDEN, "units must be a non-empty list")
        if len(units) > MAX_UNITS_PER_TASK:
            raise TaskRefused(TASK_PARAMS_FORBIDDEN, "at most 8 units per task")
        selected_units: list[str] = []
        for unit in units:
            if not isinstance(unit, str) or not UNIT_RE.fullmatch(unit):
                raise TaskRefused(TASK_PARAMS_FORBIDDEN, "unit name does not match the v0 unit pattern")
            if unit in selected_units:
                raise TaskRefused(TASK_PARAMS_FORBIDDEN, "unit list contains duplicates")
            selected_units.append(unit)
        configured = tuple(allowed_units)
        if not configured:
            raise TaskRefused(AGENT_UNIT_NOT_ALLOWED, "no allowed_units configured on this node")
        allowed = set(configured)
        for unit in selected_units:
            if unit not in allowed:
                raise TaskRefused(AGENT_UNIT_NOT_ALLOWED, "unit is not in the local allowlist")
        return
    if operation == OPERATION_CAPABILITY_INSPECT:
        _require_only_params(params, set())
        return
    if operation == OPERATION_SELF_TEST:
        _require_only_params(params, {"nonce"})
        nonce = params.get("nonce")
        if nonce is not None and (not isinstance(nonce, str) or not is_valid_nonce(nonce)):
            raise TaskRefused(TASK_PARAMS_FORBIDDEN, "nonce must be base64url text of at least 16 bytes")
        return


class TaskExecutor:
    """把校验过的任务分派到只读实现；返回完整结果 payload。"""

    def __init__(
        self,
        *,
        node_uid: str,
        agent_version: str,
        observer: Observer | None = None,
        allowed_units=(),
        logger=None,
        operations=OPERATION_SPECS,
        interrupt=None,
    ) -> None:
        self.node_uid = node_uid
        self.agent_version = agent_version
        self.allowed_units = tuple(allowed_units)
        self.operations = dict(operations)
        self.observer = observer or Observer(node_uid=node_uid, agent_version=agent_version, allowed_units=self.allowed_units)
        self.logger = logger or get_logger()
        # SIGTERM 事件（threading.Event 或任何有 is_set() 的对象）；None 表示不协作取消。
        self.interrupt = interrupt

    def _check_interrupt(self) -> None:
        interrupt = self.interrupt
        if interrupt is not None and interrupt.is_set():
            raise TaskInterrupted("agent is shutting down")

    # -- 入口 ---------------------------------------------------------------
    def handle(self, envelope) -> dict:
        """校验并执行；永远返回结果 payload（SUCCEEDED/REFUSED/FAILED/UNKNOWN）。"""
        task_id = envelope.get("task_id") if isinstance(envelope, dict) else None
        operation = envelope.get("operation") if isinstance(envelope, dict) else None
        safe_task_id = task_id if isinstance(task_id, str) else "unknown"
        safe_operation = operation if isinstance(operation, str) else "unknown"
        try:
            task = validate_envelope(
                envelope,
                node_uid=self.node_uid,
                supported_operations=frozenset(self.operations),
                allowed_units=self.allowed_units,
            )
        except TaskRefused as refusal:
            # 校验发生在调用实现之前，保证无副作用 → REFUSED。
            return self._refused(safe_task_id, safe_operation, refusal.code)
        spec = self.operations.get(task.operation)
        if spec is None:  # 防御性兜底：validate_envelope 已按同一张表拒绝
            return self._refused(task.task_id, task.operation, TASK_OPERATION_UNKNOWN)
        try:
            data = self._dispatch(task, spec)
        except TaskRefused as refusal:
            # 已经进入实现函数：Agent 不再有资格声明"零副作用"，因此绝不能报 REFUSED。
            # 只读实现按 FAILED（无副作用，可重投）；可变更实现按 UNKNOWN（不可重投）。
            return self._execution_failure(task, spec, refusal)
        except Exception as error:  # noqa: BLE001 - 实现层异常不拖垮循环
            return self._execution_failure(task, spec, error)
        return make_result(
            task_id=task.task_id,
            node_uid=self.node_uid,
            operation=task.operation,
            status=RESULT_SUCCEEDED,
            data=data,
        )

    def _refused(self, task_id: str, operation: str, code: str) -> dict:
        return make_result(
            task_id=task_id,
            node_uid=self.node_uid,
            operation=operation,
            status=RESULT_REFUSED,
            code=code,
        )

    def _failed(self, task_id: str, operation: str, code: str) -> dict:
        return make_result(
            task_id=task_id,
            node_uid=self.node_uid,
            operation=operation,
            status=RESULT_FAILED,
            code=code,
        )

    def _unknown(self, task_id: str, operation: str, code: str) -> dict:
        return make_result(
            task_id=task_id,
            node_uid=self.node_uid,
            operation=operation,
            status=RESULT_UNKNOWN,
            code=code,
        )

    def _in_doubt(self, task: ValidatedTask, spec: OperationSpec, code: str) -> dict:
        self.logger.error(
            "task_execution_in_doubt",
            task_id=task.task_id,
            operation=task.operation,
            code=code,
            effect=spec.effect,
        )
        return self._unknown(task.task_id, task.operation, AGENT_EXECUTION_UNKNOWN)

    def _execution_failure(self, task: ValidatedTask, spec: OperationSpec, error: Exception) -> dict:
        """实现抛异常：只读 → FAILED（可重投）；may_mutate → UNKNOWN（绝不重投）。"""
        if spec.effect == MAY_MUTATE:
            self.logger.error(
                "task_execution_failed",
                task_id=task.task_id,
                operation=task.operation,
                status=RESULT_UNKNOWN,
                code=AGENT_EXECUTION_UNKNOWN,
                error_type=type(error).__name__,
            )
            return self._unknown(task.task_id, task.operation, AGENT_EXECUTION_UNKNOWN)
        code = self._failure_code(error)
        self.logger.error(
            "task_execution_failed",
            task_id=task.task_id,
            operation=task.operation,
            status=RESULT_FAILED,
            code=code,
            error_type=type(error).__name__,
        )
        return self._failed(task.task_id, task.operation, code)

    @staticmethod
    def _failure_code(error: Exception) -> str:
        candidate = getattr(error, "code", None)
        if isinstance(candidate, str) and EXECUTION_CODE_RE.fullmatch(candidate):
            return candidate
        return AGENT_EXECUTION_FAILED

    # -- 分派 ---------------------------------------------------------------
    def _dispatch(self, task: ValidatedTask, spec: OperationSpec) -> dict:
        self._check_interrupt()
        handler = getattr(self, spec.handler, None)
        if not callable(handler):
            # 声明表与实现不一致属于本地实现缺陷：按执行失败处理（只读 → FAILED）。
            raise RuntimeError("operation declaration has no handler")
        return handler(task)

    def _observe(self, task: ValidatedTask) -> dict:
        want = task.params.get("want")
        selected = tuple(DEFAULT_WANT) if want is None else tuple(want)
        return self.observer.observe(selected)

    def _service_status(self, task: ValidatedTask) -> dict:
        # 参数与白名单已在 validate_envelope 阶段校验：这里只执行，不再拒绝。
        selected = tuple(task.params.get("units") or ())
        units: dict[str, str] = {}
        for unit in selected:
            # 每个 unit 都是一次有超时的子进程；SIGTERM 时在两次之间停下，
            # 把"已读到的部分 + 中断"报成 FAILED（只读、无副作用、可重投）。
            self._check_interrupt()
            units[unit] = self.observer.unit_state(unit)
        return {
            "units": units,
            "configured_units": len(self.allowed_units),
        }

    def _capability_inspect(self, task: ValidatedTask) -> dict:
        return self.observer.capability()

    def _self_test(self, task: ValidatedTask) -> dict:
        nonce = task.params.get("nonce")
        return {
            "task_id": task.task_id,
            "node_uid": self.node_uid,
            "agent_version": self.agent_version,
            "nonce": nonce,
            "observed_at": format_timestamp(now_utc()),
        }
