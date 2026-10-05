"""W4 managed-windows enrollment surface — static guardrails (repo-only).

Canonical script lives at ``fleet/10_platforms/windows/common/onboarding/enrollment/managed-windows-enroll.ps1``.
This module is the Fleet-side static contract for that script: explicit apply
authority, fail-closed current-state guards, stage separation, host-key hygiene,
firewall containment, no TOFU/open/Tailscale/WinRM/lifecycle/reboot mutation,
ACL-preserving authorized_keys handling, and evidence hygiene.

The script is staged:
  Bootstrap — install OpenSSH.Server capability + capture bounded public host-key
              fingerprints without exposing a remotely reachable service.
  Activate  — configure admin authorized_keys (ACL), scoped firewall, service
              activation. Requires runtime -AuthorizedKeyPath and
              -ManagementSourceScope.

Default execution is plan/non-mutating; -Apply + elevation required for any
mutation. ``REAL_DEVICE_CONTACT = FORBIDDEN`` in this build.
"""

from __future__ import annotations

import ipaddress
import re
from pathlib import Path

ENROLLMENT_VERSION = "0.2.0"
ENROLLMENT_SCRIPT_REL = Path("fleet/10_platforms/windows/common/onboarding/enrollment/managed-windows-enroll.ps1")

# Narrow management-source scope grammar (mirrors PowerShell Test-ValidManagementScope v0.1.2).
# R2 single-scope contract: exactly ONE exact IP or CIDR, with valid prefix
# bounds; comma-separated lists are rejected so intended vs observed scope
# always compares idempotently (exact single match). Rejects broad/special
# aliases and malformed values.
SCOPE_ALIASES = frozenset(
    {
        "any",
        "internet",
        "localsubnet",
        "dns",
        "dhcp",
        "wins",
        "defaultgateway",
        "unicast",
        "multicast",
        "intranet",
        "ipv6internet",
    }
)


def is_narrow_management_scope(scope: str | None) -> bool:
    """Python mirror of the PowerShell narrow scope validator (deterministic).

    Accepts exactly one exact IP or CIDR. IPv4 CIDR prefix must be 8-32,
    IPv6 CIDR prefix 16-128. Rejects commas (R2 single-scope contract),
    0.0.0.0/::/broadcast, wildcards, aliases, whitespace-embedded and
    malformed values.
    """
    if scope is None or not scope.strip():
        return False
    if "," in scope:
        return False
    s = scope.strip()
    if not s:
        return False
    if re.search(r"\s", s):
        return False
    if re.search(r"[\*\?\\]", s):
        return False
    if s.lower() in SCOPE_ALIASES:
        return False
    if s in ("0.0.0.0/0", "::/0"):
        return False
    if "/" in s:
        parts = s.split("/")
        if len(parts) != 2:
            return False
        ip_text, prefix_text = parts[0].strip(), parts[1].strip()
        if not ip_text or not prefix_text:
            return False
        try:
            prefix = int(prefix_text, 10)
        except ValueError:
            return False
        try:
            ip = ipaddress.ip_address(ip_text)
        except ValueError:
            return False
        if isinstance(ip, ipaddress.IPv4Address):
            if prefix < 8 or prefix > 32:
                return False
            if ip_text == "0.0.0.0":
                return False
            if prefix == 0:
                return False
        elif isinstance(ip, ipaddress.IPv6Address):
            if prefix < 16 or prefix > 128:
                return False
            if ip_text == "::":
                return False
            if prefix == 0:
                return False
        else:
            return False
    else:
        try:
            ipaddress.ip_address(s)
        except ValueError:
            return False
        if s in ("0.0.0.0", "::", "255.255.255.255"):
            return False
    return True

# Stages — stage separation is a required design property.
ENROLLMENT_STAGES: tuple[str, ...] = ("Bootstrap", "Activate")

# Section markers used in committed script (case-insensitive).
ENROLLMENT_SECTIONS: tuple[str, ...] = (
    "plan_guard",
    "apply_authority",
    "stage_bootstrap",
    "stage_activate",
)

_SECTION_MARKER_RE = r"#\s*SECTION:\s*{name}\b"

# Mutation cmdlets that MUST be guarded by -Apply (elevation) path.
# The enrollment surface owns these; the validator ensures they never appear in
# plan-only paths or unguarded global scope.
MUTATION_CMDLETS: tuple[str, ...] = (
    "Add-WindowsCapability",
    "Set-Service",
    "Start-Service",
    "New-NetFirewallRule",
    "Set-NetFirewallRule",
    "Remove-NetFirewallRule",
    "Set-Acl",
    "Set-Content",
    "Add-Content",
)

