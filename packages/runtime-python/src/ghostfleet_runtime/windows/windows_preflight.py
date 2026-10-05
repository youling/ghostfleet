"""Managed-windows read-only preflight seam — repository-only, deterministic.

The fixed PowerShell surface lives at ``fleet/10_platforms/windows/common/onboarding/preflight/managed-windows-preflight.ps1``.
This module is the Fleet-side static contract for that script: which sections
exist, which PowerShell verbs are forbidden (no mutation), and which secret /
topology patterns must never appear in the committed script.

The script itself is read-only detection only. It performs no install, enable,
start, firewall, WinRM, Tailscale, or registry mutation, and it reports
bounded public host-key fingerprints only (parsed ``SHA256:...`` / ``MD5:...``
from ``ssh-keygen -lf`` on ``*.pub`` files), never the full raw command line,
comment text, or private key material. WinRM observation is typed
(``OBSERVED`` / ``NOT_OBSERVED`` / ``UNKNOWN`` via an explicit
``$LASTEXITCODE`` check, preserving ``Unknown != False``). Live execution (if
ever authorized by a separate Work Order) still requires a pinned Windows
OpenSSH fingerprint (see ``ssh_identity``) and Human authorization; this Work
Order performs no real Windows contact.
"""

from __future__ import annotations

import re
from pathlib import Path

PREFLIGHT_VERSION = "0.1.0"

PREFLIGHT_SCRIPT_REL = Path("fleet/10_platforms/windows/common/onboarding/preflight/managed-windows-preflight.ps1")

# Fixed read-only surface. The committed .ps1 carries one
# "# SECTION: <name>" marker per entry; order is fixed.
PREFLIGHT_SURFACE: tuple[str, ...] = (
    "os_build",
    "openssh_capability_service",
    "tailscale_presence",
    "winrm_observation",
    "firewall_openssh_summary",
    "host_key_fingerprints",
)

_SECTION_MARKER_TEMPLATE = r"#\s*SECTION:\s*{name}\b"

# Mutation / enrollment / fail-open verbs that must never appear in the
# committed read-only script (case-insensitive). The list is specific cmdlet
# names rather than blanket verb prefixes so in-memory output construction
# ([PSCustomObject], Select-Object, Where-Object, ForEach-Object) stays legal.
FORBIDDEN_PS_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bSet-Service\b", re.IGNORECASE),
    re.compile(r"\bStart-Service\b", re.IGNORECASE),
    re.compile(r"\bStop-Service\b", re.IGNORECASE),
    re.compile(r"\bRestart-Service\b", re.IGNORECASE),
    re.compile(r"\bNew-Service\b", re.IGNORECASE),
    re.compile(r"\bRemove-Service\b", re.IGNORECASE),
    re.compile(r"\bSet-ItemProperty\b", re.IGNORECASE),
    re.compile(r"\bNew-ItemProperty\b", re.IGNORECASE),
    re.compile(r"\bRemove-ItemProperty\b", re.IGNORECASE),
    re.compile(r"\bSet-Item\b", re.IGNORECASE),
    re.compile(r"\bNew-Item\b", re.IGNORECASE),
    re.compile(r"\bRemove-Item\b", re.IGNORECASE),
    re.compile(r"\bSet-Content\b", re.IGNORECASE),
    re.compile(r"\bAdd-Content\b", re.IGNORECASE),
    re.compile(r"\bClear-Content\b", re.IGNORECASE),
    re.compile(r"\bOut-File\b", re.IGNORECASE),
    re.compile(r"\bAdd-WindowsCapability\b", re.IGNORECASE),
    re.compile(r"\bAdd-WindowsFeature\b", re.IGNORECASE),
    re.compile(r"\bInstall-WindowsFeature\b", re.IGNORECASE),
    re.compile(r"\bEnable-WindowsOptionalFeature\b", re.IGNORECASE),
    re.compile(r"\bDisable-WindowsOptionalFeature\b", re.IGNORECASE),
    re.compile(r"\bInstall-Module\b", re.IGNORECASE),
    re.compile(r"\bNew-NetFirewallRule\b", re.IGNORECASE),
    re.compile(r"\bSet-NetFirewallRule\b", re.IGNORECASE),
    re.compile(r"\bRemove-NetFirewallRule\b", re.IGNORECASE),
    re.compile(r"\bSet-NetFirewallProfile\b", re.IGNORECASE),
    re.compile(r"\bEnable-PSRemoting\b", re.IGNORECASE),
    re.compile(r"\bDisable-PSRemoting\b", re.IGNORECASE),
    re.compile(r"\bNew-LocalUser\b", re.IGNORECASE),
    re.compile(r"\bSet-LocalUser\b", re.IGNORECASE),
    re.compile(r"\bRemove-LocalUser\b", re.IGNORECASE),
    re.compile(r"\bAdd-LocalGroupMember\b", re.IGNORECASE),
    re.compile(r"\bSet-ExecutionPolicy\b", re.IGNORECASE),
    # Tailscale: presence checks only — never login/up/down/config.
    re.compile(
        r"\btailscale\s+(up|down|login|logout|set|advertise|exit-node|funnel|serve|configure)\b",
        re.IGNORECASE,
    ),
    # WinRM: observation (get/enumerate) only — never quickconfig/set/create.
    re.compile(r"\bwinrm\s+(quickconfig|create|set|delete|put)\b", re.IGNORECASE),
    re.compile(r"\bnetsh\s+advfirewall\s+set\b", re.IGNORECASE),
    re.compile(r"ssh-keygen\s+-A\b"),
    re.compile(r"ssh-keygen\s+-R\b"),
    # Piped remote-code execution is never part of a read-only preflight.
    re.compile(r"Invoke-WebRequest.*\|\s*Invoke-Expression", re.IGNORECASE | re.DOTALL),
    re.compile(r"Invoke-RestMethod.*\|\s*Invoke-Expression", re.IGNORECASE | re.DOTALL),
    # Fail-open SSH trust must never appear, even in examples.
    re.compile(r"StrictHostKeyChecking\s*=\s*(accept-new|no|false)", re.IGNORECASE),
    re.compile(r"UserKnownHostsFile\s*=\s*/dev/null"),
    re.compile(r"^\s*host_key_checking\s*=\s*false\s*$", re.IGNORECASE | re.MULTILINE),
    # Private host-key material must never be read: only *.pub + ssh-keygen -lf.
    re.compile(r"ssh_host_(rsa|dsa|ecdsa|ed25519)_key(?!['\"]?\.pub)", re.IGNORECASE),
)

