"""Fleet SSH host identity policy — fail closed.

Fleet automation must never silently trust an unknown SSH host key.
Enrollment must establish a verifiable host identity (known-hosts/host-key
reference or an explicitly defined identity mechanism such as Tailscale SSH
identity) before ongoing SSH automation runs. Read-only/dry-run automation
fails closed when the profile requires host identity but no verified
identity input is available. Real host keys/endpoints never enter this repo.

SSH identity mechanisms are explicit and typed (FO2B3 / legacy mechanism contract):
- ``tailscale_ssh_control_plane``: host recognition/verification is provided
  by the Tailscale control plane via ``tailscale ssh`` and the
  coordination-server-advertised host keys (strict host checking). This is
  NOT provider-independent attestation.
- ``pinned_openssh``: legacy Human-maintained pinned known-hosts OpenSSH
  material (kept only as an explicitly legacy/rollback-compatible seam).
Mechanisms are differentiated so evidence never falsely claims
provider-independent identity proof.

Managed-windows (W2) uses the same fail-closed seam with Windows OpenSSH
host-key fingerprints as the pinned identity material: public
``SHA256:...`` / ``MD5:aa:bb:...`` fingerprint strings only, never private
key material, never TOFU/accept-new. See
``fleet/10_platforms/windows/common/onboarding/preflight/managed-windows-preflight.ps1`` (read-only preflight) and
``docs/runbooks/MANAGED_WINDOWS_PREFLIGHT.md``.
"""

import re
from enum import Enum
from pathlib import Path
from typing import Mapping

# Settings that silently accept an unknown host key (TOFU / fail-open).
UNSAFE_SSH_SETTING_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\s*host_key_checking\s*=\s*false\s*$", re.IGNORECASE),
    re.compile(r"StrictHostKeyChecking\s*=\s*(accept-new|no|false)", re.IGNORECASE),
    re.compile(r"UserKnownHostsFile\s*=\s*/dev/null"),
)

# Profiles whose automation requires a verified SSH host identity.
HOST_IDENTITY_REQUIRING_PROFILES = {"managed-linux", "managed-windows"}

# Windows OpenSSH pinned host-identity material (public fingerprints only).
# OpenSSH default is SHA256 base64; MD5 colon-hex is the legacy display form.
# An optional explicit "fingerprint:" namespace prefix is accepted so durable
# refs stay self-describing; raw endpoints/IPs/hostnames are never accepted.
WINDOWS_SHA256_FINGERPRINT_PATTERN = re.compile(r"^SHA256:[A-Za-z0-9+/=]+$")
WINDOWS_MD5_FINGERPRINT_PATTERN = re.compile(
    r"^MD5:([0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2}$"
)

# Substrings that prove a Windows identity ref is private key material or a
# fail-open placeholder rather than a pinned public fingerprint.
WINDOWS_IDENTITY_FORBIDDEN_MARKERS = (
    "BEGIN OPENSSH PRIVATE KEY",
    "BEGIN RSA PRIVATE KEY",
    "BEGIN EC PRIVATE KEY",
    "BEGIN PRIVATE KEY",
    "PRIVATE KEY",
)


class SSHIdentityMechanism(str, Enum):
    """Distinguish identity-providing SSH plans.

    ``TAILSCALE_SSH_CONTROL_PLANE`` is the FO2B3 normal Tailscale-SSH primary
    plane. ``PINNED_OPENSSH`` is the legacy Human-maintained pinned
    known-hosts seam retained for rollback compatibility only.
    """

    TAILSCALE_SSH_CONTROL_PLANE = "tailscale_ssh_control_plane"
    PINNED_OPENSSH = "pinned_openssh"


class HostIdentityError(Exception):
    """Raised when automation requires host identity but none is verified."""


def scan_unsafe_ssh_settings(automation_dir: Path) -> list[str]:
    """Return locations of unsafe/TOFU SSH settings in the automation tree.

    Scans every file under ``automation_dir`` (configs, inventories,
    playbooks, README). An empty result means the skeleton is fail-closed by
    construction; any occurrence must be treated as a review blocker.
    """
    violations: list[str] = []
    if not automation_dir.exists():
        return violations

    for f in sorted(automation_dir.rglob("*")):
        # Only configuration/playbook material counts as settings; prose
        # docs (.md) describing the policy are not settings themselves.
        if not f.is_file() or f.suffix == ".md":
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            for pattern in UNSAFE_SSH_SETTING_PATTERNS:
                if pattern.search(stripped):
                    violations.append(
                        f"{f.relative_to(automation_dir)}:{lineno}: unsafe SSH setting: {stripped}"
                    )
    return violations


def require_verified_host_identity(
    profile: str,
    identity_input: Mapping[str, str] | None,
) -> None:
    """Fail closed when the profile needs host identity but none is verified.

    ``identity_input`` maps node_id -> verified identity reference (e.g. a
    known-hosts entry name or Tailscale SSH identity; for ``managed-windows``
    a pinned Windows OpenSSH host-key fingerprint — see
    :func:`is_windows_host_identity_ref`). A missing or empty
    input for a host-identity-requiring profile raises ``HostIdentityError``
    so read-only/dry-run automation refuses to run rather than silently
    trusting an unverified host key.

    For ``managed-windows`` every provided ref must be a bounded public
    fingerprint (``SHA256:...`` / ``MD5:...``) — arbitrary non-empty strings
    are rejected by construction so the canonical gate cannot be satisfied
    with a placeholder.
    """
    if profile not in HOST_IDENTITY_REQUIRING_PROFILES:
        return
    if not identity_input:
        raise HostIdentityError(
            f"profile '{profile}' requires verified SSH host identity but no "
            "verified identity input is available; refusing fail-open automation"
        )
    if profile == "managed-windows":
        for node_id, ref in identity_input.items():
            if not is_windows_host_identity_ref(ref):
                raise HostIdentityError(
                    f"profile '{profile}' node '{node_id}' requires a pinned "
                    "Windows OpenSSH host-key fingerprint (SHA256:... / MD5:... "
                    "public only); refusing non-fingerprint identity ref"
                )