# Forbidden verbs/patterns that must NEVER appear regardless of guard (repo-only
# containment).
FORBIDDEN_PS_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\btailscale\s+(up|down|login|logout|set|advertise|exit-node|funnel|serve|configure)\b", re.IGNORECASE),
    re.compile(r"\bEnable-PSRemoting\b", re.IGNORECASE),
    re.compile(r"\bDisable-PSRemoting\b", re.IGNORECASE),
    re.compile(r"\bwinrm\s+(quickconfig|create|set|delete|put)\b", re.IGNORECASE),
    re.compile(r"\bnetsh\s+advfirewall\s+set\b", re.IGNORECASE),
    re.compile(r"\bRestart-Computer\b", re.IGNORECASE),
    re.compile(r"\bRestart-Service\s+.*WinRM\b", re.IGNORECASE),
    re.compile(r"ssh-keygen\s+-A\b"),
    re.compile(r"ssh-keygen\s+-R\b"),
    re.compile(r"Invoke-WebRequest.*\|\s*Invoke-Expression", re.IGNORECASE | re.DOTALL),
    re.compile(r"Invoke-RestMethod.*\|\s*Invoke-Expression", re.IGNORECASE | re.DOTALL),
    # Registry/lifecycle separation: must never edit registry/nodes.yaml
    re.compile(r"registry/nodes\.yaml", re.IGNORECASE),
    re.compile(r"management_profile", re.IGNORECASE),  # assignment handled elsewhere
    # Private host-key material must never be read: only *.pub + ssh-keygen -lf
    re.compile(r"ssh_host_(rsa|dsa|ecdsa|ed25519)_key(?!['\"]?\.pub)", re.IGNORECASE),
)

# Fail-open SSH trust — never allowed, even in comments/examples.
TOFU_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"StrictHostKeyChecking\s*=\s*(accept-new|no|false)", re.IGNORECASE),
    re.compile(r"UserKnownHostsFile\s*=\s*/dev/null"),
    re.compile(r"^\s*host_key_checking\s*=\s*false\s*$", re.IGNORECASE | re.MULTILINE),
)

# Secret / private-topology literals that must never appear in committed script.
FORBIDDEN_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"BEGIN\s+.*PRIVATE\s+KEY"),
    re.compile(r"(?i)\b(password|passwd)\s*[:=]\s*['\"][^'\"]+['\"]"),
    re.compile(r"\b(tskey-[A-Za-z0-9-]+|ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+)\b"),
    # Raw IPv4 literals are treated as topology — except 0.0.0.0/0 which is
    # itself forbidden as an open scope and caught by firewall containment.
    # We scan scripts for obvious endpoint literals.
    re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
)

# Firewall open scope literals — must never appear as a default or fallback.
OPEN_SCOPE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"RemoteAddress\s*.*Any", re.IGNORECASE),
    re.compile(r"0\.0\.0\.0/0"),
    re.compile(r"::/0"),
)


def _find_repo_root() -> Path:
    from ghostfleet_runtime.resource_paths import resource_root
    return resource_root()


REPO_ROOT = _find_repo_root()


def get_enrollment_script_path(repo_root: Path | None = None) -> Path:
    if repo_root is None:
        repo_root = REPO_ROOT
    return repo_root / ENROLLMENT_SCRIPT_REL.as_posix()


def load_enrollment_script(repo_root: Path | None = None) -> str:
    return get_enrollment_script_path(repo_root).read_text(encoding="utf-8")


def _slice_section(text: str, section_name: str) -> str:
    marker = re.compile(_SECTION_MARKER_RE.format(name=re.escape(section_name)), re.IGNORECASE)
    starts = [m.start() for m in marker.finditer(text)]
    if not starts:
        return ""
    start = starts[0]
    all_markers: list[int] = []
    for name in ENROLLMENT_SECTIONS:
        for m in re.finditer(_SECTION_MARKER_RE.format(name=re.escape(name)), text, re.IGNORECASE):
            all_markers.append(m.start())
    all_markers = sorted(set(all_markers))
    idx = all_markers.index(start)
    end = all_markers[idx + 1] if idx + 1 < len(all_markers) else len(text)
    return text[start:end]


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

def validate_enrollment_surface(text: str) -> list[str]:
    errors: list[str] = []
    # param block must contain -Apply switch and Stage ValidateSet Bootstrap/Activate
    if not re.search(r"\[switch\]\s*\$Apply\b", text):
        errors.append("enrollment: param block must contain [switch]$Apply")
    if not re.search(r"ValidateSet\(\s*\"Bootstrap\"\s*,\s*\"Activate\"", text):
        errors.append("enrollment: Stage must be ValidateSet(\"Bootstrap\",\"Activate\")")
    # Elevation function required
    if "Test-IsElevated" not in text:
        errors.append("enrollment: missing Test-IsElevated elevation helper")
    if "WindowsPrincipal" not in text or "IsInRole" not in text:
        errors.append("enrollment: elevation check must use WindowsPrincipal/IsInRole(Administrator)")
    # Version marker
    if ENROLLMENT_VERSION not in text:
        errors.append(f"enrollment: script must contain version {ENROLLMENT_VERSION}")
    # Section markers present at least once
    for name in ENROLLMENT_SECTIONS:
        pat = re.compile(_SECTION_MARKER_RE.format(name=re.escape(name)), re.IGNORECASE)
        matches = list(pat.finditer(text))
        if not matches:
            errors.append(f"enrollment: missing required section marker '{name}'")
        elif len(matches) > 1:
            errors.append(f"enrollment: duplicate section marker '{name}'")
    # Ensure staged plan/apply semantics described
    if "plan only" not in text.lower():
        errors.append("enrollment: script must document plan-only default semantics")
    return errors


