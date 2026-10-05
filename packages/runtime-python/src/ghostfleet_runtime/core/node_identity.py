"""Fleet node identity resolution — deterministic order per ADR-001.

Fleet Identity v2 (legacy mechanism contract, ADR-001) resolution order when
correlating an observed external object to a Fleet node:

1. exact node_uid                # strongest, when available
2. exact canonical node_id
3. exact historical alias
4. exact asset_ref correlation
5. provider ref correlation      # registry schema 1.2.0 management_provider_refs
6. deterministic naming match    # navigation only — NEVER authorizes mutation
7. heuristic guess               # NEVER mutate; require confirmation

Heuristic/naming matches may help a weak Agent navigate, but must never
authorize mutation: :func:`require_mutation_target` fails closed for
anything below an exact match.

NOTE (FO2B3 / legacy mechanism contract): the provider ref is a rotatable, opaque,
provider-scoped CORRELATION bound to the exact node_uid — not a second
immutable identity. It is consumed by the runtime transport resolution, but
it never becomes a Fleet mutation authority root; `node_uid` remains the
authority.
"""

from dataclasses import dataclass

MATCH_NODE_UID = "node_uid"
MATCH_NODE_ID = "node_id"
MATCH_ALIAS = "alias"
MATCH_ASSET_REF = "asset_ref"
MATCH_NAMING = "naming_correlation"
NO_MATCH = "unresolved"

# Exact-match tiers (steps 1-4). These authorize mutation when the caller
# itself holds separate authority; naming correlation never does.
EXACT_MATCH_TIERS = (MATCH_NODE_UID, MATCH_NODE_ID, MATCH_ALIAS, MATCH_ASSET_REF)


class NodeIdentityError(Exception):
    """Base class for fail-closed node identity resolution errors."""


class AmbiguousNodeError(NodeIdentityError):
    """Raised when an exact match resolves to more than one node."""


class UnresolvedNodeError(NodeIdentityError):
    """Raised when no deterministic resolution exists."""


class HeuristicMutationDenied(NodeIdentityError):
    """Raised when a naming/heuristic match is used to request mutation."""


@dataclass(frozen=True)
class NodeResolution:
    """Result of resolving one external reference against the registry.

    ``mutation_authorized`` is True only for exact-match tiers
    (node_uid / node_id / alias / asset_ref). Naming correlation is
    navigation-only: it may help a Human/Agent find the right node, but it
    MUST NOT authorize any mutation.
    """

    reference: str
    node_id: str
    node_uid: str
    match: str
    mutation_authorized: bool


def _iter_nodes(nodes: dict):
    for node_id, node in nodes.items():
        if isinstance(node, dict):
            yield node_id, node


def _exact_matches(reference: str, nodes: dict, key_selector) -> list[tuple[str, dict]]:
    return [
        (node_id, node)
        for node_id, node in _iter_nodes(nodes)
        if key_selector(node) == reference
    ]


