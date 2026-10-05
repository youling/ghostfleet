"""Common read-only Android A0 capability detector (vendor-neutral).

This module implements exactly one job: classify a single resolved Android
device into sanitized capability *classes* suitable for later live execution,
without any mutation and without durable output of secrets or topology.

Design intent
-------------
K20 and Lenovo must not each grow ad-hoc discovery scripts. This is the shared
Fleet-owned detector seam they both consume, staying inside the existing
``ghostfleet_runtime.android`` package and reusing its contracts.

Hard invariants
---------------
- read-only only: the probe surface is a fixed allowlisted set of read
  methods; there is no arbitrary shell/ADB passthrough;
- target-exact, fail-closed: absent/ambiguous targets refuse; ``UNAUTHORIZED``
  is never collapsed into ``OFFLINE``; ``UNKNOWN != FALSE``;
- deterministic: same observations map to the same classes, so later live
  consumers get a stable vocabulary;
- secret/topology-safe: ``report_to_dict`` strips serial / IP / MAC / SSID /
  account / pairing / auth / lock-credential material before durable output.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

# --- normalization bounds ---------------------------------------------------

_MAX_IDENTIFIER_LEN = 64
_VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}$")
_IP_LIKE_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
_MAC_LIKE_RE = re.compile(
    r"^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$"
)

# Closed vocabulary of known Android OEM manufacturer classes. Raw probe
# strings are normalized to one of these bounded classes; the raw source
# string is never emitted into durable output. ``other`` is the catch-all
# for a recognized-but-unclassified non-sensitive manufacturer; ``unknown``
# means absent/unreadable evidence.
OEM_CLASSES = (
    "xiaomi", "lenovo", "samsung", "google", "huawei", "oppo",
    "vivo", "motorola", "sony", "nokia", "nothing", "asus",
    "other", "unknown",
)
_OEM_CLASS_BY_TOKEN = {
    "xiaomi": "xiaomi",
    "redmi": "xiaomi",
    "poco": "xiaomi",
    "lenovo": "lenovo",
    "motorola": "motorola",
    "samsung": "samsung",
    "google": "google",
    "pixel": "google",
    "huawei": "huawei",
    "honor": "huawei",
    "oppo": "oppo",
    "oneplus": "oppo",
    "realme": "oppo",
    "vivo": "vivo",
    "iqoo": "vivo",
    "sony": "sony",
    "nokia": "nokia",
    "nothing": "nothing",
    "asus": "asus",
}
# Tokens that encode sensitive topology/device evidence; any observation
# that contains one is treated as unreadable (unknown), never classified.
_TOXIC_TOKEN_RE = re.compile(
    r"(?:^|[^a-z0-9])(?:sn|imei|meid|esn|iccid|mac|ssid|bssid|uuid|guid|wifi|bt|ipv?)[0-9_:.-]",
    re.IGNORECASE,
)


def _classify_oem(value: Any) -> str:
    """Normalize an OEM probe observation to a bounded manufacturer class.

    ``other`` is returned for a recognized but unclassified non-sensitive
    manufacturer observation; ``unknown`` for absent/unreadable evidence.
    The raw source string is never returned.
    """
    if value is None:
        return "unknown"
    raw = str(value).strip().lower()
    if not raw or len(raw) > _MAX_IDENTIFIER_LEN:
        return "unknown"
    if _IP_LIKE_RE.match(raw) or _MAC_LIKE_RE.match(raw):
        return "unknown"
    if _TOXIC_TOKEN_RE.search(raw):
        return "unknown"
    for token in re.split(r"[^a-z0-9]+", raw):
        if token in _OEM_CLASS_BY_TOKEN:
            return _OEM_CLASS_BY_TOKEN[token]
    # A recognized-but-unclassified manufacturer observation. We do not know
    # its class; map to the bounded ``other`` seat rather than the raw string.
    return "other"


def _classify_build(value: Any) -> str:
    """Normalize a build-family observation to a bounded class.

    There is no real closed build taxonomy yet, so a build observation is
    never emitted verbatim: it collapses to ``other`` when present and
    non-sensitive, ``unknown`` when absent/unreadable.
    """
    if value is None:
        return "unknown"
    raw = str(value).strip().lower()
    if not raw or len(raw) > _MAX_IDENTIFIER_LEN:
        return "unknown"
    if _IP_LIKE_RE.match(raw) or _MAC_LIKE_RE.match(raw):
        return "unknown"
    if _TOXIC_TOKEN_RE.search(raw):
        return "unknown"
    return "other"


def _safe_version(value: Any) -> str | None:
    """Bound ``android_version`` to a dotted-integer pattern.

    Arbitrary probe strings (identifiers, topology fragments, IPs) are
    rejected rather than passed through durable output.
    """
    if value is None:
        return None
    raw = str(value).strip()
    if not raw or len(raw) > _MAX_IDENTIFIER_LEN:
        return None
    if _VERSION_RE.match(raw):
        return raw
    return None


# --- capability class enumerations (sanitized vocabulary only) ------------

USB_STATES = ("absent", "offline", "unauthorized", "authorized-online")
TRISTATE = ("unknown", "no", "yes")
KEYGUARD_STATES = ("unknown", "non-secure", "secure")
DEVICE_CLASSES = ("unknown", "phone", "tablet")
CONTROLLER_RELATIONSHIPS = ("unknown", "none", "bound")
CONTROLLER_READINESS = ("unknown", "not-ready", "ready")
SESSION_READINESS = ("unknown", "not-ready", "ready")
VPN_CLASSES = ("unknown", "none", "always-on", "lockdown")
MDM_CLASSES = ("unknown", "none", "device-owner", "profile-owner", "mdm")
OEM_RESTRICTION_CLASSES = ("unknown", "unrestricted", "restricted")
RECORD_STATES = ("unknown", "absent", "present")


# --- exceptions ------------------------------------------------------------

class DetectorError(Exception):
    """Base class for detector failures (never a device-kind result)."""


class AbsentDeviceError(DetectorError):
    """No Android device target is discoverable for this run."""


class AmbiguousDeviceError(DetectorError):
    """More than one target matched; refuse rather than pick one."""


class UnsupportedProbeFieldError(DetectorError):
    """A probe exposed an unsupported/unknown read field."""


# --- target resolution -----------------------------------------------------

@dataclass(frozen=True)
class ResolvedTarget:
    """A single resolved device target for read-only detection.

    ``ref`` is used only to correlate the discovery result to the caller's
    node reference; it is never emitted as a durable identifier.
    """

    ref: str
    transport_state: str


def resolve_target(discovery: dict[str, str]) -> ResolvedTarget:
    """Resolve exactly one Android device, fail closed.

    ``discovery`` maps an opaque per-node reference (node_id / node_uid /
    asset_ref — caller-owned) to that device's observed USB ADB transport
    state. Rules:
    - zero entries -> :class:`AbsentDeviceError` (absent target);
    - a distinct unauthorized device alone is a valid target: it must NOT be
      collapsed into offline (it exists, but not authorized);
    - a distinct offline device alone is a valid target only when the caller
      pins it (in practice an offline device is not directly readable, but the
      transport state must still be reported truthfully);
    - more than one distinct device -> :class:`AmbiguousDeviceError`.
    """
    if not isinstance(discovery, dict) or not discovery:
        raise AbsentDeviceError("no Android device target is discoverable")

    valid: list[tuple[str, str]] = []
    for ref, state in discovery.items():
        if not isinstance(state, str):
            raise DetectorError(
                "discovery transport state must be a string; "
                "non-string values are not coerced"
            )
        norm = state.lower()
        if norm == "unauthorized":
            norm = "unauthorized"
        valid.append((ref, norm))

    if len(valid) > 1:
        masked = [f"ref[{i}]" for i in range(len(valid))]
        raise AmbiguousDeviceError(
            f"multiple Android device targets resolved: {masked}; "
            "refuse rather than pick one"
        )

    ref, state = valid[0]
    if state not in USB_STATES:
        # Only ever surface recognized, sanitized transport states; an
        # unrecognized raw value must not become FALSE/offline by chance.
        raise DetectorError(
            f"unrecognized discovery transport state {state!r}; "
            "refuse rather than coerce to a known state"
        )
    return ResolvedTarget(ref=ref, transport_state=state)


# --- read-only probe surface -----------------------------------------------

@runtime_checkable
class A0Probe(Protocol):
    """Fixed allowlist of read-only Android capability probes.

    A concrete probe implementation reads device facts *without mutation* and
    returns raw observation values. The classifier never calls an arbitrary
    command runner: only these methods exist on the star.
    """

    def android_version(self) -> str | None: ...
    def api_level(self) -> int | None: ...
    def oem_family(self) -> str | None: ...
    def device_class(self) -> str | None: ...
    def usb_transport_state(self) -> str | None: ...
    def wireless_debugging(self) -> dict[str, Any]: ...
    def controller_relationship(self) -> str | None: ...
    def controller_readiness(self) -> str | None: ...
    def keyguard_secure(self) -> bool | None: ...
    def screen_on(self) -> bool | None: ...
    def wake_ready(self) -> bool | None: ...
    def session_entry_ready(self) -> bool | None: ...
    def tailscale(self) -> dict[str, Any]: ...
    def vpn_always_on(self) -> bool | None: ...
    def vpn_lockdown(self) -> bool | None: ...
    def mdm(self) -> dict[str, Any]: ...
    def reboot_recovery_evidence(self) -> dict[str, Any]: ...
    def battery_restriction(self) -> str | None: ...


# --- result model ----------------------------------------------------------

@dataclass
class CapabilityReport:
    """Sanitized capability-class result for exactly one device.

    Only capability classes are emitted. No serial / IP / MAC / SSID /
    account / pairing code / auth key / lock credential appears here.
    """

    target_ref: str
    transport_state: str
    android_version: str | None = None
    api_level: int | None = None
    oem_family: str | None = None
    build_family: str | None = None
    device_class: str = "unknown"
    usb: str = "absent"
    wireless: dict = field(default_factory=dict)
    controller_relationship: str = "unknown"
    controller_readiness: str = "unknown"
    keyguard: str = "unknown"
    screen_on: bool | None = None
    wake_ready: bool | None = None
    session_entry_ready: str = "unknown"
    tailscale: dict = field(default_factory=dict)
    vpn: str = "unknown"
    mdm: str = "unknown"
    reboot_recovery: dict = field(default_factory=dict)
    battery_restriction: str = "unknown"
    # Determinism / audit fields.
    mutation_attempted: bool = False
    unreachable: bool = False

    def to_dict(self) -> dict:
        """Serialize with topology/secret-free confidence that the classes are
        already sanitized. ``target_ref`` is a caller node reference, not a
        device identifier, and is omitted from durable output.
        """
        return {
            "transport_state": self.transport_state,
            "android_version": self.android_version,
            "api_level": self.api_level,
            "oem_family": self.oem_family,
            "build_family": self.build_family,
            "device_class": self.device_class,
            "usb": self.usb,
            "wireless": {k: _safe_value(v) for k, v in self.wireless.items()},
            "controller_relationship": self.controller_relationship,
            "controller_readiness": self.controller_readiness,
            "keyguard": self.keyguard,
            "screen_on": self.screen_on,
            "wake_ready": self.wake_ready,
            "session_entry_ready": self.session_entry_ready,
            "tailscale": {k: _safe_value(v) for k, v in self.tailscale.items()},
            "vpn": self.vpn,
            "mdm": self.mdm,
            "reboot_recovery": {k: _safe_value(v) for k, v in self.reboot_recovery.items()},
            "battery_restriction": self.battery_restriction,
            "mutation_attempted": self.mutation_attempted,
            "unreachable": self.unreachable,
        }


def _safe_value(value: Any) -> Any:
    """Return only JSON-safe scalars; anything unknown maps to None."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return None