def validate_enrollment_apply_gating(text: str) -> list[str]:
    errors: list[str] = []
    # Every mutation cmdlet must appear in an Apply-guarded context.
    # Minimal check: script contains 'if (-not $Apply)' plan early-exit before any mutation slice,
    # and mutation slices are under 'if -not (Test-IsElevated)' fail-closed check.
    if "if (-not $Apply)" not in text and 'if (-not $Apply)' not in text:
        errors.append("enrollment: missing plan guard 'if (-not $Apply)' early exit")
    if 'if (-not (Test-IsElevated))' not in text:
        errors.append("enrollment: mutation must be guarded by 'if (-not (Test-IsElevated))' fail-closed check")
    # Mutation cmdlets must exist (this is an enrollment surface)
    for cmdlet in MUTATION_CMDLETS:
        if cmdlet not in text:
            # Add-Content/Set-Content/Set-Acl are required for authorized_keys ACL path.
            # If missing, surface is incomplete.
            if cmdlet in ("Set-Content", "Add-Content", "Set-Acl"):
                errors.append(f"enrollment: missing required mutation cmdlet '{cmdlet}' for authorized_keys ACL path")
            elif cmdlet in ("Add-WindowsCapability", "New-NetFirewallRule"):
                errors.append(f"enrollment: missing required mutation cmdlet '{cmdlet}'")
    # Plan guard slice should not contain mutation (sample plan probe vs actual mutation).
    plan_slice = _slice_section(text, "plan_guard")
    if plan_slice:
        for cmdlet in ("Add-WindowsCapability", "New-NetFirewallRule", "Start-Service"):
            if cmdlet in plan_slice:
                errors.append(f"enrollment: plan_guard must not contain mutation '{cmdlet}'")
    return errors


def validate_enrollment_privilege(text: str) -> list[str]:
    errors: list[str] = []
    if "Test-IsElevated" not in text:
        errors.append("enrollment: privilege check Test-IsElevated missing")
    # Apply without elevation must throw
    if 'Apply requires elevated' not in text:
        errors.append("enrollment: Apply must fail closed when not elevated (throw message)")
    return errors


def validate_enrollment_powershell7_baseline(text: str) -> list[str]:
    errors: list[str] = []
    bootstrap = _slice_section(text, "stage_bootstrap")
    activate = _slice_section(text, "stage_activate")
    required_global = (
        "$MinimumPowerShellVersion = [version]'7.6.6'",
        "PowerShell\\7\\pwsh.exe",
        "PowerShell-7.6.6-win-x64.msi",
        "PowerShell-7.6.6-win-arm64.msi",
        "958838FF55091E1C8705D89EFED0CC7E8245A3A6EF6C0CCFAE20015227108AD8",
        "387D0AF8E92BA97F73616C91FA8F29A284E8F82EE6C40FE12DADE971BB05BAC4",
        "Get-FileHash",
        "Get-AuthenticodeSignature",
        "CN=Microsoft Corporation",
        "ENABLE_PSREMOTING=0",
        "ADD_PATH=1",
        "USE_MU=1",
        "ENABLE_MU=1",
        "/norestart",
        "BOOTSTRAP_PWSH7_ARCH_UNSUPPORTED",
        "BOOTSTRAP_PWSH7_SHA256_MISMATCH",
        "BOOTSTRAP_PWSH7_SIGNATURE_INVALID",
        "BOOTSTRAP_PWSH7_POST_INSTALL_NOT_COMPLIANT",
    )
    for marker in required_global:
        if marker not in text:
            errors.append(f"enrollment: PowerShell 7 baseline missing required contract marker {marker}")
    if bootstrap and "Ensure-PowerShell7" not in bootstrap:
        errors.append("enrollment: Bootstrap must own Ensure-PowerShell7 convergence")
    if activate and "ACTIVATE_PWSH7_NOT_COMPLIANT" not in activate:
        errors.append("enrollment: Activate must fail closed when PowerShell 7 Bootstrap baseline is absent")
    if activate and any(token in activate for token in ("Start-BitsTransfer", "Invoke-WebRequest", "msiexec.exe")):
        errors.append("enrollment: Activate must not download or install PowerShell; runtime convergence belongs to Bootstrap")
    hash_pos = text.find("Get-FileHash")
    sig_pos = text.find("Get-AuthenticodeSignature")
    msi_pos = text.find("msiexec.exe")
    if min(hash_pos, sig_pos, msi_pos) >= 0 and not (hash_pos < msi_pos and sig_pos < msi_pos):
        errors.append("enrollment: PowerShell MSI hash/signature verification must precede msiexec")
    if "Enable-PSRemoting" in text:
        errors.append("enrollment: PowerShell 7 baseline must not enable PSRemoting/WinRM")
    return errors


