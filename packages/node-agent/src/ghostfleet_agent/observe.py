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
import stat
import subprocess
import sys

from .logging import get_logger
from .protocol import canonical_bytes
from .trust import host_root_owned

# ADR §7：只读公开投影，绝不读 root 0600 的私有 capability state。
CAPABILITY_STATUS_PATH = "/etc/ghostfleet/capability-status.json"
MAX_CAPABILITY_BYTES = 256 * 1024
MAX_CAPABILITY_ARTIFACTS = 8
MAX_UNITS_OBSERVED = 8
MAX_DRIFT_ITEMS = 8
SYSTEMCTL_TIMEOUT_S = 5.0
MAX_COMMAND_OUTPUT_BYTES = 1024

UNIT_RE = re.compile(r"^[a-z][a-z0-9_.@-]{0,63}\.service$")
UNIT_STATE_RE = re.compile(r"^[a-z][a-z-]{0,31}$")

# systemd 通知相关变量绝不能传给子进程：libsystemd 的命令行工具（systemctl /
# loginctl / systemd-analyze）退出时会向 NOTIFY_SOCKET 发 EXIT_STATUS=...，
# 主进程之外的发信会被 systemd 拒绝并每轮记一条 journal 噪音。
CHILD_ENV_STRIP_KEYS = (
    "NOTIFY_SOCKET",
    "LISTEN_FDS",
    "LISTEN_PID",
    "WATCHDOG_USEC",
    "WATCHDOG_PID",
)
KNOWN_UNIT_STATES = frozenset(
    {"active", "reloading", "inactive", "failed", "activating", "deactivating", "unknown"}
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
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ARTIFACT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


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


def child_environment(environ=None) -> dict[str, str]:
    """子进程环境：保留 PATH/LANG/HOME/XDG_RUNTIME_DIR，剔除 systemd 通知变量。

    不做 env -i 式清空：命令行工具需要正常的 PATH 与 locale。只剔除
    NOTIFY_SOCKET / LISTEN_* / WATCHDOG_*，避免子进程代主进程发伪通知。
    """
    source = os.environ if environ is None else environ
    environment = {str(key): str(value) for key, value in source.items()}
    for key in CHILD_ENV_STRIP_KEYS:
        environment.pop(key, None)
    return environment


class CommandRunner:
    """最小 subprocess 包装：数组传参、无 shell、超时、输出截断。"""

    def __init__(self, *, timeout_s: float = SYSTEMCTL_TIMEOUT_S, logger=None, environ=None) -> None:
        self.timeout_s = timeout_s
        self.logger = logger or get_logger()
        # 仅测试注入用；生产路径取 os.environ 再剥离通知变量。
        self._environ = environ

    def run(self, argv: list[str]) -> tuple[int, str]:
        try:
            completed = subprocess.run(  # noqa: S603 - 数组传参，无 shell
                argv,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=self.timeout_s,
                check=False,
                env=child_environment(self._environ),
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
        capability_path: str = CAPABILITY_STATUS_PATH,
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
        """公开能力投影：只回白名单字段与整体摘要，绝不回文件原文。

        信任前置条件（不符即 UNKNOWN，不尝试"部分读取"）：常规文件、mode 无组/
        其他写位、属主是 host root（namespace-aware，见 trust.host_root_owned：
        uid 0 已映射要求 st_uid == 0；只映射自身 UID 的沙箱里要求 overflow uid +
        只读挂载 + 当前用户不可写）。文件缺失是 UNAVAILABLE，信任校验失败是
        UNTRUSTED。
        """
        try:
            info = os.lstat(self.capability_path)
        except FileNotFoundError:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNAVAILABLE"}
        except OSError:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        if not stat.S_ISREG(info.st_mode):
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        if stat.S_IMODE(info.st_mode) & 0o022:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        trusted, _reason = host_root_owned(self.capability_path, info)
        if not trusted:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        try:
            with open(self.capability_path, "rb") as handle:
                raw = handle.read(MAX_CAPABILITY_BYTES + 1)
        except OSError:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        if len(raw) > MAX_CAPABILITY_BYTES:
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        if not isinstance(document, dict):
            return {"status": "UNKNOWN", "reason": "CAPABILITY_STATUS_UNTRUSTED"}
        return {"status": "READ", "digest": hashlib.sha256(raw).hexdigest(), **self._project_capability(document)}

    @staticmethod
    def _project_capability(document: dict) -> dict:
        """只投影公开字段；任何非法/越界字段直接省略而不是回显。"""
        projected: dict = {}
        schema = bounded_text(document.get("schema"), limit=64)
        if schema is not None:
            projected["schema"] = schema
        selection = bounded_text(document.get("selection_digest"), limit=128)
        if selection is None:
            selection = bounded_text(document.get("selection"), limit=128)
        if selection is not None:
            projected["selection_digest"] = selection
        artifacts = Observer._project_artifacts(document.get("artifacts"))
        if artifacts:
            projected["artifacts"] = artifacts
        user_unit = Observer._project_artifact(document.get("user_unit"))
        if user_unit is not None:
            projected["user_unit"] = user_unit
        payload = bounded_text(document.get("payload_sha256"), limit=64)
        if payload is not None and _SHA256_RE.fullmatch(payload):
            projected["payload_sha256"] = payload
        for key in ("control_account", "privileged_account", "release_pin", "applied_at"):
            value = bounded_text(document.get(key), limit=128)
            if value is not None:
                projected[key] = value
        return projected

    @staticmethod
    def _project_artifact(value) -> dict | None:
        if not isinstance(value, dict):
            return None
        name = value.get("name")
        sha = value.get("sha256")
        if not isinstance(name, str) or not _ARTIFACT_NAME_RE.fullmatch(name):
            return None
        if not isinstance(sha, str) or not _SHA256_RE.fullmatch(sha):
            return None
        return {"name": name, "sha256": sha}

    @staticmethod
    def _project_artifacts(value) -> list:
        if isinstance(value, dict):
            pairs = value.items()
            raw_items = []
            for name, sha in pairs:
                raw_items.append({"name": name, "sha256": sha})
        elif isinstance(value, list):
            raw_items = list(value)
        else:
            return []
        projected: list = []
        for item in raw_items[:MAX_CAPABILITY_ARTIFACTS]:
            artifact = Observer._project_artifact(item)
            if artifact is not None:
                projected.append(artifact)
        return projected

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
