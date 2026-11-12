"""命令行入口（zipapp 形态 `python3 -I node-agent.pyz <command>`）。

- `run`（默认）：常驻循环；不改 cwd、不依赖环境变量、不往 pyz 写字节；
- `check-config`：只校验配置与本地凭据可读（绝不联网）；
- `status --json`：读取本地 state/ledger/outbox 输出机器可读摘要（绝不联网）；
- 兼容旧用法：`--config PATH --once`（验收/排障）；
- `--version`：打印版本。

退出码（ADR §9，稳定合同）：
  0 正常结束（SIGTERM/SIGINT 完成收尾、--once 一轮成功、check-config/status 成功）
  2 配置/参数非法（含未知键、危险 URL、非法 interval）
  3 凭据/配置文件不可用（缺失、不可读、越权、格式非法）；不发起任何网络请求
  4 控制面明确拒绝本节点凭据（401/403、吊销、未准入）
  5 运行时失败（状态文件损坏、写盘失败、--once 单轮可重试失败、内部异常）
"""
from __future__ import annotations

import argparse
import errno
import json
import os
import signal
import stat
import sys
import threading

from . import __version__
from .client import ControlPlaneClient
from .config import DEFAULT_CONFIG_PATH, ConfigError, load_config
from .ledger import Ledger, LedgerCorruptError, LedgerWriteError
from .logging import get_logger, register_secret, clear_secrets
from .loop import AgentLoop, AuthFatalError
from .observe import Observer
from .outbox import Outbox, OutboxCorruptError, OutboxWriteError
from .protocol import (
    AGENT_CONFIG_UNTRUSTED,
    AGENT_CREDENTIAL_PERMISSIVE,
    NODE_UID_RE,
    ProtocolError,
    decode_json,
)
from .sdnotify import Notifier
from .state import (
    StateCorruptError,
    StateReadError,
    StateStore,
    StateWriteError,
    StoreError,
    ensure_state_dir,
)
from .tasks import TaskExecutor
from .trust import (
    REASON_MOUNT_NOT_READONLY,
    REASON_UID_MISMATCH,
    REASON_WRITABLE_BY_USER,
    host_root_owned,
)

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_CREDENTIAL = 3
EXIT_AUTH_FATAL = 4
EXIT_RUNTIME = 5

MAX_TOKEN_BYTES = 4096
MAX_TOKEN_CHARS = 512
MAX_NODE_META_BYTES = 64 * 1024

CREDENTIAL_TOKEN_MISSING = "CREDENTIAL_TOKEN_MISSING"
CREDENTIAL_TOKEN_UNREADABLE = "CREDENTIAL_TOKEN_UNREADABLE"
CREDENTIAL_TOKEN_INVALID = "CREDENTIAL_TOKEN_INVALID"
CREDENTIAL_NODE_META_MISSING = "CREDENTIAL_NODE_META_MISSING"
CREDENTIAL_NODE_META_INVALID = "CREDENTIAL_NODE_META_INVALID"


class CredentialError(Exception):
    """本地凭据/节点身份不可用：fail closed，不发起任何控制面请求。"""

    def __init__(self, code: str, field: str = "", detail: str = "") -> None:
        self.code = code
        self.field = field
        self.detail = detail
        super().__init__(code)