# Secret / private-topology literals that must never appear in the script.
FORBIDDEN_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"BEGIN\s+.*PRIVATE\s+KEY"),
    re.compile(r"(?i)\b(password|passwd)\s*[:=]\s*['\"][^'\"]+['\"]"),
    re.compile(r"\b(tskey-[A-Za-z0-9-]+|ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+)\b"),
    re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
)


def _find_repo_root() -> Path:
    from ghostfleet_runtime.resource_paths import resource_root
    return resource_root()


REPO_ROOT = _find_repo_root()


def get_preflight_surface() -> tuple[str, ...]:
    """Return the fixed read-only preflight section names, in order."""
    return PREFLIGHT_SURFACE


def get_preflight_script_path(repo_root: Path | None = None) -> Path:
    """Return the absolute path of the committed preflight script."""
    if repo_root is None:
        repo_root = REPO_ROOT
    return repo_root / PREFLIGHT_SCRIPT_REL.as_posix()


def load_preflight_script(repo_root: Path | None = None) -> str:
    """Read the committed preflight script as text."""
    return get_preflight_script_path(repo_root).read_text(encoding="utf-8")


def validate_preflight_surface(text: str) -> list[str]:
    """Check the fixed section markers exist exactly once, in order."""
    errors: list[str] = []
    positions: list[int] = []
    for name in PREFLIGHT_SURFACE:
        pattern = re.compile(
            _SECTION_MARKER_TEMPLATE.format(name=re.escape(name)),
            re.IGNORECASE,
        )
        matches = list(pattern.finditer(text))
        if not matches:
            errors.append(f"preflight: missing required section marker '{name}'")
        elif len(matches) > 1:
            errors.append(f"preflight: duplicate section marker '{name}'")
        else:
            positions.append(matches[0].start())
    if not errors and positions != sorted(positions):
        errors.append("preflight: section markers out of fixed order")
    return errors


def validate_preflight_readonly(text: str) -> list[str]:
    """Reject mutation/enrollment/fail-open verbs in the script."""
    errors: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        for pattern in FORBIDDEN_PS_PATTERNS:
            if pattern.search(stripped):
                errors.append(
                    f"preflight:{lineno}: forbidden mutation/enrollment pattern "
                    f"'{pattern.pattern}' in: {stripped[:120]}"
                )
    return errors


def validate_preflight_no_secret(text: str) -> list[str]:
    """Reject secret / private-key / topology literals in the script."""
    errors: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            # Secret markers are rejected even in comments: the committed
            # script must never carry private material as documentation.
            pass
        for pattern in FORBIDDEN_SECRET_PATTERNS:
            if pattern.search(line):
                errors.append(
                    f"preflight:{lineno}: forbidden secret/topology pattern "
                    f"'{pattern.pattern}'"
                )
    return errors


# Bounded public fingerprint extraction — the only durable fingerprint shape
# allowed from ``ssh-keygen -lf`` output. The full line may contain size,
# comment, and key-type suffix; we emit only the fingerprint and an optional
# bounded key-type enum.
_FINGERPRINT_EXTRACT_RE = re.compile(r"(SHA256:[A-Za-z0-9+/=]+|MD5:[0-9a-fA-F:]+)")
_ALLOWED_KEY_TYPES = frozenset(
    {"ED25519", "RSA", "DSA", "ECDSA", "ED25519-CERT", "RSA-CERT", "ECDSA-CERT", "DSA-CERT"}
)


