"""observe：只读事实采集、有界输出、失败降级 UNKNOWN、drift 只读。"""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys

import pytest

from agent_test_support import unprivileged_owner
from ghostfleet_agent.observe import (
    CHILD_ENV_STRIP_KEYS,
    DISK_FAILING_PCT,
    DISK_PRESSURE_PCT,
    HEALTH_DEGRADED,
    HEALTH_FAILING,
    HEALTH_OK,
    MAX_CAPABILITY_BYTES,
    MAX_DRIFT_ITEMS,
    MAX_UNITS_OBSERVED,
    CommandRunner,
    Observer,
    bounded_text,
    child_environment,
    compute_drift,
)

NODE_UID = "node-00000000-0000-4000-8000-000000000000"
AGENT_VERSION = "0.1.0.dev0"


class FakeRunner:
    def __init__(self, responses=None, default=(0, "active")):
        self.responses = dict(responses or {})
        self.default = default
        self.calls = []

    def run(self, argv):
        self.calls.append(list(argv))
        return self.responses.get(argv[-1], self.default)


def write_fixture(directory):
    (directory / "uptime").write_text("3600.5 12345.0\n", encoding="ascii")
    (directory / "meminfo").write_text(
        "MemTotal:       1000 kB\nMemAvailable:    400 kB\n", encoding="ascii"
    )
    disk = directory / "disk"
    disk.mkdir()
    capability = directory / "capability.json"
    # 公开投影形态：只有白名单字段，没有 root-only 私有 state 的内容。
    capability.write_text(
        json.dumps(
            {
                "schema": "ghostfleet-capability-status/v0",
                "selection_digest": "a" * 64,
                "artifacts": [{"name": "fleet-runtime", "sha256": "b" * 64}],
                "user_unit": {"name": "fleet-runtime.service", "sha256": "c" * 64},
                "payload_sha256": "d" * 64,
                "control_account": "fleet-control",
                "privileged_account": "root",
                "release_pin": "2026.11.12",
                "applied_at": "2026-11-12T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )
    capability.chmod(0o644)
    return capability, disk


def install_sandbox_trust(monkeypatch, directory, *, uid_map=None, mountinfo=None, overflowuid=None, writable=False):
    """模拟 systemd 硬化沙箱的 proc 视图：只映射别的 UID + / 只读。

    ADR §9：这种沙箱里 host root 拥有的文件显示为 overflow uid。测试文件实际
    属于当前用户，因此把 uid_map 造成「映射了另一个 UID」，让 st_uid 未被覆盖、
    走 overflow 分支；overflowuid 注入成当前用户的 uid。测试把四项事实全部注入。
    """
    trust = importlib.import_module("ghostfleet_agent.trust")
    proc = directory / "fake-proc"
    proc.mkdir(parents=True, exist_ok=True)
    euid = os.geteuid()
    if uid_map is None:
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


@pytest.fixture(autouse=True)
def sandbox_trust(tmp_path, monkeypatch):
    """默认让 fixture 文件在这个模拟沙箱里等价于「host root 拥有」。"""
    return install_sandbox_trust(monkeypatch, tmp_path)


def make_observer(directory, *, runner=None, units=(), hostname="node-host", capability=None):
    capability_path, disk = write_fixture(directory)
    if capability is not None:
        capability_path.write_text(capability, encoding="utf-8")
    return Observer(
        node_uid=NODE_UID,
        agent_version=AGENT_VERSION,
        allowed_units=units,
        capability_path=str(capability_path),
        runner=runner or FakeRunner(),
        uptime_path=str(directory / "uptime"),
        meminfo_path=str(directory / "meminfo"),
        disk_path=str(disk),
        hostname=hostname,
    )


# -- 有界文本 ---------------------------------------------------------------
@pytest.mark.parametrize(
    "value, expected",
    [("  hello  ", "hello"), ("", None), (None, None), ("x" * 65, None), ("bad\x01", None), ("ok", "ok")],
)
def test_bounded_text(value, expected):
    assert bounded_text(value, limit=64) == expected


# -- 基础事实 ---------------------------------------------------------------
def test_identity_is_bounded(tmp_path):
    assert make_observer(tmp_path).identity() == {
        "node_uid": NODE_UID,
        "hostname": "node-host",
        "agent_version": AGENT_VERSION,
    }


def test_identity_degrades_invalid_hostname(tmp_path):
    assert make_observer(tmp_path, hostname="bad host!").identity()["hostname"] == "unknown"


def test_os_info_is_bounded_strings(tmp_path):
    info = make_observer(tmp_path).os_info()
    assert set(info) == {"system", "release", "machine", "python"}
    for value in info.values():
        assert isinstance(value, str) and value


def test_uptime_reads_proc_format(tmp_path):
    assert make_observer(tmp_path).uptime_s() == 3600


def test_uptime_missing_file_is_none(tmp_path):
    observer = make_observer(tmp_path)
    observer.uptime_path = str(tmp_path / "missing")
    assert observer.uptime_s() is None


@pytest.mark.parametrize("content", ["", "abc", "-5 0", "9" * 20 + " 0"])
def test_uptime_garbage_is_none(tmp_path, content):
    observer = make_observer(tmp_path)
    path = tmp_path / "uptime-bad"
    path.write_text(content, encoding="ascii")
    observer.uptime_path = str(path)
    assert observer.uptime_s() is None


def test_memory_reports_bytes_and_usage(tmp_path):
    memory = make_observer(tmp_path).memory()
    assert memory["total_bytes"] == 1000 * 1024
    assert memory["available_bytes"] == 400 * 1024
    assert memory["used_pct"] == 60.0


@pytest.mark.parametrize("content", [None, "MemAvailable: 10 kB\n"])
def test_memory_degrades_without_total(tmp_path, content):
    observer = make_observer(tmp_path)
    if content is None:
        observer.meminfo_path = str(tmp_path / "missing")
    else:
        path = tmp_path / "meminfo-bad"
        path.write_text(content, encoding="ascii")
        observer.meminfo_path = str(path)
    assert observer.memory() == {"status": "UNKNOWN"}


def test_load_average_shape(tmp_path):
    value = make_observer(tmp_path).load_average()
    assert set(value) <= {"load1", "load5", "load15", "status"}


def test_disk_reports_usage(tmp_path):
    observer = make_observer(tmp_path)
    usage = observer.disk()
    assert usage["path"] == observer.disk_path
    assert usage["total_bytes"] > 0
    assert 0 <= usage["used_pct"] <= 100


def test_disk_missing_path_degrades(tmp_path):
    observer = make_observer(tmp_path)
    observer.disk_path = str(tmp_path / "nope")
    assert observer.disk() == {"status": "UNKNOWN"}


# -- systemd 单元状态 -------------------------------------------------------
def test_unit_state_uses_systemctl_output(tmp_path):
    runner = FakeRunner({"a.service": (0, "active\n"), "b.service": (0, "inactive")})
    observer = make_observer(tmp_path, runner=runner)
    assert observer.unit_state("a.service") == "active"
    assert observer.unit_state("b.service") == "inactive"
    assert runner.calls[0] == [
        "systemctl",
        "--user",
        "show",
        "--property=ActiveState",
        "--value",
        "a.service",
    ]


def test_unit_state_nonzero_or_garbage_is_unknown(tmp_path):
    observer = make_observer(tmp_path, runner=FakeRunner(default=(3, "active")))
    assert observer.unit_state("a.service") == "unknown"
    observer.runner = FakeRunner(default=(0, "not-a-state!"))
    assert observer.unit_state("a.service") == "unknown"
    observer.runner = FakeRunner(default=(0, ""))
    assert observer.unit_state("a.service") == "unknown"


def test_unit_state_rejects_invalid_unit_without_running_command(tmp_path):
    runner = FakeRunner()
    observer = make_observer(tmp_path, runner=runner)
    assert observer.unit_state("Bad Name") == "unknown"
    assert runner.calls == []


def test_services_filters_dedupes_and_caps(tmp_path):
    units = tuple(f"unit-{index:02d}.service" for index in range(MAX_UNITS_OBSERVED + 4))
    observer = make_observer(tmp_path, runner=FakeRunner(default=(0, "active")), units=units)
    result = observer.services()
    assert result["configured"] == MAX_UNITS_OBSERVED
    assert list(result["units"]) == list(units[:MAX_UNITS_OBSERVED])


def test_services_skips_invalid_and_duplicate_names(tmp_path):
    observer = make_observer(tmp_path, units=("bad name.service", "ok.service", "ok.service"))
    assert observer.services() == {"units": {"ok.service": "active"}, "configured": 1}


def test_services_empty_allowlist(tmp_path):
    assert make_observer(tmp_path).services() == {"units": {}, "configured": 0}


# -- capability 公开投影 ----------------------------------------------------
def test_capability_returns_projection_without_raw_content(tmp_path):
    observer = make_observer(tmp_path)
    raw = open(observer.capability_path, "rb").read()
    summary = observer.capability()
    assert summary["status"] == "READ"
    assert summary["digest"] == hashlib.sha256(raw).hexdigest()
    assert summary["schema"] == "ghostfleet-capability-status/v0"
    assert summary["selection_digest"] == "a" * 64
    assert summary["artifacts"] == [{"name": "fleet-runtime", "sha256": "b" * 64}]
    assert summary["user_unit"] == {"name": "fleet-runtime.service", "sha256": "c" * 64}
    assert summary["payload_sha256"] == "d" * 64
    assert summary["control_account"] == "fleet-control"
    assert summary["privileged_account"] == "root"
    assert summary["release_pin"] == "2026.11.12"
    assert summary["applied_at"] == "2026-11-12T00:00:00Z"
    rendered = json.dumps(summary)
    assert "components" not in summary
    # 返回值只能是投影，绝不能回显文件原文或私有路径。
    assert str(observer.capability_path) not in rendered
    assert "/var/lib/fleet" not in rendered


def test_capability_projects_published_v1_bootstrap_shape(tmp_path):
    # Mirrors capability_status_projection() in packages/bootstrap/src/bootstrap.js:
    # selection_digest and payload_sha256 are top-level; user_unit also retains
    # the payload digest/path for the installer's unit-to-payload assertion.
    document = {
        "schema": "ghostfleet-capability-status/v1",
        "selection_schema": "ghostfleet-selected-capability/v2",
        "selection_digest": "sha256:" + "a" * 64,
        "release_pin": "a" * 40,
        "applied_at": "2026-11-13T00:00:00Z",
        "control_account": "ghostfleet-managed",
        "privileged_account": "ghostfleet-ops",
        "artifacts": [
            {"name": "ghostfleet-managed.service", "sha256": "b" * 64, "mode": "0644", "kind": "unit"},
            {"name": "node-agent.pyz", "sha256": "d" * 64, "mode": "0755", "kind": "payload"},
        ],
        "payload_sha256": "d" * 64,
        "user_unit": {
            "name": "ghostfleet-managed.service",
            "sha256": "b" * 64,
            "payload_sha256": "d" * 64,
            "payload_path": "/usr/local/libexec/ghostfleet/node-agent.pyz",
        },
    }
    observer = make_observer(tmp_path, capability=json.dumps(document))
    summary = observer.capability()
    assert summary["status"] == "READ"
    assert summary["schema"] == "ghostfleet-capability-status/v1"
    assert summary["selection_digest"] == "sha256:" + "a" * 64
    assert summary["payload_sha256"] == "d" * 64
    assert summary["user_unit"] == {
        "name": "ghostfleet-managed.service",
        "sha256": "b" * 64,
    }
    rendered = json.dumps(summary)
    assert "payload_path" not in rendered
    assert "selection_schema" not in rendered


def test_capability_projection_drops_unknown_and_malformed_fields(tmp_path):
    document = {
        "schema": "ghostfleet-capability-status/v0",
        "payload_sha256": "not-a-digest",
        "artifacts": [{"name": "ok-artifact", "sha256": "e" * 64}, {"name": "bad name", "sha256": "e" * 64}],
        "user_unit": {"name": "unit.service", "sha256": "short"},
        "secret_debug": "must-not-appear",
        "raw_path": "/var/lib/fleet/capability-state.json",
    }
    summary = make_observer(tmp_path, capability=json.dumps(document)).capability()
    assert summary["status"] == "READ"
    assert summary["artifacts"] == [{"name": "ok-artifact", "sha256": "e" * 64}]
    assert "user_unit" not in summary
    assert "payload_sha256" not in summary
    rendered = json.dumps(summary)
    for leaked in ("secret_debug", "must-not-appear", "raw_path", "/var/lib/fleet"):
        assert leaked not in rendered


def test_capability_missing_is_unavailable(tmp_path):
    observer = make_observer(tmp_path)
    observer.capability_path = str(tmp_path / "absent.json")
    assert observer.capability() == {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNAVAILABLE"}
    assert observer.capability_digest() is None


def test_capability_owner_mismatch_is_untrusted(tmp_path, monkeypatch):
    install_sandbox_trust(monkeypatch, tmp_path / "owner", overflowuid="12345678")
    observer = make_observer(tmp_path)
    # 沙箱里「host root」等价于 overflow uid；文件属主是当前用户 → 必须 UNTRUSTED。
    assert observer.capability() == {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}


def test_capability_writable_mount_is_untrusted(tmp_path, monkeypatch):
    install_sandbox_trust(
        monkeypatch,
        tmp_path / "rw",
        mountinfo="36 1 8:1 / / rw,relatime - ext4 /dev/root rw\n",
    )
    observer = make_observer(tmp_path)
    assert observer.capability() == {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}


def test_capability_writable_by_user_is_untrusted(tmp_path, monkeypatch):
    install_sandbox_trust(monkeypatch, tmp_path / "wok", writable=True)
    observer = make_observer(tmp_path)
    assert observer.capability() == {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}


def test_capability_requires_uid_zero_when_namespace_maps_root(tmp_path, monkeypatch):
    install_sandbox_trust(monkeypatch, tmp_path / "mapped", uid_map="0 0 4294967295\n")
    observer = make_observer(tmp_path)
    # uid 0 已映射时只认 st_uid == 0；属主不是 host root（root 跑时 chown 4242）→ 不可信。
    unprivileged_owner(observer.capability_path)
    assert observer.capability() == {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}


def test_capability_group_or_world_writable_is_untrusted(tmp_path):
    observer = make_observer(tmp_path)
    for mode in (0o664, 0o622, 0o666):
        os.chmod(observer.capability_path, mode)
        assert observer.capability()["reason"] == "CAPABILITY_STATUS_UNTRUSTED"


def test_capability_symlink_is_untrusted(tmp_path):
    observer = make_observer(tmp_path)
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps({"schema": "x"}), encoding="utf-8")
    link = tmp_path / "link.json"
    link.symlink_to(target)
    observer.capability_path = str(link)
    assert observer.capability()["reason"] == "CAPABILITY_STATUS_UNTRUSTED"


@pytest.mark.parametrize(
    "content",
    ["{not json", "[1, 2, 3]", json.dumps({"schema": "ok"}) + "\x00"],
)
def test_capability_invalid_content_is_untrusted(tmp_path, content):
    summary = make_observer(tmp_path, capability=content).capability()
    assert summary == {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}


def test_capability_too_large_is_untrusted(tmp_path):
    observer = make_observer(tmp_path)
    path = tmp_path / "big.json"
    path.write_bytes(b"{" + b"x" * (MAX_CAPABILITY_BYTES + 2))
    path.chmod(0o644)
    observer.capability_path = str(path)
    assert observer.capability()["reason"] == "CAPABILITY_STATUS_UNTRUSTED"


# -- 组合观测 / 快照 / 健康度 -----------------------------------------------
def test_observe_default_want(tmp_path):
    facts = make_observer(tmp_path).observe()
    assert facts["status"] == "OK"
    assert set(facts["observed"]) == {"identity", "os", "uptime_s", "disk", "services"}


def test_observe_custom_want_subset(tmp_path):
    facts = make_observer(tmp_path).observe(("identity", "capability"))
    assert set(facts["observed"]) == {"identity", "capability"}


def test_snapshot_is_compact_and_serialisable(tmp_path):
    snapshot = make_observer(tmp_path).snapshot()
    assert set(snapshot) == {
        "agent_version",
        "units",
        "capability_digest",
        "capability_status",
        "disk_used_pct",
        "os",
    }
    assert len(json.dumps(snapshot, sort_keys=True)) < 4096


def test_health_ok_when_all_active_and_capability_read(tmp_path):
    observer = make_observer(tmp_path, units=("agent.service",))
    assert observer.health(snapshot=observer.snapshot()) == HEALTH_OK


def test_health_degraded_on_inactive_unit(tmp_path):
    observer = make_observer(tmp_path, units=("agent.service",), runner=FakeRunner(default=(0, "inactive")))
    snapshot = observer.snapshot()
    assert snapshot["units"]["agent.service"] == "inactive"
    assert observer.health(snapshot=snapshot) == HEALTH_DEGRADED


def test_health_degraded_on_capability_missing(tmp_path):
    observer = make_observer(tmp_path)
    observer.capability_path = str(tmp_path / "absent.json")
    assert observer.health(snapshot=observer.snapshot()) == HEALTH_DEGRADED


@pytest.mark.parametrize(
    "overrides, outbox_depth, failures, expected",
    [
        ({"disk_used_pct": DISK_PRESSURE_PCT}, 0, 0, HEALTH_DEGRADED),
        ({"disk_used_pct": DISK_FAILING_PCT}, 0, 0, HEALTH_FAILING),
        ({"disk_used_pct": 10.0}, 0, 3, HEALTH_FAILING),
        ({"disk_used_pct": 10.0}, 2, 0, HEALTH_DEGRADED),
        ({"disk_used_pct": 10.0}, 0, 0, HEALTH_OK),
    ],
)
def test_health_thresholds(tmp_path, overrides, outbox_depth, failures, expected):
    observer = make_observer(tmp_path)
    snapshot = {
        "agent_version": AGENT_VERSION,
        "units": {},
        "capability_digest": "x" * 64,
        "capability_status": "READ",
    }
    snapshot.update(overrides)
    assert observer.health(snapshot=snapshot, outbox_depth=outbox_depth, failures=failures) == expected


# -- drift ------------------------------------------------------------------
def test_compute_drift_reports_facts():
    previous = {
        "agent_version": "1",
        "units": {"a.service": "active", "b.service": "active"},
        "capability_digest": "a" * 64,
        "disk_used_pct": 10.0,
    }
    current = {
        "agent_version": "2",
        "units": {"a.service": "failed", "b.service": "inactive"},
        "capability_digest": "b" * 64,
        "disk_used_pct": 95.0,
    }
    drift = compute_drift(previous, current)
    kinds = [item["kind"] for item in drift]
    assert kinds[0] == "unit_state_changed"
    assert "capability_digest_changed" in kinds
    assert "disk_pressure" in kinds
    assert "agent_version_changed" in kinds
    assert len(drift) <= MAX_DRIFT_ITEMS


def test_compute_drift_bounds_unit_changes():
    previous = {"units": {f"u{index}.service": "active" for index in range(20)}}
    current = {"units": {f"u{index}.service": "failed" for index in range(20)}}
    drift = compute_drift(previous, current)
    assert len(drift) == MAX_DRIFT_ITEMS
    assert all(item["kind"] == "unit_state_changed" for item in drift)


def test_compute_drift_tolerates_missing_inputs():
    assert compute_drift(None, {}) == []
    assert compute_drift({}, {"disk_used_pct": 99.0}) == []
    assert compute_drift({"disk_used_pct": 95.0}, {"disk_used_pct": 10.0}) == []


# -- 命令执行 ---------------------------------------------------------------
def test_command_runner_runs_without_shell():
    code, output = CommandRunner(timeout_s=5.0).run([sys.executable, "-c", "print('hello')"])
    assert (code, output) == (0, "hello")


def test_command_runner_reports_nonzero_exit():
    code, output = CommandRunner(timeout_s=5.0).run([sys.executable, "-c", "import sys; sys.exit(3)"])
    assert (code, output) == (3, "")


def test_command_runner_missing_binary_degrades():
    assert CommandRunner(timeout_s=5.0).run(["/nonexistent/probe"]) == (127, "")


def test_command_runner_timeout_degrades():
    code, output = CommandRunner(timeout_s=0.05).run(
        [sys.executable, "-c", "import time; time.sleep(5)"]
    )
    assert (code, output) == (127, "")


# -- P1-B：子进程不继承 systemd 通知变量（避免每轮 journal 噪音） -------------
def test_child_environment_strips_systemd_notification_keys():
    environment = child_environment(
        {
            "PATH": "/usr/bin:/bin",
            "HOME": "/srv/managed",
            "LANG": "C.UTF-8",
            "XDG_RUNTIME_DIR": "/run/user/1002",
            "NOTIFY_SOCKET": "/run/user/1002/systemd/notify",
            "LISTEN_FDS": "1",
            "LISTEN_PID": "1234",
            "WATCHDOG_USEC": "60000000",
            "WATCHDOG_PID": "1234",
        }
    )
    for key in CHILD_ENV_STRIP_KEYS:
        assert key not in environment
    # 不做 env -i：命令行工具仍需正常 PATH / locale / HOME / runtime dir。
    assert environment["PATH"] == "/usr/bin:/bin"
    assert environment["HOME"] == "/srv/managed"
    assert environment["XDG_RUNTIME_DIR"] == "/run/user/1002"


def test_command_runner_child_cannot_see_notify_socket():
    probe = (
        "import json, os;"
        "print(json.dumps({k: k in os.environ for k in "
        "['NOTIFY_SOCKET','LISTEN_FDS','LISTEN_PID','WATCHDOG_USEC','WATCHDOG_PID','PATH','HOME']}))"
    )
    runner = CommandRunner(
        timeout_s=5.0,
        environ={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/"),
            "NOTIFY_SOCKET": "/run/systemd/notify",
            "WATCHDOG_USEC": "60000000",
        },
    )
    code, output = runner.run([sys.executable, "-c", probe])
    assert code == 0
    seen = json.loads(output)
    for key in ("NOTIFY_SOCKET", "LISTEN_FDS", "LISTEN_PID", "WATCHDOG_USEC", "WATCHDOG_PID"):
        assert seen[key] is False
    assert seen["PATH"] is True
    assert seen["HOME"] is True


def test_command_runner_output_is_unchanged_by_environment_stripping():
    runner = CommandRunner(timeout_s=5.0, environ=dict(os.environ, NOTIFY_SOCKET="/run/systemd/notify"))
    assert runner.run([sys.executable, "-c", "print('hello')"]) == (0, "hello")
