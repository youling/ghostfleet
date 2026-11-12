"""cli：凭据 fail closed、退出码合同、--once 端到端。"""
from __future__ import annotations

import importlib
import json
import os
import threading

import pytest

from agent_test_support import FakeControlPlane, make_task
from ghostfleet_agent import cli, protocol
from ghostfleet_agent.cli import (
    EXIT_AUTH_FATAL,
    EXIT_CONFIG,
    EXIT_CREDENTIAL,
    EXIT_OK,
    EXIT_RUNTIME,
    MAX_TOKEN_CHARS,
    CredentialError,
    install_signal_handlers,
    load_node_uid,
    load_token,
    main,
)
from ghostfleet_agent.logging import clear_secrets


@pytest.fixture(autouse=True)
def _clean_secrets():
    clear_secrets()
    yield
    clear_secrets()


@pytest.fixture()
def sandbox(tmp_path):
    from agent_test_support import AgentSandbox

    return AgentSandbox(tmp_path / "agent")


# -- token ------------------------------------------------------------------
def test_load_token_strips_trailing_newline(sandbox):
    assert load_token(str(sandbox.token_path)) == "test-token-0000000000000000000000000000"


@pytest.mark.parametrize(
    "content, code",
    [
        ("", "CREDENTIAL_TOKEN_MISSING"),
        ("   \n\n", "CREDENTIAL_TOKEN_MISSING"),
        ("two tokens", "CREDENTIAL_TOKEN_INVALID"),
        ("bad\x00token", "CREDENTIAL_TOKEN_INVALID"),
        ("x" * (MAX_TOKEN_CHARS + 1), "CREDENTIAL_TOKEN_INVALID"),
    ],
)
def test_load_token_rejects_bad_content(sandbox, content, code):
    sandbox.token_path.write_text(content, encoding="utf-8")
    with pytest.raises(CredentialError) as excinfo:
        load_token(str(sandbox.token_path))
    assert excinfo.value.code == code
    assert excinfo.value.field == "token_path"


def test_load_token_rejects_missing_file(tmp_path):
    with pytest.raises(CredentialError) as excinfo:
        load_token(str(tmp_path / "absent-token"))
    assert excinfo.value.code == "CREDENTIAL_TOKEN_MISSING"


def test_load_token_rejects_non_regular_file(tmp_path):
    directory = tmp_path / "a-directory"
    directory.mkdir()
    with pytest.raises(CredentialError) as excinfo:
        load_token(str(directory))
    assert excinfo.value.code == "CREDENTIAL_TOKEN_INVALID"


def test_load_token_rejects_oversized_file(sandbox):
    sandbox.token_path.write_bytes(b"a" * (cli.MAX_TOKEN_BYTES + 1))
    with pytest.raises(CredentialError) as excinfo:
        load_token(str(sandbox.token_path))
    assert excinfo.value.code == "CREDENTIAL_TOKEN_INVALID"


def test_load_token_rejects_invalid_utf8(sandbox):
    sandbox.token_path.write_bytes(b"\xff\xfe\x00")
    with pytest.raises(CredentialError) as excinfo:
        load_token(str(sandbox.token_path))
    assert excinfo.value.code == "CREDENTIAL_TOKEN_INVALID"


# -- node meta --------------------------------------------------------------
def test_load_node_uid_accepts_repository_shape(sandbox):
    assert load_node_uid(str(sandbox.node_meta_path)) == sandbox.node_uid


@pytest.mark.parametrize(
    "content, code",
    [
        ("", "CREDENTIAL_NODE_META_MISSING"),
        ("not json", "CREDENTIAL_NODE_META_INVALID"),
        ("[]", "CREDENTIAL_NODE_META_INVALID"),
        ('{"platform": "linux"}', "CREDENTIAL_NODE_META_INVALID"),
        ('{"node_uid": "node-bad"}', "CREDENTIAL_NODE_META_INVALID"),
        ('{"node_uid": 5}', "CREDENTIAL_NODE_META_INVALID"),
    ],
)
def test_load_node_uid_rejects_bad_meta(sandbox, content, code):
    sandbox.node_meta_path.write_text(content, encoding="utf-8")
    with pytest.raises(CredentialError) as excinfo:
        load_node_uid(str(sandbox.node_meta_path))
    assert excinfo.value.code == code


