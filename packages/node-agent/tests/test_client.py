"""client：请求头/信封、稳定分类、nonce 重试、拒绝重定向、关闭环境代理。"""
from __future__ import annotations

import json
import urllib.request

import pytest

from agent_test_support import TEST_AGENT_VERSION, TEST_TOKEN
from ghostfleet_agent import protocol
from ghostfleet_agent.client import (
    CATEGORY_RESULT,
    ControlPlaneClient,
    GuardedRedirectHandler,
    TransportError,
    TransportResponse,
    UrllibTransport,
    _extract_error_code,
    build_envelope,
    parse_retry_after,
)
from ghostfleet_agent.protocol import (
    AGENT_CONTROL_PLANE_UNREACHABLE,
    AGENT_INVALID_RESPONSE,
    AGENT_NETWORK_ERROR,
    AGENT_PAYLOAD_TOO_LARGE,
    AGENT_REDIRECT_REFUSED,
    NODE_AUTH_INVALID,
    NODE_BOOT_ID_CAPACITY_REACHED,
    NODE_BOOT_REPLAY,
    NODE_CLOCK_SKEW,
    NODE_NONCE_REPLAY,
    NODE_RATE_LIMITED,
    NODE_SCOPE_MISMATCH,
    NODE_SEQ_REGRESSION,
    OUTCOME_AUTH_FATAL,
    OUTCOME_BOOT_REPLAY,
    OUTCOME_DENIED,
    OUTCOME_INVALID_RESPONSE,
    OUTCOME_NETWORK_ERROR,
    OUTCOME_NONCE_REPLAY,
    OUTCOME_OK,
    OUTCOME_RATE_LIMITED,
    OUTCOME_REJECTED,
    OUTCOME_SERVER_ERROR,
    OUTCOME_SEQ_REGRESSION,
    OUTCOME_TRANSPORT_REFUSED,
    TASK_OPERATION_MISMATCH,
    TASK_RESULT_CONFLICT,
    TASK_RESULT_SCHEMA_UNSUPPORTED,
    TASK_RESULT_SCOPE_MISMATCH,
    ProtocolError,
)

NODE_UID = "node-00000000-0000-4000-8000-000000000000"
BASE_URL = "https://control.example.invalid"


class FakeTransport:
    def __init__(self, responses=None, error=None):
        self.responses = list(responses or [])
        self.error = error
        self.calls = []

    def post(self, url, *, headers, body, timeout_s):
        self.calls.append({"url": url, "headers": headers, "body": body, "timeout_s": timeout_s})
        if self.error is not None:
            raise self.error
        if self.responses:
            item = self.responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return TransportResponse(200, b"{}")


def make_client(transport, *, base_url=BASE_URL, **kwargs):
    return ControlPlaneClient(
        base_url=base_url,
        node_uid=NODE_UID,
        agent_version=TEST_AGENT_VERSION,
        token=TEST_TOKEN,
        transport=transport,
        **kwargs,
    )


def json_response(status, payload):
    return TransportResponse(status, json.dumps(payload).encode("utf-8"))


def heartbeat(client):
    return client.heartbeat(
        lambda nonce: build_envelope(node_uid=NODE_UID, boot_id="boot-0001", seq=1, nonce=nonce)
    )


# -- 构造与请求头 -----------------------------------------------------------
def test_headers_carry_bearer_and_node_identity():
    transport = FakeTransport()
    heartbeat(make_client(transport))
    headers = transport.calls[0]["headers"]
    assert headers["Authorization"] == f"Bearer {TEST_TOKEN}"
    assert headers["x-ghostfleet-node-uid"] == NODE_UID
    assert headers["x-ghostfleet-agent-version"] == TEST_AGENT_VERSION
    assert headers["content-type"] == "application/json"
    assert transport.calls[0]["timeout_s"] == 10.0


def test_result_path_is_node_scoped():
    client = make_client(FakeTransport())
    assert client.result_path("task-0001") == f"/v0/nodes/{NODE_UID}/tasks/task-0001/result"


def test_empty_token_and_base_url_are_rejected():
    with pytest.raises(ProtocolError) as excinfo:
        ControlPlaneClient(
            base_url=BASE_URL, node_uid=NODE_UID, agent_version=TEST_AGENT_VERSION, token=""
        )
    assert excinfo.value.code == NODE_AUTH_INVALID
    with pytest.raises(ProtocolError) as excinfo:
        ControlPlaneClient(
            base_url="", node_uid=NODE_UID, agent_version=TEST_AGENT_VERSION, token=TEST_TOKEN
        )
    assert excinfo.value.code == AGENT_CONTROL_PLANE_UNREACHABLE


