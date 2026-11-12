"""sdnotify：白名单消息、路径与抽象 socket、失败不抛异常、绝不 unlink。"""
from __future__ import annotations

import io
import json
import os
import socket
import uuid

import pytest

from ghostfleet_agent.logging import Logger
from ghostfleet_agent.sdnotify import (
    ALLOWED_MESSAGES,
    MAINPID_PREFIX,
    MAX_MESSAGE_BYTES,
    NOTIFY_SOCKET_ENV,
    READY,
    STATUS_PREFIX,
    STOPPING,
    WATCHDOG,
    Notifier,
    mainpid_message,
    send_notification,
)


def bound_socket(path: str) -> socket.socket:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    sock.bind(path)
    sock.settimeout(2.0)
    return sock


def test_path_socket_receives_message(tmp_path):
    path = str(tmp_path / "notify.sock")
    sock = bound_socket(path)
    try:
        assert send_notification(READY, socket_path=path) is True
        assert sock.recv(64) == b"READY=1"
        # 绝不 unlink systemd 的 socket 路径
        assert os.path.exists(path)
    finally:
        sock.close()


def test_abstract_socket_is_supported():
    name = "ghostfleet-test-" + uuid.uuid4().hex
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    sock.bind("\0" + name)
    sock.settimeout(2.0)
    try:
        assert send_notification(WATCHDOG, socket_path="@" + name) is True
        assert sock.recv(64) == b"WATCHDOG=1"
    finally:
        sock.close()


def test_environ_is_used_when_no_socket_path(tmp_path):
    path = str(tmp_path / "notify.sock")
    sock = bound_socket(path)
    try:
        assert send_notification(STOPPING, environ={NOTIFY_SOCKET_ENV: path}) is True
        assert sock.recv(64) == b"STOPPING=1"
    finally:
        sock.close()


@pytest.mark.parametrize("message", ["", "STATUS=hello", "READY=1\nWATCHDOG=1", "ready=1"])
def test_message_allowlist_is_enforced(message):
    with pytest.raises(ValueError):
        send_notification(message, socket_path="/nonexistent")


def test_allowlist_constant_is_minimal():
    assert ALLOWED_MESSAGES == frozenset({READY, STOPPING, WATCHDOG})
    assert MAX_MESSAGE_BYTES == 1024
    assert STATUS_PREFIX == "STATUS="


@pytest.mark.parametrize(
    "target",
    [None, "", "/nonexistent/ghostfleet-notify.sock", "\x00bad", "/tmp/" + "x" * 300],
)
def test_unusable_targets_return_false(monkeypatch, target):
    environ = {} if target is None else {NOTIFY_SOCKET_ENV: target}
    assert send_notification(READY, environ=environ) is False


def test_notifier_is_disabled_without_socket():
    notifier = Notifier(environ={})
    assert notifier.enabled is False
    assert notifier.socket_target is None
    assert notifier.ready() is False
    assert notifier.watchdog() is False
    assert notifier.stopping is not None


def test_notifier_warns_only_once_on_failure():
    stream = io.StringIO()
    notifier = Notifier(environ={NOTIFY_SOCKET_ENV: "/nonexistent/ghostfleet.sock"}, logger=Logger(stream))
    assert notifier.enabled is True
    assert notifier.ready() is False
    assert notifier.watchdog() is False
    records = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert len(records) == 1
    assert records[0]["event"] == "sdnotify_failed"
    assert records[0]["enabled"] is True


def test_notifier_sends_through_injected_socket(tmp_path):
    path = str(tmp_path / "notify.sock")
    sock = bound_socket(path)
    try:
        notifier = Notifier(socket_path=path)
        assert notifier.enabled is True
        assert notifier.ready() is True
        assert sock.recv(64) == b"READY=1"
    finally:
        sock.close()


def test_status_text_is_intentionally_unsupported():
    with pytest.raises(NotImplementedError):
        Notifier(environ={}).status("anything")


# -- MAINPID（Type=notify 的进程归因） --------------------------------------
def test_mainpid_message_validation():
    assert mainpid_message(4321) == "MAINPID=4321"
    # 省略 pid 表示当前进程，必须是正整数。
    assert mainpid_message().startswith(MAINPID_PREFIX)
    assert int(mainpid_message()[len(MAINPID_PREFIX):]) > 0
    for bad in (0, -1, True, "4321"):
        with pytest.raises(ValueError):
            mainpid_message(bad)


def test_mainpid_is_sent_over_injected_socket(tmp_path):
    path = str(tmp_path / "notify.sock")
    sock = bound_socket(path)
    try:
        notifier = Notifier(socket_path=path)
        assert notifier.mainpid(4321) is True
        assert sock.recv(64) == b"MAINPID=4321"
    finally:
        sock.close()
