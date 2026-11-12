"""严格配置加载：缺字段、类型错、未知顶层键一律拒绝启动（fail closed）。

配置形态（ADR §4，root-owned 非秘密文件 /etc/ghostfleet/node-agent.json）：

    {
      "control_plane_origin": "https://<control-plane-host>",
      "heartbeat_interval_s": 30,
      "heartbeat_interval_min_s": 15,
      "heartbeat_interval_max_s": 300,
      "jitter_ratio": 0.1,
      "request_timeout_s": 10,
      "allowed_units": ["ghostfleet-managed.service"]
    }

控制面 origin 只来自该 root-owned 文件；普通用户无法把 Agent 指向攻击者端点。
凭据路径（~/.config/ghostfleet/node-token）、节点元数据（~/.config/ghostfleet/node.json）
与运行态目录（~/.local/state/ghostfleet-agent）是 ADR 固定的默认值；仅测试/验收
harness 需要用 token_path/node_meta_path/state_dir 覆盖，因此保留为"可选但必须合法"。

旧字段 control_plane_url / interval_s 作为兼容别名接受（同一份文件里二者互斥）。

loopback 的明文 http（127.0.0.1 / ::1 / localhost）默认在生产配置里被拒绝
（CONFIG_LOOPBACK_HTTP_FORBIDDEN）：否则一个被改写的控制面 origin 可以把 Bearer
token 明文发到本机监听者。只有测试/验收 harness 通过环境变量
GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP=1（或显式 allow_loopback_http=True）才放行，
并留下一条 "测试例外" 日志。
"""
from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from . import __version__ as PACKAGE_VERSION
from .logging import Logger, get_logger
from .protocol import ProtocolError, decode_json

CONFIG_JSON_INVALID = "CONFIG_JSON_INVALID"
CONFIG_FILE_MISSING = "CONFIG_FILE_MISSING"
CONFIG_FILE_UNREADABLE = "CONFIG_FILE_UNREADABLE"
CONFIG_NOT_OBJECT = "CONFIG_NOT_OBJECT"
CONFIG_UNKNOWN_KEY = "CONFIG_UNKNOWN_KEY"
CONFIG_MISSING_FIELD = "CONFIG_MISSING_FIELD"
CONFIG_TYPE_INVALID = "CONFIG_TYPE_INVALID"
CONFIG_VALUE_INVALID = "CONFIG_VALUE_INVALID"
CONFIG_URL_INVALID = "CONFIG_URL_INVALID"
CONFIG_UNIT_INVALID = "CONFIG_UNIT_INVALID"
CONFIG_LOOPBACK_HTTP_FORBIDDEN = "CONFIG_LOOPBACK_HTTP_FORBIDDEN"

DEFAULT_CONFIG_PATH = "/etc/ghostfleet/node-agent.json"
DEFAULT_INTERVAL_S = 30.0
MIN_INTERVAL_S = 15.0
MAX_INTERVAL_S = 300.0
DEFAULT_JITTER_RATIO = 0.1
MAX_JITTER_RATIO = 0.5
DEFAULT_REQUEST_TIMEOUT_S = 10.0
MAX_REQUEST_TIMEOUT_S = 300.0
MAX_ALLOWED_UNITS = 16
MAX_CONFIG_BYTES = 64 * 1024

UNIT_RE = re.compile(r"^[a-z][a-z0-9_.@-]{0,63}\.service$")
LOOPBACK_HTTP_TEST_ENV = "GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
AGENT_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")

TOP_LEVEL_KEYS = frozenset(
    {
        "control_plane_origin",
        "control_plane_url",
        "heartbeat_interval_s",
        "heartbeat_interval_min_s",
        "heartbeat_interval_max_s",
        "jitter_ratio",
        "request_timeout_s",
        "allowed_units",
        "token_path",
        "node_meta_path",
        "state_dir",
        "interval_s",
        "agent_version",
    }
)
# ADR §4：origin 是唯一必填字段；其余有界默认值或 ADR 固定默认路径。
REQUIRED_KEYS = frozenset({"control_plane_origin"})
CONFIG_SCHEMA_KEYS = ("control_plane_origin", "control_plane_url")

TOKEN_RELATIVE_PATH = os.path.join(".config", "ghostfleet", "node-token")
NODE_META_RELATIVE_PATH = os.path.join(".config", "ghostfleet", "node.json")
STATE_RELATIVE_DIR = os.path.join(".local", "state", "ghostfleet-agent")