def test_build_envelope_has_protocol_fields():
    envelope = build_envelope(node_uid=NODE_UID, boot_id="boot-0001", seq=7, nonce="a" * 22)
    assert envelope["schema"] == protocol.SCHEMA_AGENT
    assert envelope["node_uid"] == NODE_UID
    assert envelope["boot_id"] == "boot-0001"
    assert envelope["seq"] == 7
    assert protocol.is_valid_nonce(envelope["nonce"])
    assert protocol.parse_timestamp(envelope["sent_at"])
    protocol.canonical_bytes(envelope)


def test_build_envelope_rejects_field_collision():
    with pytest.raises(ProtocolError):
        build_envelope(
            node_uid=NODE_UID, boot_id="boot", seq=1, nonce="a" * 22, extra={"seq": 2}
        )


# -- 成功响应 ---------------------------------------------------------------
@pytest.mark.parametrize(
    "value, expected",
    [
        (5, 30.0),
        (15, 30.0),
        (0, 30.0),
        (-30, 30.0),
        (300, 300.0),
        (1000, 300.0),
        ("30", None),
        (True, None),
        (None, None),
    ],
)
def test_heartbeat_interval_is_clamped(value, expected):
    transport = FakeTransport([json_response(200, {"interval_s": value, "tasks": []})])
    response = heartbeat(make_client(transport))
    assert response.ok
    assert response.interval_s == expected


@pytest.mark.parametrize("category, limit", [("heartbeat", 2), ("poll", 4)])
def test_task_lists_are_bounded(category, limit):
    tasks = [{"task_id": f"task-{index}"} for index in range(limit + 1)]
    payload = {"tasks": tasks, "interval_s": 30}
    transport = FakeTransport([json_response(200, payload)])
    client = make_client(transport)
    response = heartbeat(client) if category == "heartbeat" else client.poll(lambda nonce: {"nonce": nonce})
    assert response.kind == OUTCOME_INVALID_RESPONSE
    assert response.code == AGENT_INVALID_RESPONSE


def test_task_lists_are_parsed():
    transport = FakeTransport(
        [json_response(200, {"interval_s": 30, "tasks": [{"task_id": "task-1"}, {"task_id": "task-2"}]})]
    )
    response = heartbeat(make_client(transport))
    assert [task["task_id"] for task in response.tasks] == ["task-1", "task-2"]


@pytest.mark.parametrize("raw", [b"[]", b"not json", b""])
def test_non_object_success_body_is_invalid(raw):
    transport = FakeTransport([TransportResponse(200, raw)])
    response = heartbeat(make_client(transport))
    assert response.kind == OUTCOME_INVALID_RESPONSE
    assert response.code == AGENT_INVALID_RESPONSE


# -- 状态分类 ---------------------------------------------------------------
@pytest.mark.parametrize(
    "status, payload, expected_kind, expected_code",
    [
        (401, {"code": NODE_AUTH_INVALID}, OUTCOME_AUTH_FATAL, NODE_AUTH_INVALID),
        (401, {}, OUTCOME_AUTH_FATAL, NODE_AUTH_INVALID),
        (401, {"code": NODE_CLOCK_SKEW}, OUTCOME_DENIED, NODE_CLOCK_SKEW),
        # ADR §5.1-4/合同 3：401/403 都是 FATAL——停止上报等待人类修复。
        (403, {"code": NODE_SCOPE_MISMATCH}, OUTCOME_AUTH_FATAL, NODE_SCOPE_MISMATCH),
        (403, {}, OUTCOME_AUTH_FATAL, NODE_SCOPE_MISMATCH),
        (429, {}, OUTCOME_RATE_LIMITED, NODE_RATE_LIMITED),
        (500, {}, OUTCOME_SERVER_ERROR, "AGENT_SERVER_ERROR"),
        (503, {"code": NODE_RATE_LIMITED}, OUTCOME_SERVER_ERROR, NODE_RATE_LIMITED),
        (302, {}, OUTCOME_TRANSPORT_REFUSED, AGENT_REDIRECT_REFUSED),
        (400, {}, OUTCOME_DENIED, None),
        (413, {}, OUTCOME_DENIED, None),
        (415, {}, OUTCOME_DENIED, None),
    ],
)
def test_heartbeat_status_classification(status, payload, expected_kind, expected_code):
    transport = FakeTransport([json_response(status, payload)])
    response = heartbeat(make_client(transport))
    assert (response.kind, response.status, response.code) == (expected_kind, status, expected_code)