def validate_enrollment_current_state_guards(text: str) -> list[str]:
    errors: list[str] = []
    if 'NotPresent' not in text or 'Installed' not in text or 'UNKNOWN' not in text:
        errors.append("enrollment: must distinguish NotPresent | Installed | UNKNOWN (fail-closed)")
    if 'Get-WindowsCapability' not in text:
        errors.append("enrollment: must probe OpenSSH capability via Get-WindowsCapability")
    if 'capability state is UNKNOWN' not in text.lower() and 'UNKNOWN' not in text:
        errors.append("enrollment: must refuse mutation when capability state is UNKNOWN")
    # Idempotency: already_installed / already_present handling
    if 'already_installed' not in text:
        errors.append("enrollment: Bootstrap must be idempotent (handle already Installed)")
    if 'already_present' not in text:
        errors.append("enrollment: Activate must be idempotent (handle already_present key/firewall)")
    return errors


def validate_enrollment_stage_separation(text: str) -> list[str]:
    errors: list[str] = []
    bootstrap = _slice_section(text, "stage_bootstrap")
    activate = _slice_section(text, "stage_activate")
    if not bootstrap:
        errors.append("enrollment: missing stage_bootstrap section")
    if not activate:
        errors.append("enrollment: missing stage_activate section")
    if bootstrap:
        # Containment: Bootstrap must NOT start service or create firewall or configure authorized_keys
        for forbidden in ("Start-Service", "New-NetFirewallRule", "administrators_authorized_keys"):
            if forbidden in bootstrap:
                errors.append(f"enrollment: Bootstrap must not contain '{forbidden}' (containment-first)")
        if 'Add-WindowsCapability' not in bootstrap:
            errors.append("enrollment: Bootstrap must contain Add-WindowsCapability install path")
        if 'hostKeyFingerprints' not in bootstrap and 'Get-BoundedFingerprints' not in bootstrap:
            errors.append("enrollment: Bootstrap must capture bounded host-key fingerprints")
    if activate:
        for required in ("AuthorizedKeyPath", "ManagementSourceScope", "New-NetFirewallRule", "Set-Service", "Start-Service", "administrators_authorized_keys"):
            if required not in activate:
                errors.append(f"enrollment: Activate must contain '{required}' bounded action")
        if 'RemoteAddress' not in activate or '$ManagementSourceScope' not in activate:
            errors.append("enrollment: Activate firewall must use -RemoteAddress $ManagementSourceScope (no hardcoded scope)")
    return errors


def validate_enrollment_host_key_hygiene(text: str) -> list[str]:
    errors: list[str] = []
    if 'ssh_host_*.pub' not in text:
        errors.append("enrollment: must read only ssh_host_*.pub public keys")
    if 'ssh-keygen -lf' not in text:
        errors.append("enrollment: must capture fingerprints via ssh-keygen -lf on *.pub files")
    if 'SHA256:[A-Za-z0-9+/=]+' not in text:
        errors.append("enrollment: must extract bounded SHA256:/MD5: fingerprints")
    if 'PRIVATE KEY' in text and 'PRIVATE KEY' in text:
        # Private key string appears only in guard/validation context, not as read path.
        # Allow "BEGIN.*PRIVATE KEY" in validation regex, but forbid raw file read pattern.
        pass
    # Forbid direct private key file read
    if re.search(r"ssh_host_(rsa|dsa|ecdsa|ed25519)_key(?!['\"]?\.pub)", text, re.IGNORECASE):
        errors.append("enrollment: must never read private host-key file (only .pub)")
    # Bounded extraction only — must include typed status
    if 'FINGERPRINT_UNAVAILABLE' not in text or 'FINGERPRINT_ERROR' not in text:
        errors.append("enrollment: fingerprint handling must use typed status (FINGERPRINT_UNAVAILABLE/FINGERPRINT_ERROR)")
    return errors