class ConfigError(Exception):
    """配置拒绝；`code` 是稳定错误码，`field` 指明拒绝的字段。"""

    def __init__(self, code: str, field: str = "", detail: str = "") -> None:
        self.code = code
        self.field = field
        self.detail = detail
        super().__init__(f"{code}: {field}" if field else code)


@dataclass(frozen=True)
class NodeAgentConfig:
    """已校验的进程配置；所有路径均为绝对路径。"""

    control_plane_url: str
    token_path: str
    node_meta_path: str
    state_dir: str
    agent_version: str
    interval_s: float = DEFAULT_INTERVAL_S
    interval_min_s: float = MIN_INTERVAL_S
    interval_max_s: float = MAX_INTERVAL_S
    jitter_ratio: float = DEFAULT_JITTER_RATIO
    request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S
    allowed_units: tuple[str, ...] = field(default_factory=tuple)
    loopback_http: bool = False
    source_path: str = ""

    @property
    def control_plane_host(self) -> str:
        return urlsplit(self.control_plane_url).hostname or ""

    @property
    def interval_bounds(self) -> tuple[float, float]:
        return (self.interval_min_s, self.interval_max_s)


def _fail(code: str, field_name: str, detail: str = "") -> ConfigError:
    return ConfigError(code, field_name, detail)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _require_string(document: dict, name: str, *, max_length: int = 4096) -> str:
    value = document[name]
    if not isinstance(value, str):
        raise _fail(CONFIG_TYPE_INVALID, name, "must be a string")
    if not value or "\x00" in value:
        raise _fail(CONFIG_VALUE_INVALID, name, "must be a non-empty string without NUL")
    if len(value) > max_length:
        raise _fail(CONFIG_VALUE_INVALID, name, "is too long")
    return value


def _require_absolute_path(document: dict, name: str) -> str:
    value = _require_string(document, name, max_length=4096)
    if not os.path.isabs(value):
        raise _fail(CONFIG_VALUE_INVALID, name, "must be an absolute path")
    return os.path.normpath(value)


def _number_with_bounds(
    document: dict,
    name: str,
    *,
    default: float,
    minimum: float,
    maximum: float,
    clamp: bool,
) -> float:
    if name not in document:
        return float(default)
    value = document[name]
    if not _is_number(value):
        raise _fail(CONFIG_TYPE_INVALID, name, "must be a number")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise _fail(CONFIG_VALUE_INVALID, name, "must be finite")
    if number < minimum or number > maximum:
        if not clamp:
            raise _fail(CONFIG_VALUE_INVALID, name, f"must be within [{minimum}, {maximum}]")
        number = min(max(number, minimum), maximum)
    return number


def _validate_allowed_units(document: dict) -> tuple[str, ...]:
    if "allowed_units" not in document:
        return ()
    value = document["allowed_units"]
    if not isinstance(value, list):
        raise _fail(CONFIG_TYPE_INVALID, "allowed_units", "must be a list")
    if len(value) > MAX_ALLOWED_UNITS:
        raise _fail(CONFIG_VALUE_INVALID, "allowed_units", f"at most {MAX_ALLOWED_UNITS} units")
    units: list[str] = []
    for unit in value:
        if not isinstance(unit, str) or not UNIT_RE.fullmatch(unit):
            raise _fail(CONFIG_UNIT_INVALID, "allowed_units", "unit name must match systemd user unit syntax")
        if unit in units:
            raise _fail(CONFIG_VALUE_INVALID, "allowed_units", "duplicate unit name")
        units.append(unit)
    return tuple(units)


def default_token_path(home: str | None = None) -> str:
    """ADR §4 固定凭据路径：~/.config/ghostfleet/node-token。"""
    return os.path.join(_home_directory(home), TOKEN_RELATIVE_PATH)


def default_node_meta_path(home: str | None = None) -> str:
    """ADR §4 固定节点元数据路径：~/.config/ghostfleet/node.json。"""
    return os.path.join(_home_directory(home), NODE_META_RELATIVE_PATH)


def default_state_dir(home: str | None = None) -> str:
    """ADR §4 固定运行态目录：~/.local/state/ghostfleet-agent。"""
    return os.path.join(_home_directory(home), STATE_RELATIVE_DIR)


