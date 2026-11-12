"""控制面 HTTP 客户端：urllib + 关闭代理 + 拒绝重定向 + 稳定分类。

威胁模型（ADR §9）：
- 只用 HTTPS（唯一例外是 loopback 验收，由 config 显式记录）；
- 显式忽略环境代理，避免被 http(s)_proxy 劫持到中间人；
- 任何 3xx 都拒绝，绝不跟随 Location；
- 远端响应体只在内存里解析出稳定 error code，绝不进日志；
- 非 2xx 归一为有限分类，供循环决定"退避重试 / 永久拒绝 / 致命停止"。
"""
from __future__ import annotations

import http.client
import json
import socket
import ssl
import urllib.error
import urllib.request

from .logging import get_logger
from .protocol import (
    AGENT_CONTROL_PLANE_UNREACHABLE,
    AGENT_INVALID_RESPONSE,
    AGENT_NETWORK_ERROR,
    AGENT_PAYLOAD_TOO_LARGE,
    AGENT_REDIRECT_REFUSED,
    AGENT_SERVER_ERROR,
    AGENT_UNEXPECTED_STATUS,
    MAX_HEARTBEAT_BYTES,
    MAX_POLL_BYTES,
    MAX_RESULT_BYTES,
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
    OUTCOME_SEQ_REGRESSION,
    OUTCOME_SERVER_ERROR,
    OUTCOME_TRANSPORT_REFUSED,
    SCHEMA_AGENT,
    TASK_OPERATION_MISMATCH,
    TASK_RESULT_CONFLICT,
    TASK_RESULT_SCHEMA_UNSUPPORTED,
    TASK_RESULT_SCOPE_MISMATCH,
    ProtocolError,
    canonical_bytes,
    format_timestamp,
    new_nonce,
    now_utc,
)
from .tasks import MAX_TASKS_PER_HEARTBEAT, MAX_TASKS_PER_POLL

MAX_RESPONSE_BYTES = 256 * 1024
# 客户端心跳下限 30s：ADR §5.1 的速率预算（24 容量 + 1/10s）按 30s 周期留了
# 2 倍余量。服务端或抖动分支给出更小值时按 30s 处理，绝不自己打穿 bucket。
MIN_INTERVAL_S = 30.0
MAX_INTERVAL_S = 300.0
CATEGORY_HEARTBEAT = "heartbeat"
CATEGORY_POLL = "poll"
CATEGORY_RESULT = "result"
CATEGORY_LIMITS = {
    CATEGORY_HEARTBEAT: MAX_HEARTBEAT_BYTES,
    CATEGORY_POLL: MAX_POLL_BYTES,
    CATEGORY_RESULT: MAX_RESULT_BYTES,
}
# 控制面已明确判定"这条结果永远不可接受"的码：只能丢件 + warning，
# 不能当 DENIED 无限重投（那会持续烧速率预算并把真实原因埋掉）。
RESULT_REJECTED_CODES = frozenset(
    {
        TASK_RESULT_CONFLICT,
        TASK_RESULT_SCHEMA_UNSUPPORTED,
        TASK_RESULT_SCOPE_MISMATCH,
        TASK_OPERATION_MISMATCH,
    }
)
ERROR_CODE_RE = r"^[A-Z][A-Z0-9_]{3,63}$"
import re

_CODE_RE = re.compile(ERROR_CODE_RE)


class TransportError(Exception):
    """传输层错误；`kind` ∈ TIMEOUT/NETWORK/TLS/REDIRECT_REFUSED/TOO_LARGE。"""

    def __init__(self, kind: str, detail: str = "") -> None:
        self.kind = kind
        self.detail = detail
        super().__init__(kind)


class TransportResponse:
    __slots__ = ("status", "body", "headers")

    def __init__(self, status: int, body: bytes, headers: dict | None = None) -> None:
        self.status = status
        self.body = body
        self.headers = dict(headers or {})


class GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """任何重定向都视为攻击面拒绝，不跟随。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 - 标准签名
        raise TransportError("REDIRECT_REFUSED", f"redirect status {code} is not allowed")


class UrllibTransport:
    """唯一发起真实网络 I/O 的薄层；可被测试替换为假传输。"""

    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            GuardedRedirectHandler(),
        )

    def post(self, url: str, *, headers: dict, body: bytes, timeout_s: float) -> TransportResponse:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with self._opener.open(request, timeout=timeout_s) as response:
                status = int(response.status)
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                headers = _lower_headers(response.headers)
        except urllib.error.HTTPError as error:
            status = int(error.code)
            headers = _lower_headers(getattr(error, "headers", None))
            raw = b""
            try:
                raw = error.read(MAX_RESPONSE_BYTES + 1) or b""
            except Exception:  # noqa: BLE001 - 已拿到状态码，响应体失败不影响分类
                raw = b""
        except urllib.error.URLError as error:
            reason = error.reason
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise TransportError("TIMEOUT") from None
            if isinstance(reason, ssl.SSLError):
                raise TransportError("TLS") from None
            raise TransportError("NETWORK") from None
        except (socket.timeout, TimeoutError):
            raise TransportError("TIMEOUT") from None
        except ssl.SSLError:
            raise TransportError("TLS") from None
        except TransportError:
            raise
        except (http.client.HTTPException, OSError):
            raise TransportError("NETWORK") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise TransportError("TOO_LARGE")
        return TransportResponse(status, raw, headers)


def _lower_headers(headers) -> dict:
    if headers is None:
        return {}
    try:
        return {str(name).lower(): str(value) for name, value in headers.items()}
    except (AttributeError, TypeError):
        return {}


MAX_RETRY_AFTER_S = 3600
MIN_RETRY_AFTER_S = 1


def parse_retry_after(value) -> int | None:
    """解析 Retry-After：只接受整数秒；非法/越界返回 None（不猜 HTTP-date）。"""
    if isinstance(value, (list, tuple)) and value:
        value = value[0]
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        seconds = value
    elif isinstance(value, str):
        text = value.strip()
        if not text.isdigit() or len(text) > 5:
            return None
        seconds = int(text)
    else:
        return None
    if seconds < MIN_RETRY_AFTER_S:
        return None
    # 服务端要求的等待超过 1h 时钳到上限并如实执行（绝不提前重试）。
    return min(seconds, MAX_RETRY_AFTER_S)


def _extract_error_code(document) -> str | None:
    if not isinstance(document, dict):
        return None
    candidate = document.get("code")
    if candidate is None and isinstance(document.get("error"), dict):
        candidate = document["error"].get("code")
    if isinstance(candidate, str) and _CODE_RE.fullmatch(candidate):
        return candidate
    return None


def _parse_document(raw: bytes):
    if not raw:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


class Response:
    """分类后的控制面响应；body 只在内存中使用。"""

    __slots__ = ("kind", "status", "code", "body", "retry_after_s")

    def __init__(self, kind: str, status: int | None, code: str | None, body=None, retry_after_s: int | None = None) -> None:
        self.kind = kind
        self.status = status
        self.code = code
        self.body = body
        self.retry_after_s = retry_after_s

    @property
    def ok(self) -> bool:
        return self.kind == OUTCOME_OK

    def __repr__(self) -> str:  # pragma: no cover - 仅调试
        return f"Response(kind={self.kind!r}, status={self.status!r}, code={self.code!r})"


class HeartbeatResponse(Response):
    __slots__ = ("interval_s", "tasks")

    def __init__(self, kind, status, code, body=None, interval_s=None, tasks=None, retry_after_s=None) -> None:
        super().__init__(kind, status, code, body, retry_after_s)
        self.interval_s = interval_s
        self.tasks = list(tasks or [])


class PollResponse(Response):
    __slots__ = ("tasks",)

    def __init__(self, kind, status, code, body=None, tasks=None, retry_after_s=None) -> None:
        super().__init__(kind, status, code, body, retry_after_s)
        self.tasks = list(tasks or [])


class TaskListError(Exception):
    pass


def _parse_tasks(document, limit: int) -> list[dict]:
    if not isinstance(document, dict):
        raise TaskListError("response is not an object")
    raw_tasks = document.get("tasks")
    if raw_tasks is None:
        return []
    if not isinstance(raw_tasks, list):
        raise TaskListError("tasks is not a list")
    if len(raw_tasks) > limit:
        raise TaskListError("too many tasks in one response")
    tasks: list[dict] = []
    for item in raw_tasks:
        if not isinstance(item, dict):
            raise TaskListError("task entry is not an object")
        tasks.append(item)
    return tasks


def _clamp_interval(value, bounds=None) -> float | None:
    """把控制面给的 interval_s 钳制到配置的心跳上下限（合同/ADR §6）。"""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        return None
    low, high = bounds if bounds is not None else (MIN_INTERVAL_S, MAX_INTERVAL_S)
    # 配置可以更窄，但下限不得低于客户端的 30s 速率底线。
    low = max(float(low), MIN_INTERVAL_S)
    high = max(float(high), low)
    return min(max(number, low), high)


def build_envelope(*, node_uid: str, boot_id: str, seq: int, nonce: str, extra: dict | None = None) -> dict:
    """构造协议信封（canonical 可序列化）。"""
    envelope = {
        "schema": SCHEMA_AGENT,
        "node_uid": node_uid,
        "nonce": nonce,
        "sent_at": format_timestamp(now_utc()),
        "boot_id": boot_id,
        "seq": int(seq),
    }
    if extra:
        for key, value in extra.items():
            if key in envelope:
                raise ProtocolError("AGENT_INTERNAL_ERROR", "envelope field collision")
            envelope[key] = value
    return envelope


class ControlPlaneClient:
    """按端点语义分类响应的客户端；只在必要时重试一次 nonce 冲突。"""

    def __init__(
        self,
        *,
        base_url: str,
        node_uid: str,
        agent_version: str,
        token: str,
        timeout_s: float = 10.0,
        logger=None,
        transport=None,
        nonce_factory=new_nonce,
    ) -> None:
        if not base_url or base_url.endswith("/"):
            base_url = base_url.rstrip("/")
        if not base_url:
            raise ProtocolError(AGENT_CONTROL_PLANE_UNREACHABLE, "base_url must not be empty")
        if not isinstance(token, str) or not token:
            raise ProtocolError(NODE_AUTH_INVALID, "token must not be empty")
        self.base_url = base_url
        self.node_uid = node_uid
        self.agent_version = agent_version
        self._token = token
        self.timeout_s = float(timeout_s)
        self.logger = logger or get_logger()
        self.transport = transport or UrllibTransport()
        self._nonce_factory = nonce_factory

    # -- 请求 ---------------------------------------------------------------
    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "x-ghostfleet-node-uid": self.node_uid,
            "x-ghostfleet-agent-version": self.agent_version,
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": f"ghostfleet-node-agent/{self.agent_version}",
        }

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    RETRYABLE_CONFLICTS = frozenset(
        {OUTCOME_NONCE_REPLAY, OUTCOME_SEQ_REGRESSION, OUTCOME_BOOT_REPLAY}
    )

    def send(self, path: str, body_builder, *, category: str, retry_hook=None) -> Response:
        """发送一次请求；409 按码分派，换新 nonce/seq/boot_id 重试一次。

        retry_hook(kind) 在重试前被调用：loop 用它轮换 boot_id（NODE_BOOT_REPLAY）。
        nonce 与 seq 由 body_builder 每次重新生成，因此天然换新。
        """
        limit = CATEGORY_LIMITS[category]
        response = self._send_once(path, body_builder, category=category, limit=limit)
        if response.kind in self.RETRYABLE_CONFLICTS:
            self.logger.warning("request_conflict_retry", category=category, outcome=response.kind)
            if retry_hook is not None:
                retry_hook(response.kind)
            response = self._send_once(path, body_builder, category=category, limit=limit)
        return response

    def _send_once(self, path: str, body_builder, *, category: str, limit: int) -> Response:
        nonce = self._nonce_factory()
        body = body_builder(nonce)
        try:
            encoded = canonical_bytes(body)
        except ProtocolError:
            self.logger.error("request_not_serialisable", category=category)
            return Response(OUTCOME_INVALID_RESPONSE, None, AGENT_INVALID_RESPONSE)
        if len(encoded) > limit:
            raise ProtocolError(AGENT_PAYLOAD_TOO_LARGE, "request body exceeds endpoint limit")
        try:
            transport_response = self.transport.post(
                self._url(path),
                headers=self._headers(),
                body=encoded,
                timeout_s=self.timeout_s,
            )
        except TransportError as error:
            if error.kind == "REDIRECT_REFUSED":
                self.logger.error("redirect_refused", category=category)
                return Response(OUTCOME_TRANSPORT_REFUSED, None, AGENT_REDIRECT_REFUSED)
            if error.kind == "TOO_LARGE":
                self.logger.error("response_too_large", category=category)
                return Response(OUTCOME_INVALID_RESPONSE, None, AGENT_INVALID_RESPONSE)
            self.logger.warning("transport_error", category=category, kind=error.kind)
            return Response(OUTCOME_NETWORK_ERROR, None, AGENT_NETWORK_ERROR)
        document = _parse_document(transport_response.body)
        retry_after = parse_retry_after(transport_response.headers.get("retry-after"))
        return self._classify(transport_response.status, document, category=category, retry_after_s=retry_after)

    def _classify(self, status: int, document, *, category: str, retry_after_s: int | None = None) -> Response:
        code = _extract_error_code(document)
        if 200 <= status < 300:
            if not isinstance(document, dict):
                return Response(OUTCOME_INVALID_RESPONSE, status, AGENT_INVALID_RESPONSE)
            return Response(OUTCOME_OK, status, None, document)
        if 300 <= status < 400:
            return Response(OUTCOME_TRANSPORT_REFUSED, status, AGENT_REDIRECT_REFUSED)
        if status == 401:
            if code == NODE_CLOCK_SKEW:
                # 本地时钟不可信：退避重试，不当作凭据失效。
                return Response(OUTCOME_DENIED, status, code)
            return Response(OUTCOME_AUTH_FATAL, status, code or NODE_AUTH_INVALID)
        if status == 403:
            # 403 = 凭据/节点生命周期问题（NODE_SCOPE_MISMATCH / NODE_NOT_ADMITTED）：
            # 只有人类修复才能恢复，按 FATAL 停止上报，而不是无限重试。
            return Response(OUTCOME_AUTH_FATAL, status, code or NODE_SCOPE_MISMATCH)
        if status == 409:
            if code == NODE_BOOT_ID_CAPACITY_REACHED:
                # 控制面 boot 历史已满：node 侧无法自愈（不能自己 rotate），重试只会
                # 持续烧速率预算并把真实原因埋掉；只有 operator 处理才能恢复。
                return Response(OUTCOME_AUTH_FATAL, status, code)
            if code == NODE_NONCE_REPLAY:
                return Response(OUTCOME_NONCE_REPLAY, status, code)
            if code == NODE_SEQ_REGRESSION:
                return Response(OUTCOME_SEQ_REGRESSION, status, code)
            if code == NODE_BOOT_REPLAY:
                return Response(OUTCOME_BOOT_REPLAY, status, code)
            if category == CATEGORY_RESULT and code in RESULT_REJECTED_CODES:
                return Response(OUTCOME_REJECTED, status, code)
            return Response(OUTCOME_DENIED, status, code)
        if status == 429:
            return Response(OUTCOME_RATE_LIMITED, status, code or NODE_RATE_LIMITED, retry_after_s=retry_after_s)
        if status in (413, 415):
            kind = OUTCOME_REJECTED if category == CATEGORY_RESULT else OUTCOME_DENIED
            return Response(kind, status, code)
        if 400 <= status < 500:
            kind = OUTCOME_REJECTED if category == CATEGORY_RESULT else OUTCOME_DENIED
            return Response(kind, status, code)
        if status >= 500:
            return Response(OUTCOME_SERVER_ERROR, status, code or AGENT_SERVER_ERROR)
        return Response(OUTCOME_INVALID_RESPONSE, status, code or AGENT_UNEXPECTED_STATUS)

    # -- 端点 ---------------------------------------------------------------
    def heartbeat(self, body_builder, *, interval_bounds=None, retry_hook=None) -> HeartbeatResponse:
        response = self.send(
            f"/v0/nodes/{self.node_uid}/heartbeat",
            body_builder,
            category=CATEGORY_HEARTBEAT,
            retry_hook=retry_hook,
        )
        if not response.ok:
            return HeartbeatResponse(
                response.kind, response.status, response.code, response.body, retry_after_s=response.retry_after_s
            )
        # interval 由控制面下发，客户端下限 30s（速率预算），上限 300s。
        raw_interval = response.body.get("interval_s")
        if (
            isinstance(raw_interval, (int, float))
            and not isinstance(raw_interval, bool)
            and raw_interval < MIN_INTERVAL_S
        ):
            self.logger.warning(
                "server_interval_below_floor", interval_s=raw_interval, floor_s=MIN_INTERVAL_S
            )
        interval_s = _clamp_interval(raw_interval, interval_bounds)
        try:
            tasks = _parse_tasks(response.body, MAX_TASKS_PER_HEARTBEAT)
        except TaskListError as error:
            self.logger.error("heartbeat_tasks_invalid", reason=str(error))
            return HeartbeatResponse(OUTCOME_INVALID_RESPONSE, response.status, AGENT_INVALID_RESPONSE, response.body)
        return HeartbeatResponse(OUTCOME_OK, response.status, None, response.body, interval_s, tasks)

    def poll(self, body_builder, *, retry_hook=None) -> PollResponse:
        response = self.send(
            f"/v0/nodes/{self.node_uid}/tasks/poll",
            body_builder,
            category=CATEGORY_POLL,
            retry_hook=retry_hook,
        )
        if not response.ok:
            return PollResponse(
                response.kind, response.status, response.code, response.body, retry_after_s=response.retry_after_s
            )
        try:
            tasks = _parse_tasks(response.body, MAX_TASKS_PER_POLL)
        except TaskListError as error:
            self.logger.error("poll_tasks_invalid", reason=str(error))
            return PollResponse(OUTCOME_INVALID_RESPONSE, response.status, AGENT_INVALID_RESPONSE, response.body)
        return PollResponse(OUTCOME_OK, response.status, None, response.body, tasks)

    def result_path(self, task_id: str) -> str:
        return f"/v0/nodes/{self.node_uid}/tasks/{task_id}/result"

    def send_result_body(self, body_builder, task_id: str, *, retry_hook=None) -> Response:
        return self.send(self.result_path(task_id), body_builder, category=CATEGORY_RESULT, retry_hook=retry_hook)
