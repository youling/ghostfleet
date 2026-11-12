"""stdout JSON lines 日志 + 脱敏（journald 捕获，不写文件、不发网络）。

边界（ADR §4）：
- 只写 stdout；每条一行、字段有界，异常绝不拖垮常驻循环；
- 字段白名单式脱敏：敏感键、已登记 token、任意 ≥32 字符 base64url 形态、短码形态一律打码；
- 错误只记稳定 code，不记远端响应体、不记异常文本、不记凭据。
"""
from __future__ import annotations

import json
import math
import re
import sys
import threading

from .protocol import format_timestamp, now_utc

REDACTED = "[REDACTED]"
LOG_LEVEL_INFO = "info"
LOG_LEVEL_WARNING = "warning"
LOG_LEVEL_ERROR = "error"

# 合同 E：循环事件行字段固定为 {ts, event, seq, detail}，事件名也是白名单。
EVENT_NAMES = frozenset({"poll", "task_start", "task_result", "backoff", "fatal"})

MAX_STRING_CHARS = 160
MAX_FIELDS = 16
MAX_LIST_ITEMS = 8
MAX_MAPPING_ITEMS = 16
MAX_DEPTH = 2

# 键名本身即敏感：值无论形态都打码。
SENSITIVE_KEYS = frozenset(
    {
        "token",
        "access_token",
        "refresh_token",
        "node_token",
        "authorization",
        "bearer",
        "secret",
        "client_secret",
        "password",
        "passwd",
        "credential",
        "credentials",
        "private_key",
        "api_key",
        "apikey",
        "resume_session",
        "short_code",
    }
)

_BASE64URL_RUN = re.compile(r"[A-Za-z0-9_-]{32,}")
_SHORT_CODE = re.compile(r"(?<![A-Za-z0-9])[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2}(?![A-Za-z0-9])")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

_SECRETS: set[str] = set()
_SECRETS_LOCK = threading.Lock()


def register_secret(value) -> None:
    """登记一个明文凭据，之后任何日志字段里出现它都会被替换。"""
    if isinstance(value, str) and len(value) >= 8:
        with _SECRETS_LOCK:
            _SECRETS.add(value)


def clear_secrets() -> None:
    """仅测试使用：清空登记表。"""
    with _SECRETS_LOCK:
        _SECRETS.clear()


def redact_string(value: str) -> str:
    if not value:
        return value
    text = value
    with _SECRETS_LOCK:
        secrets = sorted(_SECRETS, key=len, reverse=True)
    for secret in secrets:
        if secret in text:
            text = text.replace(secret, REDACTED)
    text = _BASE64URL_RUN.sub(REDACTED, text)
    text = _SHORT_CODE.sub(REDACTED, text)
    text = _CONTROL_CHARS.sub(" ", text)
    if len(text) > MAX_STRING_CHARS:
        text = text[:MAX_STRING_CHARS] + "…"
    return text


def redact(value, *, key: str | None = None, depth: int = 0):
    """把任意值转换成有界、可 JSON 序列化、已脱敏的形态。"""
    if key is not None and isinstance(key, str) and key.lower() in SENSITIVE_KEYS:
        return REDACTED
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return redact_string(value) if value else value
    if depth >= MAX_DEPTH:
        if isinstance(value, (list, tuple, dict)):
            return f"<bounded {type(value).__name__}>"
        return redact_string(str(value))
    if isinstance(value, (list, tuple)):
        items = [redact(item, depth=depth + 1) for item in value[:MAX_LIST_ITEMS]]
        if len(value) > MAX_LIST_ITEMS:
            items.append(f"<+{len(value) - MAX_LIST_ITEMS} more>")
        return items
    if isinstance(value, dict):
        result: dict = {}
        for index, (item_key, item_value) in enumerate(value.items()):
            if index >= MAX_MAPPING_ITEMS:
                result["<truncated>"] = f"+{len(value) - MAX_MAPPING_ITEMS} more keys"
                break
            safe_key = redact_string(str(item_key)) if item_key else str(item_key)
            result[safe_key] = redact(item_value, key=str(item_key), depth=depth + 1)
        return result
    return redact_string(str(value))


class Logger:
    """单行 JSON 日志器；stream 为空时在每次写入时解析 sys.stdout（可被测试捕获）。"""

    def __init__(self, stream=None) -> None:
        self._stream = stream

    def emit(self, level: str, event: str, fields: dict | None = None) -> None:
        record: dict = {
            "ts": format_timestamp(now_utc()),
            "level": level,
            "event": event,
        }
        if fields:
            for index, (key, value) in enumerate(fields.items()):
                if index >= MAX_FIELDS:
                    break
                if key in record:
                    continue
                record[redact_string(str(key))] = redact(value, key=str(key))
        try:
            line = json.dumps(
                record,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
        except (TypeError, ValueError):
            # 字段不可序列化时仍要留下一条可诊断日志，但绝不拼接原始值。
            line = json.dumps(
                {
                    "ts": record["ts"],
                    "level": level,
                    "event": event,
                    "log_error": "UNSERIALISABLE_FIELD",
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        self._write(line)

    def event(self, event: str, seq: int, detail: dict | None = None) -> None:
        """固定字段事件行（合同 E）：只有 ts/event/seq/detail，detail 经脱敏。

        detail 只允许放 operation 名、task_id、状态码等非秘密事实；token、nonce、
        完整 params 一律不得出现在这里（调用方负责，脱敏器兜底）。
        """
        if event not in EVENT_NAMES:
            raise ValueError(f"event name is not in the allowlist: {event}")
        record = {
            "ts": format_timestamp(now_utc()),
            "event": event,
            "seq": int(seq),
            "detail": redact(detail or {}),
        }
        try:
            line = json.dumps(
                record,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
        except (TypeError, ValueError):
            line = json.dumps(
                {"ts": record["ts"], "event": event, "seq": int(seq), "detail": {"log_error": "UNSERIALISABLE_DETAIL"}},
                sort_keys=True,
                separators=(",", ":"),
            )
        self._write(line)

    def _write(self, line: str) -> None:
        try:
            stream = self._stream if self._stream is not None else sys.stdout
            stream.write(line + "\n")
            stream.flush()
        except Exception:  # noqa: BLE001 - 日志失败绝不拖垮代理
            return

    def info(self, event: str, **fields) -> None:
        self.emit(LOG_LEVEL_INFO, event, fields)

    def warning(self, event: str, **fields) -> None:
        self.emit(LOG_LEVEL_WARNING, event, fields)

    def error(self, event: str, **fields) -> None:
        self.emit(LOG_LEVEL_ERROR, event, fields)


_DEFAULT_LOGGER = Logger()


def configure(stream=None) -> Logger:
    """配置进程默认 logger；stream 为空表示每次使用 sys.stdout。"""
    global _DEFAULT_LOGGER
    _DEFAULT_LOGGER = Logger(stream)
    return _DEFAULT_LOGGER


def get_logger() -> Logger:
    return _DEFAULT_LOGGER


def log_event(event: str, level: str = LOG_LEVEL_INFO, **fields) -> None:
    get_logger().emit(level, event, fields)