def _tristate(value: Any) -> str:
    """Map an observed value to a tristate class without collapsing unknown."""
    if value is None:
        return "unknown"
    if value is True:
        return "yes"
    if value is False:
        return "no"
    if value in ("yes", "no", "enabled", "disabled", "on", "off"):
        if value in ("yes", "enabled", "on"):
            return "yes"
        return "no"
    return "unknown"


def _record_state(value: Any) -> str:
    """Classify presence evidence (reboot/recovery) as unknown/absent/present."""
    if value is None:
        return "unknown"
    if value is True:
        return "present"
    if value is False:
        return "absent"
    if value in ("present", "absent"):
        return value
    return "unknown"


def _battery_class(value: Any) -> str:
    if value is None:
        return "unknown"
    if isinstance(value, bool):
        return "restricted" if value else "unrestricted"
    if isinstance(value, str):
        low = value.lower()
        if low in ("restricted", "unrestricted"):
            return low
        if low in ("true", "yes", "1", "restrict", "aggressive"):
            return "restricted"
        if low in ("false", "no", "0", "unrestricted", "normal"):
            return "unrestricted"
    return "unknown"


def _vpn_class(always_on: Any, lockdown: Any) -> str:
    if lockdown is True:
        return "lockdown"
    if always_on is True:
        return "always-on"
    if always_on is False and lockdown is False:
        return "none"
    return "unknown"