def parse_identity_mechanism(identity_reference: str) -> SSHIdentityMechanism:
    """Classify a verified-identity reference into an explicit mechanism.

    References are typed: ``tailscale_ssh_control_plane:<...>`` maps to the
    Tailscale-SSH control-plane mechanism; the legacy ``known-hosts:`` prefix
    maps to the pinned OpenSSH seam. Anything unknown fails closed rather
    than defaulting to a loose identity claim.
    """
    if not isinstance(identity_reference, str):
        raise HostIdentityError("identity reference must be a string")
    token = identity_reference.split(":", 1)[0]
    if token == "tailscale_ssh_control_plane":
        return SSHIdentityMechanism.TAILSCALE_SSH_CONTROL_PLANE
    if token == "known-hosts":
        return SSHIdentityMechanism.PINNED_OPENSSH
    raise HostIdentityError(
        "unknown SSH identity mechanism; expected 'tailscale_ssh_control_plane' "
        "or legacy 'known-hosts'"
    )


def require_identity_mechanism(
    profile: str,
    identity_input: Mapping[str, str] | None,
    *,
    mechanism: SSHIdentityMechanism,
    reason: str,
) -> None:
    """Assert every required target is verified under an exact mechanism.

    Used by the normal Tailscale-SSH plane so the evidence cannot silently
    claim the provider-bound Tailscale mechanism while the actual verified
    identity input is legacy pinned OpenSSH material (or vice versa).

    Empty/unknown mechanism references are rejected: capability names or
    arbitrary strings are not identity authority. A reference is only ever
    accepted when it classifies to the exact requested ``mechanism``.
    """
    if profile not in HOST_IDENTITY_REQUIRING_PROFILES:
        return
    if not identity_input:
        raise HostIdentityError(
            f"profile '{profile}' requires {mechanism.value} host identity but "
            "no verified identity input is available"
        )
    for node_id, reference in identity_input.items():
        if parse_identity_mechanism(reference) is not mechanism:
            raise HostIdentityError(
                f"node '{node_id}': expected {mechanism.value} host identity but "
                f"got a different mechanism ({reason})"
            )


def verify_all_required_identities(
    targets: list[str],
    identity_input: Mapping[str, str],
) -> list[str]:
    """Check every automation target has a verified identity reference.

    Returns error strings (empty = every required target is covered).
    """
    errors = []
    for target in targets:
        if not identity_input.get(target):
            errors.append(f"node '{target}': no verified SSH host identity reference")
    return errors


def is_windows_host_identity_ref(value: object) -> bool:
    """Return True when ``value`` is a pinned Windows OpenSSH fingerprint ref.

    Accepted forms (public material only)::

        SHA256:<base64>
        MD5:aa:bb:... (16 colon-hex pairs)
        fingerprint:SHA256:<base64>
        fingerprint:MD5:aa:bb:...

    Everything else — empty/whitespace, private key blocks, endpoints/IPs,
    ``accept-new``/TOFU placeholders, generic passwords/tokens — returns
    False so callers fail closed.
    """
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text:
        return False
    upper = text.upper()
    for marker in WINDOWS_IDENTITY_FORBIDDEN_MARKERS:
        if marker in upper:
            return False
    lowered = text.lower()
    if lowered.startswith("fingerprint:"):
        text = text[len("fingerprint:"):].strip()
        if not text:
            return False
    if WINDOWS_SHA256_FINGERPRINT_PATTERN.match(text):
        # Reject padding-only / trivially short placeholders.
        b64 = text[len("SHA256:"):]
        return len(b64.strip("=")) >= 16
    if WINDOWS_MD5_FINGERPRINT_PATTERN.match(text):
        return True
    return False


def validate_windows_host_identity_refs(
    targets: list[str],
    identity_input: Mapping[str, str] | None,
) -> list[str]:
    """Fail-closed fingerprint validation for managed-windows targets.

    Every target must map to a pinned public fingerprint ref (see
    :func:`is_windows_host_identity_ref`). Missing refs, private key
    material, and non-fingerprint placeholders are errors. An empty target
    list is a no-op (nothing to protect).
    """
    errors: list[str] = []
    if not targets:
        return errors
    if not identity_input:
        for target in targets:
            errors.append(
                f"node '{target}': no verified Windows OpenSSH fingerprint reference"
            )
        return errors
    for target in targets:
        ref = identity_input.get(target)
        if not ref:
            errors.append(
                f"node '{target}': no verified Windows OpenSSH fingerprint reference"
            )
        elif not is_windows_host_identity_ref(ref):
            errors.append(
                f"node '{target}': identity ref is not a pinned Windows OpenSSH "
                "host-key fingerprint (SHA256:... / MD5:... public only)"
            )
    return errors