def test_load_node_uid_rejects_missing_file(tmp_path):
    with pytest.raises(CredentialError) as excinfo:
        load_node_uid(str(tmp_path / "absent-node.json"))
    assert excinfo.value.code == "CREDENTIAL_NODE_META_MISSING"


# -- 参数解析 ---------------------------------------------------------------
def test_version_flag_prints_version(capsys):
    with pytest.raises(SystemExit) as excinfo:
        main(["--version"])
    assert excinfo.value.code == 0
    assert "0.1.0.dev0" in capsys.readouterr().out


def test_unknown_flag_exits_with_usage_error():
    with pytest.raises(SystemExit) as excinfo:
        main(["--definitely-not-a-flag"])
    assert excinfo.value.code == 2


# -- main 退出码 ------------------------------------------------------------
def test_missing_config_file_exits_credential(sandbox, tmp_path):
    # 合同 C：配置/凭据缺失或不可读 = 环境未就绪 → 3，且绝不联网。
    assert main(["--config", str(tmp_path / "absent.json")]) == EXIT_CREDENTIAL


def test_invalid_config_exits_config(sandbox, control_plane):
    sandbox.write_raw_config('{"unknown_field": true}')
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_CONFIG


def test_missing_token_exits_credential(sandbox, control_plane):
    sandbox.write_config(control_plane.url, token_path=str(sandbox.root / "absent-token"))
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_CREDENTIAL
    assert control_plane.records == []


def test_bad_node_meta_exits_credential(sandbox, control_plane):
    sandbox.node_meta_path.write_text('{"node_uid": "not-a-node"}', encoding="utf-8")
    sandbox.write_config(control_plane.url)
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_CREDENTIAL
    assert control_plane.records == []


def test_corrupt_state_exits_runtime(sandbox, control_plane):
    sandbox.write_config(control_plane.url)
    sandbox.state_dir.mkdir(parents=True, exist_ok=True)
    sandbox.state_paths()["state"].write_text("{not json", encoding="utf-8")
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_RUNTIME


def test_once_success_returns_zero(sandbox, control_plane):
    sandbox.write_config(control_plane.url)
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_OK
    assert control_plane.requests_to("/heartbeat")
    assert sandbox.state_paths()["state"].exists()


def test_once_executes_single_task(sandbox, control_plane):
    sandbox.write_config(control_plane.url)
    control_plane.heartbeat_tasks = [make_task(node_uid=sandbox.node_uid)]
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_OK
    assert len(control_plane.results) == 1
    result = control_plane.results[0]
    assert result["task_id"] == "task-0001"
    assert result["result"]["status"] == "SUCCEEDED"


def test_once_auth_fatal_returns_four(sandbox, control_plane):
    sandbox.write_config(control_plane.url)
    control_plane.respond = lambda record: (401, {"code": "NODE_AUTH_INVALID"})
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_AUTH_FATAL


def test_once_retryable_failure_returns_five(sandbox, control_plane):
    sandbox.write_config(control_plane.url)
    control_plane.respond = lambda record: (500, {"code": "INTERNAL"})
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_RUNTIME


def test_scope_mismatch_is_fatal(sandbox, control_plane):
    sandbox.write_config(control_plane.url)
    # ADR §5.1-4/合同 3：403 属于 FATAL（停止上报等人类修复）。
    control_plane.respond = lambda record: (403, {"code": "NODE_SCOPE_MISMATCH"})
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_AUTH_FATAL


def test_once_failure_is_recorded_in_state(sandbox, control_plane):
    sandbox.write_config(control_plane.url)
    control_plane.respond = lambda record: (503, {"code": "UNAVAILABLE"})
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_RUNTIME
    document = json.loads(sandbox.state_paths()["state"].read_text(encoding="utf-8"))
    assert document["consecutive_failures"] >= 1
    assert document["last_health"] == "FAILING"