@pytest.mark.parametrize(
    "status, payload, expected_kind, expected_code",
    [
        (409, {"code": TASK_RESULT_CONFLICT}, OUTCOME_REJECTED, TASK_RESULT_CONFLICT),
        (409, {"code": "SOMETHING_ELSE"}, OUTCOME_DENIED, "SOMETHING_ELSE"),
        (400, {"code": "TASK_ENVELOPE_INVALID"}, OUTCOME_REJECTED, "TASK_ENVELOPE_INVALID"),
        (413, {}, OUTCOME_REJECTED, None),
        (415, {}, OUTCOME_REJECTED, None),
    ],
)
def test_result_status_classification(status, payload, expected_kind, expected_code):
    transport = FakeTransport([json_response(status, payload)])
    response = make_client(transport).send_result_body(lambda nonce: {"nonce": nonce}, "task-0001")
    assert (response.kind, response.code) == (expected_kind, expected_code)


# -- nonce 重试 -------------------------------------------------------------
def test_nonce_replay_retries_once_with_fresh_nonce():
    transport = FakeTransport(
        [
            json_response(409, {"code": NODE_NONCE_REPLAY}),
            json_response(200, {"interval_s": 30, "tasks": []}),
        ]
    )
    response = heartbeat(make_client(transport))
    assert response.ok
    assert len(transport.calls) == 2
    nonces = [json.loads(call["body"])["nonce"] for call in transport.calls]
    assert nonces[0] != nonces[1]


def test_nonce_replay_twice_is_not_retried_forever():
    transport = FakeTransport([json_response(409, {"code": NODE_NONCE_REPLAY})] * 3)
    response = heartbeat(make_client(transport))
    assert response.kind == OUTCOME_NONCE_REPLAY
    assert len(transport.calls) == 2


# -- 传输层错误 -------------------------------------------------------------
@pytest.mark.parametrize(
    "kind, expected_kind, expected_code",
    [
        ("TIMEOUT", OUTCOME_NETWORK_ERROR, AGENT_NETWORK_ERROR),
        ("NETWORK", OUTCOME_NETWORK_ERROR, AGENT_NETWORK_ERROR),
        ("TLS", OUTCOME_NETWORK_ERROR, AGENT_NETWORK_ERROR),
        ("REDIRECT_REFUSED", OUTCOME_TRANSPORT_REFUSED, AGENT_REDIRECT_REFUSED),
        ("TOO_LARGE", OUTCOME_INVALID_RESPONSE, AGENT_INVALID_RESPONSE),
    ],
)
def test_transport_errors_are_classified(kind, expected_kind, expected_code):
    transport = FakeTransport(error=TransportError(kind))
    response = heartbeat(make_client(transport))
    assert (response.kind, response.code) == (expected_kind, expected_code)


def test_oversized_request_body_is_refused_without_network_io():
    transport = FakeTransport()
    client = make_client(transport)
    with pytest.raises(ProtocolError) as excinfo:
        client.heartbeat(lambda nonce: {"nonce": nonce, "blob": "x" * 20000})
    assert excinfo.value.code == AGENT_PAYLOAD_TOO_LARGE
    assert transport.calls == []


def test_unserialisable_body_returns_invalid_response():
    transport = FakeTransport()
    response = make_client(transport).heartbeat(
        lambda nonce: {"nonce": nonce, "bad": float("nan")}
    )
    assert response.kind == OUTCOME_INVALID_RESPONSE
    assert transport.calls == []


# -- 错误码提取与重定向策略 -------------------------------------------------
@pytest.mark.parametrize(
    "document, expected",
    [
        ({"code": "NODE_AUTH_INVALID"}, "NODE_AUTH_INVALID"),
        ({"error": {"code": "NODE_CLOCK_SKEW"}}, "NODE_CLOCK_SKEW"),
        ({"code": "lowercase"}, None),
        ({"code": 5}, None),
        ([], None),
        (None, None),
    ],
)
def test_extract_error_code(document, expected):
    assert _extract_error_code(document) == expected


def test_redirect_handler_refuses_every_redirect():
    with pytest.raises(TransportError) as excinfo:
        GuardedRedirectHandler().redirect_request(
            None, None, 302, "Found", {}, "https://elsewhere.invalid/"
        )
    assert excinfo.value.kind == "REDIRECT_REFUSED"


# -- 真实 urllib 传输 -------------------------------------------------------
def test_urllib_transport_disables_environment_proxies():
    # build_opener 会跳过默认 ProxyHandler，且自定义实例不会进 handlers 列表；
    # 净效果就是"完全不使用代理"。这里断言结构上没有任何 ProxyHandler 生效。
    transport = UrllibTransport()
    handlers = transport._opener.handlers
    assert not [handler for handler in handlers if isinstance(handler, urllib.request.ProxyHandler)]
    assert urllib.request.getproxies() is not None  # 环境里可能有代理变量，但传输层不用它们


