"""observe：只读事实采集、有界输出、失败降级 UNKNOWN、drift 只读。"""
from __future__ import annotations

import hashlib
import json
import sys

import pytest

from ghostfleet_agent.observe import (
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
    capability.write_text(
        json.dumps(
            {
                "schema": "capability/v0",
                "components": {"runtime": {"state": "READY"}, "bad!": "ready", "agent": "installed"},
            }
        ),
        encoding="utf-8",
    )
    return capability, disk


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


# -- capability 摘要 --------------------------------------------------------
def test_capability_returns_digest_and_component_states(tmp_path):
    observer = make_observer(tmp_path)
    raw = open(observer.capability_path, "rb").read()
    summary = observer.capability()
    assert summary["status"] == "READ"
    assert summary["digest"] == hashlib.sha256(raw).hexdigest()
    assert summary["components"] == {"agent": "installed", "runtime": "ready"}
    assert "READY" not in json.dumps(summary)


def test_capability_missing_is_absent(tmp_path):
    observer = make_observer(tmp_path)
    observer.capability_path = str(tmp_path / "absent.json")
    assert observer.capability() == {"status": "MISSING", "reason": "CAPABILITY_STATE_ABSENT"}
    assert observer.capability_digest() is None


@pytest.mark.parametrize(
    "content, reason",
    [
        ("{not json", "CAPABILITY_STATE_INVALID"),
        ("[1, 2, 3]", "CAPABILITY_STATE_INVALID"),
    ],
)
def test_capability_invalid_content_degrades(tmp_path, content, reason):
    summary = make_observer(tmp_path, capability=content).capability()
    assert summary == {"status": "UNKNOWN", "reason": reason}


def test_capability_too_large_degrades(tmp_path):
    observer = make_observer(tmp_path)
    path = tmp_path / "big.json"
    path.write_bytes(b"{" + b"x" * (MAX_CAPABILITY_BYTES + 2))
    observer.capability_path = str(path)
    assert observer.capability()["reason"] == "CAPABILITY_STATE_TOO_LARGE"


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
