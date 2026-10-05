"""Remote maintenance survivability evidence interfaces (T4).

Reusable repository mechanisms for Fleet remote maintenance survivability
evidence (Fleet 2.0.0 + Onboarding 3.0.0). Provides typed evidence envelopes
for HUMAN_PRIVILEGED_PATH, MACHINE_PRIVILEGED_PATH, CONTROLLER_FALLBACK,
INDEPENDENT_RECOVERY, REBOOT_RECOVERY, SECURITY_GATE, plus
controller fallback server/port/pin/key class representation without embedding
instance values, and recovery/reboot/security gate interfaces.

No provider-specific instance logic or real node facts are embedded.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal


# ---------------------------------------------------------------------------
# Evidence vocabulary (matches remote-maintenance-evidence.schema.json)
# ---------------------------------------------------------------------------

GATE_STATUSES = ("PASS", "BLOCKED", "UNKNOWN")
HUMAN_REAUTH_CAPABILITIES = (
    "CHECK_PERIOD_ALWAYS",
    "ALTERNATIVE_ACCEPTED",
    "UNAVAILABLE",
    "UNKNOWN",
)
RECOVERY_CLASSES = (
    "INDEPENDENT_CONSOLE",
    "RESCUE",
    "REINSTALL_ONLY",
    "OTHER_PROVEN_CLASS",
)
SHARED_FAILURE_DOMAINS = (
    "HOST_POWER_STORAGE",
    "TAILSCALE",
    "IDP",
    "CLOUDFLARE",
    "CONTROLLER",
    "PROVIDER",
    "OTHER_DOCUMENTED",
)

NODE_UID_RE = re.compile(r"^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
EVIDENCE_REF_RE = re.compile(r"^evidence:[A-Za-z0-9._-]{1,128}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


class RemoteMaintenanceError(ValueError):
    def __init__(self, code: str, detail: str = ""):
        self.code = code
        super().__init__(f"{code}: {detail}" if detail else code)


# ---------------------------------------------------------------------------
# Gate dataclass
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class GateEvidence:
    status: Literal["PASS", "BLOCKED", "UNKNOWN"]
    evidence_ref: str | None

    def validate(self) -> list[str]:
        errors: list[str] = []
        if self.status not in GATE_STATUSES:
            errors.append(f"invalid gate status: {self.status!r}")
        if self.status == "PASS" and not self.evidence_ref:
            errors.append("PASS gate requires evidence_ref")
        if self.evidence_ref is not None and not EVIDENCE_REF_RE.fullmatch(self.evidence_ref):
            errors.append(f"invalid evidence_ref: {self.evidence_ref!r}")
        return errors

    def to_json(self) -> dict[str, Any]:
        return {"status": self.status, "evidence_ref": self.evidence_ref}


# ---------------------------------------------------------------------------
# Controller fallback class (no instance values)
# ---------------------------------------------------------------------------

# Fallback classes are deployment evidence categories, not instance locators.
CONTROLLER_FALLBACK_KEY_CLASSES = (
    "PRIVILEGED_OPS_KEY",
    "ORDINARY_CONTROL_KEY",
    "OTHER_KEY_CLASS",
)
CONTROLLER_FALLBACK_PIN_CLASSES = (
    "PINNED_OPENSSH",
    "TAILSCALE_SSH_CONTROL_PLANE",
    "OTHER_PIN_CLASS",
)
CONTROLLER_FALLBACK_SERVER_CLASSES = (
    "DEDICATED_FALLBACK_CONTROLLER",
    "WORKSTATION_FALLBACK",
    "OTHER_SERVER_CLASS",
)
CONTROLLER_FALLBACK_PORT_CLASSES = (
    "SSH_22",
    "ALTERNATE_SSH_PORT",
    "OTHER_PORT_CLASS",
)

@dataclass(frozen=True)
class ControllerFallbackSpec:
    """Reusable fallback representation without instance values.

    Fields describe the *class* of fallback, not the real server hostname,
    port number, pin value, or key material. This satisfies Scope C:
    represent controller fallback server/port/pin/key class without
    embedding instance values.
    """
    server_class: str
    port_class: str
    pin_class: str
    key_class: str
    revocable: bool
    transport_mode: str = "ssh"

    def validate(self) -> list[str]:
        errors: list[str] = []
        if self.server_class not in CONTROLLER_FALLBACK_SERVER_CLASSES:
            errors.append(f"invalid server_class: {self.server_class!r}")
        if self.port_class not in CONTROLLER_FALLBACK_PORT_CLASSES:
            errors.append(f"invalid port_class: {self.port_class!r}")
        if self.pin_class not in CONTROLLER_FALLBACK_PIN_CLASSES:
            errors.append(f"invalid pin_class: {self.pin_class!r}")
        if self.key_class not in CONTROLLER_FALLBACK_KEY_CLASSES:
            errors.append(f"invalid key_class: {self.key_class!r}")
        if self.key_class == "ORDINARY_CONTROL_KEY":
            errors.append("FALLBACK_MUST_NOT_REUSE_ORDINARY_KEY")
        if self.revocable is not True:
            errors.append("FALLBACK_MUST_BE_REVOCABLE")
        # Ensure no instance values are embedded: fail if server_class looks like hostname/IP
        if re.search(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", self.server_class):
            errors.append("FALLBACK_SERVER_CLASS_MUST_NOT_CONTAIN_IP")
        if "." in self.server_class and "invalid" not in self.server_class.lower() and "example" not in self.server_class.lower():
            # Allow only synthetic placeholder if dot present
            errors.append("FALLBACK_SERVER_CLASS_MUST_NOT_CONTAIN_HOSTNAME")
        return errors

    def to_evidence_gate(self, status: str, evidence_ref: str | None) -> GateEvidence:
        return GateEvidence(status=status, evidence_ref=evidence_ref)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Recovery / reboot / security gate interfaces
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class IndependentRecoverySpec:
    recovery_class: str
    evidence_ref: str | None
    proven_independent: bool

    def validate(self) -> list[str]:
        errors: list[str] = []
        if self.recovery_class not in RECOVERY_CLASSES:
            errors.append(f"invalid recovery_class: {self.recovery_class!r}")
        if self.recovery_class == "REINSTALL_ONLY" and self.proven_independent:
            errors.append("REINSTALL_ONLY_CANNOT_BE_INDEPENDENT")
        if self.recovery_class == "OTHER_PROVEN_CLASS" and not self.evidence_ref:
            errors.append("OTHER_PROVEN_CLASS_REQUIRES_EVIDENCE_REF")
        if self.recovery_class == "OTHER_PROVEN_CLASS" and not self.proven_independent:
            errors.append("OTHER_PROVEN_CLASS_MUST_BE_PROVEN_INDEPENDENT")
        return errors


@dataclass(frozen=True)
class RebootRecoverySpec:
    verified_via_external_observation: bool
    evidence_ref: str | None

    def validate(self) -> list[str]:
        errors: list[str] = []
        if self.verified_via_external_observation and not self.evidence_ref:
            errors.append("REBOOT_RECOVERY_PASS_REQUIRES_EVIDENCE_REF")
        return errors


@dataclass(frozen=True)
class SecurityGateSpec:
    running_version: str | None
    reviewed_floor: str | None
    advisories_reviewed: list[str] = field(default_factory=list)
    has_accept_env: bool = False

    def validate(self) -> list[str]:
        # Delegate to human_tailscale_ssh validation hooks
        from .human_tailscale_ssh import validate_security_floor

        return validate_security_floor(
            running_version=self.running_version,
            reviewed_floor=self.reviewed_floor,
            advisories_reviewed=self.advisories_reviewed,
            has_accept_env=self.has_accept_env,
        )


# ---------------------------------------------------------------------------
# Full evidence envelope
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RemoteMaintenanceEvidence:
    schema_version: str
    node_uid: str
    projection: dict[str, Any]
    profile_generation: str
    REMOTE_MAINTENANCE_READY: str
    HUMAN_REAUTH_CAPABILITY: str
    HUMAN_PRIVILEGED_PATH: GateEvidence
    MACHINE_PRIVILEGED_PATH: GateEvidence
    CONTROLLER_FALLBACK: GateEvidence
    INDEPENDENT_RECOVERY: GateEvidence
    REBOOT_RECOVERY: GateEvidence
    SECURITY_GATE: GateEvidence
    RECOVERY_CLASS: str
    shared_failure_domains: list[str]
    # Optional typed specs (not part of schema, for reusable interfaces)
    fallback_spec: ControllerFallbackSpec | None = None
    independent_recovery_spec: IndependentRecoverySpec | None = None
    reboot_spec: RebootRecoverySpec | None = None
    security_spec: SecurityGateSpec | None = None

    def validate_shape(self) -> list[str]:
        errors: list[str] = []
        if self.schema_version != "1.0.0":
            errors.append("schema_version must be 1.0.0")
        if not NODE_UID_RE.fullmatch(self.node_uid):
            errors.append(f"invalid node_uid: {self.node_uid!r}")
        if not DIGEST_RE.fullmatch(self.profile_generation):
            errors.append(f"invalid profile_generation: {self.profile_generation!r}")
        if self.REMOTE_MAINTENANCE_READY not in GATE_STATUSES:
            errors.append(f"invalid REMOTE_MAINTENANCE_READY: {self.REMOTE_MAINTENANCE_READY!r}")
        if self.HUMAN_REAUTH_CAPABILITY not in HUMAN_REAUTH_CAPABILITIES:
            errors.append(f"invalid HUMAN_REAUTH_CAPABILITY: {self.HUMAN_REAUTH_CAPABILITY!r}")
        if self.RECOVERY_CLASS not in RECOVERY_CLASSES:
            errors.append(f"invalid RECOVERY_CLASS: {self.RECOVERY_CLASS!r}")
        for domain in self.shared_failure_domains:
            if domain not in SHARED_FAILURE_DOMAINS:
                errors.append(f"invalid shared_failure_domain: {domain!r}")
        if len(set(self.shared_failure_domains)) != len(self.shared_failure_domains):
            errors.append("shared_failure_domains must be unique")
        if not self.shared_failure_domains:
            errors.append("shared_failure_domains must be non-empty")

        for gate_name in (
            "HUMAN_PRIVILEGED_PATH",
            "MACHINE_PRIVILEGED_PATH",
            "CONTROLLER_FALLBACK",
            "INDEPENDENT_RECOVERY",
            "REBOOT_RECOVERY",
            "SECURITY_GATE",
        ):
            gate: GateEvidence = getattr(self, gate_name)
            for err in gate.validate():
                errors.append(f"{gate_name}: {err}")

        # Projection shape
        projection_fields = {"schema_version", "product_source_revision", "instance_overlay_revision", "projection_digest"}
        proj = self.projection if isinstance(self.projection, dict) else {}
        if not isinstance(self.projection, dict) or set(proj) != projection_fields:
            errors.append("projection must match the closed instance-projection shape")
        for key in sorted(projection_fields):
            if key not in proj:
                errors.append(f"projection missing {key}")
        if proj.get("schema_version") != "1.0.0":
            errors.append("projection schema_version must be 1.0.0")
        for rev_key in ("product_source_revision", "instance_overlay_revision"):
            rev = proj.get(rev_key)
            if not isinstance(rev, str) or not REVISION_RE.fullmatch(rev):
                errors.append(f"invalid projection {rev_key}: {rev!r}")
        if not isinstance(proj.get("projection_digest"), str) or not DIGEST_RE.fullmatch(proj["projection_digest"]):
            errors.append(f"invalid projection_digest: {proj.get('projection_digest')!r}")

        # Typed specs validation
        if self.fallback_spec and self.fallback_spec.validate():
            errors.extend(f"fallback_spec: {e}" for e in self.fallback_spec.validate())
        if self.independent_recovery_spec and self.independent_recovery_spec.validate():
            errors.extend(f"independent_recovery_spec: {e}" for e in self.independent_recovery_spec.validate())
        if self.independent_recovery_spec is not None:
            spec = self.independent_recovery_spec
            gate = self.INDEPENDENT_RECOVERY
            if spec.recovery_class != self.RECOVERY_CLASS or spec.evidence_ref != gate.evidence_ref:
                errors.append("independent_recovery_spec: RECOVERY_EVIDENCE_BINDING_MISMATCH")
            if gate.status == "PASS" and spec.proven_independent is not True:
                errors.append("independent_recovery_spec: PASS_REQUIRES_PROVEN_INDEPENDENCE")
        if self.reboot_spec and self.reboot_spec.validate():
            errors.extend(f"reboot_spec: {e}" for e in self.reboot_spec.validate())
        if self.reboot_spec is not None:
            spec = self.reboot_spec
            gate = self.REBOOT_RECOVERY
            if spec.evidence_ref != gate.evidence_ref:
                errors.append("reboot_spec: REBOOT_EVIDENCE_BINDING_MISMATCH")
            if gate.status == "PASS" and spec.verified_via_external_observation is not True:
                errors.append("reboot_spec: PASS_REQUIRES_EXTERNAL_OBSERVATION")
        if self.security_spec and self.security_spec.validate():
            errors.extend(f"security_spec: {e}" for e in self.security_spec.validate())

        return errors

    def to_json(self) -> dict[str, Any]:
        if self.validate_shape():
            raise RemoteMaintenanceError("REMOTE_MAINTENANCE_EVIDENCE_INVALID")
        if aggregate_ready(self) != self.REMOTE_MAINTENANCE_READY:
            raise RemoteMaintenanceError("REMOTE_MAINTENANCE_AGGREGATE_MISMATCH")
        return {
            "schema_version": self.schema_version,
            "node_uid": self.node_uid,
            "projection": dict(self.projection),
            "profile_generation": self.profile_generation,
            "REMOTE_MAINTENANCE_READY": self.REMOTE_MAINTENANCE_READY,
            "HUMAN_REAUTH_CAPABILITY": self.HUMAN_REAUTH_CAPABILITY,
            "HUMAN_PRIVILEGED_PATH": self.HUMAN_PRIVILEGED_PATH.to_json(),
            "MACHINE_PRIVILEGED_PATH": self.MACHINE_PRIVILEGED_PATH.to_json(),
            "CONTROLLER_FALLBACK": self.CONTROLLER_FALLBACK.to_json(),
            "INDEPENDENT_RECOVERY": self.INDEPENDENT_RECOVERY.to_json(),
            "REBOOT_RECOVERY": self.REBOOT_RECOVERY.to_json(),
            "SECURITY_GATE": self.SECURITY_GATE.to_json(),
            "RECOVERY_CLASS": self.RECOVERY_CLASS,
            "shared_failure_domains": list(self.shared_failure_domains),
        }

def aggregate_ready(evidence: RemoteMaintenanceEvidence) -> str:
    """Compute the accepted BLOCKED-first aggregate; never create gate evidence."""
    if evidence.validate_shape():
        raise RemoteMaintenanceError("REMOTE_MAINTENANCE_EVIDENCE_INVALID")

    if evidence.HUMAN_REAUTH_CAPABILITY == "UNKNOWN":
        if evidence.HUMAN_PRIVILEGED_PATH.status != "UNKNOWN":
            raise RemoteMaintenanceError("HUMAN_CAPABILITY_GATE_MISMATCH")
    elif evidence.HUMAN_REAUTH_CAPABILITY == "UNAVAILABLE":
        if evidence.HUMAN_PRIVILEGED_PATH.status != "BLOCKED":
            raise RemoteMaintenanceError("HUMAN_CAPABILITY_GATE_MISMATCH")

    if evidence.RECOVERY_CLASS == "REINSTALL_ONLY" and evidence.INDEPENDENT_RECOVERY.status != "BLOCKED":
        raise RemoteMaintenanceError("RECOVERY_CLASS_GATE_MISMATCH")

    gates = [
        evidence.HUMAN_PRIVILEGED_PATH,
        evidence.MACHINE_PRIVILEGED_PATH,
        evidence.CONTROLLER_FALLBACK,
        evidence.INDEPENDENT_RECOVERY,
        evidence.REBOOT_RECOVERY,
        evidence.SECURITY_GATE,
    ]
    if any(g.status == "BLOCKED" for g in gates):
        return "BLOCKED"
    if any(g.status == "UNKNOWN" for g in gates):
        return "UNKNOWN"
    return "PASS"

