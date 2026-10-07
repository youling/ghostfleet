"""Compatibility adapters: legacy Python/TS inputs -> provider-neutral contract.

Legacy Python ``TransportResolutionRequest`` and TS ``ControlTarget`` do not
carry the frozen contract's explicit ``purpose`` or durable ``dispatch_state``.
Adapters require those values explicitly; missing values remain fail-closed and
are never defaulted to ``NOT_DISPATCHED`` or ``machine-control``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .transport_contract import (
    Authority,
    Caller,
    DispatchState,
    Plane,
    PlaneBinding,
    Purpose,
    TransportRequest,
)

if TYPE_CHECKING:
    from .transport_resolution import TransportResolutionRequest


_LEGACY_TS_MODE_TO_PLANE: dict[str, Plane] = {
    "mesh_hostname": Plane.CLOUDFLARE_VPC,
    "direct_tunnel": Plane.CLOUDFLARE_VPC,
    "local_ssh": Plane.NATIVE_LAN,
}


def _legacy_provider_to_plane(provider: str) -> Plane:
    normalized = provider.strip().lower()
    if normalized in ("tailscale", "tailnet"):
        return Plane.TAILNET
    if normalized in ("cloudflare", "cloudflare-vpc", "workers-vpc", "tunnel"):
        return Plane.CLOUDFLARE_VPC
    return Plane.NATIVE_LAN


def python_legacy_to_contract(
    legacy: "TransportResolutionRequest",
    *,
    purpose: Purpose | None,
    dispatch_state: DispatchState | None,
    caller: Caller,
    authority: Authority,
    observed_tags: tuple[str, ...] = (),
) -> TransportRequest:
    """Map a legacy ``TransportResolutionRequest`` to a contract ``TransportRequest``.

    ``purpose`` and ``dispatch_state`` must be supplied explicitly when known;
    ``None`` is preserved so the contract's ``evaluate_gate`` can fail closed.
    ``observed_tags`` are runtime observations and never merged into
    ``PlaneBinding.required_tags``.
    """
    from .transport_resolution import TransportMode as LegacyMode

    plane = _legacy_provider_to_plane(getattr(legacy, "provider_ref", "") or "")
    # The legacy request's ``management_profile`` is not authority; it is only
    # retained as a durable binding hint. The real ``Authority`` comes from the
    # caller-supplied ``authority``.
    required_tags: tuple[str, ...]
    if getattr(legacy, "mode", None) is LegacyMode.NORMAL:
        required_tags = ("tag:fleet-ssh-target",)
    else:
        required_tags = ()

    provider_ref = getattr(legacy, "provider_ref", None) or ""
    binding = PlaneBinding(
        plane=plane if provider_ref else Plane.TAILNET,
        provider="tailscale" if provider_ref else "tailscale",
        provider_ref=provider_ref,
        required_tags=required_tags,
        runtime_tags=tuple(observed_tags),
    )
    return TransportRequest(
        node_uid=legacy.node_uid,
        caller=caller,
        authority=authority,
        purpose=purpose,
        dispatch_state=dispatch_state,
        plane_bindings=(binding,),
    )


def ts_control_target_to_contract(
    *,
    node_uid: str,
    transport_mode: str,
    purpose: Purpose | None,
    dispatch_state: DispatchState | None,
    caller: Caller,
    authority: Authority,
    observed_tags: tuple[str, ...] = (),
) -> TransportRequest:
    """Map a legacy TS ``ControlTarget.transport_mode`` entry to a contract request."""
    plane = _LEGACY_TS_MODE_TO_PLANE.get(transport_mode, Plane.NATIVE_LAN)
    provider = "cloudflare" if plane is Plane.CLOUDFLARE_VPC else "native"
    required_tags: tuple[str, ...] = ()
    # Never synthesize purpose or dispatch_state here.
    binding = PlaneBinding(
        plane=plane,
        provider=provider,
        provider_ref="",
        required_tags=required_tags,
        runtime_tags=tuple(observed_tags),
    )
    return TransportRequest(
        node_uid=node_uid,
        caller=caller,
        authority=authority,
        purpose=purpose,
        dispatch_state=dispatch_state,
        plane_bindings=(binding,),
    )