def _mdm_class(device_owner: Any, profile_owner: Any, mdm_present: Any) -> str:
    device = _tristate(device_owner)
    profile = _tristate(profile_owner)
    present = _tristate(mdm_present)
    # Precedence: strong dedicated DPC first, then a generic MDM marker, else
    # the explicitly safe "none" only when every signal is a definite no.
    if device == "yes":
        return "device-owner"
    if profile == "yes":
        return "profile-owner"
    if present == "yes":
        return "mdm"
    if device == "no" and profile == "no" and present == "no":
        return "none"
    return "unknown"


# --- classifier ------------------------------------------------------------

class A0Detector:
    """Deterministic classifier mapping probe observations to capability
    classes for exactly one resolved target.

    The detector holds a probe; it never mutates a device and exposes no
    shell/ADB passthrough. Construction is cheap and side-effect free.
    """

    def __init__(self, probe: A0Probe) -> None:
        self._probe = probe

    def classify(
        self,
        discovery: dict[str, str],
        *,
        reachable: bool = True,
    ) -> CapabilityReport:
        """Run classification for the single resolved target.

        ``discovery`` maps a per-node reference to its observed transport
        state and is resolved exactly-once (fail closed on absent/ambiguous).
        """
        target = resolve_target(discovery)

        report = CapabilityReport(
            target_ref=target.ref,
            transport_state=target.transport_state,
            usb=target.transport_state,
            unreachable=not reachable,
        )

        # We only read from a reachable, authorized-online device. An offline
        # or unauthorized device cannot be probed; we report its true
        # transport class and leave every capability class unknown (never
        # false) rather than guessing.
        if target.transport_state != "authorized-online" or not reachable:
            if target.transport_state == "offline":
                report.usb = "offline"
            elif target.transport_state == "unauthorized":
                report.usb = "unauthorized"
            return report

        self._probe_and_fill(report)
        return report

    def _probe_and_fill(self, report: CapabilityReport) -> None:
        try:
            report.android_version = _safe_version(self._probe.android_version())
            report.api_level = self._safe_int(self._probe.api_level())
            report.oem_family = _classify_oem(self._probe.oem_family())
            report.build_family = _classify_build(self._probe.oem_family())
            report.device_class = self._classify_device(self._probe.device_class())

            report.usb = self._classify_usb(self._probe.usb_transport_state())
            report.wireless = self._classify_wireless(self._probe.wireless_debugging())
            report.controller_relationship = self._classify_controller_rel(
                self._probe.controller_relationship()
            )
            report.controller_readiness = self._classify_controller_readiness(
                self._probe.controller_readiness()
            )
            report.keyguard = self._classify_keyguard(self._probe.keyguard_secure())
            report.screen_on = self._safe_bool(self._probe.screen_on())
            report.wake_ready = self._safe_bool(self._probe.wake_ready())
            report.session_entry_ready = self._classify_session(
                self._probe.session_entry_ready()
            )
            report.tailscale = self._classify_tailscale(self._probe.tailscale())
            report.vpn = self._classify_vpn(self._probe.vpn_always_on(), self._probe.vpn_lockdown())
            report.mdm = self._classify_mdm(self._probe.mdm())
            report.reboot_recovery = self._classify_reboot(self._probe.reboot_recovery_evidence())
            report.battery_restriction = self._classify_battery(self._probe.battery_restriction())
        except UnsupportedProbeFieldError:
            raise
        except DetectorError:
            raise
        except Exception:  # noqa: BLE001 - a probe that can't be read fails closed
            report.unreachable = True
            raise DetectorError(
                "capability probe failed; fail closed without fabricating state"
            ) from None

    def _safe_int(self, value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _safe_bool(self, value: Any) -> bool | None:
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            low = value.lower()
            if low in ("true", "1", "yes", "on"):
                return True
            if low in ("false", "0", "no", "off"):
                return False
        return None

    def _classify_device(self, value: Any) -> str:
        if value is None:
            return "unknown"
        if not isinstance(value, str):
            value = str(value)
        low = value.strip().lower()
        if low in ("phone", "handset", "0") or "phone" in low:
            return "phone"
        if low in ("tablet", "foldable") or "tablet" in low:
            return "tablet"
        return "unknown"

    def _classify_usb(self, value: Any) -> str:
        if value is None:
            # Missing probe evidence is never positive authorization.
            return "unknown"
        if not isinstance(value, str):
            value = str(value)
        low = value.strip().lower()
        if low == "unauthorized":
            return "unauthorized"
        if low in ("offline", "off-line"):
            return "offline"
        if low in ("authorized", "authorized-online", "online", "device"):
            return "authorized-online"
        if low in ("absent", "no-device", "none", "disconnected"):
            return "absent"
        # Unknown/unrecognized probe transport value is never mapped to
        # authorized-online; positive authorization requires explicit evidence.
        return "unknown"

    def _classify_wireless(self, value: Any) -> dict:
        if not isinstance(value, dict):
            return {
                "support": "unknown",
                "enabled": "unknown",
                "paired": "unknown",
                "reconnect_capability": "unknown",
            }
        allowed = {"support", "enabled", "paired", "reconnect_capability"}
        for key in value:
            if key not in allowed:
                raise UnsupportedProbeFieldError(f"unsupported wireless-debugging probe field {key!r}")
        return {
            "support": _tristate(value.get("support")),
            "enabled": _tristate(value.get("enabled")),
            "paired": _tristate(value.get("paired")),
            "reconnect_capability": _tristate(value.get("reconnect_capability")),
        }

    def _classify_controller_rel(self, value: Any) -> str:
        if value is None:
            return "unknown"
        if not isinstance(value, str):
            value = str(value)
        low = value.strip().lower()
        if low in ("bound", "authorized", "paired", "yes"):
            return "bound"
        if low in ("none", "unbound", "no"):
            return "none"
        return "unknown"

    def _classify_controller_readiness(self, value: Any) -> str:
        if value is None:
            return "unknown"
        if not isinstance(value, str):
            value = str(value)
        low = value.strip().lower()
        if low in ("ready", "yes"):
            return "ready"
        if low in ("not-ready", "no"):
            return "not-ready"
        return "unknown"

    def _classify_keyguard(self, value: Any) -> str:
        if value is None:
            return "unknown"
        if isinstance(value, bool):
            return "secure" if value else "non-secure"
        if isinstance(value, str):
            low = value.strip().lower()
            if low in ("secure", "locked"):
                return "secure"
            if low in ("non-secure", "none", "unlocked", "nonsecure"):
                return "non-secure"
        return "unknown"

    def _classify_session(self, value: Any) -> str:
        if value is None:
            return "unknown"
        if isinstance(value, bool):
            return "ready" if value else "not-ready"
        if isinstance(value, str):
            low = value.strip().lower()
            if low in ("ready", "yes"):
                return "ready"
            if low in ("not-ready", "no"):
                return "not-ready"
        return "unknown"

    def _classify_tailscale(self, value: Any) -> dict:
        if not isinstance(value, dict):
            return {
                "installed": "unknown",
                "version_class": "unknown",
                "authenticated": "unknown",
                "connected": "unknown",
            }
        allowed = {"installed", "version_class", "authenticated", "connected"}
        for key in value:
            if key not in allowed:
                raise UnsupportedProbeFieldError(f"unsupported tailscale probe field {key!r}")
        return {
            "installed": _tristate(value.get("installed")),
            "version_class": _tristate(value.get("version_class")),
            "authenticated": _tristate(value.get("authenticated")),
            "connected": _tristate(value.get("connected")),
        }

    def _classify_vpn(self, always_on: Any, lockdown: Any) -> str:
        # Only reached on an authorized-online reachable device; the observed
        # state is classified without mutation (pairing/auth is never enabled).
        return _vpn_class(always_on, lockdown)

    def _classify_mdm(self, value: Any) -> str:
        if not isinstance(value, dict) or not value:
            return "unknown"
        allowed = {"device_owner", "profile_owner", "mdm_present"}
        for key in value:
            if key not in allowed:
                raise UnsupportedProbeFieldError(f"unsupported mdm probe field {key!r}")
        return _mdm_class(
            value.get("device_owner"),
            value.get("profile_owner"),
            value.get("mdm_present"),
        )

    def _classify_reboot(self, value: Any) -> dict:
        if not isinstance(value, dict) or not value:
            return {"reboot_evidence": "unknown", "recovery_evidence": "unknown"}
        allowed = {"reboot_evidence", "recovery_evidence"}
        for key in value:
            if key not in allowed:
                raise UnsupportedProbeFieldError(f"unsupported reboot/recovery probe field {key!r}")
        return {
            "reboot_evidence": _record_state(value.get("reboot_evidence")),
            "recovery_evidence": _record_state(value.get("recovery_evidence")),
        }

    def _classify_battery(self, value: Any) -> str:
        return _battery_class(value)
