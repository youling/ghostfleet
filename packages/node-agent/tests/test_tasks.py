"""tasks：信封 fail closed、只读分派、单位白名单、无 shell。"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import pytest

from agent_test_support import make_task
from ghostfleet_agent import protocol
from ghostfleet_agent.protocol import (
    AGENT_EXECUTION_FAILED,
    AGENT_EXECUTION_INTERRUPTED,
    AGENT_EXECUTION_UNKNOWN,
    AGENT_UNIT_NOT_ALLOWED,
    RESULT_FAILED,
    RESULT_REFUSED,
    RESULT_SUCCEEDED,
    RESULT_UNKNOWN,
    TASK_ENVELOPE_INVALID,
    TASK_EXPIRED,
    TASK_OPERATION_UNKNOWN,
    TASK_PARAMS_FORBIDDEN,
    TASK_SCOPE_MISMATCH,
    canonical_json,
)
from ghostfleet_agent.tasks import (
    MAY_MUTATE,
    MAX_TASKS_PER_HEARTBEAT,
    MAX_TASKS_PER_POLL,
    MAX_UNITS_PER_TASK,
    OPERATION_CAPABILITY_INSPECT,
    OPERATION_OBSERVE,
    OPERATION_SPECS,
    OPERATION_SELF_TEST,
    OPERATION_SERVICE_STATUS,
    READ_ONLY,
    SUPPORTED_OPERATIONS,
    OperationSpec,
    TaskExecutor,
    TaskRefused,
    ValidatedTask,
    validate_envelope,
)

NODE_UID = "node-00000000-0000-4000-8000-000000000000"
OTHER_NODE_UID = "node-11111111-1111-4111-8111-111111111111"
AGENT_VERSION = "0.1.0.dev0"
NOW = datetime(2026, 11, 12, 12, 0, 0, tzinfo=timezone.utc)


class StubObserver:
    def __init__(self, *, unit_states=None, capability=None, explode=False):
        self.unit_states = dict(unit_states or {})
        self.capability_payload = capability or {
            "status": "READ",
            "digest": "d" * 64,
            "components": {"runtime": "ready"},
        }
        self.explode = explode
        self.observed: list[tuple] = []

    def observe(self, want):
        self.observed.append(tuple(want))
        if self.explode:
            raise RuntimeError("boom")
        return {"status": "OK", "observed": {"want": list(want)}}

    def unit_state(self, unit):
        return self.unit_states.get(unit, "active")

    def capability(self):
        return self.capability_payload


def executor(**kwargs):
    kwargs.setdefault("observer", StubObserver())
    return TaskExecutor(node_uid=NODE_UID, agent_version=AGENT_VERSION, **kwargs)


# -- 信封校验 ---------------------------------------------------------------
def test_valid_envelope_is_accepted():
    task = validate_envelope(make_task(node_uid=NODE_UID), node_uid=NODE_UID)
    assert isinstance(task, ValidatedTask)
    assert (task.task_id, task.operation, task.attempt) == ("task-0001", OPERATION_OBSERVE, 1)
    assert task.params == {}
    assert "ValidatedTask" in repr(task)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda envelope: envelope.pop("schema"),
        lambda envelope: envelope.update(schema="other/v0"),
        lambda envelope: envelope.update(command="rm -rf /"),
    ],
)
def test_bad_envelope_shape_is_refused(mutate):
    envelope = make_task(node_uid=NODE_UID)
    mutate(envelope)
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


@pytest.mark.parametrize("envelope", [None, [], "task", 42])
def test_non_object_envelope_is_refused(envelope):
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_lease_expires_at_from_control_plane_is_accepted_and_executed():
    # ADR §5.2：控制面任务信封含 lease_expires_at（300 s 租约），必须接受并照常执行。
    envelope = make_task(node_uid=NODE_UID)
    envelope["lease_expires_at"] = "2026-11-12T12:05:00Z"
    task = validate_envelope(envelope, node_uid=NODE_UID)
    assert task.task_id == "task-0001"
    result = executor().handle(envelope)
    assert result["status"] == RESULT_SUCCEEDED


def test_missing_lease_expires_at_is_still_accepted():
    # 兼容旧控制面与本地测试：字段可缺失。
    envelope = make_task(node_uid=NODE_UID)
    assert "lease_expires_at" not in envelope
    assert validate_envelope(envelope, node_uid=NODE_UID).task_id == "task-0001"


@pytest.mark.parametrize(
    "lease",
    ["2026-11-12T12:05:00+00:00", "2026-11-12 12:05:00Z", "not-a-time", "", 300, None],
)
def test_malformed_lease_expires_at_is_refused(lease):
    envelope = make_task(node_uid=NODE_UID)
    envelope["lease_expires_at"] = lease
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_lease_expires_at_does_not_change_expiry_semantics():
    # 过期只看 expires_at：租约字段存在也不影响 TASK_EXPIRED 的判定顺序。
    envelope = make_task(
        node_uid=NODE_UID,
        issued_at=protocol.format_timestamp(NOW - timedelta(seconds=400)),
        expires_at=protocol.format_timestamp(NOW - timedelta(seconds=1)),
    )
    envelope["lease_expires_at"] = "2026-11-12T12:10:00Z"
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID, now=NOW)
    assert excinfo.value.code == TASK_EXPIRED


@pytest.mark.parametrize("task_id", ["", "has space", "../escape", "-leading", "x" * 97, "bad/slash"])
def test_unsafe_task_id_is_refused(task_id):
    envelope = make_task(node_uid=NODE_UID)
    envelope["task_id"] = task_id
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_scope_mismatch_is_refused():
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(make_task(node_uid=OTHER_NODE_UID), node_uid=NODE_UID)
    assert excinfo.value.code == TASK_SCOPE_MISMATCH


@pytest.mark.parametrize(
    "node_uid", ["node-bad", "", "node-00000000-0000-4000-8000-00000000000Z"]
)
def test_malformed_node_uid_is_refused(node_uid):
    envelope = make_task(node_uid=NODE_UID)
    envelope["node_uid"] = node_uid
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_missing_operation_is_refused():
    envelope = make_task(node_uid=NODE_UID)
    envelope.pop("operation")
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


@pytest.mark.parametrize("params", [None, [], "observe", 5])
def test_non_object_params_are_refused(params):
    envelope = make_task(node_uid=NODE_UID)
    envelope["params"] = params
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_PARAMS_FORBIDDEN


def test_forbidden_params_key_is_refused():
    envelope = make_task(node_uid=NODE_UID, params={"shell": "true"})
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_PARAMS_FORBIDDEN


def test_deep_params_are_refused():
    envelope = make_task(node_uid=NODE_UID, params={"a": {"b": {"c": {"d": 1}}}})
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_PARAMS_FORBIDDEN


@pytest.mark.parametrize("attempt", [0, 4, -1, True, "1", 1.0])
def test_invalid_attempt_is_refused(attempt):
    envelope = make_task(node_uid=NODE_UID)
    envelope["attempt"] = attempt
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_timestamps_must_be_rfc3339_z():
    envelope = make_task(node_uid=NODE_UID)
    envelope["issued_at"] = "2026-11-12T12:00:00+00:00"
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_lifetime_over_six_hundred_seconds_is_refused():
    envelope = make_task(
        node_uid=NODE_UID,
        issued_at=protocol.format_timestamp(NOW),
        expires_at=protocol.format_timestamp(NOW + timedelta(seconds=601)),
    )
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID, now=NOW)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_expired_task_is_refused():
    envelope = make_task(
        node_uid=NODE_UID,
        # lifetime 必须 ≤600 s，否则先命中 TASK_ENVELOPE_INVALID 而不是 TASK_EXPIRED。
        issued_at=protocol.format_timestamp(NOW - timedelta(seconds=400)),
        expires_at=protocol.format_timestamp(NOW - timedelta(seconds=1)),
    )
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID, now=NOW)
    assert excinfo.value.code == TASK_EXPIRED


def test_future_issued_at_beyond_skew_is_refused():
    issued = NOW + timedelta(seconds=601)
    envelope = make_task(
        node_uid=NODE_UID,
        issued_at=protocol.format_timestamp(issued),
        expires_at=protocol.format_timestamp(issued + timedelta(seconds=300)),
    )
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(envelope, node_uid=NODE_UID, now=NOW)
    assert excinfo.value.code == TASK_ENVELOPE_INVALID


def test_unknown_operation_is_refused():
    with pytest.raises(TaskRefused) as excinfo:
        validate_envelope(make_task(node_uid=NODE_UID, operation="shell.exec"), node_uid=NODE_UID)
    assert excinfo.value.code == TASK_OPERATION_UNKNOWN


# -- 分派：错误路径 ---------------------------------------------------------
def test_handle_invalid_envelope_returns_refused_result():
    result = executor().handle({"task_id": "task-0001", "operation": "node.observe"})
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == TASK_ENVELOPE_INVALID
    assert result["task_id"] == "task-0001"
    assert result["node_uid"] == NODE_UID
    canonical_json(result)


def test_handle_missing_task_id_uses_unknown_placeholders():
    result = executor().handle({"schema": protocol.SCHEMA_TASK})
    assert (result["task_id"], result["operation"]) == ("unknown", "unknown")
    assert result["status"] == RESULT_REFUSED


class MutatingExecutor(TaskExecutor):
    """测试替身：显式声明一个 may_mutate operation，执行到一半抛异常。"""

    def __init__(self, **kwargs):
        operations = dict(OPERATION_SPECS)
        operations["test.mutate"] = OperationSpec("test.mutate", MAY_MUTATE, "_mutate")
        super().__init__(operations=operations, **kwargs)

    def _mutate(self, task):
        raise RuntimeError("side effect may have happened")


def test_read_only_implementation_error_is_failed_not_refused():
    result = executor(observer=StubObserver(explode=True)).handle(make_task(node_uid=NODE_UID))
    assert result["status"] == RESULT_FAILED
    assert result["status"] != RESULT_REFUSED
    assert result["code"] == AGENT_EXECUTION_FAILED


def test_validation_refusal_never_calls_the_implementation():
    observer = StubObserver()
    result = executor(observer=observer).handle(
        make_task(node_uid=NODE_UID, params={"want": ["not-a-fact"]})
    )
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == TASK_PARAMS_FORBIDDEN
    assert observer.observed == []  # spy：实现函数 0 次调用


class RecordingObserver(StubObserver):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.unit_calls: list[str] = []

    def unit_state(self, unit):
        self.unit_calls.append(unit)
        return super().unit_state(unit)


def test_disallowed_unit_is_refused_before_any_observer_call():
    observer = RecordingObserver()
    result = executor(observer=observer, allowed_units=("agent.service",)).handle(
        make_task(node_uid=NODE_UID, operation=OPERATION_SERVICE_STATUS, params={"units": ["other.service"]})
    )
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == AGENT_UNIT_NOT_ALLOWED
    assert observer.unit_calls == []  # 白名单校验在 validate 阶段，实现/子进程 0 次调用


def test_invalid_units_are_refused_before_any_observer_call():
    observer = RecordingObserver()
    result = executor(observer=observer, allowed_units=("agent.service",)).handle(
        make_task(
            node_uid=NODE_UID,
            operation=OPERATION_SERVICE_STATUS,
            params={"units": ["agent.service", "agent.service"]},
        )
    )
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == TASK_PARAMS_FORBIDDEN
    assert observer.unit_calls == []


def test_may_mutate_implementation_error_is_unknown_not_refused():
    result = MutatingExecutor(node_uid=NODE_UID, agent_version=AGENT_VERSION).handle(
        make_task(node_uid=NODE_UID, operation="test.mutate")
    )
    assert result["status"] == RESULT_UNKNOWN
    assert result["status"] not in (RESULT_REFUSED, RESULT_FAILED)
    assert result["code"] == AGENT_EXECUTION_UNKNOWN


def test_v0_operations_are_declared_read_only_with_real_handlers():
    assert set(OPERATION_SPECS) == SUPPORTED_OPERATIONS
    assert {spec.effect for spec in OPERATION_SPECS.values()} == {READ_ONLY}
    probe = TaskExecutor(node_uid=NODE_UID, agent_version=AGENT_VERSION, observer=StubObserver())
    for spec in OPERATION_SPECS.values():
        assert callable(getattr(probe, spec.handler))


def test_supported_operations_is_the_read_only_vocabulary():
    assert SUPPORTED_OPERATIONS == frozenset(
        {OPERATION_OBSERVE, OPERATION_SERVICE_STATUS, OPERATION_CAPABILITY_INSPECT, OPERATION_SELF_TEST}
    )
    assert (MAX_TASKS_PER_POLL, MAX_TASKS_PER_HEARTBEAT) == (4, 2)


# -- node.observe -----------------------------------------------------------
def test_observe_dispatches_default_want():
    observer = StubObserver()
    result = executor(observer=observer).handle(make_task(node_uid=NODE_UID))
    assert result["status"] == RESULT_SUCCEEDED
    assert observer.observed == [("identity", "os", "uptime", "disk", "services")]
    assert result["data"]["observed"]["want"] == list(observer.observed[0])


def test_observe_custom_want_is_passed_through():
    observer = StubObserver()
    result = executor(observer=observer).handle(
        make_task(node_uid=NODE_UID, params={"want": ["identity", "capability"]})
    )
    assert result["status"] == RESULT_SUCCEEDED
    assert observer.observed == [("identity", "capability")]


@pytest.mark.parametrize(
    "params",
    [
        {"want": []},
        {"want": "identity"},
        {"want": ["identity", "identity"]},
        {"want": ["shell"]},
        {"want": ["identity"], "extra": 1},
    ],
)
def test_observe_rejects_bad_want(params):
    result = executor().handle(make_task(node_uid=NODE_UID, params=params))
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == TASK_PARAMS_FORBIDDEN


# -- service.status.read ----------------------------------------------------
def test_service_status_requires_allowlist():
    result = executor().handle(
        make_task(
            node_uid=NODE_UID,
            operation=OPERATION_SERVICE_STATUS,
            params={"units": ["agent.service"]},
        )
    )
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == AGENT_UNIT_NOT_ALLOWED


def test_service_status_rejects_unit_outside_allowlist():
    result = executor(allowed_units=("agent.service",)).handle(
        make_task(
            node_uid=NODE_UID,
            operation=OPERATION_SERVICE_STATUS,
            params={"units": ["other.service"]},
        )
    )
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == AGENT_UNIT_NOT_ALLOWED


def test_service_status_reads_allowed_units():
    observer = StubObserver(unit_states={"agent.service": "failed"})
    result = executor(allowed_units=("agent.service",), observer=observer).handle(
        make_task(
            node_uid=NODE_UID,
            operation=OPERATION_SERVICE_STATUS,
            params={"units": ["agent.service"]},
        )
    )
    assert result["status"] == RESULT_SUCCEEDED
    assert result["data"] == {
        "units": {"agent.service": "failed"},
        "configured_units": 1,
    }


@pytest.mark.parametrize(
    "units",
    [
        None,
        [],
        "agent.service",
        [1],
        ["Bad Name"],
        ["agent.service", "agent.service"],
        ["agent.service"] * (MAX_UNITS_PER_TASK + 1),
    ],
)
def test_service_status_rejects_bad_units(units):
    result = executor(allowed_units=("agent.service",)).handle(
        make_task(
            node_uid=NODE_UID,
            operation=OPERATION_SERVICE_STATUS,
            params={"units": units},
        )
    )
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == TASK_PARAMS_FORBIDDEN


# -- capability.inspect -----------------------------------------------------
def test_capability_inspect_returns_digest_and_states():
    result = executor().handle(
        make_task(node_uid=NODE_UID, operation=OPERATION_CAPABILITY_INSPECT)
    )
    assert result["status"] == RESULT_SUCCEEDED
    assert result["data"]["digest"] == "d" * 64
    assert result["data"]["components"] == {"runtime": "ready"}


def test_capability_inspect_rejects_params():
    result = executor().handle(
        make_task(
            node_uid=NODE_UID,
            operation=OPERATION_CAPABILITY_INSPECT,
            params={"path": "/etc/shadow"},
        )
    )
    assert result["status"] == RESULT_REFUSED
    assert result["code"] == TASK_PARAMS_FORBIDDEN


# -- agent.self.test --------------------------------------------------------
def test_self_test_echoes_nonce_and_versions():
    nonce = protocol.new_nonce()
    result = executor().handle(
        make_task(node_uid=NODE_UID, operation=OPERATION_SELF_TEST, params={"nonce": nonce})
    )
    assert result["status"] == RESULT_SUCCEEDED
    assert result["data"]["nonce"] == nonce
    assert result["data"]["node_uid"] == NODE_UID
    assert result["data"]["agent_version"] == AGENT_VERSION
    assert result["data"]["task_id"] == "task-0001"
    assert protocol.parse_timestamp(result["data"]["observed_at"])


def test_self_test_without_nonce_and_with_bad_nonce():
    result = executor().handle(make_task(node_uid=NODE_UID, operation=OPERATION_SELF_TEST))
    assert result["status"] == RESULT_SUCCEEDED
    assert result["data"]["nonce"] is None
    refused = executor().handle(
        make_task(node_uid=NODE_UID, operation=OPERATION_SELF_TEST, params={"nonce": "short"})
    )
    assert refused["status"] == RESULT_REFUSED
    assert refused["code"] == TASK_PARAMS_FORBIDDEN


# -- SIGTERM 协作式取消（P1：退出延迟） --------------------------------------
class InterruptingObserver(StubObserver):
    """第一次 unit_state 之后置中断事件：模拟 SIGTERM 落在任务执行中间。"""

    def __init__(self, interrupt, *, units):
        super().__init__(unit_states={unit: "active" for unit in units})
        self.interrupt = interrupt
        self.units_read: list[str] = []

    def unit_state(self, unit):
        state = super().unit_state(unit)
        self.units_read.append(unit)
        self.interrupt.set()
        return state


def test_interrupt_before_implementation_is_failed_not_refused():
    interrupt = threading.Event()
    interrupt.set()
    observer = StubObserver()
    result = executor(observer=observer, interrupt=interrupt).handle(make_task(node_uid=NODE_UID))
    # 绝不能冒充 REFUSED：REFUSED 是"实现从未被调用"的承诺；这里是 SIGTERM 中止。
    assert result["status"] == RESULT_FAILED
    assert result["code"] == AGENT_EXECUTION_INTERRUPTED
    assert observer.observed == []


def test_interrupt_between_units_stops_the_rest_of_the_task():
    interrupt = threading.Event()
    units = ["a.service", "b.service", "c.service"]
    observer = InterruptingObserver(interrupt, units=units)
    interruptible = TaskExecutor(
        node_uid=NODE_UID,
        agent_version=AGENT_VERSION,
        observer=observer,
        allowed_units=units,
        interrupt=interrupt,
    )
    result = interruptible.handle(
        make_task(node_uid=NODE_UID, operation=OPERATION_SERVICE_STATUS, params={"units": units})
    )
    assert result["status"] == RESULT_FAILED
    assert result["code"] == AGENT_EXECUTION_INTERRUPTED
    assert observer.units_read == ["a.service"]  # 剩余 unit 一次都没读


def test_interrupt_with_may_mutate_implementation_is_unknown():
    interrupt = threading.Event()
    interrupt.set()
    result = MutatingExecutor(
        node_uid=NODE_UID, agent_version=AGENT_VERSION, observer=StubObserver(), interrupt=interrupt
    ).handle(make_task(node_uid=NODE_UID, operation="test.mutate"))
    assert result["status"] == RESULT_UNKNOWN
    assert result["code"] == AGENT_EXECUTION_UNKNOWN