# -- 子命令：check-config / status（合同 B/E） ------------------------------
def test_check_config_prints_json_and_never_calls_control_plane(sandbox, control_plane, capsys):
    # 用 https origin：避免 loopback 例外告警行混进"纯 JSON 输出"断言。
    sandbox.write_config("https://control.example.invalid")
    assert main(["check-config", "--config", str(sandbox.config_path)]) == EXIT_OK
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(lines) == 1
    document = json.loads(lines[0])
    assert document["ok"] is True
    assert document["command"] == "check-config"
    assert document["node_uid"] == sandbox.node_uid
    assert document["control_plane_host"] == "control.example.invalid"
    assert control_plane.records == []


def test_status_json_is_offline_single_line(sandbox, control_plane, capsys):
    sandbox.write_config("https://control.example.invalid")
    assert main(["status", "--json", "--config", str(sandbox.config_path)]) == EXIT_OK
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(lines) == 1
    document = json.loads(lines[0])
    assert document["ok"] is True
    assert document["command"] == "status"
    assert document["initialised"] is False
    assert document["polls"] == 0
    assert document["tasks_executed"] == 0
    assert control_plane.records == []


def test_status_reports_work_counters_after_once(sandbox, control_plane, capsys):
    sandbox.write_config(control_plane.url)
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_OK
    capsys.readouterr()
    before = len(control_plane.records)
    assert main(["status", "--json", "--config", str(sandbox.config_path)]) == EXIT_OK
    document = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert document["initialised"] is True
    assert document["polls"] >= 1
    assert len(control_plane.records) == before  # status 绝不联网


# -- 启动信任闸门（ADR §9） -------------------------------------------------
def install_config_trust(monkeypatch, directory, *, uid_map=None, mountinfo=None, overflowuid=None, writable=False):
    """注入 /proc 视图，让默认配置的 host-root 判据可在测试里确定性复现。"""
    trust = importlib.import_module("ghostfleet_agent.trust")
    proc = directory / "fake-proc"
    proc.mkdir(parents=True, exist_ok=True)
    euid = os.geteuid()
    if uid_map is None:
        # 只映射别的 UID：测试文件（属主是当前用户）落进 overflow 分支。
        other = euid + 1000
        uid_map = f"          {other}        {other}          1\n"
    if mountinfo is None:
        mountinfo = "36 1 8:1 / / ro,relatime - ext4 /dev/root rw\n"
    if overflowuid is None:
        overflowuid = f"{euid}\n"
    (proc / "uid_map").write_text(uid_map, encoding="ascii")
    (proc / "mountinfo").write_text(mountinfo, encoding="ascii")
    (proc / "overflowuid").write_text(overflowuid, encoding="ascii")
    monkeypatch.setattr(trust, "UID_MAP_PATH", str(proc / "uid_map"))
    monkeypatch.setattr(trust, "MOUNTINFO_PATH", str(proc / "mountinfo"))
    monkeypatch.setattr(trust, "OVERFLOWUID_PATH", str(proc / "overflowuid"))
    monkeypatch.setattr(trust, "_path_is_writable", (lambda path: True) if writable else (lambda path: False))
    return proc


def test_permissive_token_mode_exits_credential_without_network(sandbox, control_plane, capsys):
    sandbox.write_config(control_plane.url)
    sandbox.token_path.chmod(0o644)
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_CREDENTIAL
    assert control_plane.records == []
    output = capsys.readouterr().out
    assert "AGENT_CREDENTIAL_PERMISSIVE" in output
    assert "test-token" not in output


def test_symlinked_token_exits_credential(sandbox, control_plane, capsys):
    sandbox.write_config(control_plane.url)
    target = sandbox.root / "token-target"
    target.write_text(sandbox.token_path.read_text(encoding="utf-8"), encoding="utf-8")
    target.chmod(0o600)
    sandbox.token_path.unlink()
    sandbox.token_path.symlink_to(target)
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_CREDENTIAL
    assert control_plane.records == []
    assert "AGENT_CREDENTIAL_PERMISSIVE" in capsys.readouterr().out


def test_token_owner_mismatch_is_rejected(sandbox):
    sandbox.token_path.chmod(0o600)
    with pytest.raises(CredentialError) as excinfo:
        cli.verify_token_trust(str(sandbox.token_path), euid=os.geteuid() + 1)
    assert excinfo.value.code == "AGENT_CREDENTIAL_PERMISSIVE"
    assert excinfo.value.detail == "TOKEN_OWNER_MISMATCH"