def resolve_node(reference: str, nodes: dict) -> NodeResolution:
    """Resolve one reference against the registry, ADR-001 order, fail closed.

    Exact tiers are tried in order: node_uid, node_id, alias, asset_ref.
    Explicit provider refs (step 5) are not representable in registry
    schema 1.1 — they live in provider adapters and never here. If no exact
    tier matches, a deterministic naming correlation (the canonical node_id
    token appearing inside the reference) is returned navigation-only.
    Ambiguity within an exact tier fails closed via :class:`AmbiguousNodeError`
    (the registry validator normally makes this unreachable).
    """
    if not isinstance(reference, str) or not reference:
        raise UnresolvedNodeError("empty reference cannot be resolved")

    def _finish(reference, node_id, node, match):
        return NodeResolution(
            reference=reference,
            node_id=node_id,
            node_uid=node["node_uid"],
            match=match,
            mutation_authorized=match in EXACT_MATCH_TIERS,
        )

    # 1. exact node_uid — strongest
    matches = _exact_matches(reference, nodes, lambda n: n.get("node_uid"))
    if matches:
        if len(matches) > 1:
            raise AmbiguousNodeError(
                f"node_uid {reference!r} matches multiple nodes: "
                f"{sorted(n for n, _ in matches)}"
            )
        node_id, node = matches[0]
        return _finish(reference, node_id, node, MATCH_NODE_UID)

    # 2. exact canonical node_id
    node = nodes.get(reference)
    if isinstance(node, dict):
        return _finish(reference, reference, node, MATCH_NODE_ID)

    # 3. exact historical alias
    matches = [
        (node_id, n)
        for node_id, n in _iter_nodes(nodes)
        if isinstance(n.get("aliases"), list) and reference in n["aliases"]
    ]
    if matches:
        if len(matches) > 1:
            raise AmbiguousNodeError(
                f"alias {reference!r} matches multiple nodes: "
                f"{sorted(n for n, _ in matches)}"
            )
        node_id, node = matches[0]
        return _finish(reference, node_id, node, MATCH_ALIAS)

    # 4. exact asset_ref correlation
    matches = _exact_matches(reference, nodes, lambda n: n.get("asset_ref"))
    if matches:
        if len(matches) > 1:
            raise AmbiguousNodeError(
                f"asset_ref {reference!r} matches multiple nodes: "
                f"{sorted(n for n, _ in matches)}"
            )
        node_id, node = matches[0]
        return _finish(reference, node_id, node, MATCH_ASSET_REF)

    # 5. explicit provider ref — registry schema 1.2.0 carries an optional
    #    opaque `management_provider_refs.tailscale` bound to this node_uid.
    #    It is a provider-correlation reference, NOT a second identity, and it
    #    is consumed by the runtime transport resolution layer (not here as a
    #    Fleet identity tier).

    # 6. deterministic naming correlation — navigation only.
    candidates = [
        (node_id, n)
        for node_id, n in _iter_nodes(nodes)
        if _is_naming_correlation(reference, node_id)
    ]
    if len(candidates) == 1:
        node_id, node = candidates[0]
        return _finish(reference, node_id, node, MATCH_NAMING)

    raise UnresolvedNodeError(
        f"reference {reference!r} does not resolve to any Fleet node "
        "deterministically; fail closed"
    )


def _is_naming_correlation(reference: str, node_id: str) -> bool:
    """Deterministic naming correlation: the canonical node_id token appears
    as a distinct token inside the reference (e.g. ``fleet-synthetic-device`` or
    ``fleet-synthetic-device.example.invalid`` contains the token ``synthetic-device``).

    This is intentionally conservative: it only extracts tokens from the
    reference (split on `.`, `-` boundaries are NOT split — the node_id is
    matched as a whole token so ``bwh`` does not correlate to ``synthetic-device``)
    and never treats a substring as sufficient.
    """
    tokens = {t for t in reference.split(".") if t}
    # Strip a leading `fleet-` management-surface prefix from each token
    # (ADR-001: fleet- is a stable Fleet access-surface prefix, not identity).
    stripped = set()
    for token in tokens:
        stripped.add(token)
        if token.startswith("fleet-"):
            stripped.add(token[len("fleet-"):])
    return node_id in tokens or node_id in stripped


def require_mutation_target(reference: str, nodes: dict) -> NodeResolution:
    """Return the exact-match resolution required before any mutation.

    Fails closed:
    - naming/heuristic correlation -> :class:`HeuristicMutationDenied`
      (a name match may help navigation but never authorizes mutation);
    - no deterministic match -> :class:`UnresolvedNodeError`;
    - ambiguity -> :class:`AmbiguousNodeError`.
    """
    try:
        resolution = resolve_node(reference, nodes)
    except UnresolvedNodeError:
        raise UnresolvedNodeError(
            f"mutation target {reference!r} has no deterministic Fleet "
            "identity resolution; refusing"
        ) from None
    if not resolution.mutation_authorized:
        raise HeuristicMutationDenied(
            f"reference {reference!r} only correlates to node "
            f"{resolution.node_id!r} by naming heuristic; heuristic match "
            "MUST NOT authorize mutation — use exact node_uid/node_id/alias"
        )
    return resolution