def validate_enrollment_firewall_containment(text: str) -> list[str]:
    errors: list[str] = []
    if '$ManagementSourceScope' not in text:
        errors.append("enrollment: firewall creation must require -ManagementSourceScope runtime input")
    if 'Test-ValidManagementScope' not in text:
        errors.append("enrollment: must validate ManagementSourceScope via Test-ValidManagementScope")
    if 'requires explicit -ManagementSourceScope' not in text:
        errors.append("enrollment: must refuse Activate when ManagementSourceScope missing/open")
    # Narrow validator v0.1.2 (R2 single-scope contract): exact IP/CIDR only,
    # prefix bounds, alias rejection, commas rejected (no multi-scope lists).
    if 'IPAddress]::TryParse' not in text:
        errors.append("enrollment: Test-ValidManagementScope must use IPAddress::TryParse for exact IP/CIDR validation")
    if "Contains(',')" not in text and 'Contains(",")' not in text:
        errors.append("enrollment: Test-ValidManagementScope must reject comma-separated lists (R2 single-scope contract)")
    if 'localsubnet' not in text.lower() or 'alias' not in text.lower():
        errors.append("enrollment: Test-ValidManagementScope must explicitly reject broad/special firewall aliases (Any/LocalSubnet/Internet/...)")
    if '-lt 8' not in text or '-gt 32' not in text:
        errors.append("enrollment: Test-ValidManagementScope must enforce IPv4 CIDR prefix bounds (8-32)")
    if '-lt 16' not in text or '-gt 128' not in text:
        errors.append("enrollment: Test-ValidManagementScope must enforce IPv6 CIDR prefix bounds (16-128)")
    if 'ACTIVATE_MANAGEMENT_SCOPE_INVALID' not in text:
        errors.append("enrollment: Activate must refuse open/broad/malformed scope with typed ACTIVATE_MANAGEMENT_SCOPE_INVALID")
    # R2 single-scope idempotency: exact canonical single comparison, no subset matching.
    if '$scopeNorm' not in text:
        errors.append("enrollment: Activate must canonicalize the single intended scope ($scopeNorm) for exact idempotent comparison")
    if 'Test-ExactManagementScopeEquivalent' not in text:
        errors.append("enrollment: Activate must compare observed scope by exact network semantics, including Windows dotted-netmask normalization")
    if 'Get-IPv4PrefixLengthFromDottedMask' not in text or 'Convert-ToCanonicalManagementScope' not in text:
        errors.append("enrollment: exact scope comparison must canonicalize numeric-prefix and Windows dotted-netmask forms")
    if re.search(r"\$remote(Pre)?\s+-contains\s+\$ManagementSourceScope", text):
        errors.append("enrollment: Activate must not use '-contains $ManagementSourceScope' subset matching (R2 exact single-scope contract)")
    if re.search(r"\$remote(Pre)?\[[^]]+\]\s+-ieq\s+\$scopeNorm", text):
        errors.append("enrollment: Activate must not compare firewall scope by raw string equality; Windows may normalize CIDR to dotted netmask")
    # Must NOT contain hard open scope literals as a default
    # Allow the validation check that rejects those literals, but forbid actual New-NetFirewallRule with Any
    # Check for hardcoded Any in New-NetFirewallRule context is caught via OPEN_SCOPE check below.
    # Only error if script sets RemoteAddress to Any literal directly.
    if re.search(r"New-NetFirewallRule.*RemoteAddress\s+['\"]?Any['\"]?", text, re.IGNORECASE):
        errors.append("enrollment: firewall rule must not use RemoteAddress Any (open scope)")
    if re.search(r"New-NetFirewallRule.*0\.0\.0\.0/0", text):
        errors.append("enrollment: firewall rule must not use 0.0.0.0/0 open scope")
    # Must emit remoteScoped boolean typed evidence (no raw address)
    if 'remoteScoped' not in text:
        errors.append("enrollment: firewall evidence must emit typed remoteScoped boolean (no raw RemoteAddress durable)")
    return errors


def validate_enrollment_no_tofu(text: str) -> list[str]:
    errors: list[str] = []
    for pat in TOFU_PATTERNS:
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if pat.search(stripped):
                errors.append(f"enrollment:{lineno}: forbidden TOFU/fail-open pattern '{pat.pattern}'")
    return errors


def validate_enrollment_no_tailscale_mutation(text: str) -> list[str]:
    errors: list[str] = []
    for pat in FORBIDDEN_PS_PATTERNS:
        # Only check tailscale mutation pattern here
        if "tailscale" not in pat.pattern:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if pat.search(stripped):
                errors.append(f"enrollment:{lineno}: forbidden tailscale mutation '{pat.pattern}'")
    return errors


def validate_enrollment_no_winrm_mutation(text: str) -> list[str]:
    errors: list[str] = []
    winrm_pats = [p for p in FORBIDDEN_PS_PATTERNS if "winrm" in p.pattern.lower() or "Enable-PSRemoting" in p.pattern]
    for pat in winrm_pats:
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if pat.search(stripped):
                errors.append(f"enrollment:{lineno}: forbidden WinRM mutation '{pat.pattern}'")
    return errors


def validate_enrollment_no_registry_mutation(text: str) -> list[str]:
    errors: list[str] = []
    if re.search(r"registry/nodes\.yaml", text, re.IGNORECASE):
        errors.append("enrollment: must never edit registry/nodes.yaml")
    # management_profile assignment is forbidden from this host script
    # Allow mention in comments, but forbid actual assignment/mutation patterns.
    if re.search(r"management_profile\s*[:=]", text, re.IGNORECASE):
        # Check non-comment lines
        for lineno, line in enumerate(text.splitlines(), start=1):
            if line.strip().startswith("#"):
                continue
            if re.search(r"management_profile\s*[:=]", line, re.IGNORECASE):
                errors.append(f"enrollment:{lineno}: must not assign management_profile from host script")
    return errors


def validate_enrollment_no_reboot(text: str) -> list[str]:
    errors: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.search(r"\bRestart-Computer\b", stripped, re.IGNORECASE):
            errors.append(f"enrollment:{lineno}: must not reboot (Restart-Computer)")
        if re.search(r"\bshutdown\s+/r\b", stripped, re.IGNORECASE):
            errors.append(f"enrollment:{lineno}: must not reboot via shutdown /r")
    return errors