def test_world_writable_config_exits_credential(sandbox, control_plane, capsys):
    sandbox.write_config(control_plane.url)
    sandbox.config_path.chmod(0o666)
    assert main(["--config", str(sandbox.config_path), "--once"]) == EXIT_CREDENTIAL
    assert control_plane.records == []
    output = capsys.readouterr().out
    assert "AGENT_CONFIG_UNTRUSTED" in output
    assert "test-token" not in output


def test_default_config_accepts_host_root_overflow_on_readonly_mount(sandbox, monkeypatch, tmp_path):
    # systemd 硬化沙箱常态：只映射自身 UID，host root 显示为 overflow uid。
    install_config_trust(monkeypatch, tmp_path)
    path = sandbox.write_config("https://control.example.invalid")
    path.chmod(0o644)
    cli.verify_config_trust(str(path), default_path=str(path))  # 不抛即通过


@pytest.mark.skipif(os.geteuid() == 0, reason="root 下普通用户文件同时也是 root 文件")
def test_default_config_requires_root_owner(sandbox, monkeypatch, tmp_path):
    path = sandbox.write_config("https://control.example.invalid")
    path.chmod(0o644)
    # uid 0 已映射 → 只认 st_uid == 0；文件属于当前用户 → 不可信。
    install_config_trust(monkeypatch, tmp_path, uid_map="0 0 4294967295\n")
    with pytest.raises(CredentialError) as excinfo:
        cli.verify_config_trust(str(path), default_path=str(path))
    assert excinfo.value.code == "AGENT_CONFIG_UNTRUSTED"
    assert excinfo.value.detail == "CONFIG_ROOT_NOT_PROVEN"


def test_default_config_on_writable_mount_is_rejected(sandbox, monkeypatch, tmp_path):
    install_config_trust(
        monkeypatch,
        tmp_path,
        mountinfo="36 1 8:1 / / rw,relatime - ext4 /dev/root rw\n",
    )
    path = sandbox.write_config("https://control.example.invalid")
    path.chmod(0o644)
    with pytest.raises(CredentialError) as excinfo:
        cli.verify_config_trust(str(path), default_path=str(path))
    assert excinfo.value.detail == "CONFIG_MOUNT_NOT_READONLY"


def test_default_config_writable_by_user_is_rejected(sandbox, monkeypatch, tmp_path):
    install_config_trust(monkeypatch, tmp_path, writable=True)
    path = sandbox.write_config("https://control.example.invalid")
    path.chmod(0o644)
    with pytest.raises(CredentialError) as excinfo:
        cli.verify_config_trust(str(path), default_path=str(path))
    assert excinfo.value.detail == "CONFIG_WRITABLE_BY_USER"


def test_default_config_requires_exact_0644(sandbox, monkeypatch, tmp_path):
    install_config_trust(monkeypatch, tmp_path)
    path = sandbox.write_config("https://control.example.invalid")
    path.chmod(0o664)
    with pytest.raises(CredentialError) as excinfo:
        cli.verify_config_trust(str(path), default_path=str(path))
    assert excinfo.value.detail == "CONFIG_MODE_NOT_0644"


def test_config_symlink_is_rejected(sandbox):
    path = sandbox.write_config("https://control.example.invalid")
    link = sandbox.root / "config-link.json"
    link.symlink_to(path)
    with pytest.raises(CredentialError) as excinfo:
        cli.verify_config_trust(str(link), default_path=str(link))
    assert excinfo.value.code == "AGENT_CONFIG_UNTRUSTED"
    assert excinfo.value.detail == "CONFIG_NOT_REGULAR_FILE"


# -- 信号处理 --------------------------------------------------------------
def test_signal_handlers_are_main_thread_only():
    event = threading.Event()
    result = {}

    def worker():
        result["installed"] = install_signal_handlers(event, cli.get_logger())

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(timeout=5)
    assert result["installed"] is False


def test_signal_handler_sets_the_stop_event():
    import signal

    event = threading.Event()
    logger = cli.get_logger()
    original = signal.getsignal(signal.SIGTERM)
    try:
        assert install_signal_handlers(event, logger) is True
        handler = signal.getsignal(signal.SIGTERM)
        handler(signal.SIGTERM, None)
        assert event.is_set() is True
    finally:
        signal.signal(signal.SIGTERM, original)
