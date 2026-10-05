"""Concrete read-only A0 live controller probe (fixed allowlist).

This module materializes the controller-side ``A0Probe`` seam required by
``legacy mechanism contract``. It is a **fixed read-only controller probe**, not a generic
shell/ADB command runner, and it does NOT use the business ``AndroidRuntime``.

Hard invariants
---------------
- read-only only: every subprocess call is a fixed template from ``COMMAND_ALLOWLIST``;
  there is no arbitrary command/shell/ADB passthrough and no caller-supplied
  serial, package, settings key, path, endpoint or argument;
- fail-closed transport selection: zero eligible transports -> ABSENT; more than
  one -> AMBIGUOUS; exactly one may be used ephemerally for the requested
  canonical Fleet node; the selected serial/endpoint is never printed, returned
  in a durable result/error, committed, or written to an issue/report;
- target-exact: the live consumer supplies an exact canonical Fleet ``node_uid``;
  the controller runs inside a single-device window and never promotes the ADB
  serial/endpoint into Fleet identity;
- no mutation: no pair/enable/install/reboot/unlock/write/tap/input/swipe/app
  flow capability; Wireless Debugging is observation only (no ``adb pair`` /
  ``adb connect``); Tailscale/VPN/MDM are read-only observations;
- sanitized errors: durable/loggable errors carry a typed stage + class only,
  never raw stdout/stderr, serial, endpoint, IP/MAC/SSID/account/key/code;
- unknown, never fabricated: when an observation cannot be safely/portably made
  the probe returns ``None`` (or the bounded ``unknown`` class) so the detector
  classifies it ``unknown`` rather than fabricating no/false/authorized.

Observation surface coverage
-----------------------------
Safely/portably derivable from fixed read-only commands:
``android_version``, ``api_level``, ``oem_family``, ``device_class``,
``usb_transport_state`` (from enumeration), ``wireless_debugging.support``
(API >= 30), ``wireless_debugging.enabled`` (settings), ``tailscale.installed``
(pm list packages), ``vpn_always_on`` / ``vpn_lockdown`` (settings),
``mdm.device_owner`` (dpm get-device-owner), ``reboot_recovery.recovery_evidence``
(bootreason). The remaining dimensions (controller relationship/readiness,
keyguard/screen/wake/session readiness, wireless paired/reconnect, Tailscale
auth/connect, MDM profile/owner-vs-present, battery restriction) have no safe,
portable read-only observation in a bring-up window and are reported ``unknown``
rather than fabricated. They can be extended later without changing the contract.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from ghostfleet_runtime.android.detector import (
    A0Detector,
    A0Probe,
    AbsentDeviceError,
    AmbiguousDeviceError,
    CapabilityReport,
    DetectorError,
    ResolvedTarget,
)

# --- fixed command allowlist ----------------------------------------------

# Each entry is an exact, immutable argv. No part is interpolated with caller or
# device data. The selected transport serial is supplied only through the
# ANDROID_SERIAL process environment by the production runner, never embedded in
# the argv and never emitted.
_ENUMERATE_CMD: tuple[str, ...] = ("adb", "devices", "-l")

_READ_COMMANDS: dict[str, tuple[str, ...]] = {
    "android_version": ("adb", "shell", "getprop", "ro.build.version.release"),
    "api_level": ("adb", "shell", "getprop", "ro.build.version.sdk"),
    "oem_manufacturer": ("adb", "shell", "getprop", "ro.product.manufacturer"),
    "oem_brand": ("adb", "shell", "getprop", "ro.product.brand"),
    "build_characteristics": ("adb", "shell", "getprop", "ro.build.characteristics"),
    "wireless_enabled": ("adb", "shell", "settings", "get", "global", "adb_wifi_enabled"),
    "vpn_always_on": ("adb", "shell", "settings", "get", "global", "always_on_vpn_app"),
    "vpn_lockdown": ("adb", "shell", "settings", "get", "global", "vpn_lockdown"),
    "device_owner": ("adb", "shell", "dpm", "get-device-owner"),
    "tailscale_installed": ("adb", "shell", "pm", "list", "packages", "com.tailscale.ipn"),
    "bootreason": ("adb", "shell", "getprop", "ro.boot.bootreason"),
}

# Human-readable durable allowlist (serial-free) for reports and scans.
COMMAND_ALLOWLIST: tuple[str, ...] = tuple(
    " ".join(cmd) for cmd in (_ENUMERATE_CMD, *tuple(_READ_COMMANDS.values()))
)

# Map `adb devices` raw state tokens to the sanitized USB vocabulary.
_USB_STATE_MAP = {
    "device": "authorized-online",
    "unauthorized": "unauthorized",
    "offline": "offline",
}

# Exact canonical Fleet node_uid (provider-neutral identity v2) is the only
# identity input accepted; node_id/alias/hostname/IP/SSH alias are not authority.
_NODE_UID_RE = re.compile(
    r"^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_ADB_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class CommandResult:
    """Captured fixed-command result; stderr is intentionally discarded."""

    stdout: str
    returncode: int


CommandRunner = Callable[[tuple[str, ...], str | None], CommandResult]


class ControllerProbeError(DetectorError):
    """Typed failure for the live controller probe.

    Carries only a capability stage + class; never raw command output, serial,
    endpoint or device selector.
    """

    def __init__(self, stage: str, kind: str) -> None:
        self.stage = stage
        self.kind = kind
        super().__init__(f"{stage}: {kind}")


def _subprocess_runner(cmd: tuple[str, ...], serial: str | None) -> CommandResult:
    """Production runner: execute a fixed command for the selected serial.

    The serial is supplied only through the ANDROID_SERIAL process environment.
    Any runner fault is normalized to a non-zero result; the probe layer maps
    that to an unknown observation (no raw error surfaces).
    """
    import os
    import subprocess

    env = dict(os.environ)
    if serial:
        env["ANDROID_SERIAL"] = serial
    try:
        proc = subprocess.run(
            list(cmd),
            capture_output=True,
            text=True,
            env=env,
            timeout=_ADB_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return CommandResult("", 1)
    return CommandResult(proc.stdout or "", proc.returncode)


def _looks_like_wireless(serial: str) -> bool:
    # host:port form (a TCP/IP wireless transport); emulators use a different prefix.
    return ":" in serial and not serial.startswith("emulator-")


def _parse_enumerate(out: str) -> list[tuple[str, str, bool]]:
    """Parse `adb devices -l` output into (serial, usb_state, is_wireless).

    Unrecognized state tokens (e.g. ``no permissions``, ``connecting``) are
    retained as ``unknown`` so they can never disappear into ABSENT. The raw
    serial remains private to the selection process.
    """
    transports: list[tuple[str, str, bool]] = []
    lines = out.splitlines()
    # Skip the "List of devices attached" header.
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial = parts[0]
        state = parts[1]
        mapped = _USB_STATE_MAP.get(state, "unknown")
        transports.append((serial, mapped, _looks_like_wireless(serial)))
    return transports


class A0LiveControllerProbe:
    """Concrete read-only controller-side ``A0Probe`` adapter (fixed allowlist).

    Implements the accepted ``A0Probe`` read-only surface. Before any probe
    method is called, exactly one ADB transport must be selected via
    :meth:`select_for` inside a Human-isolated single-device window. The
    selected serial is held only in private process state and is never printed,
    returned in a result/error, committed, or written to an issue/report.
    """

    def __init__(self, runner: CommandRunner | None = None) -> None:
        self._runner: CommandRunner = runner or _subprocess_runner
        self._serial: str | None = None
        self._node_uid: str | None = None
        self._transport_state: str | None = None

    # --- transport selection (fail-closed) -------------------------------

    def select_for(self, node_uid: str) -> ResolvedTarget:
        """Select exactly one eligible ADB transport for the requested node.

        Fail-closed single-device window: zero transports -> ABSENT; more than
        one -> AMBIGUOUS; exactly one is used ephemerally. The selected serial
        is stored privately and never surfaces in any result or error.
        """
        node_uid = self._require_node_uid(node_uid)
        transports = _parse_enumerate(self._enumerate())
        if not transports:
            raise AbsentDeviceError(
                "no Android ADB transport present in the bring-up window"
            )
        if len(transports) > 1:
            raise AmbiguousDeviceError(
                "multiple Android ADB transports present; "
                "refuse the single-device window rather than pick one"
            )
        serial, state, _wireless = transports[0]
        if state == "unknown":
            raise ControllerProbeError("enumeration", "unknown_transport_state")
        self._serial = serial
        self._node_uid = node_uid
        self._transport_state = state
        return ResolvedTarget(ref=node_uid, transport_state=state)

    def _enumerate(self) -> str:
        try:
            result = self._runner(_ENUMERATE_CMD, None)
        except Exception:  # noqa: BLE001 - sanitize controller/ADB failures
            raise ControllerProbeError("enumeration", "controller_execution_failed") from None
        if not isinstance(result, CommandResult) or result.returncode != 0:
            raise ControllerProbeError("enumeration", "controller_execution_failed")
        return result.stdout or ""

    @staticmethod
    def _require_node_uid(node_uid: str) -> str:
        if not isinstance(node_uid, str) or not _NODE_UID_RE.match(node_uid):
            raise ControllerProbeError("node_uid", "invalid_or_missing_node_uid")
        return node_uid

    # --- fixed read-only observation surface ------------------------------

    def _read(self, key: str) -> str | None:
        """Run one fixed allowlisted command; return stripped stdout or None.

        Any runner fault or non-zero exit maps to ``None`` (unknown), never to a
        raised error that would leak raw command output.
        """
        if self._serial is None:
            return None
        template = _READ_COMMANDS[key]
        try:
            result = self._runner(template, self._serial)
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(result, CommandResult) or result.returncode != 0:
            return None
        return (result.stdout or "").strip()

    @staticmethod
    def _yesno(raw: str | None) -> str:
        if raw is None:
            return "unknown"
        r = raw.strip().lower()
        if r in ("1", "true", "yes", "on", "enabled"):
            return "yes"
        if r in ("0", "false", "no", "off", "disabled"):
            return "no"
        return "unknown"

    def android_version(self) -> str | None:
        return self._read("android_version") or None

    def api_level(self) -> int | None:
        raw = self._read("api_level")
        if not raw:
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    def oem_family(self) -> str | None:
        for key in ("oem_manufacturer", "oem_brand"):
            val = self._read(key)
            if val:
                return val
        return None

    def device_class(self) -> str | None:
        return self._read("build_characteristics") or None

    def usb_transport_state(self) -> str | None:
        # Truthful state of the selected transport; reported without re-emitting
        # the serial. The detector re-classifies this safely.
        return self._transport_state

    def wireless_debugging(self) -> dict[str, Any]:
        support = "unknown"
        api = self.api_level()
        if api is not None:
            support = "yes" if api >= 30 else "no"
        enabled = self._yesno(self._read("wireless_enabled"))
        return {
            "support": support,
            "enabled": enabled,
            "paired": "unknown",
            "reconnect_capability": "unknown",
        }

    def controller_relationship(self) -> str | None:
        # A Fleet controller relationship is a management fact, not a
        # device-observable property; report unknown rather than fabricate.
        return None

    def controller_readiness(self) -> str | None:
        return None

    def keyguard_secure(self) -> bool | None:
        # No safe, portable read-only observation without unlocking; unknown.
        return None

    def screen_on(self) -> bool | None:
        return None

    def wake_ready(self) -> bool | None:
        return None

    def session_entry_ready(self) -> str | None:
        return None

    def tailscale(self) -> dict[str, Any]:
        installed = "unknown"
        raw = self._read("tailscale_installed")
        if raw is not None and "com.tailscale.ipn" in raw:
            installed = "yes"
        elif raw is not None:
            installed = "no"
        return {
            "installed": installed,
            "version_class": "unknown",
            "authenticated": "unknown",
            "connected": "unknown",
        }

    def vpn_always_on(self) -> bool | None:
        raw = self._read("vpn_always_on")
        if raw is None:
            return None
        return raw.strip().lower() not in {"", "null", "none", "unset"}

    def vpn_lockdown(self) -> bool | None:
        value = self._yesno(self._read("vpn_lockdown"))
        if value == "unknown":
            return None
        return value == "yes"

    def mdm(self) -> dict[str, Any]:
        # `dpm get-device-owner` prints a package name or "none"; no mutation.
        raw = self._read("device_owner")
        if raw is None:
            device_owner = "unknown"
        else:
            normalized = raw.strip().lower()
            explicit_no_owner = normalized in {
                "none",
                "no device owner",
                "device owner: none",
                "device-owner: none",
            }
            device_owner = "no" if explicit_no_owner else (
                "yes" if normalized else "unknown"
            )
        return {
            "device_owner": device_owner,
            "profile_owner": "unknown",
            "mdm_present": "unknown",
        }

    def reboot_recovery_evidence(self) -> dict[str, Any]:
        raw = (self._read("bootreason") or "").lower()
        recovery = "present" if "recovery" in raw else "unknown"
        return {"reboot_evidence": "unknown", "recovery_evidence": recovery}

    def battery_restriction(self) -> str | None:
        # No safe generic read-only observation; report unknown.
        return None

    # --- high-level composition ------------------------------------------

    def classify_for(self, node_uid: str) -> CapabilityReport:
        """Select the single device and classify it via the accepted detector."""
        target = self.select_for(node_uid)
        return A0Detector(self).classify({target.ref: target.transport_state})