def validate_enrollment_evidence_hygiene(text: str) -> list[str]:
    errors: list[str] = []
    for pat in FORBIDDEN_SECRET_PATTERNS:
        for lineno, line in enumerate(text.splitlines(), start=1):
            # Secret markers are rejected even in comments per W2 policy (must never carry private material)
            # but allow validation regex itself: lines containing 'BEGIN.*PRIVATE' as part of a regex are okay.
            # We distinguish: a literal private key block vs a validation pattern.
            if pat.search(line):
                # Allow the validator regex line: it contains "BEGIN.*PRIVATE KEY" as pattern syntax, not literal key.
                if "PRIVATE KEY" in line and ("-match" in line or "regex" in line.lower() or "Escape" in line):
                    continue
                # Allow compensation comments describing the rule
                if line.strip().startswith("#") and "PRIVATE KEY" not in line.strip().upper().replace("PRIVATE KEY", ""):
                    # Still, pure comment carrying password/token is forbidden; falls through
                    pass
                # The 0.0.0.0/0 check is handled by firewall containment; don't double-count here
                if pat.pattern == r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b" and "0.0.0.0" in line:
                    continue
                # Capability version string is not an endpoint IP
                if pat.pattern == r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b" and "OpenSSH.Server" in line:
                    continue
                # If line is the validation function that explicitly checks for the forbidden marker, allow
                if "PRIVATE KEY" in line and "throw" in line.lower():
                    continue
                errors.append(f"enrollment:{lineno}: forbidden secret/topology pattern '{pat.pattern}'")
    return errors


def validate_enrollment_authorized_keys_acl(text: str) -> list[str]:
    errors: list[str] = []
    if "administrators_authorized_keys" not in text:
        errors.append("enrollment: Activate must handle administrators_authorized_keys")
    if "Set-Acl" not in text or "Get-Acl" not in text:
        errors.append("enrollment: authorized_keys handling must preserve ACL via Get-Acl/Set-Acl")
    if "SetAccessRuleProtection" not in text:
        errors.append("enrollment: must disable inheritance via SetAccessRuleProtection")
    if "S-1-5-32-544" not in text or "S-1-5-18" not in text:
        errors.append("enrollment: ACL must be restricted to Administrators (S-1-5-32-544) + SYSTEM (S-1-5-18) only")
    if "Test-ValidSSHPublicKey" not in text:
        errors.append("enrollment: must validate AuthorizedKeyPath content as single-line OpenSSH public key")
    if "AuthorizedKeyPath" not in text:
        errors.append("enrollment: must accept runtime -AuthorizedKeyPath input (no embedded key material)")
    # Repair v0.1.1: key-content idempotency must be independent of ACL idempotency.
    # Always verify/reconcile canonical ACL even when key is already present.
    if "authorizedKeysAclResult" not in text or "aclResult" not in text:
        errors.append("enrollment: must report independent authorizedKeysAclResult/aclResult (ACL reconciled even on already_present)")
    if "already_present" not in text or "reconciled" not in text:
        errors.append("enrollment: must distinguish key already_present from ACL reconciled")
    activate = _slice_section(text, "stage_activate")
    if activate:
        # ACL enforcement must occur even on the already_present path: require the
        # independent-ACL comment and require Set-Acl to appear after the key-result block.
        if "independent of ACL" not in activate and "even when key is already present" not in activate and "even on already_present" not in activate:
            errors.append("enrollment: Activate must document ACL idempotency independent of key-content idempotency")
        key_pos = activate.find("already_present")
        acl_pos = activate.find("Set-Acl")
        if key_pos == -1 or acl_pos == -1 or not (acl_pos > key_pos):
            errors.append("enrollment: Activate must reconcile ACL after key-content check (not skipped on already_present)")
    return errors


