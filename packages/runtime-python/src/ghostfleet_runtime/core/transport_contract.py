"""Provider-neutral transport contract scaffold (Issue #36 Phase 4).

Semantics frozen by Architect review on #36:

- Node identity / provider+plane / locator / endpoint / caller auth /
  authority / target proof / purpose / dispatch state are separate facts.
- ``dispatch_state`` MUST NOT default to ``NOT_DISPATCHED``. A missing
  dispatch state fails closed. ``MAY_HAVE_EXECUTED`` / ``UNKNOWN`` must
  survive timeout/crash/restart via a durable store.
- ``purpose`` has no global default; only an explicit legacy
  machine-control entry may derive it.
- ``required_tags`` (durable policy) is never merged with
  ``runtime_tags`` (provider observation).
- Raw OAuth tokens, SSH private keys, enrollment auth keys must never
  enter the public registry/contract.

This module is a scaffold: no provider adapter performs real network
mutation, no adaptive router selects or scores candidates.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Iterable, Mapping

__all__ = [
    "Plane",
    "Purpose",
    "DispatchState",
    "FailureDomain",
    "EndpointKind",
    "TargetProofMethod",
    "LocatorKind",
    "PlaneBinding",
    "Endpoint",
    "Caller",
    "Authority",
    "TargetProof",
    "Candidate",
    "TransportRequest",
    "DispatchStateStore",
    "JsonFileDispatchStateStore",
    "DispatchStateUnrecoverableError",
    "PurposeUnspecifiedError",
    "ContractValidationError",
    "evaluate_gate",
    "tag_policy_satisfied",
    "assert_no_secret_fields",
    "derive_purpose_for_legacy_machine_control_entry",
]


class ContractValidationError(Exception):
    """Fail-closed contract validation failure."""


class PurposeUnspecifiedError(ContractValidationError):
    pass


class DispatchStateUnrecoverableError(ContractValidationError):
    pass


class Purpose(str, Enum):
    MACHINE_CONTROL = "machine-control"
    HUMAN_MAINTENANCE = "human-maintenance"
    RECOVERY = "recovery"


class Plane(str, Enum):
    CLOUDFLARE_VPC = "cloudflare-vpc"
    TAILNET = "tailnet"
    NATIVE_LAN = "native-lan"


class DispatchState(str, Enum):
    NOT_DISPATCHED = "NOT_DISPATCHED"
    MAY_HAVE_EXECUTED = "MAY_HAVE_EXECUTED"
    UNKNOWN = "UNKNOWN"


class FailureDomain(str, Enum):
    WORKER_VPC = "worker_vpc"
    TAILNET = "tailnet"
    LAN = "lan"
    PROVIDER = "provider"
    UNKNOWN = "unknown"


class EndpointKind(str, Enum):
    TAILSCALE_SSH = "tailscale_ssh"
    NATIVE_SSHD = "native_sshd"
    CLOUDFLARED_FORWARDED_SSHD = "cloudflared_forwarded_sshd"


class TargetProofMethod(str, Enum):
    PINNED_HOST_KEY = "pinned_host_key"
    PROVIDER_BINDING_TAG = "provider_binding_tag"
    TAILSCALE_JIT_HOST_KEY = "tailscale_jit_host_key"


class LocatorKind(str, Enum):
    BINDING_NAME = "binding_name"
    PROVIDER_REF = "provider_ref"
    MAGICDNS = "magicdns"
    EXPLICIT_IP = "explicit_ip"


@dataclass(frozen=True)
class PlaneBinding:
    plane: Plane
    provider: str
    provider_ref: str
    required_tags: tuple[str, ...] = ()  # durable policy
    runtime_tags: tuple[str, ...] = ()  # provider observation, never merged


@dataclass(frozen=True)
class Endpoint:
    kind: EndpointKind
    port: int | None = None


@dataclass(frozen=True)
class Caller:
    auth_kind: str  # oauth | tailscale_acl | openssh_pubkey
    actor_ref: str


@dataclass(frozen=True)
class Authority:
    scope: str  # machine-control | human-maintenance | recovery
    policy_revision: str


@dataclass(frozen=True)
class TargetProof:
    method: TargetProofMethod
    detail_digest: str | None = None


@dataclass(frozen=True)
class Candidate:
    plane: Plane
    endpoint: Endpoint
    target_proof: TargetProof
    locator_kind: LocatorKind
    failure_domain: FailureDomain


@dataclass(frozen=True)
class TransportRequest:
    node_uid: str
    caller: Caller
    authority: Authority
    purpose: Purpose | None  # None => fail closed
    dispatch_state: DispatchState | None  # None => fail closed
    plane_bindings: tuple[PlaneBinding, ...] = ()

    def require_purpose(self) -> Purpose:
        if self.purpose is None:
            raise PurposeUnspecifiedError("purpose is required; no global default")
        return self.purpose

    def require_dispatch_state(self) -> DispatchState:
        if self.dispatch_state is None:
            raise DispatchStateUnrecoverableError(
                "dispatch_state is unknown; refusing to treat it as NOT_DISPATCHED"
            )
        return self.dispatch_state


def derive_purpose_for_legacy_machine_control_entry() -> Purpose:
    """Only explicit legacy entry may derive a purpose; record the derivation."""
    return Purpose.MACHINE_CONTROL


def _candidate_for_binding(binding: PlaneBinding) -> Candidate:
    """Provider-specific materialization belongs to the adapter, but the
    scaffold must not fake tailnet facts for a cloudflare binding (RF-2).
    This helper keeps the scaffold's candidate summaries honest per plane.
    """
    if binding.plane is Plane.TAILNET:
        return Candidate(
            plane=binding.plane,
            endpoint=Endpoint(kind=EndpointKind.TAILSCALE_SSH),
            target_proof=TargetProof(method=TargetProofMethod.PROVIDER_BINDING_TAG),
            locator_kind=LocatorKind.PROVIDER_REF,
            failure_domain=FailureDomain.TAILNET,
        )
    if binding.plane is Plane.CLOUDFLARE_VPC:
        return Candidate(
            plane=binding.plane,
            endpoint=Endpoint(kind=EndpointKind.CLOUDFLARED_FORWARDED_SSHD),
            target_proof=TargetProof(method=TargetProofMethod.PINNED_HOST_KEY),
            locator_kind=LocatorKind.BINDING_NAME,
            failure_domain=FailureDomain.WORKER_VPC,
        )
    # NATIVE_LAN / recovery
    return Candidate(
        plane=binding.plane,
        endpoint=Endpoint(kind=EndpointKind.NATIVE_SSHD),
        target_proof=TargetProof(method=TargetProofMethod.PINNED_HOST_KEY),
        locator_kind=LocatorKind.EXPLICIT_IP,
        failure_domain=FailureDomain.LAN,
    )


def evaluate_gate(request: TransportRequest) -> dict[str, object]:
    """Return candidates or an empty list with a fail-closed reason.

    The gate is provider-neutral: it only does purpose/effect/authority policy
    fencing (RF-3). Provider-specific candidate materialization is left to the
    adapter via ``_candidate_for_binding`` and never faked across planes (RF-2).
    """
    purpose = request.require_purpose()
    state = request.require_dispatch_state()
    if state is not DispatchState.NOT_DISPATCHED:
        return {
            "candidates": [],
            "reason": "reconcile_required",
            "dispatch_state": state.value,
            "purpose": purpose.value,
        }
    # RF-3: authority scope must be consistent with purpose; cross-authority
    # requests produce no candidates instead of silently succeeding.
    if request.authority.scope != purpose.value:
        return {
            "candidates": [],
            "reason": "authority_mismatch",
            "dispatch_state": state.value,
            "purpose": purpose.value,
        }
    allowed = {
        Purpose.MACHINE_CONTROL: (Plane.CLOUDFLARE_VPC, Plane.TAILNET),
        Purpose.HUMAN_MAINTENANCE: (Plane.TAILNET,),
        Purpose.RECOVERY: (Plane.NATIVE_LAN,),
    }[purpose]
    candidates: list[Candidate] = []
    for binding in request.plane_bindings:
        if binding.plane not in allowed:
            continue
        # RF-3: required_tags is durable policy; runtime_tags is observation.
        # Missing required tag fails closed for that binding.
        if not tag_policy_satisfied(binding.required_tags, binding.runtime_tags):
            continue
        candidates.append(_candidate_for_binding(binding))
    if not candidates:
        # Distinguish empty due to tag policy vs no matching plane.
        has_plane_match = any(b.plane in allowed for b in request.plane_bindings)
        reason = "tag_policy_unsatisfied" if has_plane_match else "no_candidate_for_purpose"
        return {"candidates": [], "reason": reason, "purpose": purpose.value}
    return {"candidates": candidates, "reason": "ok", "purpose": purpose.value}


def tag_policy_satisfied(required_tags: Iterable[str], runtime_tags: Iterable[str]) -> bool:
    required = set(required_tags)
    runtime = set(runtime_tags)
    return required.issubset(runtime)


_FORBIDDEN_FIELD_HINTS = ("token", "secret", "private_key", "auth_key", "credential")


def assert_no_secret_fields(mapping: Mapping[str, object]) -> None:
    for key in mapping:
        lowered = key.lower()
        if any(hint in lowered for hint in _FORBIDDEN_FIELD_HINTS):
            raise ContractValidationError(f"secret-like field is forbidden in contract: {key}")


class DispatchStateStore:
    """Durable dispatch-state store; must survive process restart."""

    def get(self, key: str) -> DispatchState | None:  # pragma: no cover - interface
        raise NotImplementedError

    def put(self, key: str, state: DispatchState) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class JsonFileDispatchStateStore(DispatchStateStore):
    """Local durable store used by the scaffold; production stores may
    back this with SQLite/registry-backed state. Values are never inferred.
    """

    def __init__(self, path: str | os.PathLike[str]):
        self._path = Path(path)

    def _read(self) -> dict[str, str]:
        if not self._path.exists():
            return {}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        if not isinstance(raw, dict):
            return {}
        return {str(k): str(v) for k, v in raw.items()}

    def get(self, key: str) -> DispatchState | None:
        value = self._read().get(key)
        if value is None:
            return None
        try:
            return DispatchState(value)
        except ValueError:
            return None

    def put(self, key: str, state: DispatchState) -> None:
        data = self._read()
        data[key] = state.value
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self._path)