def _read_regular_file(path: str, *, max_bytes: int, missing_code: str, invalid_code: str, field: str) -> bytes:
    try:
        info = os.stat(path)
    except FileNotFoundError:
        raise CredentialError(missing_code, field, "file-missing") from None
    except OSError:
        raise CredentialError(invalid_code, field, "stat-failed") from None
    if not stat.S_ISREG(info.st_mode):
        raise CredentialError(invalid_code, field, "not-a-regular-file")
    if info.st_size <= 0:
        raise CredentialError(missing_code, field, "empty-file")
    if info.st_size > max_bytes:
        raise CredentialError(invalid_code, field, "file-too-large")
    try:
        with open(path, "rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError:
        raise CredentialError(invalid_code, field, "read-failed") from None
    if len(raw) > max_bytes:
        raise CredentialError(invalid_code, field, "file-too-large")
    return raw


def load_token(path: str) -> str:
    """读取 Bearer token：单行、无内嵌空白、≤512 字符。"""
    raw = _read_regular_file(
        path,
        max_bytes=MAX_TOKEN_BYTES,
        missing_code=CREDENTIAL_TOKEN_MISSING,
        invalid_code=CREDENTIAL_TOKEN_INVALID,
        field="token_path",
    )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise CredentialError(CREDENTIAL_TOKEN_INVALID, "token_path", "not-utf8") from None
    token = text.strip()
    if not token:
        raise CredentialError(CREDENTIAL_TOKEN_MISSING, "token_path", "blank-token")
    if len(token) > MAX_TOKEN_CHARS:
        raise CredentialError(CREDENTIAL_TOKEN_INVALID, "token_path", "token-too-long")
    for char in token:
        if char.isspace() or ord(char) < 0x20 or ord(char) == 0x7F:
            raise CredentialError(CREDENTIAL_TOKEN_INVALID, "token_path", "token-has-whitespace-or-control")
    return token


def load_node_uid(path: str) -> str:
    """读取 node.json 的 node_uid；形态必须是仓库统一的 node-<uuidv4>。"""
    raw = _read_regular_file(
        path,
        max_bytes=MAX_NODE_META_BYTES,
        missing_code=CREDENTIAL_NODE_META_MISSING,
        invalid_code=CREDENTIAL_NODE_META_INVALID,
        field="node_meta_path",
    )
    try:
        document = decode_json(raw.decode("utf-8"), error_code=CREDENTIAL_NODE_META_INVALID)
    except (UnicodeDecodeError, ProtocolError):
        raise CredentialError(CREDENTIAL_NODE_META_INVALID, "node_meta_path", "not-json") from None
    if not isinstance(document, dict):
        raise CredentialError(CREDENTIAL_NODE_META_INVALID, "node_meta_path", "not-an-object")
    node_uid = document.get("node_uid")
    if not isinstance(node_uid, str) or not NODE_UID_RE.fullmatch(node_uid):
        raise CredentialError(CREDENTIAL_NODE_META_INVALID, "node_meta_path", "node-uid-invalid")
    return node_uid


# trust 原因码 → verify_config_trust 的稳定 detail（错误码始终是 AGENT_CONFIG_UNTRUSTED）。
CONFIG_TRUST_DETAILS = {
    REASON_UID_MISMATCH: "CONFIG_ROOT_NOT_PROVEN",
    REASON_MOUNT_NOT_READONLY: "CONFIG_MOUNT_NOT_READONLY",
    REASON_WRITABLE_BY_USER: "CONFIG_WRITABLE_BY_USER",
}


def verify_token_trust(path: str, *, euid: int | None = None) -> None:
    """凭据信任闸门：常规文件、属主本人、mode 恰好 0600。

    只回错误码与字段名，绝不打印文件内容或除路径外的信息。
    """
    expected_uid = os.geteuid() if euid is None else int(euid)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        raise CredentialError(CREDENTIAL_TOKEN_MISSING, "token_path", "TOKEN_MISSING") from None
    except OSError:
        raise CredentialError(CREDENTIAL_TOKEN_UNREADABLE, "token_path", "TOKEN_UNREADABLE") from None
    if not stat.S_ISREG(info.st_mode):
        raise CredentialError(AGENT_CREDENTIAL_PERMISSIVE, "token_path", "TOKEN_NOT_REGULAR_FILE")
    if info.st_uid != expected_uid:
        raise CredentialError(AGENT_CREDENTIAL_PERMISSIVE, "token_path", "TOKEN_OWNER_MISMATCH")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise CredentialError(AGENT_CREDENTIAL_PERMISSIVE, "token_path", "TOKEN_MODE_NOT_0600")


def verify_config_trust(
    path: str,
    *,
    euid: int | None = None,
    default_path: str | None = None,
) -> None:
    """配置信任闸门：默认 /etc 配置必须是 host root 拥有的 0644 常规文件。

    「host root 拥有」是 namespace-aware 的判据（见 trust.host_root_owned）：
    uid 0 已映射时要求 st_uid == 0；未映射（只映射自身 UID，systemd 硬化沙箱的
    常态）时要求 overflow uid + 只读挂载 + 当前用户不可写。

    --config 覆盖只用于排障/验收，要求属主是当前用户且组/其他不可写；
    两种形态都必须是常规文件（拒绝符号链接）。只回稳定 detail 码，不回文件内容。
    """
    expected_uid = os.geteuid() if euid is None else int(euid)
    # 运行期解析默认路径，便于验收/测试用 monkeypatch 替换（模块导入后仍生效）。
    resolved_default = DEFAULT_CONFIG_PATH if default_path is None else default_path
    try:
        info = os.lstat(path)
    except OSError:
        raise CredentialError(AGENT_CONFIG_UNTRUSTED, "config", "CONFIG_UNREADABLE") from None
    if not stat.S_ISREG(info.st_mode):
        raise CredentialError(AGENT_CONFIG_UNTRUSTED, "config", "CONFIG_NOT_REGULAR_FILE")
    mode = stat.S_IMODE(info.st_mode)
    if os.path.abspath(path) == os.path.abspath(resolved_default):
        if mode != 0o644:
            raise CredentialError(AGENT_CONFIG_UNTRUSTED, "config", "CONFIG_MODE_NOT_0644")
        trusted, reason = host_root_owned(path, info)
        if not trusted:
            detail = CONFIG_TRUST_DETAILS.get(reason, "CONFIG_ROOT_NOT_PROVEN")
            raise CredentialError(AGENT_CONFIG_UNTRUSTED, "config", detail)
        return
    if info.st_uid != expected_uid:
        raise CredentialError(AGENT_CONFIG_UNTRUSTED, "config", "CONFIG_OWNER_MISMATCH")
    if mode & 0o022:
        raise CredentialError(AGENT_CONFIG_UNTRUSTED, "config", "CONFIG_WORLD_WRITABLE")


COMMAND_RUN = "run"
COMMAND_CHECK_CONFIG = "check-config"
COMMAND_STATUS = "status"
COMMANDS = (COMMAND_RUN, COMMAND_CHECK_CONFIG, COMMAND_STATUS)

# 配置文件本身不可用属于"环境未就绪"（3），而不是"内容非法"（2）。
_CONFIG_UNAVAILABLE_CODES = frozenset({"CONFIG_FILE_MISSING", "CONFIG_FILE_UNREADABLE"})


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ghostfleet-node-agent",
        description="GhostFleet 节点侧常驻运行时（拉模型，无入站端口）。",
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=COMMANDS,
        default=COMMAND_RUN,
        help="子命令（默认 run）",
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="配置文件路径（默认 %(default)s）")
    parser.add_argument("--once", action="store_true", help="只执行一轮后退出，用于验收/排障")
    parser.add_argument("--json", action="store_true", help="status 以 JSON 输出（机器可读）")
    parser.add_argument("--version", action="version", version=f"ghostfleet-node-agent {__version__}")
    return parser


