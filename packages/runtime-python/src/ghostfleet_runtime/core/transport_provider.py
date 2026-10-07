"""Provider adapter interface: provider-specific resolution/observation only.

The provider-neutral contract owns purpose, authority, target-proof, and
effect-state fencing. Provider adapters only materialize runtime evidence for a
single ``PlaneBinding`` and never decide cross-purpose authority or dispatch.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .transport_contract import Candidate, PlaneBinding, TransportRequest


@runtime_checkable
class TransportProviderAdapter(Protocol):
    """Provider-specific adapter: resolve a PlaneBinding to candidate summaries."""

    plane: str  # Plane value; kept as str to avoid circular import of Enum

    def candidates(
        self, request: TransportRequest, binding: PlaneBinding
    ) -> tuple[Candidate, ...]:
        """Return candidate summaries for this plane/binding without network mutation."""

    def observed_tags(self, binding: PlaneBinding) -> tuple[str, ...]:
        """Return runtime-observed tags for the binding; never merged into required_tags."""

    def health(self, binding: PlaneBinding) -> str:
        """Return a short health/failure-domain observation label."""
