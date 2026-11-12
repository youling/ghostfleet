"""本地事实采集：只读、有界、无 shell、失败降级为 UNKNOWN。

采到的都是"事实"，不是"授权"：观测结果只用于上报与 drift 比对，不触发任何
变更动作。任何探测器失败都返回 UNKNOWN/None，不抛异常拖垮常驻循环；只有
编程错误（TypeError 之类）才会冒泡。
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys

from .logging import get_logger
from .protocol import canonical_bytes

CAPABILITY_STATE_PATH = "/var/lib/fleet/capability-state.json"
MAX_CAPABILITY_BYTES = 256 * 1024
MAX_UNITS_OBSERVED = 8
MAX_DRIFT_ITEMS = 8
SYSTEMCTL_TIMEOUT_S = 5.0
MAX_COMMAND_OUTPUT_BYTES = 1024

UNIT_RE = re.compile(r"^[a-z][a-z0-9_.@-]{0,63}\.service$")
UNIT_STATE_RE = re.compile(r"^[a-z][a-z-]{0,31}$")
KNOWN_UNIT_STATES = frozenset(
    {"active", "reloading", "inactive", "failed", "activating", "deactivating", "unknown"}
)
CAPABILITY_STATE_VALUES = frozenset(
    {"ready", "installed", "missing", "degraded", "unknown", "active", "inactive", "failed", "absent"}
)

HEALTH_OK = "OK"
HEALTH_DEGRADED = "DEGRADED"
HEALTH_FAILING = "FAILING"
HEALTH_VALUES = frozenset({HEALTH_OK, HEALTH_DEGRADED, HEALTH_FAILING})

WANT_TOKENS = ("identity", "os", "uptime", "disk", "services", "capability")
DEFAULT_WANT = ("identity", "os", "uptime", "disk", "services")
DISK_PRESSURE_PCT = 90.0
DISK_FAILING_PCT = 97.0

_HOSTNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_VERSION_TOKEN_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")


class ProbeError(Exception):
    """探测器内部使用；`code` 会进入结果数据的 `status` 字段而不是异常文本。"""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(code)


def bounded_text(value, *, limit: int = 64) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > limit:
        return None
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in text):
        return None
    return text


class CommandRunner:
    """最小 subprocess 包装：数组传参、无 shell、超时、输出截断。"""

    def __init__(self, *, timeout_s: float = SYSTEMCTL_TIMEOUT_S, logger=None) -> None:
        self.timeout_s = timeout_s
        self.logger = logger or get_logger()

    def run(self, argv: list[str]) -> tuple[int, str]:
        try:
            completed = subprocess.run(  # noqa: S603 - 数组传参，无 shell
                argv,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=self.timeout_s,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            self.logger.warning("probe_command_failed", argv0=argv[0] if argv else "?", reason=type(error).__name__)
            return 127, ""
        stdout = completed.stdout[:MAX_COMMAND_OUTPUT_BYTES].decode("utf-8", "replace").strip()
        return completed.returncode, stdout


class Observer:
    """采集器；全部外部输入可注入，便于确定性测试。"""

    def __init__(
        self,
        *,
        node_uid: str,
        agent_version: str,
        allowed_units=(),
        capability_path: str = CAPABILITY_STATE_PATH,
        runner: CommandRunner | None = None,
        uptime_path: str = "/proc/uptime",
        meminfo_path: str = "/proc/meminfo",
        disk_path: str = "/",
        hostname: str | None = None,
        logger=None,
    ) -> None:
        self.node_uid = node_uid
        self.agent_version = agent_version
        self.allowed_units = tuple(allowed_units)
        self.capability_path = capability_path
        self.runner = runner or CommandRunner(logger=logger)
        self.uptime_path = uptime_path
        self.meminfo_path = meminfo_path
        self.disk_path = disk_path
        self._hostname = hostname
        self.logger = logger or get_logger()

    # -- 基础事实 -----------------------------------------------------------
    def identity(self) -> dict:
        hostname = self._hostname
        if hostname is None:
            try:
                hostname = socket.gethostname()
            except OSError:
                hostname = None
        safe_hostname = bounded_text(hostname, limit=64)
        if safe_hostname is None or not _HOSTNAME_RE.fullmatch(safe_hostname):
            safe_hostname = "unknown"
        return {
            "node_uid": self.node_uid,
            "hostname": safe_hostname,
            "agent_version": self.agent_version,
        }

    def os_info(self) -> dict:
        return {
            "system": bounded_text(platform.system(), limit=32) or "unknown",
            "release": bounded_text(platform.release(), limit=64) or "unknown",
            "machine": bounded_text(platform.machine(), limit=32) or "unknown",
            "python": platform.python_version(),
        }

    def uptime_s(self) -> int | None:
        try:
            with open(self.uptime_path, "rb") as handle:
                raw = handle.read(64)
        except OSError:
            return None
        try:
            first = raw.decode("ascii").split()[0]
            value = float(first)
        except (IndexError, ValueError, UnicodeDecodeError):
            return None
        if value < 0 or value > 10 ** 10:
            return None
        return int(value)

    def memory(self) -> dict:
        """读取 MemTotal / MemAvailable（KiB → 字节）；失败返回 UNKNOWN 形态。"""
        values: dict[str, int] = {}
        try:
            with open(self.meminfo_path, "rb") as handle:
                raw = handle.read(16 * 1024)
        except OSError:
            return {"status": "UNKNOWN"}
        for line in raw.decode("ascii", "replace").splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] in ("MemTotal:", "MemAvailable:"):
                try:
                    values[parts[0][:-1]] = int(parts[1]) * 1024
                except ValueError:
                    continue
        total = values.get("MemTotal")
        available = values.get("MemAvailable")
        if not total:
            return {"status": "UNKNOWN"}
        result: dict = {"total_bytes": total}
        if available is not None:
            result["available_bytes"] = available
            result["used_pct"] = round(100.0 * (total - available) / total, 1)
        return result

    def load_average(self) -> dict:
        try:
            one, five, fifteen = os.getloadavg()
        except (OSError, AttributeError):
            return {"status": "UNKNOWN"}
        return {"load1": round(one, 2), "load5": round(five, 2), "load15": round(fifteen, 2)}

    def disk(self) -> dict:
        try:
            usage = shutil.disk_usage(self.disk_path)
        except OSError:
            return {"status": "UNKNOWN"}
        if usage.total <= 0:
            return {"status": "UNKNOWN"}
        used_pct = round(100.0 * usage.used / usage.total, 1)
        return {
            "path": self.disk_path,
            "total_bytes": usage.total,
            "free_bytes": usage.free,
            "used_pct": used_pct,
        }

    def unit_state(self, unit: str) -> str:
        if not UNIT_RE.fullmatch(unit):
            return "unknown"
        code, output = self.runner.run(["systemctl", "--user", "show", "--property=ActiveState", "--value", unit])
        if code != 0 or not output:
            return "unknown"
        value = output.splitlines()[0].strip()
        if not UNIT_STATE_RE.fullmatch(value):
            return "unknown"
        return value if value in KNOWN_UNIT_STATES else "unknown"

    def services(self, units=None) -> dict:
        selected = tuple(self.allowed_units if units is None else units)
        seen: list[str] = []
        for unit in selected:
            if UNIT_RE.fullmatch(unit) and unit not in seen:
                seen.append(unit)
            if len(seen) >= MAX_UNITS_OBSERVED:
                break
        if not seen:
            return {"units": {}, "configured": 0}
        return {"units": {unit: self.unit_state(unit) for unit in seen}, "configured": len(seen)}

    def capability(self) -> dict:
        """只读摘要：digest + 组件状态键；不回文件内容。"""
        try:
            with open(self.capability_path, "rb") as handle:
                raw = handle.read(MAX_CAPABILITY_BYTES + 1)
        except FileNotFoundError:
            return {"status": "MISSING", "reason": "CAPABILITY_STATE_ABSENT"}
        except PermissionError:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATE_UNREADABLE"}
        except OSError:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATE_UNREADABLE"}
        if len(raw) > MAX_CAPABILITY_BYTES:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATE_TOO_LARGE"}
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATE_INVALID"}
        if not isinstance(document, dict):
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATE_INVALID"}
        digest = hashlib.sha256(raw).hexdigest()
        components = self._component_states(document)
        return {"status": "READ", "digest": digest, "components": components}

    @staticmethod
    def _component_states(document: dict) -> dict:
        source = document.get("components")
        if not isinstance(source, dict):
            source = {key: value for key, value in document.items() if key != "schema"}
        states: dict[str, str] = {}
        for name, value in sorted(source.items()):
            if len(states) >= 16:
                break
            if not isinstance(name, str) or not _VERSION_TOKEN_RE.fullmatch(name):
                continue
            state = None
            if isinstance(value, str):
                state = value
            elif isinstance(value, dict):
                candidate = value.get("state") or value.get("status")
                state = candidate if isinstance(candidate, str) else None
            if state is not None and state.lower() in CAPABILITY_STATE_VALUES:
                states[name] = state.lower()
        return states

    def capability_digest(self) -> str | None:
        summary = self.capability()
        return summary.get("digest") if summary.get("status") == "READ" else None

    # -- 组合观测 -----------------------------------------------------------
    def observe(self, want=None) -> dict:
        """按 want 子集采集；want 由 tasks 层校验后才调用。"""
        selected = tuple(DEFAULT_WANT if want is None else want)
        facts: dict = {"status": "OK", "observed": {}}
        observed = facts["observed"]
        if "identity" in selected:
            observed["identity"] = self.identity()
        if "os" in selected:
            observed["os"] = self.os_info()
        if "uptime" in selected:
            observed["uptime_s"] = self.uptime_s()
        if "disk" in selected:
            observed["disk"] = self.disk()
        if "services" in selected:
            observed["services"] = self.services()
        if "capability" in selected:
            observed["capability"] = self.capability()
        return facts

    def snapshot(self) -> dict:
        """用于 drift 比对的紧凑快照（落 state.json，长度有界）。"""
        disk = self.disk()
        capability = self.capability()
        services = self.services()
        return {
            "agent_version": self.agent_version,
            "units": services.get("units", {}),
            "capability_digest": capability.get("digest") if capability.get("status") == "READ" else None,
            "capability_status": capability.get("status"),
            "disk_used_pct": disk.get("used_pct"),
            "os": self.os_info(),
        }

    def health(self, *, snapshot: dict | None = None, outbox_depth: int = 0, failures: int = 0) -> str:
        snapshot = snapshot if snapshot is not None else self.snapshot()
        disk_pct = snapshot.get("disk_used_pct")
        if isinstance(disk_pct, (int, float)) and disk_pct >= DISK_FAILING_PCT:
            return HEALTH_FAILING
        if failures >= 3:
            return HEALTH_FAILING
        degraded = False
        units = snapshot.get("units")
        if isinstance(units, dict):
            for state in units.values():
                if state != "active":
                    degraded = True
                    break
        if snapshot.get("capability_status") in ("MISSING", "UNKNOWN"):
            degraded = True
        if isinstance(disk_pct, (int, float)) and disk_pct >= DISK_PRESSURE_PCT:
            degraded = True
        if outbox_depth > 0:
            degraded = True
        return HEALTH_DEGRADED if degraded else HEALTH_OK


def compute_drift(previous, current) -> list[dict]:
    """比较两次快照，产出有界 drift 列表；只报告事实，不触发变更。"""
    drift: list[dict] = []
    if not isinstance(previous, dict) or not isinstance(current, dict):
        return drift
    previous_units = previous.get("units") if isinstance(previous.get("units"), dict) else {}
    current_units = current.get("units") if isinstance(current.get("units"), dict) else {}
    for unit in sorted(current_units):
        before = previous_units.get(unit)
        after = current_units[unit]
        if before != after:
            drift.append({"kind": "unit_state_changed", "unit": unit, "previous": before, "current": after})
        if len(drift) >= MAX_DRIFT_ITEMS:
            return drift
    before_digest = previous.get("capability_digest")
    after_digest = current.get("capability_digest")
    if before_digest != after_digest:
        drift.append(
            {
                "kind": "capability_digest_changed",
                "previous_present": before_digest is not None,
                "current_present": after_digest is not None,
            }
        )
    if len(drift) >= MAX_DRIFT_ITEMS:
        return drift
    before_disk = previous.get("disk_used_pct")
    after_disk = current.get("disk_used_pct")
    if isinstance(before_disk, (int, float)) and isinstance(after_disk, (int, float)):
        if after_disk >= DISK_PRESSURE_PCT > before_disk:
            drift.append({"kind": "disk_pressure", "used_pct": after_disk})
    if previous.get("agent_version") != current.get("agent_version"):
        drift.append({"kind": "agent_version_changed"})
    return drift[:MAX_DRIFT_ITEMS]