def test_real_transport_sends_headers_and_parses_heartbeat(control_plane):
    client = make_client(UrllibTransport(), base_url=control_plane.url)
    response = heartbeat(client)
    assert response.ok
    # 服务端回 15s，但客户端下限是 30s（ADR §5.1 速率预算）。
    assert response.interval_s == 30.0
    record = control_plane.requests_to("/heartbeat")[0]
    assert record["headers"]["authorization"] == f"Bearer {TEST_TOKEN}"
    assert record["headers"]["x-ghostfleet-node-uid"] == NODE_UID
    body = record["body"]
    assert body["schema"] == protocol.SCHEMA_AGENT
    assert protocol.is_valid_nonce(body["nonce"])


def test_real_transport_refuses_redirect_without_following(control_plane):
    control_plane.respond = lambda record: (302, None)
    control_plane.respond_headers = {"Location": "https://elsewhere.invalid/next"}
    client = make_client(UrllibTransport(), base_url=control_plane.url)
    response = heartbeat(client)
    assert response.kind == OUTCOME_TRANSPORT_REFUSED
    assert response.code == AGENT_REDIRECT_REFUSED
    assert len(control_plane.requests_to("/heartbeat")) == 1


# -- 合同 3：429 Retry-After 与 409 seq/boot 分派 ---------------------------
def test_boot_id_capacity_409_is_fatal_with_server_code():
    # 服务端 boot 历史已满：node 侧无法自愈，必须 FATAL 而不是无限退避。
    transport = FakeTransport(
        [TransportResponse(409, json.dumps({"code": NODE_BOOT_ID_CAPACITY_REACHED}).encode(), {})]
    )
    response = heartbeat(make_client(transport))
    assert response.kind == OUTCOME_AUTH_FATAL
    assert response.code == NODE_BOOT_ID_CAPACITY_REACHED


@pytest.mark.parametrize(
    "status, code",
    [
        (400, TASK_RESULT_SCHEMA_UNSUPPORTED),
        (409, TASK_RESULT_SCOPE_MISMATCH),
        (409, TASK_OPERATION_MISMATCH),
        (409, TASK_RESULT_CONFLICT),
    ],
)
def test_result_rejections_are_permanent_not_retryable(status, code):
    # 控制面已判定这条结果永远不可接受：只能丢件，不能当 DENIED 无限重投。
    transport = FakeTransport([TransportResponse(status, json.dumps({"code": code}).encode(), {})])
    client = make_client(transport)
    response = client.send_result_body(lambda nonce: {"nonce": nonce}, "task-1")
    assert response.kind == OUTCOME_REJECTED
    assert response.code == code


def test_same_code_outside_result_category_stays_denied():
    transport = FakeTransport(
        [TransportResponse(409, json.dumps({"code": TASK_RESULT_SCOPE_MISMATCH}).encode(), {})]
    )
    response = heartbeat(make_client(transport))
    assert response.kind == OUTCOME_DENIED
    assert response.code == TASK_RESULT_SCOPE_MISMATCH


def test_rate_limit_carries_retry_after_seconds():
    transport = FakeTransport(
        [TransportResponse(429, json.dumps({"code": NODE_RATE_LIMITED}).encode(), {"retry-after": "42"})]
    )
    response = heartbeat(make_client(transport))
    assert response.kind == OUTCOME_RATE_LIMITED
    assert response.retry_after_s == 42


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("42", 42),
        (" 7 ", 7),
        (5, 5),
        ([30], 30),
        ("Wed, 21 Oct 2015 07:28:00 GMT", None),
        ("0", None),
        ("99999", 3600),
        (True, None),
        (None, None),
    ],
)
def test_parse_retry_after_is_strict(raw, expected):
    assert parse_retry_after(raw) == expected


@pytest.mark.parametrize(
    "code, expected_outcome",
    [(NODE_SEQ_REGRESSION, OUTCOME_SEQ_REGRESSION), (NODE_BOOT_REPLAY, OUTCOME_BOOT_REPLAY)],
)
def test_seq_and_boot_conflicts_retry_once_through_hook(code, expected_outcome):
    transport = FakeTransport(
        [
            json_response(409, {"code": code}),
            json_response(200, {"interval_s": 30, "tasks": []}),
        ]
    )
    hooks = []
    response = make_client(transport).heartbeat(
        lambda nonce: build_envelope(node_uid=NODE_UID, boot_id="boot-0001", seq=1, nonce=nonce),
        retry_hook=hooks.append,
    )
    assert response.ok
    assert hooks == [expected_outcome]
    assert len(transport.calls) == 2
    nonces = [json.loads(call["body"])["nonce"] for call in transport.calls]
    assert nonces[0] != nonces[1]