def extract_bounded_fingerprint(raw_line: str) -> str | None:
    """Extract only the bounded ``SHA256:...`` / ``MD5:...`` token.

    The ``ssh-keygen -lf`` line is ``<bits> <fingerprint> <comment> (<type>)``.
    We must never persist the comment segment. Returns the bounded fingerprint
    or ``None`` when no valid token is present.
    """
    if not isinstance(raw_line, str):
        return None
    match = _FINGERPRINT_EXTRACT_RE.search(raw_line)
    if not match:
        return None
    token = match.group(1)
    # Shape-check via the canonical patterns from ssh_identity.
    from ghostfleet_runtime.ssh_identity import (
        WINDOWS_MD5_FINGERPRINT_PATTERN,
        WINDOWS_SHA256_FINGERPRINT_PATTERN,
    )

    if WINDOWS_SHA256_FINGERPRINT_PATTERN.match(token):
        b64 = token[len("SHA256:") :]
        if len(b64.strip("=")) >= 16:
            return token
        return None
    if WINDOWS_MD5_FINGERPRINT_PATTERN.match(token):
        return token
    return None


def parse_winrm_observation_raw(raw: str) -> None:
    """Placeholder — WinRM observation must not emit raw config.

    This function exists only to document the invariant for static tests:
    durable WinRM evidence is the typed ``status/observed`` pair, never the
    raw ``winrm get`` output.
    """
    return None


def _slice_section(text: str, section_name: str) -> str:
    """Return the raw text of one ``# SECTION: <name>`` slice."""
    marker = re.compile(
        _SECTION_MARKER_TEMPLATE.format(name=re.escape(section_name)),
        re.IGNORECASE,
    )
    starts = [m.start() for m in marker.finditer(text)]
    if not starts:
        return ""
    start = starts[0]
    # End is the next section marker or EOF.
    all_markers = []
    for name in PREFLIGHT_SURFACE:
        for m in re.finditer(
            _SECTION_MARKER_TEMPLATE.format(name=re.escape(name)), text, re.IGNORECASE
        ):
            all_markers.append(m.start())
    all_markers = sorted(set(all_markers))
    idx = all_markers.index(start)
    end = all_markers[idx + 1] if idx + 1 < len(all_markers) else len(text)
    return text[start:end]


def validate_preflight_fingerprint_hygiene(text: str) -> list[str]:
    """Ensure host-key output is bounded and WinRM observation is typed."""
    errors: list[str] = []
    fg_slice = _slice_section(text, "host_key_fingerprints")
    if fg_slice:
        # Must parse via a bounded SHA256/MD5 extraction, not persist raw line.
        if "SHA256:[A-Za-z0-9+/=]+" not in fg_slice and "SHA256:[A-Za-z0-9" not in fg_slice:
            errors.append("preflight: host_key_fingerprints must extract bounded SHA256/MD5 fingerprint")
        # Fingerprint section must not copy raw exception/command text.
        if "Exception.Message" in fg_slice:
            errors.append("preflight: host_key_fingerprints must not emit raw Exception.Message")
        # The buggy pattern `fingerprint = \"$fp\"` (persisting entire ssh-keygen line) is forbidden.
        if re.search(r'fingerprint\s*=\s*"\$fp"', fg_slice):
            errors.append("preflight: host_key_fingerprints must not persist raw ssh-keygen line")
        # Must handle typed status, not raw error strings.
        if "FINGERPRINT_UNAVAILABLE" not in fg_slice or "FINGERPRINT_ERROR" not in fg_slice:
            errors.append("preflight: host_key_fingerprints must use typed fingerprint status")
    winrm_slice = _slice_section(text, "winrm_observation")
    if winrm_slice:
        # Must inspect native exit code explicitly; unconditionally setting observed=true is a false positive.
        if "$LASTEXITCODE" not in winrm_slice:
            errors.append("preflight: winrm_observation must check $LASTEXITCODE explicitly")
        if re.search(r'\.Substring\(0,\s*\[Math\]::Min\(0', winrm_slice):
            errors.append("preflight: winrm_observation must not use buggy Substring(0, Min(0,...))")
        # Must not emit raw winrm config output.
        if re.search(r'truncated\s*=\s*"\$out"', winrm_slice, re.IGNORECASE):
            errors.append("preflight: winrm_observation must not emit raw winrm config output")
        # Typed tri-state must be present, preserving Unknown != False.
        if "UNKNOWN" not in winrm_slice or "OBSERVED" not in winrm_slice or "NOT_OBSERVED" not in winrm_slice:
            errors.append("preflight: winrm_observation must emit typed UNKNOWN/OBSERVED/NOT_OBSERVED")
        if "observed" not in winrm_slice.lower():
            errors.append("preflight: winrm_observation must emit typed observed boolean")
    return errors


def validate_preflight_script(text: str) -> list[str]:
    """Run all static checks; empty list means the script is compliant."""
    errors: list[str] = []
    errors.extend(validate_preflight_surface(text))
    errors.extend(validate_preflight_readonly(text))
    errors.extend(validate_preflight_no_secret(text))
    errors.extend(validate_preflight_fingerprint_hygiene(text))
    return errors
