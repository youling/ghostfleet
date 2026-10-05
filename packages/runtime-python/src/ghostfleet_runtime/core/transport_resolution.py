"""Fail-closed runtime transport resolution for Fleet nodes.

Fleet identity and transport are deliberately separate.  Callers must first
hold an exact ``node_uid`` and a management profile/path; a node id, alias,
hostname, IP address, or SSH alias is never accepted as transport authority.

The objects in this module are an in-memory seam.  Runtime locators and
provider machine names are intentionally kept on ephemeral objects only.
``TransportResolution.as_durable_evidence`` emits a small, topology-free
summary suitable for logs, artifacts, or GitHub comments.

FO2B3 (legacy mechanism contract / ARCHITECT_FO2B3_TAILSCALE_SSH_PRIMARY_MATERIALIZATION):
normal Tailscale-SSH mode resolves by an exact canonical provider ref.
Match count MUST equal one and the peer must currently carry
``tag:fleet-ssh-target``.  Name/alias/MagicDNS/IP and
``navigation_name_hint`` MUST NOT become an authority fallback in normal
mode.  The legacy canary hint behavior is retained only behind an explicit
``legacy`` seam so current history remains understandable.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import re
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence


NODE_UID_PATTERN = re.compile(
    r"^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class TransportMode(Enum):
    """Distinguish the normal Tailscale-SSH auth plane from legacy canary aid.

    NORMAL is the FO2B3 provider-bound Tailscale-SSH primary plane: resolution
    is by exact provider ref + service tag; name/IP/navigation hint is never an
    authority fallback.

    LEGACY_CANARY is the explicitly gated canary-aid seam retained so the
    current history remains understandable. It must NEVER become the normal
    path; anything reaching it is treated as canary-only.
    """

    NORMAL = "normal"
    LEGACY_CANARY = "legacy_canary"


# The destination service tag: transport/auth role only, no Fleet lifecycle
# meaning. Presence is required for the Tailscale-SSH normal plane.
FLEET_SSH_TARGET_TAG = "tag:fleet-ssh-target"


def iter_tailscale_peer_objects(status: Any) -> tuple[Any, ...]:
    """Return peer objects from Tailscale JSON mapping or list shapes."""
    if not isinstance(status, Mapping):
        return ()
    peers = status.get("Peer")
    if isinstance(peers, Mapping):
        return tuple(peers.values())
    if isinstance(peers, (list, tuple)):
        return tuple(peers)
    return ()


class TransportStatus(str, Enum):
    """Stable status vocabulary; none of the resolution failures means offline."""

    IDENTITY_UNRESOLVED = "IDENTITY_UNRESOLVED"
    IDENTITY_AMBIGUOUS = "IDENTITY_AMBIGUOUS"
    TRANSPORT_INVENTORY_UNAVAILABLE = "TRANSPORT_INVENTORY_UNAVAILABLE"
    TRANSPORT_TARGET_UNRESOLVED = "TRANSPORT_TARGET_UNRESOLVED"
    TRANSPORT_TARGET_AMBIGUOUS = "TRANSPORT_TARGET_AMBIGUOUS"
    TRANSPORT_REACHABILITY_FAILED = "TRANSPORT_REACHABILITY_FAILED"
    TARGET_IDENTITY_MISMATCH = "TARGET_IDENTITY_MISMATCH"
    SOURCE_IDENTITY_UNPROVEN = "SOURCE_IDENTITY_UNPROVEN"
    TARGET_RESOLVED = "TARGET_RESOLVED"
    TARGET_CONTACTED = "TARGET_CONTACTED"


class TransportResolutionError(Exception):
    """Base class for fail-closed transport resolution failures."""

    status: TransportStatus

    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


class IdentityUnresolvedError(TransportResolutionError):
    status = TransportStatus.IDENTITY_UNRESOLVED


class IdentityAmbiguousError(TransportResolutionError):
    status = TransportStatus.IDENTITY_AMBIGUOUS


class TransportInventoryUnavailableError(TransportResolutionError):
    status = TransportStatus.TRANSPORT_INVENTORY_UNAVAILABLE


class TransportTargetUnresolvedError(TransportResolutionError):
    status = TransportStatus.TRANSPORT_TARGET_UNRESOLVED


class TransportTargetAmbiguousError(TransportResolutionError):
    status = TransportStatus.TRANSPORT_TARGET_AMBIGUOUS


class TransportReachabilityError(TransportResolutionError):
    status = TransportStatus.TRANSPORT_REACHABILITY_FAILED


class TargetIdentityMismatchError(TransportResolutionError):
    status = TransportStatus.TARGET_IDENTITY_MISMATCH


class SourceIdentityUnprovenError(TransportResolutionError):
    status = TransportStatus.SOURCE_IDENTITY_UNPROVEN


def _require_node_uid(value: str) -> str:
    if not isinstance(value, str) or not NODE_UID_PATTERN.fullmatch(value):
        raise IdentityUnresolvedError(
            "transport resolution requires an exact Fleet node_uid; "
            "node_id, alias, hostname, and locator values are not authority"
        )
    return value


@dataclass(frozen=True)
class TransportResolutionRequest:
    """The only identity input accepted by a transport adapter.

    ``mode`` selects the resolution authority plane. In ``NORMAL`` mode the
    adapter resolves by exact canonical provider ref + service tag only; the
    ``navigation_name_hint`` is ignored as an authority fallback. In
    ``LEGACY_CANARY`` mode the name hint may aid navigation as an explicitly
    gated seam.
    """

    node_uid: str
    management_path: str
    management_profile: str
    navigation_name_hint: str | None = None
    mode: TransportMode = TransportMode.NORMAL
    provider_ref: str | None = None

    def __post_init__(self) -> None:
        _require_node_uid(self.node_uid)
        if not isinstance(self.management_path, str) or not self.management_path:
            raise IdentityUnresolvedError("management_path is required")
        if not isinstance(self.management_profile, str) or not self.management_profile:
            raise IdentityUnresolvedError("management_profile is required")
        if not isinstance(self.mode, TransportMode):
            try:
                object.__setattr__(self, "mode", TransportMode(self.mode))
            except (ValueError, TypeError):
                raise IdentityUnresolvedError("invalid transport mode") from None


@dataclass(frozen=True)
class RuntimeTransportHint:
    """Explicit, controlled-canary hint; never durable and never sufficient alone."""

    node_uid: str
    provider: str
    locator: str
    locator_kind: str = "runtime"

    def __post_init__(self) -> None:
        _require_node_uid(self.node_uid)
        if not self.provider or not self.locator:
            raise TransportTargetUnresolvedError("runtime transport hint is incomplete")


@dataclass(frozen=True)
class TransportCandidate:
    """Ephemeral candidate returned by a provider adapter."""

    node_uid: str
    provider: str
    locator: str
    locator_kind: str = "runtime"
    provider_ref: str | None = None
    name_hint: str | None = None
    correlation: str = "provider_node_uid"

    def __post_init__(self) -> None:
        _require_node_uid(self.node_uid)
        if not self.provider or not self.locator:
            raise TransportTargetUnresolvedError("transport candidate is incomplete")


@dataclass(frozen=True)
class TailscalePeer:
    """A sanitized/live peer view consumed only in memory by the adapter.

    ``node_uid`` is the authoritative correlation when available.  A
    ``canonical_name_hint`` can only provide navigation assistance when the
    request explicitly supplies the same hint; it is never treated as proof.
    ``provider_ref`` is the opaque Tailscale provider-scoped correlation ref
    (stable node ID). ``tags`` is the current transport/auth role tag set.
    """

    machine_name: str
    node_uid: str | None = None
    provider_ref: str | None = None
    canonical_name_hint: str | None = None
    tags: tuple[str, ...] = ()

    def has_service_tag(self) -> bool:
        return FLEET_SSH_TARGET_TAG in self.tags


class TransportAdapter(Protocol):
    def candidates(
        self,
        request: TransportResolutionRequest,
        *,
        inventory: Iterable[object] | None = None,
        runtime_hint: RuntimeTransportHint | None = None,
    ) -> Sequence[TransportCandidate]: ...


class TailscaleTransportAdapter:
    """Resolve Tailscale candidates without turning names into authority."""

    provider = "tailscale"

    def candidates(
        self,
        request: TransportResolutionRequest,
        *,
        inventory: Iterable[TailscalePeer] | None = None,
        runtime_hint: RuntimeTransportHint | None = None,
    ) -> Sequence[TransportCandidate]:
        if runtime_hint is not None:
            if request.mode is TransportMode.NORMAL:
                # NORMAL mode must never consume a runtime hint; the only
                # authority is the exact canonical provider ref + service tag.
                # A hint reaching the normal plane fails closed before contact.
                raise TransportTargetUnresolvedError(
                    "runtime transport hint is forbidden in NORMAL mode; "
                    "the normal plane resolves by exact provider ref only"
                )
            if runtime_hint.node_uid != request.node_uid:
                raise IdentityUnresolvedError(
                    "runtime transport hint node_uid does not match the exact request"
                )
            if runtime_hint.provider != self.provider:
                raise TransportTargetUnresolvedError(
                    f"Tailscale adapter cannot consume provider {runtime_hint.provider!r}"
                )
            return (
                TransportCandidate(
                    node_uid=request.node_uid,
                    provider=runtime_hint.provider,
                    locator=runtime_hint.locator,
                    locator_kind=runtime_hint.locator_kind,
                ),
            )

        if inventory is None:
            raise TransportInventoryUnavailableError(
                "Tailscale peer inventory is unavailable; no implicit name lookup is allowed"
            )

        # Normal Tailscale-SSH plane: resolve by EXACT canonical provider ref,
        # then require exactly one match carrying the fleet-ssh-target tag.
        # Name/alias/MagicDNS/IP/navigation hint is never a fallback in this
        # mode. A missing/unbound provider ref fails closed before contact.
        if request.mode is TransportMode.NORMAL:
            provider_ref = self._required_provider_ref(request)
            matches: list[TransportCandidate] = []
            for raw_peer in inventory:
                peer = self._coerce_peer(raw_peer)
                if peer is None or not peer.machine_name:
                    continue
                if peer.provider_ref != provider_ref:
                    continue
                if not peer.has_service_tag():
                    raise TargetIdentityMismatchError(
                        f"peer for node_uid {request.node_uid} does not currently "
                        f"carry {FLEET_SSH_TARGET_TAG}; refusing (fail closed)"
                    )
                matches.append(
                    TransportCandidate(
                        node_uid=request.node_uid,
                        provider=self.provider,
                        locator=peer.machine_name,
                        provider_ref=peer.provider_ref,
                        correlation="provider_node_uid",
                    )
                )
            return tuple(matches)

        # Legacy canary seam: retains the historical navigation-name-hint and
        # runtime-hint behavior explicitly gated behind LEGACY_CANARY. It must
        # never become the normal authority path.
        matches = []
        for raw_peer in inventory:
            peer = self._coerce_peer(raw_peer)
            if peer is None or not peer.machine_name:
                continue
            exact_uid = peer.node_uid == request.node_uid
            name_hint = (
                request.navigation_name_hint
                and peer.canonical_name_hint == request.navigation_name_hint
            )
            if exact_uid or name_hint:
                matches.append(
                    TransportCandidate(
                        node_uid=request.node_uid,
                        provider=self.provider,
                        locator=peer.machine_name,
                        provider_ref=peer.provider_ref,
                        name_hint=peer.canonical_name_hint,
                        correlation=(
                            "provider_node_uid" if exact_uid else "navigation_name_hint"
                        ),
                    )
                )
        return tuple(matches)

    @staticmethod
    def _required_provider_ref(request: TransportResolutionRequest) -> str:
        """Return the canonical provider ref bound to this node_uid.

        The adapter itself does not read the registry; the caller supplies the
        exact opaque ``tailscale`` provider ref for the request's node_uid on
        the request via ``provider_ref`` (added by the runtime layer). A
        missing/unbound ref fails closed before any target contact with a
        topology-free classification.
        """
        ref = getattr(request, "provider_ref", None)
        if not isinstance(ref, str) or not ref.strip():
            raise TransportTargetUnresolvedError(
                f"no tailscale provider_ref bound for node_uid {request.node_uid}; "
                "refusing (unbound node fails closed before contact)"
            )
        return ref

    @staticmethod
    def _coerce_peer(raw_peer: object) -> TailscalePeer | None:
        """Accept typed peers or sanitized provider mappings in memory only."""
        if isinstance(raw_peer, TailscalePeer):
            return raw_peer
        if not isinstance(raw_peer, Mapping):
            return None
        machine_name = raw_peer.get("machine_name") or raw_peer.get("name")
        if not isinstance(machine_name, str):
            return None
        node_uid = raw_peer.get("node_uid") or raw_peer.get("fleet_node_uid")
        tags = raw_peer.get("tags") or ()
        if not isinstance(tags, (list, tuple)):
            tags = ()
        return TailscalePeer(
            machine_name=machine_name,
            node_uid=node_uid if isinstance(node_uid, str) else None,
            provider_ref=(
                raw_peer.get("provider_ref")
                if isinstance(raw_peer.get("provider_ref"), str)
                else None
            ),
            canonical_name_hint=(
                raw_peer.get("canonical_name_hint")
                if isinstance(raw_peer.get("canonical_name_hint"), str)
                else None
            ),
            tags=tuple(str(t) for t in tags),
        )


class PinnedIdentityVerifier(Protocol):
    def verify(
        self, request: TransportResolutionRequest, candidate: TransportCandidate
    ) -> bool: ...


ReachabilityProbe = Callable[[TransportCandidate], bool]


@dataclass(frozen=True)
class TransportResolution:
    """Accepted runtime target or a typed failure summary."""

    request: TransportResolutionRequest
    status: TransportStatus
    candidate: TransportCandidate | None = None
    candidate_count: int = 0
    identity_verified: bool = False
    detail: str = ""

    @property
    def accepted(self) -> bool:
        return self.status is TransportStatus.TARGET_CONTACTED

    def as_durable_evidence(self) -> dict[str, object]:
        """Return topology-free evidence; locator fields never cross this seam."""
        candidate = self.candidate
        return {
            "node_uid": self.request.node_uid,
            "management_path": self.request.management_path,
            "management_profile": self.request.management_profile,
            "provider": candidate.provider if candidate else None,
            "status": self.status.value,
            "candidate_count": self.candidate_count,
            "identity_verified": self.identity_verified,
            "transport_mode": self.request.mode.value,
        }


class TransportResolver:
    """Orchestrate candidate selection, reachability, and pinned proof."""

    @staticmethod
    def select_candidate(
        request: TransportResolutionRequest,
        adapter: TransportAdapter,
        *,
        inventory: Iterable[object] | None = None,
        runtime_hint: RuntimeTransportHint | None = None,
    ) -> TransportCandidate:
        """Select exactly one candidate without claiming host contact.

        FO-2B uses this pre-contact phase to materialize a temporary target.
        Host contact is established separately by the caller's fixed probe or
        Ansible operation and must not be inferred from candidate selection.
        """
        candidates = tuple(
            adapter.candidates(request, inventory=inventory, runtime_hint=runtime_hint)
        )
        if not candidates:
            raise TransportTargetUnresolvedError(
                f"no transport candidate for node_uid {request.node_uid}"
            )
        if len(candidates) > 1:
            raise TransportTargetAmbiguousError(
                f"multiple transport candidates for node_uid {request.node_uid}"
            )
        return candidates[0]

    @staticmethod
    def verify_pinned_identity(
        request: TransportResolutionRequest,
        candidate: TransportCandidate,
        identity_verifier: PinnedIdentityVerifier | Callable[..., bool] | None,
    ) -> None:
        """Verify the pinned identity without performing network contact."""
        if identity_verifier is None:
            raise TargetIdentityMismatchError(
                "pinned target identity verifier is required; refusing hostname-only trust"
            )
        try:
            if hasattr(identity_verifier, "verify"):
                verified = bool(identity_verifier.verify(request, candidate))
            else:
                verified = bool(identity_verifier(request, candidate))
        except Exception as exc:  # noqa: BLE001 - normalize verifier faults
            raise TargetIdentityMismatchError(
                f"pinned target identity verification failed: {type(exc).__name__}"
            ) from None
        if not verified:
            raise TargetIdentityMismatchError(
                f"pinned target identity does not match node_uid {request.node_uid}"
            )

    def resolve(
        self,
        request: TransportResolutionRequest,
        adapter: TransportAdapter,
        *,
        inventory: Iterable[object] | None = None,
        runtime_hint: RuntimeTransportHint | None = None,
        identity_verifier: PinnedIdentityVerifier | Callable[..., bool] | None = None,
        reachability_probe: ReachabilityProbe | None = None,
    ) -> TransportResolution:
        candidates = tuple(
            adapter.candidates(request, inventory=inventory, runtime_hint=runtime_hint)
        )
        if not candidates:
            raise TransportTargetUnresolvedError(
                f"no transport candidate for node_uid {request.node_uid}"
            )
        if len(candidates) > 1:
            raise TransportTargetAmbiguousError(
                f"multiple transport candidates for node_uid {request.node_uid}"
            )

        candidate = candidates[0]
        if reachability_probe is not None:
            try:
                reachable = bool(reachability_probe(candidate))
            except Exception as exc:  # noqa: BLE001 - normalize provider failures
                raise TransportReachabilityError(
                    f"transport reachability probe failed: {type(exc).__name__}"
                ) from None
            if not reachable:
                raise TransportReachabilityError(
                    f"transport reachability failed for node_uid {request.node_uid}"
                )

        if identity_verifier is None:
            raise TargetIdentityMismatchError(
                "pinned target identity verifier is required; refusing hostname-only trust"
            )
        try:
            if hasattr(identity_verifier, "verify"):
                verified = bool(identity_verifier.verify(request, candidate))
            else:
                verified = bool(identity_verifier(request, candidate))
        except Exception as exc:  # noqa: BLE001 - fail closed on verifier faults
            raise TargetIdentityMismatchError(
                f"pinned target identity verification failed: {type(exc).__name__}"
            ) from None
        if not verified:
            raise TargetIdentityMismatchError(
                f"pinned target identity does not match node_uid {request.node_uid}"
            )

        return TransportResolution(
            request=request,
            # Candidate selection and pinned identity proof establish a
            # resolved target. Contact is a separate claim and requires an
            # explicit successful reachability probe.
            status=(
                TransportStatus.TARGET_CONTACTED
                if reachability_probe is not None
                else TransportStatus.TARGET_RESOLVED
            ),
            candidate=candidate,
            candidate_count=1,
            identity_verified=True,
        )

    def try_resolve(self, request: TransportResolutionRequest, adapter: TransportAdapter, **kwargs) -> TransportResolution:
        """Return a typed failure result for report-producing callers."""
        try:
            return self.resolve(request, adapter, **kwargs)
        except TransportResolutionError as exc:
            return TransportResolution(
                request=request,
                status=exc.status,
                candidate_count=0,
                detail=exc.detail,
            )


def sanitize_durable_transport_result(result: TransportResolution) -> dict[str, object]:
    """Compatibility helper for callers producing durable evidence."""
    return result.as_durable_evidence()


def resolve_transport(
    request: TransportResolutionRequest,
    adapter: TransportAdapter,
    **kwargs,
) -> TransportResolution:
    """Convenience entry point for runtime backends using the typed seam."""
    return TransportResolver().resolve(request, adapter, **kwargs)
