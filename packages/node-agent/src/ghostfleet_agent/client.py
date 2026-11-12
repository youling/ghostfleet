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
import time
import urllib.error
import urllib.request

from .logging import get_logger
from .outbox import MIN_SEND_WINDOW_S
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
        monotonic=None,
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
        # 注入点：测试用假时钟验证 409 重试只花剩余预算，不引入真实睡眠。
        self._monotonic = monotonic or time.monotonic

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

    def send(self, path: str, body_builder, *, category: str, retry_hook=None, timeout_s=None) -> Response:
        """发送一次请求；409 按码分派，换新 nonce/seq/boot_id 重试一次。

        retry_hook(kind) 在重试前被调用：loop 用它轮换 boot_id（NODE_BOOT_REPLAY）。
        nonce 与 seq 由 body_builder 每次重新生成，因此天然换新。
        timeout_s 是调用方给的剩余停机预算：只允许缩短、绝不允许超过配置值。

        预算是**绝对截止点**，从 send() 入口起算：body_builder（next_seq + fsync）、
        transport 往返、retry_hook 的本地耗时全部计入。每次 post 之前都按截止点重算
        剩余超时；重试还要求剩余时间够「再跑一次同样的本地构包 + MIN_SEND_WINDOW_S」。
        因此**一次 send 的墙钟不超过它的预算**，重试既不会拿到第二份预算、也不会用
        本地构包时间吃穿预算——这是 TimeoutStopSec=30 下停机有界的依据。
        """
        limit = CATEGORY_LIMITS[category]
        deadline = self._deadline(timeout_s)
        response, local_s = self._send_once(path, body_builder, category=category, limit=limit, deadline=deadline)
        if response.kind not in self.RETRYABLE_CONFLICTS or deadline is None:
            return response
        if not self._retry_window(deadline, local_s, category=category, outcome=response.kind, stage="first-attempt"):
            return response
        self.logger.warning("request_conflict_retry", category=category, outcome=response.kind)
        if retry_hook is not None:
            retry_hook(response.kind)
        # retry_hook 也是本地耗时（轮换 boot_id / 写状态），重算一次再决定要不要重试。
        if not self._retry_window(deadline, local_s, category=category, outcome=response.kind, stage="retry-hook"):
            return response
        response, _ = self._send_once(path, body_builder, category=category, limit=limit, deadline=deadline)
        return response

    def _deadline(self, timeout_s):
        """预算 → 绝对截止点；预算不可解析或非正时返回 None（不设截止点）。"""
        budget = self.timeout_s if timeout_s is None else timeout_s
        try:
            budget = float(budget)
        except (TypeError, ValueError):
            return None
        if budget != budget or budget <= 0:  # NaN / 非正预算
            return None
        return self._monotonic() + budget

    def _remaining(self, deadline) -> float | None:
        if deadline is None:
            return None
        return deadline - self._monotonic()

    def _retry_window(self, deadline, local_s, *, category, outcome, stage) -> bool:
        """重试前必须剩「一次与上次相同的本地构包开销 + MIN_SEND_WINDOW_S」。

        只检查 MIN_SEND_WINDOW_S 不够：body_builder（next_seq + fsync）本身是本地
        耗时、无法中途打断，重试要再跑一遍，不预留就会吃穿预算。
        """
        remaining = self._remaining(deadline)
        if remaining is None:
            return True
        need = MIN_SEND_WINDOW_S + max(0.0, float(local_s or 0.0))
        if remaining >= need:
            return True
        self.logger.warning(
            "request_conflict_retry_skipped",
            category=category,
            outcome=outcome,
            stage=stage,
            remaining_s=round(remaining, 3),
            local_cost_s=round(float(local_s or 0.0), 3),
        )
        return False

    def _request_timeout(self, timeout_s) -> float:
        """剩余预算只能把请求超时调小：max(0.05, min(配置值, 剩余预算))。"""
        if timeout_s is None:
            return self.timeout_s
        try:
            budget = float(timeout_s)
        except (TypeError, ValueError):
            return self.timeout_s
        if budget != budget or budget <= 0:  # NaN / 非正预算
            return self.timeout_s
        return max(0.05, min(self.timeout_s, budget))

    def _send_once(self, path: str, body_builder, *, category: str, limit: int, deadline=None):
        """构造 → 序列化 → POST；返回 (Response, 本次本地耗时秒)。

        deadline 是绝对截止点：构包与序列化之后、POST 之前按它重算剩余超时；剩余不足
        MIN_SEND_WINDOW_S 就根本不发（返回网络错误形态，交给上层退避重试），因此不会
        出现"本地构包耗时 + 一个完整请求超时"越过预算的形态。
        """
        local_started = self._monotonic()
        nonce = self._nonce_factory()
        body = body_builder(nonce)
        try:
            encoded = canonical_bytes(body)
        except ProtocolError:
            self.logger.error("request_not_serialisable", category=category)
            return Response(OUTCOME_INVALID_RESPONSE, None, AGENT_INVALID_RESPONSE), self._local_cost(local_started)
        if len(encoded) > limit:
            raise ProtocolError(AGENT_PAYLOAD_TOO_LARGE, "request body exceeds endpoint limit")
        remaining = self._remaining(deadline)
        if remaining is not None and remaining <= 0.0:
            # 本地构包已吃穿预算：连一次最小请求都发不出去，直接按网络错误交给上层
            # 退避（绝不"再补一份预算"）。剩余>0 时仍然尝试，只是把超时钳到剩余值。
            self.logger.warning(
                "request_budget_exhausted_before_post",
                category=category,
                remaining_s=round(remaining, 3),
            )
            return Response(OUTCOME_NETWORK_ERROR, None, AGENT_NETWORK_ERROR), self._local_cost(local_started)
        try:
            transport_response = self.transport.post(
                self._url(path),
                headers=self._headers(),
                body=encoded,
                timeout_s=self._request_timeout(remaining),
            )
        except TransportError as error:
            if error.kind == "REDIRECT_REFUSED":
                self.logger.error("redirect_refused", category=category)
                return Response(OUTCOME_TRANSPORT_REFUSED, None, AGENT_REDIRECT_REFUSED), self._local_cost(local_started)
            if error.kind == "TOO_LARGE":
                self.logger.error("response_too_large", category=category)
                return Response(OUTCOME_INVALID_RESPONSE, None, AGENT_INVALID_RESPONSE), self._local_cost(local_started)
            self.logger.warning("transport_error", category=category, kind=error.kind)
            return Response(OUTCOME_NETWORK_ERROR, None, AGENT_NETWORK_ERROR), self._local_cost(local_started)
        document = _parse_document(transport_response.body)
        retry_after = parse_retry_after(transport_response.headers.get("retry-after"))
        return self._classify(transport_response.status, document, category=category, retry_after_s=retry_after), self._local_cost(local_started)

    def _local_cost(self, started: float) -> float:
        """本地耗时（构包/序列化），用于给重试预留同样的时间。"""
        return max(0.0, self._monotonic() - started)

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

    def send_result_body(self, body_builder, task_id: str, *, retry_hook=None, timeout_s=None) -> Response:
        return self.send(
            self.result_path(task_id),
            body_builder,
            category=CATEGORY_RESULT,
            retry_hook=retry_hook,
            timeout_s=timeout_s,
        )
