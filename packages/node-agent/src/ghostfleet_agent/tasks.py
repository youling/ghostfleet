"""任务信封校验 + 只读 allowlist 分派（无 shell、无特权通路）。

ADR §5.3 / §7 的执行侧合同：
- 信封字段与 task_id/node_uid/时间窗全部 fail closed；
- operation 白名单之外一律 REFUSED + TASK_OPERATION_UNKNOWN（控制面另有
  TASK_OPERATION_FORBIDDEN，Agent 只是不认识）；
- params 递归禁用键 → TASK_PARAMS_FORBIDDEN；
- service.status.read 只允许配置里的 allowed_units 白名单，unit 名正则校验；
- 任何实现层异常都收敛为 REFUSED + AGENT_EXECUTION_FAILED，绝不抛出循环。
"""
from __future__ import annotations

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
    AGENT_UNIT_NOT_ALLOWED,
    MAX_PARAMS_DEPTH,
    NODE_UID_RE,
    RESULT_REFUSED,
    RESULT_SUCCEEDED,
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
SUPPORTED_OPERATIONS = frozenset(
    {OPERATION_OBSERVE, OPERATION_SERVICE_STATUS, OPERATION_CAPABILITY_INSPECT, OPERATION_SELF_TEST}
)

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
) -> ValidatedTask:
    """校验任务信封；任何不符抛 TaskRefused（稳定错误码）。"""
    if not isinstance(envelope, dict):
        raise TaskRefused(TASK_ENVELOPE_INVALID, "task envelope must be an object")
    extra = sorted(key for key in envelope if key not in {
        "schema", "task_id", "node_uid", "operation", "params", "issued_at", "expires_at", "attempt",
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
    return ValidatedTask(task_id, envelope_node_uid, operation, dict(params), int(attempt), issued_at, expires_at)


def _require_only_params(params: dict, allowed: set[str]) -> None:
    extra = sorted(key for key in params if key not in allowed)
    if extra:
        raise TaskRefused(TASK_PARAMS_FORBIDDEN, f"params field {extra[0]} is not allowed for this operation")


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
    ) -> None:
        self.node_uid = node_uid
        self.agent_version = agent_version
        self.allowed_units = tuple(allowed_units)
        self.observer = observer or Observer(node_uid=node_uid, agent_version=agent_version, allowed_units=self.allowed_units)
        self.logger = logger or get_logger()

    # -- 入口 ---------------------------------------------------------------
    def handle(self, envelope) -> dict:
        """校验并执行；永远返回结果 payload（SUCCEEDED 或 REFUSED）。"""
        task_id = envelope.get("task_id") if isinstance(envelope, dict) else None
        operation = envelope.get("operation") if isinstance(envelope, dict) else None
        safe_task_id = task_id if isinstance(task_id, str) else "unknown"
        safe_operation = operation if isinstance(operation, str) else "unknown"
        try:
            task = validate_envelope(envelope, node_uid=self.node_uid)
        except TaskRefused as refusal:
            return self._refused(safe_task_id, safe_operation, refusal.code)
        try:
            data = self._dispatch(task)
        except TaskRefused as refusal:
            return self._refused(task.task_id, task.operation, refusal.code)
        except Exception as error:  # noqa: BLE001 - 实现层异常不拖垮循环
            self.logger.error(
                "task_execution_failed",
                task_id=task.task_id,
                operation=task.operation,
                error_type=type(error).__name__,
            )
            return self._refused(task.task_id, task.operation, AGENT_EXECUTION_FAILED)
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

    # -- 分派 ---------------------------------------------------------------
    def _dispatch(self, task: ValidatedTask) -> dict:
        if task.operation == OPERATION_OBSERVE:
            return self._observe(task)
        if task.operation == OPERATION_SERVICE_STATUS:
            return self._service_status(task)
        if task.operation == OPERATION_CAPABILITY_INSPECT:
            return self._capability_inspect(task)
        if task.operation == OPERATION_SELF_TEST:
            return self._self_test(task)
        # 防御性兜底：validate_envelope 已拒绝未知 operation。
        raise TaskRefused(TASK_OPERATION_UNKNOWN, "operation is not dispatchable")

    def _observe(self, task: ValidatedTask) -> dict:
        _require_only_params(task.params, {"want"})
        want = task.params.get("want")
        if want is None:
            selected = tuple(DEFAULT_WANT)
        else:
            if not isinstance(want, list) or not want:
                raise TaskRefused(TASK_PARAMS_FORBIDDEN, "want must be a non-empty list")
            selected_list: list[str] = []
            for token in want:
                if not isinstance(token, str) or token not in WANT_TOKENS:
                    raise TaskRefused(TASK_PARAMS_FORBIDDEN, "want contains an unsupported fact")
                if token in selected_list:
                    raise TaskRefused(TASK_PARAMS_FORBIDDEN, "want contains duplicates")
                selected_list.append(token)
            selected = tuple(selected_list)
        return self.observer.observe(selected)

    def _service_status(self, task: ValidatedTask) -> dict:
        _require_only_params(task.params, {"units"})
        units = task.params.get("units")
        if not isinstance(units, list) or not units:
            raise TaskRefused(TASK_PARAMS_FORBIDDEN, "units must be a non-empty list")
        if len(units) > MAX_UNITS_PER_TASK:
            raise TaskRefused(TASK_PARAMS_FORBIDDEN, "at most 8 units per task")
        selected: list[str] = []
        for unit in units:
            if not isinstance(unit, str) or not UNIT_RE.fullmatch(unit):
                raise TaskRefused(TASK_PARAMS_FORBIDDEN, "unit name does not match the v0 unit pattern")
            if unit in selected:
                raise TaskRefused(TASK_PARAMS_FORBIDDEN, "unit list contains duplicates")
            selected.append(unit)
        if not self.allowed_units:
            raise TaskRefused(AGENT_UNIT_NOT_ALLOWED, "no allowed_units configured on this node")
        allowed = set(self.allowed_units)
        for unit in selected:
            if unit not in allowed:
                raise TaskRefused(AGENT_UNIT_NOT_ALLOWED, "unit is not in the local allowlist")
        return {
            "units": {unit: self.observer.unit_state(unit) for unit in selected},
            "configured_units": len(self.allowed_units),
        }

    def _capability_inspect(self, task: ValidatedTask) -> dict:
        _require_only_params(task.params, set())
        return self.observer.capability()

    def _self_test(self, task: ValidatedTask) -> dict:
        _require_only_params(task.params, {"nonce"})
        nonce = task.params.get("nonce")
        if nonce is not None and (not isinstance(nonce, str) or not is_valid_nonce(nonce)):
            raise TaskRefused(TASK_PARAMS_FORBIDDEN, "nonce must be base64url text of at least 16 bytes")
        return {
            "task_id": task.task_id,
            "node_uid": self.node_uid,
            "agent_version": self.agent_version,
            "nonce": nonce,
            "observed_at": format_timestamp(now_utc()),
        }
