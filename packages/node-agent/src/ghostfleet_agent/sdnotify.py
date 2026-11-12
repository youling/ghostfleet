"""最小 sd_notify 实现（systemd Type=notify + WatchdogSec=120）。

只用 AF_UNIX 数据报，支持路径 socket 与抽象 socket（"@name" 形态）；
NOTIFY_SOCKET 未设置时静默禁用（本地直接运行时不是错误）。发送失败只记一次
warning，绝不抛异常拖垮循环；绝不 unlink systemd 的 socket 路径。
"""
from __future__ import annotations

import os
import socket

READY = "READY=1"
STOPPING = "STOPPING=1"
WATCHDOG = "WATCHDOG=1"
MAINPID_PREFIX = "MAINPID="
STATUS_PREFIX = "STATUS="
ALLOWED_MESSAGES = frozenset({READY, STOPPING, WATCHDOG})
MAX_MESSAGE_BYTES = 1024
NOTIFY_SOCKET_ENV = "NOTIFY_SOCKET"
ABSTRACT_PREFIX = "@"


def _address(socket_path: str):
    if socket_path.startswith(ABSTRACT_PREFIX):
        return "\0" + socket_path[1:]
    return socket_path


def mainpid_message(pid: int | None = None) -> str:
    """MAINPID= 让 systemd 明确绑定主进程，避免 Type=notify 的 cgroup 归因歧义。"""
    value = os.getpid() if pid is None else pid
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError("pid must be a positive integer")
    return f"{MAINPID_PREFIX}{value}"


def _validate_message(message: str) -> str:
    if message.startswith(MAINPID_PREFIX):
        suffix = message[len(MAINPID_PREFIX) :]
        if not suffix.isdigit() or int(suffix) <= 0:
            raise ValueError("MAINPID message must carry a positive integer")
        return message
    if message not in ALLOWED_MESSAGES:
        raise ValueError("sdnotify message is not in the allowlist")
    if len(message.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise ValueError("sdnotify message is too large")
    return message


def send_notification(message: str, *, socket_path: str | None = None, environ=None) -> bool:
    """发送一条 sd_notify 消息；成功 True，未启用/失败 False。不抛异常。"""
    _validate_message(message)
    environment = os.environ if environ is None else environ
    target = socket_path if socket_path is not None else environment.get(NOTIFY_SOCKET_ENV)
    if not target:
        return False
    if not isinstance(target, str) or "\x00" in target or len(target) > 256:
        return False
    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.settimeout(1.0)
        sock.connect(_address(target))
        sock.sendall(message.encode("utf-8"))
        return True
    except (OSError, ValueError):
        return False
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


class Notifier:
    """进程级 notifier：记住一次失败并避免日志刷屏。"""

    def __init__(self, *, environ=None, logger=None, socket_path: str | None = None) -> None:
        self.environ = environ
        self.logger = logger
        self.socket_path = socket_path
        self._warned = False
        self._last_error = False

    @property
    def socket_target(self) -> str | None:
        if self.socket_path is not None:
            return self.socket_path
        environment = os.environ if self.environ is None else self.environ
        return environment.get(NOTIFY_SOCKET_ENV) or None

    @property
    def enabled(self) -> bool:
        return bool(self.socket_target)

    def notify(self, message: str) -> bool:
        ok = send_notification(message, socket_path=self.socket_target, environ=self.environ)
        if not ok:
            if not self._warned and self.logger is not None:
                self.logger.warning("sdnotify_failed", message=message, enabled=self.enabled)
                self._warned = True
        self._last_error = not ok
        return ok

    def ready(self) -> bool:
        return self.notify(READY)

    def watchdog(self) -> bool:
        return self.notify(WATCHDOG)

    def stopping(self) -> bool:
        return self.notify(STOPPING)

    def mainpid(self, pid: int | None = None) -> bool:
        return self.notify(mainpid_message(pid))

    def status(self, text: str) -> bool:
        """STATUS= 不属于 allowlist 的固定消息，故不提供任意文本发送。"""
        raise NotImplementedError("STATUS= text is intentionally not supported")
