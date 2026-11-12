"""节点代理 v0 协议原语：schema、canonical JSON、nonce、稳定错误码、禁用键。

协议合同见 docs/architecture/NODE_AGENT_V0.md §5。本模块是纯函数层：不读写文件、
不发起网络请求、不启动子进程，因此全部拒绝路径都可以用确定性测试覆盖。

安全不变量：
- canonical JSON 拒绝 NaN/Infinity，保证摘要与签名输入无歧义；
- 参数递归检查禁用键（大小写不敏感）、nesting 深度与总长，没有"只读 shell"后门；
- 错误码是常量字符串，不拼接、不从远端响应里搬运（远端响应体永不出现在日志）。
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
from datetime import datetime, timezone

SCHEMA_AGENT = "ghostfleet-node-agent/v0"
SCHEMA_TASK = "ghostfleet-node-task/v0"

# 控制面 / Agent 共用的稳定错误码（ADR §5.1、§5.3）。
NODE_AUTH_INVALID = "NODE_AUTH_INVALID"
NODE_SCOPE_MISMATCH = "NODE_SCOPE_MISMATCH"
NODE_NOT_ADMITTED = "NODE_NOT_ADMITTED"
NODE_CLOCK_SKEW = "NODE_CLOCK_SKEW"
NODE_NONCE_REPLAY = "NODE_NONCE_REPLAY"
NODE_RATE_LIMITED = "NODE_RATE_LIMITED"
NODE_SEQ_REGRESSION = "NODE_SEQ_REGRESSION"
NODE_BOOT_REPLAY = "NODE_BOOT_REPLAY"
TASK_OPERATION_FORBIDDEN = "TASK_OPERATION_FORBIDDEN"
TASK_PARAMS_FORBIDDEN = "TASK_PARAMS_FORBIDDEN"
TASK_RESULT_CONFLICT = "TASK_RESULT_CONFLICT"
TASK_EXPIRED = "TASK_EXPIRED"
TASK_SCOPE_MISMATCH = "TASK_SCOPE_MISMATCH"
TASK_OPERATION_UNKNOWN = "TASK_OPERATION_UNKNOWN"

# 仅 Agent 本地产生或本地归类的稳定错误码。
PROTOCOL_INVALID = "AGENT_PROTOCOL_INVALID"
TASK_ENVELOPE_INVALID = "TASK_ENVELOPE_INVALID"
AGENT_EXECUTION_FAILED = "AGENT_EXECUTION_FAILED"
AGENT_NETWORK_ERROR = "AGENT_NETWORK_ERROR"
AGENT_SERVER_ERROR = "AGENT_SERVER_ERROR"
AGENT_INVALID_RESPONSE = "AGENT_INVALID_RESPONSE"
AGENT_REDIRECT_REFUSED = "AGENT_REDIRECT_REFUSED"
AGENT_UNEXPECTED_STATUS = "AGENT_UNEXPECTED_STATUS"
AGENT_INTERNAL_ERROR = "AGENT_INTERNAL_ERROR"
AGENT_CONTROL_PLANE_UNREACHABLE = "AGENT_CONTROL_PLANE_UNREACHABLE"

# 任务结果状态。
RESULT_SUCCEEDED = "SUCCEEDED"
RESULT_REFUSED = "REFUSED"
RESULT_UNKNOWN = "UNKNOWN"
RESULT_STATUSES = frozenset({RESULT_SUCCEEDED, RESULT_REFUSED, RESULT_UNKNOWN})

# 节点身份：与仓库既有 node_uid 形态一致（node-<uuidv4> 小写）。
NODE_UID_RE = re.compile(
    r"^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

# 任务信封里的 task_id 会进入本地 ledger 文件名以外的键、日志与 URL 路径，因此只允许
# URL/日志安全字符。超集被拒，避免路径穿越或日志注入。
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$")

MIN_NONCE_BYTES = 16
DEFAULT_NONCE_BYTES = 18  # 18 字节 → 24 个 base64url 字符（无 padding）
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{22,64}$")

MAX_PARAMS_BYTES = 4 * 1024
MAX_PARAMS_DEPTH = 3

# 出站请求分类（client 产生，outbox 消费）。只有 OK/REJECTED 表示控制面已给出终态。
OUTCOME_OK = "OK"
OUTCOME_REJECTED = "REJECTED"
OUTCOME_NONCE_REPLAY = "NONCE_REPLAY"
OUTCOME_SEQ_REGRESSION = "SEQ_REGRESSION"
OUTCOME_BOOT_REPLAY = "BOOT_REPLAY"
OUTCOME_AUTH_FATAL = "AUTH_FATAL"
OUTCOME_RATE_LIMITED = "RATE_LIMITED"
OUTCOME_SERVER_ERROR = "SERVER_ERROR"
OUTCOME_NETWORK_ERROR = "NETWORK_ERROR"
OUTCOME_TRANSPORT_REFUSED = "TRANSPORT_REFUSED"
OUTCOME_INVALID_RESPONSE = "INVALID_RESPONSE"

# 控制面拒绝但可退避重试（例如节点尚未 admitted / 时钟偏差 / 4xx 语义不明）。
AGENT_UNIT_NOT_ALLOWED = "AGENT_UNIT_NOT_ALLOWED"
AGENT_PAYLOAD_TOO_LARGE = "AGENT_PAYLOAD_TOO_LARGE"
AGENT_EXECUTION_UNKNOWN = "AGENT_EXECUTION_UNKNOWN"

OUTCOME_DENIED = "DENIED"


MAX_HEARTBEAT_BYTES = 16 * 1024
MAX_POLL_BYTES = 4 * 1024
MAX_RESULT_BYTES = 64 * 1024

# ADR §5.3 / D7：任何"执行什么"形态的键都拒绝，大小写不敏感。
FORBIDDEN_KEYS = frozenset(
    {
        "command",
        "cmd",
        "script",
        "scripts",
        "shell",
        "bash",
        "args",
        "arg",
        "argv",
        "exec",
        "execute",
        "run",
        "payload",
        "raw",
        "inline",
        "body",
        "text",
        "playbook",
        "remote_command",
        "env",
        "url",
    }
)

_RFC3339_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")


class ProtocolError(Exception):
    """协议层拒绝；`code` 是稳定错误码，`detail` 只用于本地诊断（可进日志的短文本）。"""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


def _reject_constant_factory(code: str):
    def _reject(token: str) -> None:
        raise ProtocolError(code, f"non-finite number {token} is not allowed")

    return _reject


def _no_duplicate_pairs_factory(code: str):
    def _pairs(pairs):
        document: dict = {}
        for key, value in pairs:
            if key in document:
                raise ProtocolError(code, f"duplicate key {key!r}")
            document[key] = value
        return document

    return _pairs


def decode_json(text: str, *, error_code: str = PROTOCOL_INVALID):
    """严格 JSON 解码：拒绝 NaN/Infinity、重复键与非 UTF-8 语义异常。"""
    if not isinstance(text, str):
        raise ProtocolError(error_code, "document must be text")
    try:
        return json.loads(
            text,
            parse_constant=_reject_constant_factory(error_code),
            object_pairs_hook=_no_duplicate_pairs_factory(error_code),
        )
    except ProtocolError:
        raise
    except (ValueError, RecursionError):
        raise ProtocolError(error_code, "document is not valid JSON") from None


def canonical_json(value) -> str:
    """协议 canonical JSON：sort_keys + 紧凑分隔符 + 非 ASCII 原样 + 拒绝 NaN。"""
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError, RecursionError):
        raise ProtocolError(PROTOCOL_INVALID, "value is not canonical JSON serialisable") from None


def canonical_bytes(value) -> bytes:
    return canonical_json(value).encode("utf-8")


def digest_of(value) -> str:
    """结果摘要：canonical JSON 的 sha256 十六进制。"""
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


result_digest = digest_of  # 语义别名：结果 payload 的 result_digest


def new_nonce(nbytes: int = DEFAULT_NONCE_BYTES) -> str:
    """生成 ≥16 字节随机 nonce 的 base64url 文本（无 padding）。"""
    if not isinstance(nbytes, int) or isinstance(nbytes, bool) or nbytes < MIN_NONCE_BYTES:
        raise ProtocolError(PROTOCOL_INVALID, "nonce must be at least 16 bytes")
    return base64.urlsafe_b64encode(secrets.token_bytes(nbytes)).decode("ascii").rstrip("=")


def is_valid_nonce(value) -> bool:
    return isinstance(value, str) and bool(NONCE_RE.fullmatch(value))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def format_timestamp(moment: datetime | None = None) -> str:
    """RFC 3339 UTC，秒精度，Z 后缀（协议信封统一形态）。"""
    moment = now_utc() if moment is None else moment
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_timestamp(value, *, code: str = PROTOCOL_INVALID) -> datetime:
    if not isinstance(value, str) or not _RFC3339_Z.fullmatch(value):
        raise ProtocolError(code, "timestamp must be RFC 3339 UTC with Z suffix")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ProtocolError(code, "timestamp is not a valid calendar instant") from None


def container_depth(value) -> int:
    """容器嵌套层数：根容器为 1，标量为 0。"""
    if isinstance(value, dict):
        if not value:
            return 1
        return 1 + max(container_depth(child) for child in value.values())
    if isinstance(value, (list, tuple)):
        if not value:
            return 1
        return 1 + max(container_depth(child) for child in value)
    return 0


def _scan_forbidden(value, level: int, path: str, max_depth: int) -> str | None:
    if level > max_depth:
        return None
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                return f"{path}.<non-string-key>" if path else "<non-string-key>"
            if key.lower() in FORBIDDEN_KEYS:
                return f"{path}.{key}" if path else key
        for key, child in value.items():
            found = _scan_forbidden(child, level + 1, f"{path}.{key}" if path else str(key), max_depth)
            if found:
                return found
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            found = _scan_forbidden(child, level + 1, f"{path}[{index}]", max_depth)
            if found:
                return found
    return None


def find_forbidden_key(value, *, max_depth: int = MAX_PARAMS_DEPTH) -> str | None:
    """递归查找禁用键，返回点分路径（含列表下标）；未命中返回 None。"""
    return _scan_forbidden(value, 1, "", max_depth)


def check_params(params) -> None:
    """任务参数 fail-closed 校验：对象、深度 ≤3、无禁用键、≤4 KiB。

    全部失败都归一为 TASK_PARAMS_FORBIDDEN（参数内容本身不允许回显）。
    """
    if not isinstance(params, dict):
        raise ProtocolError(TASK_PARAMS_FORBIDDEN, "params must be an object")
    if container_depth(params) > MAX_PARAMS_DEPTH:
        raise ProtocolError(TASK_PARAMS_FORBIDDEN, "params nesting exceeds 3")
    forbidden = find_forbidden_key(params)
    if forbidden:
        raise ProtocolError(TASK_PARAMS_FORBIDDEN, f"forbidden params key {forbidden}")
    try:
        size = len(canonical_bytes(params))
    except ProtocolError:
        raise ProtocolError(TASK_PARAMS_FORBIDDEN, "params must be finite JSON values") from None
    if size > MAX_PARAMS_BYTES:
        raise ProtocolError(TASK_PARAMS_FORBIDDEN, "params exceed 4 KiB")


def make_result(
    *,
    task_id: str,
    node_uid: str,
    operation: str,
    status: str,
    data=None,
    code: str | None = None,
    observed_at: str | None = None,
) -> dict:
    """构造任务结果 payload；结果为 status + 可选 data / 稳定 code。"""
    if status not in RESULT_STATUSES:
        raise ProtocolError(PROTOCOL_INVALID, "unknown result status")
    result = {
        "schema": SCHEMA_TASK,
        "task_id": task_id,
        "node_uid": node_uid,
        "operation": operation,
        "status": status,
        "observed_at": observed_at or format_timestamp(),
    }
    if data is not None:
        result["data"] = data
    if code is not None:
        result["code"] = code
    # 结果必须可 canonical 序列化（含有限数字），否则不允许进入 outbox。
    canonical_bytes(result)
    return result