def _home_directory(home: str | None = None) -> str:
    candidate = home if home is not None else os.environ.get("HOME") or os.path.expanduser("~")
    if not candidate or not os.path.isabs(candidate):
        raise _fail(CONFIG_VALUE_INVALID, "HOME", "home directory is unknown; cannot derive ADR §4 defaults")
    return os.path.normpath(candidate)


def _validate_url(value: Any, field_name: str = "control_plane_origin") -> tuple[str, bool]:
    if not isinstance(value, str) or not value:
        raise _fail(CONFIG_URL_INVALID, field_name, "must be a non-empty string")
    if any(character.isspace() or ord(character) < 0x20 for character in value):
        raise _fail(CONFIG_URL_INVALID, field_name, "must not contain whitespace or control characters")
    try:
        split = urlsplit(value)
        port = split.port
    except ValueError:
        raise _fail(CONFIG_URL_INVALID, field_name, "is not a valid URL") from None
    if split.username is not None or split.password is not None:
        raise _fail(CONFIG_URL_INVALID, field_name, "must not embed credentials")
    if split.query or split.fragment:
        raise _fail(CONFIG_URL_INVALID, field_name, "must not carry query or fragment")
    host = split.hostname
    if not host:
        raise _fail(CONFIG_URL_INVALID, field_name, "must name a host")
    scheme = split.scheme.lower()
    loopback = host.lower() in LOOPBACK_HOSTS
    if scheme == "https":
        loopback_http = False
    elif scheme == "http" and loopback:
        loopback_http = True
    else:
        raise _fail(
            CONFIG_URL_INVALID,
            field_name,
            "https is required; plain http only for loopback acceptance exceptions",
        )
    if port is not None and not 1 <= port <= 65535:
        raise _fail(CONFIG_URL_INVALID, field_name, "port is out of range")
    netloc = split.netloc
    path = split.path.rstrip("/")
    return f"{scheme}://{netloc}{path}", loopback_http


def _optional_absolute_path(document: dict, name: str) -> str:
    if name not in document:
        return ""
    return _require_absolute_path(document, name)


def _require_number(document: dict, name: str, *, minimum: float, maximum: float) -> float:
    if name not in document:
        raise _fail(CONFIG_MISSING_FIELD, name, "required field is missing")
    value = document[name]
    if not _is_number(value):
        raise _fail(CONFIG_TYPE_INVALID, name, "must be a number")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise _fail(CONFIG_VALUE_INVALID, name, "must be finite")
    if number < minimum or number > maximum:
        raise _fail(CONFIG_VALUE_INVALID, name, f"must be within [{minimum}, {maximum}]")
    return number


def _read_document(path) -> dict:
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_CONFIG_BYTES + 1)
    except FileNotFoundError:
        raise _fail(CONFIG_FILE_MISSING, "config", "config file does not exist") from None
    except OSError:
        raise _fail(CONFIG_FILE_UNREADABLE, "config", "config file is not readable") from None
    if len(raw) > MAX_CONFIG_BYTES:
        raise _fail(CONFIG_VALUE_INVALID, "config", "config file exceeds 64 KiB")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise _fail(CONFIG_JSON_INVALID, "config", "config file is not UTF-8") from None
    try:
        document = decode_json(text, error_code=CONFIG_JSON_INVALID)
    except ProtocolError as error:
        raise _fail(CONFIG_JSON_INVALID, "config", error.detail or "config is not valid JSON") from None
    if not isinstance(document, dict):
        raise _fail(CONFIG_NOT_OBJECT, "config", "config root must be an object")
    return document


def _warn_permissions(path, log: Logger) -> None:
    """root-owned 配置文件不应被 group/other 写入；只告警，避免因发行版差异拒绝启动。"""
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        return
    if mode & 0o022:
        log.warning("config_file_permissions_loose", mode=oct(mode), note="group/other writable configuration file")