def _config_error_exit(error: ConfigError) -> int:
    return EXIT_CREDENTIAL if error.code in _CONFIG_UNAVAILABLE_CODES else EXIT_CONFIG


def _print_json(document: dict) -> None:
    try:
        sys.stdout.write(json.dumps(document, sort_keys=True, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        pass


def _load_json_file(path: str):
    """status 专用：缺文件返回 None，损坏抛 StoreError；不写入、不创建。"""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(1024 * 1024 + 1)
    except FileNotFoundError:
        return None
    except OSError:
        raise StateReadError("STATE_READ_FAILED", "state file is not readable", path) from None
    if len(raw) > 1024 * 1024:
        raise StateCorruptError("STATE_CORRUPT", "state file exceeds 1 MiB", path)
    try:
        document = decode_json(raw.decode("utf-8"))
    except (UnicodeDecodeError, ProtocolError):
        raise StateCorruptError("STATE_CORRUPT", "state file is not valid JSON", path) from None
    if not isinstance(document, dict):
        raise StateCorruptError("STATE_CORRUPT", "state document is not an object", path)
    return document


def check_config(config, *, config_path: str | None = None) -> dict:
    """只读校验：配置 + token + node.json + 启动信任闸门。

    与 run 走完全相同的信任判据（P2-3）：0600 token、root-owned /etc 配置或
    当前用户拥有的 --config 覆盖文件。不合规抛 CredentialError，退出码 3。
    不建状态目录、不联网、不写盘。
    """
    token = load_token(config.token_path)
    node_uid = load_node_uid(config.node_meta_path)
    register_secret(token)
    verify_token_trust(config.token_path)
    verify_config_trust(config_path if config_path is not None else config.source_path)
    return {
        "ok": True,
        "command": COMMAND_CHECK_CONFIG,
        "config_path": config.source_path,
        "control_plane_host": config.control_plane_host,
        "loopback_http": config.loopback_http,
        "node_uid": node_uid,
        "agent_version": config.agent_version,
        "state_dir": config.state_dir,
        "allowed_units": len(config.allowed_units),
        "token_present": True,
    }


def status_report(config_or_none) -> dict:
    """读取本地状态摘要（不联网、不写盘）。状态文件缺失按"尚未运行"处理。"""
    if config_or_none is not None:
        state_dir = config_or_none.state_dir
        agent_version = config_or_none.agent_version
        node_meta_path = config_or_none.node_meta_path
    else:
        from .config import default_node_meta_path, default_state_dir

        state_dir = default_state_dir()
        node_meta_path = default_node_meta_path()
        agent_version = __version__

    try:
        node_uid = load_node_uid(node_meta_path)
    except CredentialError:
        node_uid = None

    state = _load_json_file(os.path.join(state_dir, "state.json")) or {}
    ledger = _load_json_file(os.path.join(state_dir, "ledger.json")) or {}
    outbox = _load_json_file(os.path.join(state_dir, "outbox.json")) or {}
    entries = ledger.get("entries") if isinstance(ledger.get("entries"), dict) else {}
    items = outbox.get("items") if isinstance(outbox.get("items"), list) else []

    def _int(value):
        return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0

    return {
        "ok": True,
        "command": COMMAND_STATUS,
        "agent_version": agent_version,
        "node_uid": node_uid,
        "state_dir": state_dir,
        "initialised": bool(state),
        "boot_id": state.get("boot_id"),
        "seq": _int(state.get("seq")),
        "last_start": state.get("last_start"),
        "last_stop": state.get("last_stop"),
        "last_heartbeat_at": state.get("last_heartbeat_at"),
        "last_health": state.get("last_health"),
        "stopping": bool(state.get("stopping")),
        "consecutive_failures": _int(state.get("consecutive_failures")),
        "polls": _int(state.get("polls")),
        "tasks_executed": _int(state.get("tasks_executed")),
        "outbox_overflow": _int(state.get("outbox_overflow")),
        "outbox_depth": len(items),
        "ledger_entries": len(entries),
    }


def install_signal_handlers(stop_event: threading.Event, logger) -> bool:
    """SIGTERM/SIGINT → stop_event；只在主线程可用，失败时返回 False。"""
    if threading.current_thread() is not threading.main_thread():
        return False

    def _handler(signum, _frame):
        logger.info("signal_received", signal=int(signum))
        stop_event.set()

    try:
        signal.signal(signal.SIGTERM, _handler)
        signal.signal(signal.SIGINT, _handler)
    except (ValueError, OSError):
        return False
    return True


def build_loop(config, token: str, node_uid: str, *, logger=None):
    logger = logger or get_logger()
    ensure_state_dir(config.state_dir, logger=logger)
    state_store = StateStore(os.path.join(config.state_dir, "state.json"), logger=logger)
    state_store.load()
    ledger = Ledger(os.path.join(config.state_dir, "ledger.json"), logger=logger)
    ledger.load()
    outbox = Outbox(os.path.join(config.state_dir, "outbox.json"), logger=logger)
    outbox.load()
    observer = Observer(
        node_uid=node_uid,
        agent_version=config.agent_version,
        allowed_units=config.allowed_units,
        logger=logger,
    )
    executor = TaskExecutor(
        node_uid=node_uid,
        agent_version=config.agent_version,
        observer=observer,
        allowed_units=config.allowed_units,
        logger=logger,
    )
    client = ControlPlaneClient(
        base_url=config.control_plane_url,
        node_uid=node_uid,
        agent_version=config.agent_version,
        token=token,
        timeout_s=config.request_timeout_s,
        logger=logger,
    )
    notifier = Notifier(logger=logger)
    return AgentLoop(
        config=config,
        node_uid=node_uid,
        token=token,
        state_store=state_store,
        ledger=ledger,
        outbox=outbox,
        observer=observer,
        executor=executor,
        client=client,
        notifier=notifier,
        logger=logger,
    )


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    logger = get_logger()
    command = args.command or COMMAND_RUN

    config = None
    config_error: ConfigError | None = None
    try:
        config = load_config(args.config, logger=logger)
    except ConfigError as error:
        config_error = error
        # status 是纯本地排障命令：配置缺失不应污染其机器可读输出。
        if command != COMMAND_STATUS:
            logger.error("config_rejected", code=error.code, field=error.field, detail=error.detail)

    # status 不联网、不写盘：配置不可用时退化为 ADR 默认路径仍然可读本地状态。
    if command == COMMAND_STATUS:
        try:
            report = status_report(config)
        except StoreError as error:
            _print_json({"ok": False, "command": COMMAND_STATUS, "code": error.code})
            return EXIT_RUNTIME
        except Exception as error:  # noqa: BLE001 - 只回类型名
            _print_json({"ok": False, "command": COMMAND_STATUS, "code": "STATUS_FAILED", "error_type": type(error).__name__})
            return EXIT_RUNTIME
        _print_json(report)
        return EXIT_OK

    if config_error is not None:
        if command == COMMAND_CHECK_CONFIG:
            _print_json({"ok": False, "command": COMMAND_CHECK_CONFIG, "code": config_error.code, "field": config_error.field})
        return _config_error_exit(config_error)

    if command == COMMAND_CHECK_CONFIG:
        try:
            report = check_config(config, config_path=args.config)
        except CredentialError as error:
            logger.error("credential_rejected", code=error.code, field=error.field, detail=error.detail)
            _print_json({"ok": False, "command": COMMAND_CHECK_CONFIG, "code": error.code, "field": error.field})
            return EXIT_CREDENTIAL
        except Exception as error:  # noqa: BLE001 - 只回类型名
            _print_json({"ok": False, "command": COMMAND_CHECK_CONFIG, "code": "CHECK_FAILED", "error_type": type(error).__name__})
            return EXIT_RUNTIME
        finally:
            clear_secrets()
        _print_json(report)
        return EXIT_OK

    # 只有真正进入常驻循环才打启动日志，保证 check-config/status 的 stdout 是纯 JSON。
    logger.info("agent_starting", agent_version=__version__, command=command, once=bool(args.once))

    try:
        token = load_token(config.token_path)
        node_uid = load_node_uid(config.node_meta_path)
        register_secret(token)
        # 启动信任闸门（ADR §7）：不合规一律退出 3 且不联网，只报稳定错误码。
        verify_token_trust(config.token_path)
        verify_config_trust(args.config)
    except CredentialError as error:
        logger.error("credential_rejected", code=error.code, field=error.field, detail=error.detail)
        return EXIT_CREDENTIAL

    try:
        loop = build_loop(config, token, node_uid, logger=logger)
    except StoreError as error:
        logger.error("state_unusable", code=error.code)
        return EXIT_RUNTIME

    stop_event = threading.Event()
    signals_installed = install_signal_handlers(stop_event, logger)
    try:
        loop.reconcile()
        if args.once:
            return loop.run_once()
        return loop.run_forever(stop_event=stop_event if signals_installed else None)
    except AuthFatalError as error:
        logger.error("auth_fatal", code=error.code)
        return EXIT_AUTH_FATAL
    except (
        StateCorruptError,
        StateReadError,
        StateWriteError,
        LedgerCorruptError,
        LedgerWriteError,
        OutboxCorruptError,
        OutboxWriteError,
    ) as error:
        logger.error("state_failure", code=error.code)
        return EXIT_RUNTIME
    except KeyboardInterrupt:
        try:
            loop.shutdown(reason="keyboard_interrupt")
        except StoreError as error:
            logger.error("state_failure", code=error.code)
            return EXIT_RUNTIME
        return EXIT_OK
    except Exception as error:  # noqa: BLE001 - 只记类型名，绝不打印内容（可能含敏感数据）
        logger.error("agent_error", error_type=type(error).__name__)
        return EXIT_RUNTIME
    finally:
        clear_secrets()