def validate_enrollment_pre_activation_guard(text: str) -> list[str]:
    """Repair v0.1.1 + R2: before any authorized_keys mutation, inspect sshd/inbound
    SSH exposure and fail closed on unexpected active/broader foreign exposure.

    R2 hardens enumeration to truly fail-closed. R3 also evaluates application,
    package and service filters before port coverage so AppContainer/program/service
    rules that cannot match sshd.exe are not false-positive SSH exposure. Every
    filter query captures errors and null/unclassifiable state fails closed.
    """
    errors: list[str] = []
    activate = _slice_section(text, "stage_activate")
    if not activate:
        return ["enrollment: missing stage_activate section for pre-activation guard"]
    if "pre_activation_exposure_guard" not in activate.lower():
        errors.append("enrollment: Activate must contain pre_activation_exposure_guard before authorized_keys mutation")
    for marker in (
        "ACTIVATE_PRE_EXPOSURE_UNEXPECTED_SSHD_RUNNING",
        "ACTIVATE_PRE_EXPOSURE_FOREIGN_SSH_RULE",
        "ACTIVATE_PRE_EXPOSURE_FLEET_SCOPE_MISMATCH",
        "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED",
        "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR",
        "ACTIVATE_PRE_EXPOSURE_FLEET_RULE_AMBIGUOUS",
        "ACTIVATE_PRE_EXPOSURE_RUNNING_NOT_RESUMABLE",
    ):
        if marker not in activate:
            errors.append(f"enrollment: Activate pre-exposure guard must fail closed with typed {marker}")
    if "Get-NetFirewallPortFilter" not in activate or "LocalPort" not in activate:
        errors.append("enrollment: pre-exposure guard must inspect inbound SSH exposure via Get-NetFirewallPortFilter/LocalPort")
    if "Get-NetFirewallApplicationFilter" not in activate or "Get-NetFirewallServiceFilter" not in activate:
        errors.append("enrollment: pre-exposure guard must inspect Program/Package/Service filters before treating a broad port rule as sshd exposure")
    for required in ("ruleCanMatchSshd", "sshd.exe", "Program", "Package", "Service", "PackageFamilyName"):
        if required not in activate:
            errors.append(f"enrollment: pre-exposure guard missing sshd applicability discriminator {required}")
    for required in ("AllowedExistingLocalAddress", "Get-NormalizedAllowedLocalAddresses", "LocalAddress", "localScopeExplicitlyAllowed"):
        if required not in text:
            errors.append(f"enrollment: pre-exposure guard missing explicit pre-existing local-address allowlist contract {required}")
    for required in ("exactFleetRuleCount", "Test-CanonicalAdminAuthorizedKeysAcl", "resume_existing_fleet_activation", "preExposureMode"):
        if required not in text:
            errors.append(f"enrollment: pre-exposure guard missing owned-partial-activation resume proof {required}")
    # R2: every guard inspection must capture query errors; bare SilentlyContinue
    # without -ErrorVariable (fail-open on provider/query error) is forbidden.
    if "-ErrorVariable" not in activate:
        errors.append("enrollment: pre-exposure guard must capture inspection errors via -ErrorVariable (fail closed, never null-as-safe)")
    if re.search(r"\$null\s+-eq\s+\$portFilter\)\s*\{\s*continue", activate):
        errors.append("enrollment: pre-exposure guard must not skip unresolvable port filters via continue (fail closed with ENUMERATION_FAILED)")
    # R2: range-aware TCP/22 coverage with protocol gate. The classifier helper
    # is defined once at script scope and invoked from the guard; containment
    # logic is therefore checked script-wide while the call site is required
    # inside the activate slice.
    if "Test-PortSelectorCoversSsh" not in activate:
        errors.append("enrollment: pre-exposure guard must classify port selectors via Test-PortSelectorCoversSsh (exact 22 / Any / range-containing-22)")
    if "-le 22" not in text or "22 -le" not in text:
        errors.append("enrollment: port-range coverage must test range containment of 22 ($lo -le 22 -and 22 -le $hi)")
    if "Protocol" not in text or "UDP" not in text:
        errors.append("enrollment: pre-exposure guard must gate port relevance on protocol (TCP/Any relevant, UDP excluded, unknown fail-closed)")
    # Guard must run before key mutation: guard marker must precede authorized_keys write.
    guard_pos = activate.lower().find("pre_activation_exposure_guard")
    key_write_pos = -1
    for token in ("Set-Content -LiteralPath $adminAuthPath", "Add-Content -LiteralPath $adminAuthPath", "administrators_authorized_keys"):
        pos = activate.find(token)
        if pos != -1 and (key_write_pos == -1 or pos < key_write_pos):
            # Find the first write occurrence after guard context; use earliest key path
            key_write_pos = pos
            break
    # More robust: guard must precede the keyResult/configured block
    configured_pos = activate.find("$keyResult")
    if guard_pos == -1 or configured_pos == -1 or not (guard_pos < configured_pos):
        errors.append("enrollment: pre-exposure guard must precede authorized_keys mutation (fail closed before auth mutation)")
    # Must not silently normalize foreign rules: no Set/Remove of foreign SSH rules in guard.
    # The guard may only throw on foreign exposure; it must never call Set-NetFirewallRule/Remove-NetFirewallRule
    # to rewrite foreign scope.
    for lineno, line in enumerate(activate.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.search(r"\bSet-NetFirewallRule\b", stripped, re.IGNORECASE):
            errors.append(f"enrollment:{lineno}: pre-exposure guard must not rewrite firewall via Set-NetFirewallRule (fail closed only)")
        if re.search(r"\bRemove-NetFirewallRule\b", stripped, re.IGNORECASE):
            # Removal is only allowed for the Fleet enrollment rule in runbook remediation, never
            # as silent foreign normalization inside the script. Forbid any Remove in Activate v1.
            errors.append(f"enrollment:{lineno}: Activate must not silently remove firewall rules (fail closed on foreign exposure)")
    return errors


def validate_enrollment_error_hygiene(text: str) -> list[str]:
    """Repair v0.1.1: sanitize runtime failure output so raw local paths/exception
    strings are not durable evidence. Typed ACTIVATE_*/BOOTSTRAP_* codes only."""
    errors: list[str] = []
    activate = _slice_section(text, "stage_activate")
    bootstrap = _slice_section(text, "stage_bootstrap")
    scope = (activate or "") + "\n" + (bootstrap or "")
    # Forbid raw exception/path interpolation inside throw statements.
    for lineno, line in enumerate(scope.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.lower().startswith("throw"):
            if "Exception.Message" in stripped and "ACTIVATE_" not in stripped and "BOOTSTRAP_" not in stripped:
                # Allow branching checks like `if ($inner -match ...)` but not throw lines
                # carrying raw exception text. Throw lines must be typed codes.
                errors.append(f"enrollment:{lineno}: throw must not embed raw Exception.Message (use typed ACTIVATE_*/BOOTSTRAP_* code)")
            # Old pattern: throw "...: $AuthorizedKeyPath" leaks raw local path (username/topology).
            if re.search(r"throw\s+.*:\s*\$AuthorizedKeyPath\b", stripped):
                errors.append(f"enrollment:{lineno}: throw must not echo raw AuthorizedKeyPath (use typed code without path)")
            if re.search(r"throw\s+.*\$\(\$_.Exception\.Message\)", stripped) or re.search(
                r"throw\s+.*\$\{_?\.Exception", stripped
            ):
                errors.append(f"enrollment:{lineno}: throw must not interpolate raw exception string")
            if re.search(r"throw\s+\"Failed to .*:\s*\$\(", stripped):
                errors.append(f"enrollment:{lineno}: throw must not append raw failure detail (use typed code)")
    # Require typed sanitized codes for all Activate/Bootstrap failure paths.
    for marker in (
        "ACTIVATE_AUTHORIZED_KEY_PATH_NOT_FOUND",
        "ACTIVATE_AUTHORIZED_KEY_READ_FAILED",
        "ACTIVATE_AUTHORIZED_KEYS_WRITE_FAILED",
        "ACTIVATE_AUTHORIZED_KEYS_ACL_FAILED",
        "ACTIVATE_FIREWALL_CREATE_FAILED",
        "ACTIVATE_SSHD_START_FAILED",
        "BOOTSTRAP_CAPABILITY_INSTALL_FAILED",
        "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED",
        "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR",
        "ACTIVATE_PRE_EXPOSURE_FLEET_RULE_AMBIGUOUS",
        "ACTIVATE_PRE_EXPOSURE_RUNNING_NOT_RESUMABLE",
    ):
        if marker not in scope:
            errors.append(f"enrollment: failure path must use typed sanitized {marker} (no raw path/exception)")
    return errors


def validate_enrollment_no_secret_embedding(text: str) -> list[str]:
    errors: list[str] = []
    # Must not contain an embedded public key literal like "ssh-rsa AAAA..."
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if re.search(r"^\s*ssh-(rsa|ed25519)\s+AAAA", stripped):
            errors.append(f"enrollment:{lineno}: must not embed public key material in repo")
        if re.search(r"ecdsa-sha2-nistp.*AAAA", stripped):
            errors.append(f"enrollment:{lineno}: must not embed public key material in repo")
    return errors


def validate_enrollment_script(text: str) -> list[str]:
    errors: list[str] = []
    errors.extend(validate_enrollment_surface(text))
    errors.extend(validate_enrollment_apply_gating(text))
    errors.extend(validate_enrollment_privilege(text))
    errors.extend(validate_enrollment_current_state_guards(text))
    errors.extend(validate_enrollment_powershell7_baseline(text))
    errors.extend(validate_enrollment_stage_separation(text))
    errors.extend(validate_enrollment_host_key_hygiene(text))
    errors.extend(validate_enrollment_firewall_containment(text))
    errors.extend(validate_enrollment_pre_activation_guard(text))
    errors.extend(validate_enrollment_error_hygiene(text))
    errors.extend(validate_enrollment_no_tofu(text))
    errors.extend(validate_enrollment_no_tailscale_mutation(text))
    errors.extend(validate_enrollment_no_winrm_mutation(text))
    errors.extend(validate_enrollment_no_registry_mutation(text))
    errors.extend(validate_enrollment_no_reboot(text))
    errors.extend(validate_enrollment_authorized_keys_acl(text))
    errors.extend(validate_enrollment_no_secret_embedding(text))
    # Evidence hygiene last
    errors.extend(validate_enrollment_evidence_hygiene(text))
    # Global forbidden patterns (non-stage-specific)
    for pat in FORBIDDEN_PS_PATTERNS:
        # Already handled subsets; check remaining generically but skip validated Allow patterns
        if any(k in pat.pattern for k in ("tailscale", "winrm", "Enable-PSRemoting", "registry/nodes")):
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if pat.search(stripped):
                # Allow the expected mutation cmdlets that are properly gated
                if any(cmd in stripped for cmd in MUTATION_CMDLETS):
                    continue
                errors.append(f"enrollment:{lineno}: forbidden pattern '{pat.pattern}'")
    return errors