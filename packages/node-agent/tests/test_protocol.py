"""协议纯函数：canonical JSON、时间戳、nonce、禁用键、结果构造。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from ghostfleet_agent import protocol
from ghostfleet_agent.protocol import (
    MAX_PARAMS_BYTES,
    ProtocolError,
    canonical_json,
    check_params,
    container_depth,
    decode_json,
    digest_of,
    find_forbidden_key,
    format_timestamp,
    is_valid_nonce,
    make_result,
    new_nonce,
    parse_timestamp,
)


def test_canonical_json_is_sorted_and_compact():
    assert canonical_json({"b": 1, "a": [2, 3]}) == '{"a":[2,3],"b":1}'
    assert canonical_json({"text": "中文"}) == '{"text":"中文"}'


def test_digest_is_order_independent_and_stable():
    left = digest_of({"a": 1, "b": {"c": 2}})
    right = digest_of({"b": {"c": 2}, "a": 1})
    assert left == right
    assert len(left) == 64
    assert all(char in "0123456789abcdef" for char in left)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), object()])
def test_canonical_json_rejects_non_serialisable(value):
    with pytest.raises(ProtocolError) as error:
        canonical_json(value)
    assert error.value.code == "AGENT_PROTOCOL_INVALID"


def test_decode_json_rejects_nan_infinity_duplicates():
    for text in ['{"a": NaN}', '{"a": Infinity}', '{"a": -Infinity}', '{"a": 1, "a": 2}']:
        with pytest.raises(ProtocolError) as error:
            decode_json(text)
        assert error.value.code == "AGENT_PROTOCOL_INVALID"


def test_decode_json_detects_invalid_document():
    with pytest.raises(ProtocolError):
        decode_json("{")
    assert decode_json('{"a": 1}') == {"a": 1}


def test_decode_json_uses_custom_error_code():
    with pytest.raises(ProtocolError) as error:
        decode_json("NaN", error_code="CONFIG_JSON_INVALID")
    assert error.value.code == "CONFIG_JSON_INVALID"


def test_nonce_shape_and_entropy():
    nonce = new_nonce()
    assert is_valid_nonce(nonce)
    assert len(new_nonce()) >= 22
    assert new_nonce() != new_nonce()
    assert not is_valid_nonce("short")
    assert not is_valid_nonce("!" * 24)
    assert not is_valid_nonce(None)


def test_nonce_requires_minimum_bytes():
    with pytest.raises(ProtocolError):
        new_nonce(8)


def test_timestamp_roundtrip_and_z_suffix_only():
    moment = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    text = format_timestamp(moment)
    assert text == "2026-01-02T03:04:05Z"
    assert parse_timestamp(text) == moment
    for bad in ["2026-01-02T03:04:05+00:00", "2026-01-02T03:04:05", "2026-01-02", "2026-13-01T00:00:00Z", ""]:
        with pytest.raises(ProtocolError):
            parse_timestamp(bad)


def test_timestamp_naive_is_treated_as_utc():
    naive = datetime(2026, 1, 2, 3, 4, 5)
    assert format_timestamp(naive) == "2026-01-02T03:04:05Z"


def test_container_depth_and_forbidden_keys():
    assert container_depth({"a": 1}) == 1
    assert container_depth({"a": {"b": {}}}) == 3
    assert find_forbidden_key({"want": ["identity"]}) is None
    assert find_forbidden_key({"command": "x"}) == "command"
    assert find_forbidden_key({"nested": {"script": "x"}}) == "nested.script"
    assert find_forbidden_key({"list": [{"cmd": "x"}]}) == "list[0].cmd"
    assert find_forbidden_key({"COMMAND": "x"}) == "COMMAND"


def test_check_params_accepts_bounded_v0_params():
    check_params({})
    check_params({"want": ["identity", "os"]})
    check_params({"units": ["ssh.service"]})


@pytest.mark.parametrize(
    "params",
    [
        None,
        [],
        "text",
        {"command": "rm -rf /"},
        {"args": ["x"]},
        {"a": {"b": {"c": {"d": 1}}}},
        {"a": float("nan")},
        {"data": "x" * (MAX_PARAMS_BYTES + 1)},
    ],
)
def test_check_params_is_fail_closed(params):
    with pytest.raises(ProtocolError) as error:
        check_params(params)
    assert error.value.code == "TASK_PARAMS_FORBIDDEN"


def test_params_size_limit_is_exact():
    accepted = {"data": "x" * (MAX_PARAMS_BYTES - 16)}
    check_params(accepted)
    with pytest.raises(ProtocolError):
        check_params({"data": "x" * MAX_PARAMS_BYTES})


def test_make_result_success_shape():
    result = make_result(
        task_id="task-0001",
        node_uid="node-00000000-0000-4000-8000-000000000000",
        operation="node.observe",
        status="SUCCEEDED",
        data={"identity": {}},
    )
    assert result["schema"] == protocol.SCHEMA_TASK
    assert result["status"] == "SUCCEEDED"
    assert "code" not in result
    assert result["observed_at"].endswith("Z")


def test_make_result_refused_carries_code():
    result = make_result(
        task_id="task-0001",
        node_uid="node-00000000-0000-4000-8000-000000000000",
        operation="node.observe",
        status="REFUSED",
        code="TASK_PARAMS_FORBIDDEN",
    )
    assert result["code"] == "TASK_PARAMS_FORBIDDEN"
    assert "data" not in result


def test_make_result_rejects_unknown_status_and_unsafe_data():
    with pytest.raises(ProtocolError):
        make_result(
            task_id="task-0001",
            node_uid="node-00000000-0000-4000-8000-000000000000",
            operation="node.observe",
            status="CRASHED",
        )
    with pytest.raises(ProtocolError):
        make_result(
            task_id="task-0001",
            node_uid="node-00000000-0000-4000-8000-000000000000",
            operation="node.observe",
            status="SUCCEEDED",
            data={"value": float("inf")},
        )