def load_config(
    path,
    *,
    logger: Logger | None = None,
    home: str | None = None,
    allow_loopback_http: bool | None = None,
) -> NodeAgentConfig:
    """读取并严格校验配置；任何不符即抛 ConfigError。

    origin 必填，其余字段有界默认值；token/meta/state 路径缺省使用 ADR §4 固定位置，
    测试/验收可覆盖，但覆盖值同样必须是绝对路径。

    loopback 明文 http 默认被拒绝；仅当 allow_loopback_http=True 或 harness 注入
    GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP=1 时作为测试例外接受。
    """
    log = logger or get_logger()
    document = _read_document(path)
    _warn_permissions(path, log)

    unknown = sorted(key for key in document if key not in TOP_LEVEL_KEYS)
    if unknown:
        raise _fail(CONFIG_UNKNOWN_KEY, str(unknown[0]), "unknown top-level key")

    origin_keys = [key for key in CONFIG_SCHEMA_KEYS if key in document]
    if len(origin_keys) > 1:
        raise _fail(CONFIG_VALUE_INVALID, "control_plane_origin", "control plane origin must be given exactly once")
    if not origin_keys:
        raise _fail(CONFIG_MISSING_FIELD, "control_plane_origin", "required field is missing")
    origin_key = origin_keys[0]
    control_plane_url, loopback_http = _validate_url(_require_string(document, origin_key), origin_key)

    interval_keys = [key for key in ("heartbeat_interval_s", "interval_s") if key in document]
    if len(interval_keys) > 1:
        raise _fail(CONFIG_VALUE_INVALID, "heartbeat_interval_s", "interval must be given exactly once")
    interval_name = interval_keys[0] if interval_keys else "heartbeat_interval_s"
    interval_min_s = _number_with_bounds(
        document,
        "heartbeat_interval_min_s",
        default=MIN_INTERVAL_S,
        minimum=MIN_INTERVAL_S,
        maximum=MAX_INTERVAL_S,
        clamp=False,
    )
    interval_max_s = _number_with_bounds(
        document,
        "heartbeat_interval_max_s",
        default=MAX_INTERVAL_S,
        minimum=MIN_INTERVAL_S,
        maximum=MAX_INTERVAL_S,
        clamp=False,
    )
    if interval_min_s > interval_max_s:
        raise _fail(CONFIG_VALUE_INVALID, "heartbeat_interval_min_s", "min must not exceed max")
    interval_s = _number_with_bounds(
        document,
        interval_name,
        default=DEFAULT_INTERVAL_S,
        minimum=interval_min_s,
        maximum=interval_max_s,
        clamp=True,
    )
    jitter_ratio = _number_with_bounds(
        document,
        "jitter_ratio",
        default=DEFAULT_JITTER_RATIO,
        minimum=0.0,
        maximum=MAX_JITTER_RATIO,
        clamp=True,
    )
    request_timeout_s = _number_with_bounds(
        document,
        "request_timeout_s",
        default=DEFAULT_REQUEST_TIMEOUT_S,
        minimum=0.1,
        maximum=MAX_REQUEST_TIMEOUT_S,
        clamp=False,
    )
    allowed_units = _validate_allowed_units(document)

    token_path = _optional_absolute_path(document, "token_path") or default_token_path(home)
    node_meta_path = _optional_absolute_path(document, "node_meta_path") or default_node_meta_path(home)
    state_dir = _optional_absolute_path(document, "state_dir") or default_state_dir(home)

    if "agent_version" in document:
        agent_version = _require_string(document, "agent_version", max_length=64)
        if not AGENT_VERSION_RE.fullmatch(agent_version):
            raise _fail(CONFIG_VALUE_INVALID, "agent_version", "must be a bounded version token")
    else:
        agent_version = PACKAGE_VERSION

    if loopback_http and allow_loopback_http is None:
        allow_loopback_http = os.environ.get(LOOPBACK_HTTP_TEST_ENV) == "1"
    if loopback_http and not allow_loopback_http:
        raise _fail(
            CONFIG_LOOPBACK_HTTP_FORBIDDEN,
            origin_key,
            f"plain http is only allowed for acceptance harnesses ({LOOPBACK_HTTP_TEST_ENV}=1); production requires https",
        )
    if loopback_http:
        log.warning(
            "config_loopback_http_exception",
            field=origin_key,
            host=control_plane_url.split("/")[2],
            note="TEST_EXCEPTION_ONLY: plain http is accepted only for loopback/disposable acceptance; production requires https",
        )

    return NodeAgentConfig(
        control_plane_url=control_plane_url,
        token_path=token_path,
        node_meta_path=node_meta_path,
        state_dir=state_dir,
        agent_version=agent_version,
        interval_s=interval_s,
        interval_min_s=interval_min_s,
        interval_max_s=interval_max_s,
        jitter_ratio=jitter_ratio,
        request_timeout_s=request_timeout_s,
        allowed_units=allowed_units,
        loopback_http=loopback_http,
        source_path=os.fspath(path),
    )
